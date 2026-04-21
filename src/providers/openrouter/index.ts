/**
 * OpenRouter provider — uses the official `openai` SDK pointed at openrouter.ai,
 * which is OpenAI-Chat-Completions compatible.
 */

import OpenAI from 'openai'
import { getOpenRouterAgentMode, getOpenRouterKey, getOpenRouterModel } from '../../config.js'
import { runOpenRouterAgent } from '../../agent/openrouter.js'
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
import {
  buildCritiquePrompt,
  buildFramePrompt,
  buildJudgePrompt,
  buildPlanPrompt,
  buildRevisePrompt,
} from '../prompts.js'

function makeClient(): OpenAI {
  const apiKey = getOpenRouterKey()
  if (!apiKey) {
    throw new Error('OpenRouter API key not set. Run: pj config set openrouter_api_key <key>')
  }
  return new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/planing-judeger',
      'X-Title': 'planing-judeger',
    },
  })
}

async function* streamOpenRouter(
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  if (getOpenRouterAgentMode()) {
    let fullText = ''
    for await (const ev of runOpenRouterAgent({
      systemPrompt,
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

  const client = makeClient()
  const stream = await client.chat.completions.create(
    {
      model: getOpenRouterModel(),
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    },
    { signal },
  )

  let fullText = ''
  for await (const chunk of stream) {
    if (signal.aborted) break
    const text = chunk.choices[0]?.delta?.content ?? ''
    if (text) {
      fullText += text
      yield { type: 'text', text }
    }
  }

  yield { type: 'done', fullText }
}

export class OpenRouterProvider implements PlanningProvider {
  readonly name = 'openrouter' as const
  get model(): string { return getOpenRouterModel() }

  async isAuthenticated(): Promise<boolean> {
    return getOpenRouterKey() != null
  }

  async *frame(req: PlanRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const { system, user } = buildFramePrompt(req)
    yield* streamOpenRouter(system, user, signal)
  }

  async *plan(req: PlanRequest, frames: FrameResult[], signal: AbortSignal): AsyncIterable<StreamChunk> {
    const { system, user } = buildPlanPrompt(req, frames)
    yield* streamOpenRouter(system, user, signal)
  }

  async *critique(
    req: PlanRequest,
    theirPlan: PlanResult,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildCritiquePrompt(req, theirPlan)
    yield* streamOpenRouter(system, user, signal)
  }

  async *revise(
    req: PlanRequest,
    myPlan: PlanResult,
    critiques: CritiqueResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildRevisePrompt(req, myPlan, critiques)
    yield* streamOpenRouter(system, user, signal)
  }

  async *judge(
    req: PlanRequest,
    allPlans: PlanResult[],
    allCritiques: CritiqueResult[],
    allRevisions: RevisionResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildJudgePrompt(req, allPlans, allCritiques, allRevisions)
    yield* streamOpenRouter(system, user, signal)
  }
}
