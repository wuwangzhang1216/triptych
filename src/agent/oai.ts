/**
 * OAI agent loop — uses the official `openai` SDK with tool_calls (standard
 * Chat Completions function-calling). Any endpoint in the OpenAI-compatible
 * family works identically: OpenRouter, DeepSeek, Moonshot/Kimi, Zhipu/GLM,
 * DashScope/Qwen, MiniMax, xAI Grok, Mistral, Groq, Together, Fireworks,
 * Cerebras, DeepInfra, Doubao, SiliconFlow, Perplexity, OpenAI direct, …
 */

import OpenAI from 'openai'
import {
  getOAIBaseUrl,
  getOAIExtraHeaders,
  getOAIKey,
  getOAIModel,
} from '../config.js'
import { findTool, type Tool } from './tools.js'
import type { AgentEvent } from './types.js'

function makeClient(): OpenAI {
  const apiKey = getOAIKey()
  if (!apiKey) throw new Error('OAI API key not set. Run: pj config set oai_api_key <key>')
  const baseURL = getOAIBaseUrl()
  const isOpenRouter = baseURL.includes('openrouter.ai')
  return new OpenAI({
    apiKey,
    baseURL,
    defaultHeaders: {
      ...(isOpenRouter ? {
        'HTTP-Referer': 'https://github.com/wuwangzhang1216/triptych',
        'X-Title': 'triptych',
      } : {}),
      ...getOAIExtraHeaders(),
    },
  })
}

// OpenAI SDK v6 renamed the tool type; use a local shape to avoid version churn.
interface OpenAIFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

function toolsToOpenAIParams(tools: Tool[]): OpenAIFunctionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }))
}

export interface OAIAgentOptions {
  systemPrompt: string
  userMessage: string
  tools?: Tool[]
  maxTurns?: number
  signal: AbortSignal
}

export async function* runOAIAgent(
  opts: OAIAgentOptions,
): AsyncIterable<AgentEvent> {
  const { systemPrompt, userMessage, tools = [], maxTurns = 10, signal } = opts
  const client = makeClient()
  const model = getOAIModel()

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ]
  const toolParams = tools.length > 0 ? toolsToOpenAIParams(tools) : undefined

  let fullText = ''
  let turn = 0

  while (turn < maxTurns) {
    turn++
    yield { type: 'turn_start', turn }

    const stream = await client.chat.completions.create(
      {
        model,
        stream: true,
        messages,
        ...(toolParams ? { tools: toolParams } : {}),
      },
      { signal },
    )

    // Accumulate assistant message for this turn.
    let content = ''
    // Indexed tool_calls accumulator (delta arrives in pieces per-index).
    const calls = new Map<number, { id: string; name: string; arguments: string }>()

    for await (const chunk of stream) {
      if (signal.aborted) break
      const delta = chunk.choices[0]?.delta
      if (!delta) continue
      if (delta.content) {
        content += delta.content
        fullText += delta.content
        yield { type: 'text', text: delta.content }
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!calls.has(idx)) {
            calls.set(idx, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              arguments: '',
            })
          }
          const acc = calls.get(idx)!
          if (tc.id && !acc.id) acc.id = tc.id
          if (tc.function?.name && !acc.name) acc.name = tc.function.name
          if (tc.function?.arguments) acc.arguments += tc.function.arguments
        }
      }
    }

    // If no tool calls, turn complete.
    if (calls.size === 0) break

    // Record assistant message (with tool_calls) then execute tools.
    const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: content || null,
      tool_calls: [...calls.values()].map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    }
    messages.push(assistantMsg)

    for (const call of calls.values()) {
      yield { type: 'tool_use_start', toolName: call.name, input: safeParse(call.arguments), id: call.id }
      const tool = findTool(tools, call.name)
      const start = Date.now()
      let output = ''
      if (!tool) {
        output = `Error: tool "${call.name}" not registered.`
      } else {
        try {
          output = await tool.run(safeParse(call.arguments), { signal })
        } catch (err) {
          output = `Tool "${call.name}" threw: ${(err as Error).message}`
        }
      }
      yield {
        type: 'tool_use_result',
        id: call.id,
        toolName: call.name,
        output,
        durationMs: Date.now() - start,
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: output,
      })
    }
  }

  yield { type: 'done', fullText, totalTurns: turn }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {}
  } catch {
    return { _raw: json }
  }
}

/** @deprecated use `runOAIAgent` — this alias is kept for library users. */
export { runOAIAgent as runOpenRouterAgent }
/** @deprecated use `OAIAgentOptions` — kept for library users. */
export type { OAIAgentOptions as OpenRouterAgentOptions }
