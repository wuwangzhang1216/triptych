import Anthropic from '@anthropic-ai/sdk'
import { getClaudeAgentMode, getClaudeModel, getClaudeTokens, getClaudeWebSearch } from '../../config.js'
import type {
  CritiqueResult,
  FrameResult,
  PlanRequest,
  PlanResult,
  PlanningProvider,
  RevisionResult,
  StreamChunk,
} from '../../types.js'
import { ensureValidToken, refreshAccessToken } from './auth.js'
import { runClaudeAgent } from '../../agent/claude.js'
import { DEFAULT_TOOLS } from '../../agent/tools.js'
import {
  buildCritiquePrompt,
  buildFramePrompt,
  buildJudgePrompt,
  buildPlanPrompt,
  buildRevisePrompt,
} from '../prompts.js'

const CLAUDE_CODE_IDENTIFIER = `You are Claude Code, Anthropic's official CLI for Claude.`

function makeClient(token: string): Anthropic {
  return new Anthropic({
    authToken: token,
    defaultHeaders: {
      'anthropic-beta': 'oauth-2025-04-20',
    },
  })
}

async function* streamMessages(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  // Agent mode: multi-turn loop with Read/Grep/Glob/WebFetch tools.
  if (getClaudeAgentMode()) {
    let fullText = ''
    for await (const ev of runClaudeAgent({
      systemPrompt,
      userMessage,
      tools: DEFAULT_TOOLS,
      maxTokens,
      signal,
    })) {
      if (ev.type === 'text') {
        fullText += ev.text
        yield { type: 'text', text: ev.text }
      } else if (ev.type === 'done') {
        yield { type: 'done', fullText: ev.fullText }
        return
      }
      // tool_use_start / tool_use_result / turn_start are internal-only; the
      // debate orchestrator only cares about text deltas and the final done.
    }
    yield { type: 'done', fullText }
    return
  }
  let token = await ensureValidToken()
  let retried = false

  const buildRequest = () => {
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: getClaudeModel(),
      max_tokens: maxTokens,
      stream: true,
      system: [
        { type: 'text', text: CLAUDE_CODE_IDENTIFIER },
        { type: 'text', text: systemPrompt },
      ],
      messages: [{ role: 'user', content: userMessage }],
    }
    if (getClaudeWebSearch()) {
      params.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    }
    return params
  }

  async function openStream() {
    const client = makeClient(token)
    return client.messages.stream(buildRequest(), { signal })
  }

  let stream: Awaited<ReturnType<typeof openStream>>
  try {
    stream = await openStream()
  } catch (err) {
    if ((err as { status?: number })?.status === 401 && !retried) {
      retried = true
      await refreshAccessToken()
      token = await ensureValidToken()
      stream = await openStream()
    } else {
      throw err
    }
  }

  let fullText = ''
  for await (const event of stream) {
    if (signal.aborted) break
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      const text = event.delta.text
      if (text) {
        fullText += text
        yield { type: 'text', text }
      }
    }
  }

  yield { type: 'done', fullText }
}

export class ClaudeProvider implements PlanningProvider {
  readonly name = 'claude' as const
  get model(): string { return getClaudeModel() }

  async isAuthenticated(): Promise<boolean> {
    const tokens = getClaudeTokens()
    return tokens?.accessToken != null
  }

  async *frame(req: PlanRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const { system, user } = buildFramePrompt(req)
    yield* streamMessages(system, user, 1024, signal)
  }

  async *plan(req: PlanRequest, frames: FrameResult[], signal: AbortSignal): AsyncIterable<StreamChunk> {
    const { system, user } = buildPlanPrompt(req, frames)
    yield* streamMessages(system, user, req.maxTokens ?? 8192, signal)
  }

  async *critique(
    req: PlanRequest,
    theirPlan: PlanResult,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildCritiquePrompt(req, theirPlan)
    yield* streamMessages(system, user, req.maxTokens ?? 4096, signal)
  }

  async *revise(
    req: PlanRequest,
    myPlan: PlanResult,
    critiques: CritiqueResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildRevisePrompt(req, myPlan, critiques)
    yield* streamMessages(system, user, req.maxTokens ?? 8192, signal)
  }

  async *judge(
    req: PlanRequest,
    allPlans: PlanResult[],
    allCritiques: CritiqueResult[],
    allRevisions: RevisionResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildJudgePrompt(req, allPlans, allCritiques, allRevisions)
    yield* streamMessages(system, user, (req.maxTokens ?? 8192) * 2, signal)
  }
}
