/**
 * Claude agent loop — multi-turn with client-side tool_use.
 *
 * Flow per turn:
 *   1. Stream Claude response, collect text + tool_use content blocks.
 *   2. If no tool_use blocks: emit `done` and exit.
 *   3. Otherwise execute each tool client-side, append tool_result blocks to
 *      the conversation, and loop to the next turn.
 *
 * Uses the Anthropic SDK's `messages.stream()` under the hood. OAuth auth is
 * handled by passing an access token as the SDK's authToken plus the required
 * `anthropic-beta: oauth-2025-04-20` header — same credentials already used by
 * the non-agent ClaudeProvider.
 */

import Anthropic from '@anthropic-ai/sdk'
import { getClaudeModel, getClaudeWebSearch } from '../config.js'
import { ensureValidToken, refreshAccessToken } from '../providers/claude/auth.js'
import { findTool, type Tool } from './tools.js'
import type { AgentEvent } from './types.js'

const CLAUDE_CODE_IDENTIFIER = `You are Claude Code, Anthropic's official CLI for Claude.`

function makeClient(token: string): Anthropic {
  return new Anthropic({
    authToken: token,
    defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
  })
}

function toToolDef(t: Tool): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }
}

export interface ClaudeAgentOptions {
  systemPrompt: string
  userMessage: string
  tools?: Tool[]
  maxTokens?: number
  maxTurns?: number
  signal: AbortSignal
}

export async function* runClaudeAgent(
  opts: ClaudeAgentOptions,
): AsyncIterable<AgentEvent> {
  const {
    systemPrompt,
    userMessage,
    tools = [],
    maxTokens = 8192,
    maxTurns = 10,
    signal,
  } = opts

  let token = await ensureValidToken()
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ]

  const apiTools: Anthropic.Tool[] = tools.map(toToolDef)
  const serverTools: Anthropic.ToolUnion[] = getClaudeWebSearch()
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    : []
  const allTools: Anthropic.ToolUnion[] = [...apiTools, ...serverTools]

  let fullText = ''
  let turn = 0

  while (turn < maxTurns) {
    turn++
    yield { type: 'turn_start', turn }

    const buildParams = (): Anthropic.MessageCreateParamsStreaming => ({
      model: getClaudeModel(),
      max_tokens: maxTokens,
      stream: true,
      system: [
        { type: 'text', text: CLAUDE_CODE_IDENTIFIER },
        { type: 'text', text: systemPrompt },
      ],
      messages,
      ...(allTools.length > 0 ? { tools: allTools } : {}),
    })

    let stream: ReturnType<Anthropic['messages']['stream']>
    try {
      stream = makeClient(token).messages.stream(buildParams(), { signal })
    } catch (err) {
      if ((err as { status?: number })?.status === 401) {
        await refreshAccessToken()
        token = await ensureValidToken()
        stream = makeClient(token).messages.stream(buildParams(), { signal })
      } else {
        throw err
      }
    }

    const assistantBlocks: Anthropic.ContentBlock[] = []
    const pendingToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

    // Accumulate tool_use input JSON deltas by content_block index.
    const toolInputJson = new Map<number, string>()
    const toolBlockMeta = new Map<number, { id: string; name: string }>()
    const textByIndex = new Map<number, string>()

    for await (const event of stream) {
      if (signal.aborted) break

      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          toolBlockMeta.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
          })
          toolInputJson.set(event.index, '')
        } else if (event.content_block.type === 'text') {
          textByIndex.set(event.index, '')
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          const cur = textByIndex.get(event.index) ?? ''
          textByIndex.set(event.index, cur + event.delta.text)
          fullText += event.delta.text
          yield { type: 'text', text: event.delta.text }
        } else if (event.delta.type === 'input_json_delta') {
          const cur = toolInputJson.get(event.index) ?? ''
          toolInputJson.set(event.index, cur + event.delta.partial_json)
        }
      } else if (event.type === 'content_block_stop') {
        const meta = toolBlockMeta.get(event.index)
        if (meta) {
          const raw = toolInputJson.get(event.index) ?? ''
          let input: Record<string, unknown> = {}
          try {
            input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
          } catch {
            input = { _raw: raw }
          }
          assistantBlocks.push({
            type: 'tool_use',
            id: meta.id,
            name: meta.name,
            input,
          } as Anthropic.ToolUseBlock)
          pendingToolUses.push({ id: meta.id, name: meta.name, input })
          toolInputJson.delete(event.index)
          toolBlockMeta.delete(event.index)
        } else if (textByIndex.has(event.index)) {
          const text = textByIndex.get(event.index) ?? ''
          assistantBlocks.push({ type: 'text', text, citations: [] } as Anthropic.TextBlock)
          textByIndex.delete(event.index)
        }
      }
    }

    // No tool calls → conversation complete.
    if (pendingToolUses.length === 0) break

    messages.push({ role: 'assistant', content: assistantBlocks })

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = []
    for (const use of pendingToolUses) {
      const tool = findTool(tools, use.name)
      yield { type: 'tool_use_start', toolName: use.name, input: use.input, id: use.id }
      const start = Date.now()
      let output = ''
      if (!tool) {
        output = `Error: tool "${use.name}" not registered on this agent.`
      } else {
        try {
          output = await tool.run(use.input, { signal })
        } catch (err) {
          output = `Tool "${use.name}" threw: ${(err as Error).message}`
        }
      }
      const durationMs = Date.now() - start
      yield { type: 'tool_use_result', id: use.id, toolName: use.name, output, durationMs }
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: output,
      })
    }

    messages.push({ role: 'user', content: toolResultBlocks })
  }

  yield { type: 'done', fullText, totalTurns: turn }
}
