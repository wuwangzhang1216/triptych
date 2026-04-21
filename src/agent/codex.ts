/**
 * Codex agent loop against the ChatGPT WHAM endpoint
 * (`chatgpt.com/backend-api/codex/responses`).
 *
 * Schema reference: /Users/wangzhangwu/openYak/openyak/backend/app/provider/openai_subscription.py
 *
 * WHAM tool format (flat):
 *   { type: "function", name, description, parameters }
 *   plus optionally { type: "web_search", search_context_size: "low" }
 *
 * Streaming function-call events:
 *   response.output_item.added with item.type="function_call"   → capture id, call_id, name
 *   response.function_call_arguments.delta                      → accumulate JSON string
 *   response.function_call_arguments.done                       → tool call complete
 *
 * Tool results are passed back in the next turn's `input` as:
 *   { type: "function_call",        id, call_id, name, arguments }  // assistant's call
 *   { type: "function_call_output", call_id, output }               // our result
 */

import { getCodexModel, getCodexWebSearch } from '../config.js'
import { ensureValidToken, refreshAccessToken } from '../providers/codex/auth.js'
import { findTool, type Tool } from './tools.js'
import type { AgentEvent } from './types.js'

const WHAM_URL = 'https://chatgpt.com/backend-api/codex/responses'

interface WhamFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface WhamWebSearchTool {
  type: 'web_search'
  search_context_size: 'low' | 'medium' | 'high'
}

type WhamTool = WhamFunctionTool | WhamWebSearchTool

type InputItem = Record<string, unknown>

function toWhamFunctionTools(tools: Tool[]): WhamFunctionTool[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema as Record<string, unknown>,
  }))
}

export interface CodexAgentOptions {
  systemPrompt: string
  userMessage: string
  tools?: Tool[]
  maxTurns?: number
  signal: AbortSignal
}

export async function* runCodexAgent(
  opts: CodexAgentOptions,
): AsyncIterable<AgentEvent> {
  const { systemPrompt, userMessage, tools = [], maxTurns = 10, signal } = opts

  const input: InputItem[] = [
    { role: 'user', content: [{ type: 'input_text', text: userMessage }] },
  ]

  const functionTools = toWhamFunctionTools(tools)
  const webTools: WhamTool[] = getCodexWebSearch()
    ? [{ type: 'web_search', search_context_size: 'low' }]
    : []
  const allTools: WhamTool[] = [...functionTools, ...webTools]

  let fullText = ''
  let turn = 0

  while (turn < maxTurns) {
    turn++
    yield { type: 'turn_start', turn }

    const body: Record<string, unknown> = {
      model: getCodexModel(),
      store: false,
      stream: true,
      instructions: systemPrompt || undefined,
      input,
      reasoning: { effort: 'medium', summary: 'auto' },
    }
    if (allTools.length > 0) {
      body.tools = allTools
      if (webTools.length > 0) body.include = ['web_search_call.action.sources']
    }

    let tokens = await ensureValidToken()

    const doFetch = async () =>
      fetch(WHAM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
          'ChatGPT-Account-Id': tokens.accountId,
        },
        body: JSON.stringify(body),
        signal,
      })

    let res = await doFetch()
    if (res.status === 401) {
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

    // Accumulate function call state by item_id.
    const toolAcc = new Map<
      string,
      { id: string; call_id: string; name: string; arguments: string }
    >()
    const pendingCalls: Array<{ id: string; call_id: string; name: string; input: Record<string, unknown> }> = []

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
              const parsed = JSON.parse(currentData) as {
                type?: string
                delta?: string
                item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string }
                item_id?: string
                response?: { output?: InputItem[]; status?: string }
              }
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
              } else if (eventType === 'response.output_item.added') {
                const item = parsed.item
                if (item?.type === 'function_call') {
                  const id = item.id ?? ''
                  toolAcc.set(id, {
                    id,
                    call_id: item.call_id ?? id,
                    name: item.name ?? '',
                    arguments: '',
                  })
                }
              } else if (eventType === 'response.function_call_arguments.delta') {
                const id = parsed.item_id ?? ''
                const acc = toolAcc.get(id)
                if (acc) acc.arguments += parsed.delta ?? ''
              } else if (eventType === 'response.function_call_arguments.done') {
                const id = parsed.item_id ?? ''
                const acc = toolAcc.get(id)
                if (acc) {
                  let parsedArgs: Record<string, unknown> = {}
                  try {
                    parsedArgs = acc.arguments ? (JSON.parse(acc.arguments) as Record<string, unknown>) : {}
                  } catch {
                    parsedArgs = { _raw: acc.arguments }
                  }
                  pendingCalls.push({
                    id: acc.id,
                    call_id: acc.call_id,
                    name: acc.name,
                    input: parsedArgs,
                  })
                  toolAcc.delete(id)
                }
              }
            } catch {
              // malformed SSE line — skip
            }
            currentEvent = ''
            currentData = ''
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // No tool calls → turn complete.
    if (pendingCalls.length === 0) break

    // Append the assistant's function_call items + our function_call_output items to next turn's input.
    for (const call of pendingCalls) {
      input.push({
        type: 'function_call',
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: JSON.stringify(call.input),
      })
    }
    for (const call of pendingCalls) {
      yield { type: 'tool_use_start', toolName: call.name, input: call.input, id: call.call_id }
      const tool = findTool(tools, call.name)
      const start = Date.now()
      let output = ''
      if (!tool) {
        output = `Error: tool "${call.name}" not registered on this agent.`
      } else {
        try {
          output = await tool.run(call.input, { signal })
        } catch (err) {
          output = `Tool "${call.name}" threw: ${(err as Error).message}`
        }
      }
      yield {
        type: 'tool_use_result',
        id: call.call_id,
        toolName: call.name,
        output,
        durationMs: Date.now() - start,
      }
      input.push({ type: 'function_call_output', call_id: call.call_id, output })
    }
  }

  yield { type: 'done', fullText, totalTurns: turn }
}
