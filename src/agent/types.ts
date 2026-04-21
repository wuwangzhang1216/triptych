/**
 * Agent loop event types — a superset of the simple StreamChunk used for pure LLM
 * calls. An agent turn can emit multiple rounds of tool-use; each round produces
 * tool_use and tool_result events interleaved with text.
 */

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use_start'; toolName: string; input: Record<string, unknown>; id: string }
  | { type: 'tool_use_result'; id: string; toolName: string; output: string; durationMs: number }
  | { type: 'turn_start'; turn: number }
  | { type: 'done'; fullText: string; totalTurns: number }
