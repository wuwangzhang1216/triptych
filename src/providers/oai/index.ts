/**
 * OAI provider — the generic "any OpenAI-compatible endpoint" slot.
 *
 * Points the official `openai` SDK at whatever `oai_base_url` resolves to:
 * OpenRouter (default), DeepSeek, Moonshot/Kimi, Zhipu/GLM, DashScope/Qwen,
 * MiniMax, xAI Grok, Mistral, Groq, Together, Fireworks, Cerebras, DeepInfra,
 * SiliconFlow, Doubao, Perplexity, OpenAI direct, … All speak Chat Completions
 * so the SDK call is identical; the provider only varies `apiKey`, `baseURL`,
 * and `model`.
 */

import OpenAI from 'openai'
import {
  getOAIAgentMode,
  getOAIBaseUrl,
  getOAIExtraHeaders,
  getOAIKey,
  getOAIModel,
} from '../../config.js'
import { runOAIAgent } from '../../agent/oai.js'
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

export function makeOAIClient(): OpenAI {
  const apiKey = getOAIKey()
  if (!apiKey) {
    throw new Error(
      'OAI API key not set. Run: pj config set oai_api_key <key>  ' +
      '(legacy key `openrouter_api_key` is still honored.)',
    )
  }
  const baseURL = getOAIBaseUrl()
  const isOpenRouter = baseURL.includes('openrouter.ai')
  return new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: {
      // These headers are OpenRouter-specific rank/analytics metadata. Other
      // endpoints don't read them, but sending unknown headers can still
      // confuse stricter gateways — so gate them.
      ...(isOpenRouter ? {
        'HTTP-Referer': 'https://github.com/wuwangzhang1216/triptych',
        'X-Title': 'triptych',
      } : {}),
      ...getOAIExtraHeaders(),
    },
  })
}

async function* streamOAI(
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  if (getOAIAgentMode()) {
    let fullText = ''
    for await (const ev of runOAIAgent({
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

  const client = makeOAIClient()
  const stream = await client.chat.completions.create(
    {
      model: getOAIModel(),
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

export class OAIProvider implements PlanningProvider {
  readonly name = 'oai' as const
  get model(): string { return getOAIModel() }

  async isAuthenticated(): Promise<boolean> {
    return getOAIKey() != null
  }

  async *frame(req: PlanRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const { system, user } = buildFramePrompt(req)
    yield* streamOAI(system, user, signal)
  }

  async *plan(req: PlanRequest, frames: FrameResult[], signal: AbortSignal): AsyncIterable<StreamChunk> {
    const { system, user } = buildPlanPrompt(req, frames)
    yield* streamOAI(system, user, signal)
  }

  async *critique(
    req: PlanRequest,
    theirPlan: PlanResult,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildCritiquePrompt(req, theirPlan)
    yield* streamOAI(system, user, signal)
  }

  async *revise(
    req: PlanRequest,
    myPlan: PlanResult,
    critiques: CritiqueResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildRevisePrompt(req, myPlan, critiques)
    yield* streamOAI(system, user, signal)
  }

  async *judge(
    req: PlanRequest,
    allPlans: PlanResult[],
    allCritiques: CritiqueResult[],
    allRevisions: RevisionResult[],
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const { system, user } = buildJudgePrompt(req, allPlans, allCritiques, allRevisions)
    yield* streamOAI(system, user, signal)
  }
}

/** @deprecated use `OAIProvider` — this alias is kept for library users. */
export { OAIProvider as OpenRouterProvider }
