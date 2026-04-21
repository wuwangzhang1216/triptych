/**
 * Codex provider — calls chatgpt.com/backend-api/codex/responses (WHAM API).
 * Ported from claude-code-source-all-in-one/src/services/api/providers/chatgptSubscription.ts
 */

import { getCodexAgentMode, getCodexModel, getCodexTokens, getCodexWebSearch } from '../../config.js'
import { runCodexAgent } from '../../agent/codex.js'
import { DEFAULT_TOOLS } from '../../agent/tools.js'
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
import {
  buildCritiquePrompt,
  buildFramePrompt,
  buildJudgePrompt,
  buildPlanPrompt,
  buildRevisePrompt,
} from '../prompts.js'

const WHAM_URL = 'https://chatgpt.com/backend-api/codex/responses'

async function* streamWham(
  instructions: string,
  userMessage: string,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  if (getCodexAgentMode()) {
    let fullText = ''
    for await (const ev of runCodexAgent({
      systemPrompt: instructions,
      userMessage,
      tools: DEFAULT_TOOLS,
      signal,
    })) {
      if (ev.type === 'text') {
        fullText += ev.text
        yield { type: 'text', text: ev.text }
      } else if (ev.type === 'done') {
        yield { type: 'done', fullText: ev.fullText }
        return
      }
    }
    yield { type: 'done', fullText }
    return
  }
  let tokens = await ensureValidToken()
  let retried = false

  const body: Record<string, unknown> = {
    model: getCodexModel(),
    store: false,
    stream: true,
    instructions: instructions || undefined,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: userMessage }],
      },
    ],
    reasoning: { effort: 'medium', summary: 'auto' },
  }
  if (getCodexWebSearch()) {
    body.tools = [{ type: 'web_search', search_context_size: 'low' }]
    body.include = ['web_search_call.action.sources']
  }

  async function doFetch(): Promise<Response> {
    return fetch(WHAM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
        'ChatGPT-Account-Id': tokens.accountId,
      },
      body: JSON.stringify(body),
      signal,
    })
  }

  let res = await doFetch()

  if (res.status === 401 && !retried) {
    retried = true
    await refreshAccessToken()
    tokens = await ensureValidToken()
    res = await doFetch()
  }

  if (!res.ok) {
    throw new Error(`Codex WHAM error ${res.status}: ${await res.text()}`)
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''

  try {
    while (true) {
      if (signal.aborted) break
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      let currentEvent = ''
      let currentData = ''

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          currentData = line.slice(6)
        } else if (line === '' && currentData) {
          try {
            const parsed = JSON.parse(currentData) as { type?: string; delta?: string }
            const eventType = currentEvent || parsed.type || ''

            if (
              eventType === 'response.output_text.delta' ||
              eventType === 'response.text.delta' ||
              eventType === 'response.reasoning_summary_text.delta'
            ) {
              const text = parsed.delta ?? ''
              if (text) {
                fullText += text
                yield { type: 'text', text }
              }
            }

            if (eventType === 'error') {
              const data = parsed as { message?: string }
              throw new Error(`Codex stream error: ${data.message ?? 'unknown'}`)
            }
          } catch (e) {
            if ((e as Error).message?.startsWith('Codex stream error')) throw e
            // skip malformed SSE
          }
          currentEvent = ''
          currentData = ''
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  yield { type: 'done', fullText }
}

export class CodexProvider implements PlanningProvider {
  readonly name = 'codex' as const
  get model(): string { return getCodexModel() }

  async isAuthenticated(): Promise<boolean> {
    const tokens = getCodexTokens()
    return tokens?.accessToken != null
  }

  async *frame(req: PlanRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const { system, user } = buildFramePrompt(req)
    yield* streamWham(system, user, signal)
  }

  async *plan(req: PlanRequest, frames: FrameResult[], signal: AbortSignal): AsyncIterable<StreamChunk> {
    const { system, user } = buildPlanPrompt(req, frames)
    yield* streamWham(system, user, signal)
  }

  async *critique(
    req: PlanRequest,
    theirPlan: PlanResult,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildCritiquePrompt(req, theirPlan)
    yield* streamWham(system, user, signal)
  }

  async *revise(
    req: PlanRequest,
    myPlan: PlanResult,
    critiques: CritiqueResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildRevisePrompt(req, myPlan, critiques)
    yield* streamWham(system, user, signal)
  }

  async *judge(
    req: PlanRequest,
    allPlans: PlanResult[],
    allCritiques: CritiqueResult[],
    allRevisions: RevisionResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildJudgePrompt(req, allPlans, allCritiques, allRevisions)
    yield* streamWham(system, user, signal)
  }
}
