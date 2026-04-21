#!/usr/bin/env bun
/**
 * Smoke test the Claude agent loop against a task that requires filesystem tools.
 * Usage: bun src/agent/test-smoke.ts
 */

import { runClaudeAgent } from './claude.js'
import { DEFAULT_TOOLS } from './tools.js'

const ac = new AbortController()
process.on('SIGINT', () => ac.abort())

const systemPrompt = `You are a code investigator. Use the provided tools (read, grep, glob, web_fetch) to answer questions about a local codebase.

Respond with concrete file paths and line numbers. Do not make up code that you have not read.`

const userMessage = `在目录 /Users/wangzhangwu/work/planing-judeger/src 下：
1. 用 glob 找到所有 provider 的 index.ts 文件
2. 用 grep 找出哪个文件使用了 "@anthropic-ai/sdk"
3. 读那个文件开头 20 行，告诉我它怎么构造 Anthropic 客户端

请依次执行，每步用合适的工具。`

console.log('--- Starting Claude agent ---\n')

let toolCalls = 0
for await (const event of runClaudeAgent({
  systemPrompt,
  userMessage,
  tools: DEFAULT_TOOLS,
  signal: ac.signal,
  maxTurns: 10,
  maxTokens: 4096,
})) {
  if (event.type === 'text') {
    process.stdout.write(event.text)
  } else if (event.type === 'turn_start') {
    process.stdout.write(`\n\n[--- Turn ${event.turn} ---]\n`)
  } else if (event.type === 'tool_use_start') {
    toolCalls++
    process.stdout.write(`\n\n🔧 Tool ${toolCalls}: ${event.toolName}(${JSON.stringify(event.input)})\n`)
  } else if (event.type === 'tool_use_result') {
    const preview = event.output.slice(0, 300).replace(/\n/g, ' | ')
    process.stdout.write(`   → (${event.durationMs}ms) ${preview}${event.output.length > 300 ? '...' : ''}\n\n`)
  } else if (event.type === 'done') {
    process.stdout.write(`\n\n--- Done. ${event.totalTurns} turns, ${toolCalls} tool calls, ${event.fullText.length} chars ---\n`)
  }
}
