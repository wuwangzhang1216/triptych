/**
 * Interactive Ink-based TUI for triptych. Shape modeled on Claude Code:
 * welcome banner + transcript of past prompts/results + bordered input box
 * pinned at the bottom + slash commands.
 */

import React, { useEffect, useReducer, useRef, useState } from 'react'
import { Box, Static, Text, render, useApp, useInput, useStdin, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import { spawn } from 'node:child_process'

import { Orchestrator, type ProgressEvent } from '../orchestrator/index.js'
import { ClaudeProvider } from '../providers/claude/index.js'
import { CodexProvider } from '../providers/codex/index.js'
import { OAIProvider } from '../providers/oai/index.js'
import type { ConversationTurn, JudgeStrategy, ProviderName } from '../types.js'
import {
  applyOAIPreset,
  findOAIPreset,
  getClaudeTokens,
  getCodexTokens,
  getOAIBaseUrl,
  getOAIDisplayName,
  getOAIKey,
  getOAIModel,
  OAI_PRESETS,
  readConfig,
  setConfigValue,
} from '../config.js'
import { renderMarkdownForTerminal } from './ui.js'

// ── Theme ───────────────────────────────────────────────────────────────────

const COLORS = {
  accent: '#89b4fa',
  ok:     '#a6e3a1',
  warn:   '#f9e2af',
  err:    '#f38ba8',
  claude: '#fab387',
  codex:  '#a6e3a1',
  oai:    '#cba6f7',
} as const

function providerHex(name: ProviderName): string {
  return COLORS[name]
}

const PROVIDER_ORDER: ProviderName[] = ['claude', 'codex', 'oai']

// ── Format helpers ──────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return `${m}m${rs.toString().padStart(2, '0')}s`
}

function formatChars(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`
  return `${Math.round(n / 1000)}K`
}

const PHASE_TITLE: Record<string, string> = {
  r0: 'task framing',
  r1: 'independent plans',
  r2: 'cross-critique',
  r3: 'revision',
  r4: 'final judgment',
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function useSpinnerFrame(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const iv = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 120)
    return () => clearInterval(iv)
  }, [active])
  return FRAMES[frame]!
}

/** Ticker that updates every 500ms, used to re-render elapsed time on running rows. */
function useElapsedTicker(active: boolean): number {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!active) return
    const iv = setInterval(() => setN(n => n + 1), 500)
    return () => clearInterval(iv)
  }, [active])
  return 0
}

// ── Row / phase / debate state ──────────────────────────────────────────────

type RowStatus = 'running' | 'done' | 'failed'

interface RowState {
  key: string
  label: React.ReactNode   // already-tinted label
  labelWidth: number       // raw char width for column alignment
  status: RowStatus
  startedAt: number
  finishedAt?: number
  chars: number
  message?: string
}

type PhaseId = 'r0' | 'r1' | 'r2' | 'r3' | 'r4'

interface PhaseState {
  id: PhaseId
  tail?: string            // optional extra info, e.g. "6 pairs" or "judge: codex"
  rows: RowState[]
  done: boolean
}

interface DebateState {
  running: boolean
  task: string
  phases: PhaseState[]
  finalPlan?: string
  judge?: ProviderName
  error?: string
  startedAt?: number
  finishedAt?: number
}

const INITIAL_DEBATE: DebateState = { running: false, task: '', phases: [] }

type DebateAction =
  | { type: 'start'; task: string }
  | { type: 'phase_start'; phase: Omit<PhaseState, 'done'> }
  | { type: 'row_add'; phaseId: PhaseId; row: RowState }
  | { type: 'row_chars'; phaseId: PhaseId; key: string; delta: number }
  | { type: 'row_done'; phaseId: PhaseId; key: string; finalChars: number }
  | { type: 'phase_done'; phaseId: PhaseId }
  | { type: 'finish'; finalPlan: string; judge: ProviderName }
  | { type: 'fail'; message: string }
  | { type: 'reset' }

function debateReducer(state: DebateState, action: DebateAction): DebateState {
  switch (action.type) {
    case 'start':
      return { running: true, task: action.task, phases: [], startedAt: Date.now() }

    case 'phase_start':
      return { ...state, phases: [...state.phases, { ...action.phase, done: false }] }

    case 'row_add':
      return {
        ...state,
        phases: state.phases.map(p =>
          p.id === action.phaseId ? { ...p, rows: [...p.rows, action.row] } : p,
        ),
      }

    case 'row_chars': {
      const phases = state.phases.map(p => {
        if (p.id !== action.phaseId) return p
        return {
          ...p,
          rows: p.rows.map(r =>
            r.key === action.key && r.status === 'running'
              ? { ...r, chars: r.chars + action.delta }
              : r,
          ),
        }
      })
      return { ...state, phases }
    }

    case 'row_done': {
      const phases = state.phases.map(p => {
        if (p.id !== action.phaseId) return p
        return {
          ...p,
          rows: p.rows.map(r =>
            r.key === action.key
              ? { ...r, status: 'done' as const, finishedAt: Date.now(), chars: action.finalChars }
              : r,
          ),
        }
      })
      return { ...state, phases }
    }

    case 'phase_done':
      return {
        ...state,
        phases: state.phases.map(p => (p.id === action.phaseId ? { ...p, done: true } : p)),
      }

    case 'finish':
      return {
        ...state,
        running: false,
        finalPlan: action.finalPlan,
        judge: action.judge,
        finishedAt: Date.now(),
      }

    case 'fail':
      return {
        ...state,
        running: false,
        error: action.message,
        finishedAt: Date.now(),
        phases: state.phases.map(p => ({
          ...p,
          rows: p.rows.map(r =>
            r.status === 'running'
              ? { ...r, status: 'failed' as const, finishedAt: Date.now(), message: action.message }
              : r,
          ),
        })),
      }

    case 'reset':
      return INITIAL_DEBATE
  }
}

// ── Transcript (past prompts + results) ─────────────────────────────────────

type TranscriptEntry =
  | { id: number; kind: 'prompt'; text: string }
  | { id: number; kind: 'note'; content: React.ReactNode }
  | {
      id: number
      kind: 'debate'
      task: string
      finalPlan: string
      judge: ProviderName
      durationMs: number
    }
  | { id: number; kind: 'error'; message: string }

// ── Row view ────────────────────────────────────────────────────────────────

function Row({ row }: { row: RowState }): JSX.Element {
  const spinner = useSpinnerFrame(row.status === 'running')
  useElapsedTicker(row.status === 'running')

  const elapsedMs = (row.finishedAt ?? Date.now()) - row.startedAt
  const elapsedStr = formatElapsed(elapsedMs)
  const charsStr = row.chars > 0 ? formatChars(row.chars) : ''

  let glyph: JSX.Element
  if (row.status === 'running')      glyph = <Text dimColor>{spinner}</Text>
  else if (row.status === 'done')    glyph = <Text color={COLORS.ok}>✓</Text>
  else                               glyph = <Text color={COLORS.err}>×</Text>

  return (
    <Box>
      <Text>  </Text>
      <Box width={3}>{glyph}</Box>
      <Box width={Math.max(14, row.labelWidth + 2)}>{row.label}</Box>
      <Box width={8} justifyContent="flex-end"><Text dimColor>{elapsedStr}</Text></Box>
      <Text>  </Text>
      <Box width={6} justifyContent="flex-end"><Text dimColor>{charsStr}</Text></Box>
      {row.message ? (
        <Text color={COLORS.err}>  {row.message}</Text>
      ) : null}
    </Box>
  )
}

// ── Phase view ──────────────────────────────────────────────────────────────

function PhaseView({ phase }: { phase: PhaseState }): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={COLORS.accent} bold>{phase.id}</Text>
        <Text>  </Text>
        <Text>{PHASE_TITLE[phase.id]}</Text>
        {phase.tail ? (
          <>
            <Text dimColor>  ·  </Text>
            <Text dimColor>{phase.tail}</Text>
          </>
        ) : null}
      </Box>
      {phase.rows.map(r => <Row key={r.key} row={r} />)}
    </Box>
  )
}

// ── DebateView (current in-flight debate) ───────────────────────────────────

function DebateView({ debate }: { debate: DebateState }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLORS.accent}>›</Text>
        <Text> </Text>
        <Text>{debate.task}</Text>
      </Box>
      {debate.phases.map(p => <PhaseView key={p.id} phase={p} />)}
      {debate.error ? (
        <Box marginTop={1}>
          <Text color={COLORS.err}>×</Text>
          <Text>  </Text>
          <Text color={COLORS.err}>{debate.error}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

// ── Transcript entry views ──────────────────────────────────────────────────

function PromptEntry({ text }: { text: string }): JSX.Element {
  return (
    <Box>
      <Text color={COLORS.accent}>› </Text>
      <Text>{text}</Text>
    </Box>
  )
}

function DebateEntry({ entry }: { entry: Extract<TranscriptEntry, { kind: 'debate' }> }): JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={COLORS.accent}>› </Text>
        <Text>{entry.task}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{renderMarkdownForTerminal(entry.finalPlan)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>  </Text>
        <Text dimColor>total </Text>
        <Text color={COLORS.accent}>{formatElapsed(entry.durationMs)}</Text>
        <Text dimColor>  ·  judge </Text>
        <Text color={providerHex(entry.judge)}>{entry.judge}</Text>
      </Box>
    </Box>
  )
}

function NoteEntry({ content }: { content: React.ReactNode }): JSX.Element {
  return <Box flexDirection="column" marginBottom={1}>{content as any}</Box>
}

function ErrorEntry({ message }: { message: string }): JSX.Element {
  return (
    <Box marginBottom={1}>
      <Text color={COLORS.err}>  ×  {message}</Text>
    </Box>
  )
}

function TranscriptItem({ entry }: { entry: TranscriptEntry }): JSX.Element {
  if (entry.kind === 'prompt') return <PromptEntry text={entry.text} />
  if (entry.kind === 'debate') return <DebateEntry entry={entry} />
  if (entry.kind === 'note')   return <NoteEntry content={entry.content} />
  return <ErrorEntry message={entry.message} />
}

// ── Welcome banner ──────────────────────────────────────────────────────────
//
// Claude-Code-style: a rounded border card with subtle accent, compact header,
// one provider row per line with tinted tag + model + auth state. No emoji,
// no mascot — the visual weight is carried by the frame itself.

function Welcome({ session }: { session: SessionConfig }): JSX.Element {
  const claude = getClaudeTokens()
  const codex = getCodexTokens()
  const oaiKey = getOAIKey()
  const config = readConfig()
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80
  // Cap at 88 cols so the card doesn't stretch absurdly on ultra-wide terms.
  const cardWidth = Math.min(cols - 2, 88)

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Title strip overlaid on the top edge of the bordered card: Claude-
          Code-style "╭─ triptych 0.2.0 ──────────────────────╮" look. Vanilla
          Ink doesn't support the `borderText` prop (that's a Claude Code
          fork), so we draw the top line ourselves with raw box-drawing glyphs
          and stitch it to a Box that renders only the sides and bottom. */}
      <Box width={cardWidth}>
        <Text dimColor>{'╭─ '}</Text>
        <Text bold color={COLORS.accent}>triptych</Text>
        <Text dimColor>{' 0.2.0 '}</Text>
        <Text dimColor>{'─'.repeat(Math.max(0, cardWidth - 'triptych'.length - ' 0.2.0 '.length - 5))}</Text>
        <Text dimColor>{'╮'}</Text>
      </Box>
      <Box
        borderStyle="round"
        borderColor={COLORS.accent}
        borderDimColor
        borderTop={false}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        width={cardWidth}
      >
        {/* Subtitle (was the right side of the old title row) */}
        <Box>
          <Text dimColor>three-model planning debate</Text>
        </Box>

        {/* Provider lineup */}
        <Box marginTop={1}>
          {PROVIDER_ORDER.map((p, i) => (
            <React.Fragment key={p}>
              {i > 0 ? <Text dimColor>  ·  </Text> : null}
              <Text color={providerHex(p)}>{p}</Text>
            </React.Fragment>
          ))}
          <Box flexGrow={1} />
          <Text dimColor>judge </Text>
          <Text color={COLORS.accent}>{session.judge}</Text>
        </Box>

        {/* Provider status rows */}
        <Box flexDirection="column" marginTop={1}>
          <ProviderRow
            name="claude"
            ok={claude !== null}
            detail={claude
              ? <Text dimColor>{config.claude_model ?? 'claude-opus-4-7'}</Text>
              : <Text dimColor>/login claude</Text>}
          />
          <ProviderRow
            name="codex"
            ok={codex !== null}
            detail={codex
              ? <><Text dimColor>{config.codex_model ?? 'gpt-5.4'}</Text><Text dimColor>  ·  </Text><Text dimColor>{codex.email}</Text></>
              : <Text dimColor>/login codex</Text>}
          />
          <ProviderRow
            name="oai"
            ok={oaiKey !== null}
            detail={oaiKey
              ? <><Text dimColor>{getOAIModel()}</Text><Text dimColor>  ·  </Text><Text dimColor>{getOAIDisplayName()}</Text></>
              : <Text dimColor>/preset {'<deepseek|kimi|glm|…>'}</Text>}
          />
        </Box>
      </Box>

      {/* Outside the card: minimal help hint, single dim line */}
      <Box marginTop={1} paddingX={1}>
        <Text dimColor>Type a task, or </Text>
        <Text color={COLORS.accent}>/help</Text>
        <Text dimColor> for commands. </Text>
        <Text color={COLORS.accent}>↑↓</Text>
        <Text dimColor> history · </Text>
        <Text color={COLORS.accent}>tab</Text>
        <Text dimColor> complete · </Text>
        <Text color={COLORS.accent}>ctrl-c</Text>
        <Text dimColor> cancel · </Text>
        <Text color={COLORS.accent}>ctrl-d</Text>
        <Text dimColor> exit</Text>
      </Box>
    </Box>
  )
}

function ProviderRow({
  name,
  ok,
  detail,
}: {
  name: ProviderName
  ok: boolean
  detail: React.ReactNode
}): JSX.Element {
  return (
    <Box>
      <Text color={ok ? COLORS.ok : COLORS.err}>{ok ? '✓' : '×'}</Text>
      <Text>  </Text>
      <Box width={8}><Text color={providerHex(name)}>{name}</Text></Box>
      <Text>  </Text>
      {detail as any}
    </Box>
  )
}

// ── Input box ───────────────────────────────────────────────────────────────

// ── Input box — Claude-Code-style (top+bottom horizontal rules only) ───────
//
// `borderStyle="round"` with `borderLeft={false} borderRight={false}` renders
// only the two horizontal rules that frame the prompt row. The `›` prompt
// glyph lives on the input line itself (not in the border, since vanilla
// Ink doesn't support border-embedded text).

function InputBox({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: (v: string) => void
  disabled: boolean
  placeholder?: string
}): JSX.Element {
  const color = disabled ? 'gray' : COLORS.accent
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80
  const width = Math.min(cols - 2, 88)
  return (
    <Box
      flexDirection="row"
      alignItems="flex-start"
      justifyContent="flex-start"
      borderStyle="round"
      borderColor={color}
      borderDimColor={disabled}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      width={width}
    >
      <Text color={color}>›</Text>
      <Text> </Text>
      <Box flexGrow={1}>
        {disabled ? (
          <Text dimColor>{placeholder ?? '(busy — ctrl-c to cancel)'}</Text>
        ) : (
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            placeholder={placeholder}
          />
        )}
      </Box>
    </Box>
  )
}

// ── Session config (in-memory, per-run overrides) ───────────────────────────

interface SessionConfig {
  providers: ProviderName[]
  judge: JudgeStrategy
  verbose: boolean
}

function defaultSession(): SessionConfig {
  const cfg = readConfig()
  const providers: ProviderName[] = []
  if (getClaudeTokens()) providers.push('claude')
  if (getCodexTokens()) providers.push('codex')
  if (getOAIKey()) providers.push('oai')
  return {
    providers: providers.length > 0 ? providers : ['claude', 'codex', 'oai'],
    judge: (cfg.default_judge ?? 'rotate') as JudgeStrategy,
    verbose: false,
  }
}

// ── Slash command handler ───────────────────────────────────────────────────

interface CommandContext {
  session: SessionConfig
  setSession: (s: SessionConfig) => void
  addEntry: (e: TranscriptEntry) => void
  clearTranscript: () => void
  clearConversation: () => void
  conversationLength: number
  requestLogin: (provider: 'claude' | 'codex') => void
  exit: () => void
}

function noteText(lines: React.ReactNode[]): React.ReactNode {
  return (
    <>
      {lines.map((line, i) => <Box key={i}>{line as any}</Box>)}
    </>
  )
}

// ── Tab-completion ──────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  'help', 'status', 'thread',
  'new', 'clear', 'reset',
  'login',
  'providers', 'judge', 'verbose',
  'config', 'preset',
  'exit', 'quit',
] as const

const CONFIG_SUBS = ['show', 'set', 'preset'] as const
const JUDGE_VALUES = ['rotate', 'claude', 'codex', 'oai', 'vote'] as const
const PROVIDER_VALUES = ['claude', 'codex', 'oai'] as const
const LOGIN_VALUES = ['claude', 'codex'] as const
const CONFIG_KEYS = [
  'oai_api_key', 'oai_base_url', 'oai_model',
  'oai_web_search', 'oai_agent', 'oai_display_name',
  'claude_model', 'claude_web_search', 'claude_agent',
  'codex_model', 'codex_web_search', 'codex_agent',
  'default_judge',
] as const

interface CompletionResult {
  /** If unique completion found, the full input to replace with. */
  match?: string
  /** If multiple candidates, the list to show. */
  suggestions?: string[]
}

/**
 * Expand a partial slash command to its best completion.
 *
 * Rules:
 * - Single word starting with `/`  → complete command name.
 * - `/config <partial>`            → complete subcommand (show | set | preset).
 * - `/config preset <partial>` or `/preset <partial>`  → complete preset name.
 * - `/config set <partial>`        → complete config key.
 * - `/judge <partial>`             → complete strategy.
 * - `/providers <partial>`        → complete the last comma-separated token.
 * - `/login <partial>`            → complete claude | codex.
 */
export function completeSlash(input: string): CompletionResult {
  if (!input.startsWith('/')) return {}
  const trailingSpace = /\s$/.test(input)
  const words = input.slice(1).trim().split(/\s+/).filter(Boolean)

  // First-word completion: user is still typing the command name.
  if (words.length <= 1 && !trailingSpace) {
    const partial = words[0] ?? ''
    return suggest(partial, [...SLASH_COMMANDS], p => `/${p}`, { space: true })
  }

  const head = words[0]

  if (head === 'config') {
    // /config <sub> ...
    if (words.length === 1 || (words.length === 2 && !trailingSpace)) {
      const partial = words[1] ?? ''
      return suggest(partial, [...CONFIG_SUBS], p => `/config ${p}`, { space: true })
    }
    const sub = words[1]
    if (sub === 'preset') {
      const partial = trailingSpace && words.length === 2 ? '' : (words[2] ?? '')
      return suggest(partial, OAI_PRESETS.map(p => p.name), p => `/config preset ${p}`)
    }
    if (sub === 'set') {
      const partial = trailingSpace && words.length === 2 ? '' : (words[2] ?? '')
      if (words.length <= 3) return suggest(partial, [...CONFIG_KEYS], p => `/config set ${p}`, { space: true })
    }
    return {}
  }

  if (head === 'preset') {
    const partial = trailingSpace && words.length === 1 ? '' : (words[1] ?? '')
    return suggest(partial, OAI_PRESETS.map(p => p.name), p => `/preset ${p}`)
  }

  if (head === 'judge') {
    const partial = trailingSpace && words.length === 1 ? '' : (words[1] ?? '')
    return suggest(partial, [...JUDGE_VALUES], p => `/judge ${p}`)
  }

  if (head === 'login') {
    const partial = trailingSpace && words.length === 1 ? '' : (words[1] ?? '')
    return suggest(partial, [...LOGIN_VALUES], p => `/login ${p}`)
  }

  if (head === 'providers') {
    // Comma-separated. Complete just the last comma-token.
    const rest = words.slice(1).join(' ') + (trailingSpace ? ' ' : '')
    const parts = rest.split(',')
    const last = (parts[parts.length - 1] ?? '').trimStart()
    return suggest(
      last,
      [...PROVIDER_VALUES],
      p => `/providers ${parts.slice(0, -1).concat([p]).join(',')}`,
    )
  }

  return {}
}

/**
 * Three-way result:
 * - unique completion  → `{ match: <full line> }`
 * - LCP-extensible     → `{ match: <full line with LCP>, suggestions: […candidates] }`
 * - ambiguous at LCP   → `{ suggestions: […candidates] }`
 *
 * `opts.space` means "append a trailing space on a UNIQUE completion"
 * (because another argument is expected). The LCP extension never gets
 * a trailing space — you're still completing the same token.
 */
function suggest(
  partial: string,
  pool: string[],
  build: (candidate: string) => string,
  opts: { space?: boolean } = {},
): CompletionResult {
  const matches = pool.filter(p => p.startsWith(partial))
  if (matches.length === 0) return {}
  if (matches.length === 1) {
    const full = build(matches[0]!)
    return { match: opts.space ? full + ' ' : full }
  }
  const lcp = longestCommonPrefix(matches)
  if (lcp.length > partial.length) return { match: build(lcp), suggestions: matches }
  return { suggestions: matches }
}

function longestCommonPrefix(xs: string[]): string {
  if (xs.length === 0) return ''
  let prefix = xs[0]!
  for (const s of xs.slice(1)) {
    let i = 0
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) break
  }
  return prefix
}

function handleCommand(raw: string, ctx: CommandContext): void {
  const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ')

  switch (cmd) {
    case 'help':
    case '?':
      ctx.addEntry({
        id: Date.now(),
        kind: 'note',
        content: <HelpView />,
      })
      return

    case 'status':
      ctx.addEntry({
        id: Date.now(),
        kind: 'note',
        content: <StatusView session={ctx.session} />,
      })
      return

    case 'providers': {
      if (!arg) {
        ctx.addEntry({
          id: Date.now(),
          kind: 'note',
          content: <Text dimColor>  current providers: {ctx.session.providers.join(', ')}</Text>,
        })
        return
      }
      const list = arg.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) as ProviderName[]
      const invalid = list.filter(p => !['claude', 'codex', 'oai'].includes(p))
      if (invalid.length > 0) {
        ctx.addEntry({ id: Date.now(), kind: 'error', message: `unknown provider(s): ${invalid.join(', ')}` })
        return
      }
      ctx.setSession({ ...ctx.session, providers: list })
      ctx.addEntry({
        id: Date.now(),
        kind: 'note',
        content: <Text>  <Text color={COLORS.ok}>✓</Text>  providers set to <Text color={COLORS.accent}>{list.join(', ')}</Text></Text>,
      })
      return
    }

    case 'judge': {
      if (!arg) {
        ctx.addEntry({
          id: Date.now(),
          kind: 'note',
          content: <Text dimColor>  current judge: {ctx.session.judge}</Text>,
        })
        return
      }
      const allowed = ['rotate', 'claude', 'codex', 'oai', 'openrouter', 'vote']
      if (!allowed.includes(arg)) {
        ctx.addEntry({ id: Date.now(), kind: 'error', message: `unknown judge strategy: ${arg} (allowed: ${allowed.join(', ')})` })
        return
      }
      const normalized: JudgeStrategy = (arg === 'openrouter' ? 'oai' : arg) as JudgeStrategy
      ctx.setSession({ ...ctx.session, judge: normalized })
      ctx.addEntry({
        id: Date.now(),
        kind: 'note',
        content: <Text>  <Text color={COLORS.ok}>✓</Text>  judge set to <Text color={COLORS.accent}>{normalized}</Text></Text>,
      })
      return
    }

    case 'verbose': {
      const next = arg === 'off' ? false : arg === 'on' ? true : !ctx.session.verbose
      ctx.setSession({ ...ctx.session, verbose: next })
      ctx.addEntry({
        id: Date.now(),
        kind: 'note',
        content: <Text>  <Text color={COLORS.ok}>✓</Text>  verbose {next ? 'on' : 'off'}</Text>,
      })
      return
    }

    case 'config': {
      const [sub, ...subRest] = rest
      if (sub === 'show' || !sub) {
        ctx.addEntry({ id: Date.now(), kind: 'note', content: <ConfigShowView /> })
        return
      }
      if (sub === 'set') {
        const [k, ...vParts] = subRest
        const v = vParts.join(' ')
        if (!k || !v) {
          ctx.addEntry({ id: Date.now(), kind: 'error', message: 'usage: /config set <key> <value>' })
          return
        }
        try {
          const boolKeys = new Set(['oai_web_search', 'oai_agent', 'openrouter_web_search', 'openrouter_agent', 'claude_web_search', 'claude_agent', 'codex_web_search', 'codex_agent'])
          const value: unknown = boolKeys.has(k) ? (v === 'true' || v === '1') : v
          setConfigValue(k as any, value as any)
          ctx.addEntry({
            id: Date.now(),
            kind: 'note',
            content: <Text>  <Text color={COLORS.ok}>✓</Text>  set <Text bold>{k}</Text></Text>,
          })
        } catch (e) {
          ctx.addEntry({ id: Date.now(), kind: 'error', message: (e as Error).message })
        }
        return
      }
      if (sub === 'preset') {
        if (subRest.length === 0) {
          ctx.addEntry({ id: Date.now(), kind: 'note', content: <PresetListView /> })
          return
        }
        const [presetName] = subRest
        try {
          const preset = applyOAIPreset(presetName!)
          ctx.addEntry({
            id: Date.now(),
            kind: 'note',
            content: (
              <>
                <Box><Text>  <Text color={COLORS.ok}>✓</Text>  applied <Text bold>{preset.name}</Text>  <Text dimColor>{preset.display_name}</Text></Text></Box>
                <Box><Text dimColor>    base_url  {preset.base_url}</Text></Box>
                <Box><Text dimColor>    model     {preset.default_model}</Text></Box>
                {!getOAIKey() ? <Box marginTop={1}><Text dimColor>    next: /config set oai_api_key &lt;key&gt;</Text></Box> : null}
              </>
            ),
          })
        } catch (e) {
          ctx.addEntry({ id: Date.now(), kind: 'error', message: (e as Error).message })
        }
        return
      }
      ctx.addEntry({ id: Date.now(), kind: 'error', message: `unknown /config subcommand: ${sub}` })
      return
    }

    case 'preset': {
      // shortcut: /preset <name>
      if (!arg) {
        ctx.addEntry({ id: Date.now(), kind: 'note', content: <PresetListView /> })
        return
      }
      try {
        const preset = applyOAIPreset(arg)
        ctx.addEntry({
          id: Date.now(),
          kind: 'note',
          content: (
            <>
              <Box><Text>  <Text color={COLORS.ok}>✓</Text>  applied <Text bold>{preset.name}</Text>  <Text dimColor>{preset.display_name}</Text></Text></Box>
              <Box><Text dimColor>    model  {preset.default_model}</Text></Box>
            </>
          ),
        })
      } catch (e) {
        ctx.addEntry({ id: Date.now(), kind: 'error', message: (e as Error).message })
      }
      return
    }

    case 'clear':
    case 'new':
    case 'reset':
      // Synonymous: clear both the visible transcript and the semantic
      // conversation thread, so the next task starts with a clean slate.
      ctx.clearTranscript()
      ctx.clearConversation()
      return

    case 'thread': {
      const n = ctx.conversationLength
      ctx.addEntry({
        id: Date.now(),
        kind: 'note',
        content: (
          <Text dimColor>
            {'  thread: '}
            <Text color={COLORS.accent}>{n}</Text>
            {n === 1 ? ' prior turn' : ' prior turns'}
            {n > 0 ? '  ·  /new to reset' : ''}
          </Text>
        ),
      })
      return
    }

    case 'login': {
      if (!arg) {
        ctx.addEntry({ id: Date.now(), kind: 'error', message: 'usage: /login claude | /login codex' })
        return
      }
      if (arg !== 'claude' && arg !== 'codex') {
        ctx.addEntry({ id: Date.now(), kind: 'error', message: `only claude and codex use OAuth. For oai, use /preset <name> then /config set oai_api_key <key>` })
        return
      }
      ctx.requestLogin(arg)
      return
    }

    case 'exit':
    case 'quit':
    case 'q':
      ctx.exit()
      return

    default:
      ctx.addEntry({
        id: Date.now(),
        kind: 'error',
        message: `unknown command: /${cmd}  (try /help)`,
      })
  }
}

// ── Help / Status / Config / Preset views ──────────────────────────────────

function HelpView(): JSX.Element {
  const cmds: Array<[string, string]> = [
    ['<task>',                   'run a debate — follow-ups thread the prior plan as context'],
    ['/help',                    'show this help'],
    ['/status',                  'provider authentication and config status'],
    ['/thread',                  'show how many prior turns are threaded as context'],
    ['/new · /clear · /reset',   'start a fresh conversation thread and clear the transcript'],
    ['/login <provider>',        'run OAuth for claude or codex without leaving the TUI'],
    ['/providers <csv>',         'set active providers for this session (e.g. claude,oai)'],
    ['/judge <strategy>',        'set judge: rotate | claude | codex | oai | vote'],
    ['/verbose [on|off]',        'toggle verbose mode'],
    ['/config show',             'print saved configuration (secrets redacted)'],
    ['/config set <k> <v>',      'persist a config value'],
    ['/config preset [name]',    'list presets, or apply an OpenAI-compatible endpoint preset'],
    ['/preset <name>',           'shortcut for /config preset <name>'],
    ['/exit · /quit · ctrl-d',   'exit triptych'],
    ['ctrl-c',                   'cancel the current debate (keeps app running)'],
    ['↑ · ↓',                    'browse prompt history'],
    ['tab',                      'complete slash commands / preset names / judge / provider'],
  ]
  const w = Math.max(...cmds.map(([c]) => c.length))
  return (
    <Box flexDirection="column">
      <Box><Text>  </Text><Text bold>commands</Text></Box>
      {cmds.map(([c, d], i) => (
        <Box key={i}>
          <Text>    </Text>
          <Box width={w + 2}><Text color={COLORS.accent}>{c}</Text></Box>
          <Text dimColor>{d}</Text>
        </Box>
      ))}
    </Box>
  )
}

function StatusView({ session }: { session: SessionConfig }): JSX.Element {
  const claude = getClaudeTokens()
  const codex = getCodexTokens()
  const oaiKey = getOAIKey()
  const config = readConfig()
  return (
    <Box flexDirection="column">
      <Box>
        <Text>    </Text>
        <Text color={claude ? COLORS.ok : COLORS.err}>{claude ? '✓' : '×'}</Text>
        <Text>  </Text>
        <Box width={8}><Text color={providerHex('claude')}>claude</Text></Box>
        <Text>  </Text>
        <Text dimColor>{claude ? `model ${config.claude_model ?? 'claude-opus-4-7'}` : 'pj login claude'}</Text>
      </Box>
      <Box>
        <Text>    </Text>
        <Text color={codex ? COLORS.ok : COLORS.err}>{codex ? '✓' : '×'}</Text>
        <Text>  </Text>
        <Box width={8}><Text color={providerHex('codex')}>codex</Text></Box>
        <Text>  </Text>
        <Text dimColor>{codex ? `model ${config.codex_model ?? 'gpt-5.4'} · ${codex.email}` : 'pj login codex'}</Text>
      </Box>
      <Box>
        <Text>    </Text>
        <Text color={oaiKey ? COLORS.ok : COLORS.err}>{oaiKey ? '✓' : '×'}</Text>
        <Text>  </Text>
        <Box width={8}><Text color={providerHex('oai')}>oai</Text></Box>
        <Text>  </Text>
        <Text dimColor>{oaiKey ? `model ${getOAIModel()} · ${getOAIDisplayName()}` : '/preset <deepseek|kimi|glm|…>'}</Text>
      </Box>
      {oaiKey ? (
        <Box><Text>{'              '}</Text><Text dimColor>endpoint {getOAIBaseUrl()}</Text></Box>
      ) : null}
      <Box marginTop={1}>
        <Text>  </Text>
        <Text dimColor>session  providers </Text>
        <Text color={COLORS.accent}>{session.providers.join(', ')}</Text>
        <Text dimColor>  ·  judge </Text>
        <Text color={COLORS.accent}>{session.judge}</Text>
        {session.verbose ? <Text dimColor>  ·  verbose</Text> : null}
      </Box>
    </Box>
  )
}

function ConfigShowView(): JSX.Element {
  const config = readConfig()
  const safe: Record<string, unknown> = {
    ...config,
    claude_access_token: config.claude_access_token ? '[set]' : undefined,
    claude_refresh_token: config.claude_refresh_token ? '[set]' : undefined,
    codex_access_token: config.codex_access_token ? '[set]' : undefined,
    codex_refresh_token: config.codex_refresh_token ? '[set]' : undefined,
    oai_api_key: config.oai_api_key ? '[set]' : undefined,
    openrouter_api_key: config.openrouter_api_key ? '[set]' : undefined,
  }
  const rows = Object.entries(safe).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
  const keyW = Math.min(30, Math.max(14, ...rows.map(([k]) => k.length)) + 2)
  return (
    <Box flexDirection="column">
      <Box><Text>  </Text><Text bold>config</Text><Text dimColor>  ~/.triptych/config.json</Text></Box>
      {rows.map(([k, v]) => (
        <Box key={k}>
          <Text>  </Text>
          <Box width={keyW}><Text dimColor>{k}</Text></Box>
          <Text color={typeof v === 'boolean' ? (v ? COLORS.ok : COLORS.err) : typeof v === 'number' ? COLORS.warn : undefined}>
            {typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function PresetListView(): JSX.Element {
  const nameW = Math.max(12, ...OAI_PRESETS.map(p => p.name.length))
  const labelW = Math.max(18, ...OAI_PRESETS.map(p => p.display_name.length))
  return (
    <Box flexDirection="column">
      <Box><Text>  </Text><Text bold>presets</Text><Text dimColor>  /preset &lt;name&gt;</Text></Box>
      {OAI_PRESETS.map(p => (
        <Box key={p.name}>
          <Text>  </Text>
          <Box width={nameW + 2}><Text color={COLORS.accent}>{p.name}</Text></Box>
          <Box width={labelW + 2}><Text>{p.display_name}</Text></Box>
          <Text dimColor>{p.default_model}</Text>
        </Box>
      ))}
    </Box>
  )
}

// ── Main App ────────────────────────────────────────────────────────────────

function nextId(): number {
  nextId.counter = (nextId.counter ?? 0) + 1
  return nextId.counter
}
namespace nextId { export let counter = 0 }

function App(): JSX.Element {
  const { exit } = useApp()
  const { setRawMode } = useStdin()
  const [session, setSession] = useState<SessionConfig>(defaultSession)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [input, setInput] = useState('')
  const [debate, dispatch] = useReducer(debateReducer, INITIAL_DEBATE)

  // Conversation thread — each accepted turn feeds into the next debate's
  // R0/R1/R3/R4 prompts so follow-ups build on prior plans.
  const [conversation, setConversation] = useState<ConversationTurn[]>([])

  // Command history with up/down arrow navigation.
  const [history, setHistory] = useState<string[]>([])
  const historyIdx = useRef<number | null>(null)
  const draft = useRef('')

  // True while a spawned child (/login) owns stdio and Ink is suspended.
  const [suspended, setSuspended] = useState(false)

  const acRef = useRef<AbortController | null>(null)
  const ctrlCPressedAt = useRef(0)

  const addEntry = (e: TranscriptEntry) => setTranscript(t => [...t, e])
  const clearTranscript = () => setTranscript([])
  const clearConversation = () => setConversation([])

  useInput((inputChar, key) => {
    if (suspended) return

    if (key.ctrl && inputChar === 'c') {
      if (debate.running && acRef.current) {
        acRef.current.abort()
        ctrlCPressedAt.current = 0
      } else {
        // double-ctrl-c within 1.5s to exit
        const now = Date.now()
        if (now - ctrlCPressedAt.current < 1500) {
          exit()
        } else {
          ctrlCPressedAt.current = now
          addEntry({
            id: nextId(),
            kind: 'note',
            content: <Text dimColor>  (ctrl-c again to exit, or type /exit)</Text>,
          })
        }
      }
      return
    }
    if (key.ctrl && inputChar === 'd') {
      exit()
      return
    }

    // History navigation — only while idle and when there's something to browse.
    if (debate.running) return
    if (key.upArrow) {
      if (history.length === 0) return
      if (historyIdx.current === null) {
        draft.current = input
        historyIdx.current = history.length - 1
      } else if (historyIdx.current > 0) {
        historyIdx.current -= 1
      }
      setInput(history[historyIdx.current]!)
      return
    }
    if (key.downArrow) {
      if (historyIdx.current === null) return
      if (historyIdx.current < history.length - 1) {
        historyIdx.current += 1
        setInput(history[historyIdx.current]!)
      } else {
        historyIdx.current = null
        setInput(draft.current)
      }
      return
    }

    // Tab completion — slash-prefixed input only (plain task text passes through).
    if (key.tab) {
      if (!input.startsWith('/')) return
      const result = completeSlash(input)
      // Fill the input with the longest unambiguous completion (unique or LCP).
      if (result.match !== undefined && result.match !== input) {
        setInput(result.match)
        historyIdx.current = null
      }
      // Show candidates whenever more than one is possible — even when we also
      // advanced the input, so the user sees what the remaining choices are.
      if (result.suggestions && result.suggestions.length > 1) {
        addEntry({
          id: nextId(),
          kind: 'note',
          content: (
            <Box>
              <Text>  </Text>
              {result.suggestions.map((s, i) => (
                <React.Fragment key={i}>
                  {i > 0 ? <Text dimColor>  ·  </Text> : null}
                  <Text color={COLORS.accent}>{s}</Text>
                </React.Fragment>
              ))}
            </Box>
          ),
        })
      }
      return
    }

    // Any keystroke other than up/down/tab abandons history browsing so the
    // next up/down starts from a fresh "current draft" anchor.
    if (historyIdx.current !== null && (inputChar || key.return || key.backspace || key.delete)) {
      historyIdx.current = null
    }
  })

  async function runDebate(task: string): Promise<void> {
    if (session.providers.length === 0) {
      addEntry({ id: nextId(), kind: 'error', message: 'no providers active — /providers claude,codex,oai' })
      return
    }

    // Pre-flight auth check
    const providerMap: Record<ProviderName, () => Promise<boolean>> = {
      claude: async () => getClaudeTokens() !== null,
      codex:  async () => getCodexTokens() !== null,
      oai:    async () => getOAIKey() !== null,
    }
    for (const p of session.providers) {
      if (!(await providerMap[p]())) {
        addEntry({
          id: nextId(),
          kind: 'error',
          message: `${p} is not authenticated — ${p === 'oai' ? '/preset <name> then /config set oai_api_key <key>' : `/login ${p}`}`,
        })
        return
      }
    }

    const ac = new AbortController()
    acRef.current = ac

    dispatch({ type: 'start', task })

    const allProviders = [new ClaudeProvider(), new CodexProvider(), new OAIProvider()]
    const orchestrator = new Orchestrator(allProviders, {
      providers: session.providers,
      judge: session.judge,
      verbose: session.verbose,
    })

    // Snapshot conversation state at submit time; new turns get appended on
    // successful completion.
    const convoAtStart = conversation

    const onProgress = (event: ProgressEvent) => {
      switch (event.phase) {
        case 'r0_start':
        case 'r1_start':
        case 'r3_start':
          dispatch({
            type: 'phase_start',
            phase: {
              id: event.phase.slice(0, 2) as PhaseId,
              rows: event.providers.map(p => ({
                key: p,
                label: <Text color={providerHex(p)}>{p}</Text>,
                labelWidth: p.length,
                status: 'running' as const,
                startedAt: Date.now(),
                chars: 0,
              })),
            },
          })
          break

        case 'r0_stream':
        case 'r1_stream':
        case 'r3_stream': {
          const pid = event.phase.slice(0, 2) as PhaseId
          if (event.chunk.type === 'text') {
            dispatch({ type: 'row_chars', phaseId: pid, key: event.provider, delta: event.chunk.text.length })
          } else if (event.chunk.type === 'done') {
            dispatch({ type: 'row_done', phaseId: pid, key: event.provider, finalChars: event.chunk.fullText.length })
          }
          break
        }

        case 'r0_done':
        case 'r1_done':
        case 'r3_done':
          dispatch({ type: 'phase_done', phaseId: event.phase.slice(0, 2) as PhaseId })
          break

        case 'r2_start':
          dispatch({
            type: 'phase_start',
            phase: {
              id: 'r2',
              tail: `${event.pairs.length} pairs`,
              rows: event.pairs.map(({ reviewer, target }) => ({
                key: `${reviewer}→${target}`,
                label: (
                  <>
                    <Text color={providerHex(reviewer)}>{reviewer}</Text>
                    <Text dimColor> → </Text>
                    <Text color={providerHex(target)}>{target}</Text>
                  </>
                ),
                labelWidth: reviewer.length + 3 + target.length,
                status: 'running' as const,
                startedAt: Date.now(),
                chars: 0,
              })),
            },
          })
          break

        case 'r2_stream': {
          const key = `${event.reviewer}→${event.target}`
          if (event.chunk.type === 'text') {
            dispatch({ type: 'row_chars', phaseId: 'r2', key, delta: event.chunk.text.length })
          } else if (event.chunk.type === 'done') {
            dispatch({ type: 'row_done', phaseId: 'r2', key, finalChars: event.chunk.fullText.length })
          }
          break
        }

        case 'r2_done':
          dispatch({ type: 'phase_done', phaseId: 'r2' })
          break

        case 'r4_start':
          dispatch({
            type: 'phase_start',
            phase: {
              id: 'r4',
              tail: `judge: ${event.judge}`,
              rows: [{
                key: 'judge',
                label: <Text color={providerHex(event.judge)}>{event.judge}</Text>,
                labelWidth: event.judge.length,
                status: 'running' as const,
                startedAt: Date.now(),
                chars: 0,
              }],
            },
          })
          break

        case 'r4_stream':
          if (event.chunk.type === 'text') {
            dispatch({ type: 'row_chars', phaseId: 'r4', key: 'judge', delta: event.chunk.text.length })
          } else if (event.chunk.type === 'done') {
            dispatch({ type: 'row_done', phaseId: 'r4', key: 'judge', finalChars: event.chunk.fullText.length })
          }
          break

        case 'r4_done':
          dispatch({ type: 'phase_done', phaseId: 'r4' })
          break
      }
    }

    try {
      const result = await orchestrator.run(
        { task, conversation: convoAtStart.length > 0 ? convoAtStart : undefined },
        onProgress,
        ac.signal,
      )
      dispatch({
        type: 'finish',
        finalPlan: result.rounds.r4_judgment.finalPlan,
        judge: result.rounds.r4_judgment.judge,
      })
      // Append this (task, finalPlan) to the conversation thread so the next
      // debate sees it as prior context.
      setConversation(prev => [...prev, { userTask: task, finalPlan: result.rounds.r4_judgment.finalPlan }])
      // Move the finished debate into the transcript as a single entry.
      addEntry({
        id: nextId(),
        kind: 'debate',
        task,
        finalPlan: result.rounds.r4_judgment.finalPlan,
        judge: result.rounds.r4_judgment.judge,
        durationMs: result.totalDurationMs,
      })
      dispatch({ type: 'reset' })
    } catch (e) {
      const msg = (e as Error).message || 'debate failed'
      dispatch({ type: 'fail', message: msg })
      // Move the failed debate into the transcript so it scrolls out of the way.
      addEntry({ id: nextId(), kind: 'prompt', text: task })
      addEntry({ id: nextId(), kind: 'error', message: msg })
      dispatch({ type: 'reset' })
    } finally {
      acRef.current = null
    }
  }

  /**
   * Suspend Ink (release raw mode, stop re-rendering), spawn `pj login
   * <provider>` inheriting the parent terminal so the OAuth URL is visible
   * and the callback listener can bind :1618 / :8976 without fighting Ink
   * for stdin. Resume Ink after the child exits.
   */
  function runLogin(provider: 'claude' | 'codex'): void {
    if (suspended) return
    setSuspended(true)

    // Release raw mode so the child can treat the terminal as a normal tty.
    try { setRawMode(false) } catch { /* some test terms reject this */ }

    // A tiny header so the user sees where the OAuth output starts. Written
    // after Ink's last frame for this state; Ink will redraw a full frame on
    // resume, pushing this into scrollback.
    process.stdout.write(`\n  launching ${provider} oauth (browser)…\n\n`)

    const child = spawn(
      process.argv[0] ?? 'bun',
      [process.argv[1] ?? 'src/cli.ts', 'login', provider],
      { stdio: 'inherit' },
    )

    child.on('exit', (code) => {
      try { setRawMode(true) } catch { /* see above */ }
      setSuspended(false)
      if (code === 0) {
        addEntry({
          id: nextId(),
          kind: 'note',
          content: (
            <Text>
              {'  '}<Text color={COLORS.ok}>✓</Text>{`  ${provider} authenticated`}
            </Text>
          ),
        })
      } else {
        addEntry({
          id: nextId(),
          kind: 'error',
          message: `${provider} login exited with code ${code}`,
        })
      }
    })
    child.on('error', (e) => {
      try { setRawMode(true) } catch { /* see above */ }
      setSuspended(false)
      addEntry({ id: nextId(), kind: 'error', message: `login spawn failed: ${e.message}` })
    })
  }

  const onSubmit = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    setInput('')
    historyIdx.current = null

    // Push to history (skip consecutive duplicates).
    setHistory(h => (h[h.length - 1] === text ? h : [...h, text]))

    if (text.startsWith('/')) {
      addEntry({ id: nextId(), kind: 'prompt', text })
      handleCommand(text, {
        session,
        setSession,
        addEntry,
        clearTranscript,
        clearConversation,
        conversationLength: conversation.length,
        requestLogin: runLogin,
        exit,
      })
      return
    }
    // Task submission: the debate view already shows the active task, and
    // on completion we add a consolidated debate entry — no separate prompt
    // transcript entry here.
    void runDebate(text)
  }

  // Build items for Ink's <Static> (rendered once, never re-rendered). First
  // item is the welcome banner; subsequent items are transcript entries.
  type StaticItem =
    | { tag: 'welcome' }
    | { tag: 'entry'; entry: TranscriptEntry }
  const staticItems: StaticItem[] = [
    { tag: 'welcome' },
    ...transcript.map(e => ({ tag: 'entry' as const, entry: e })),
  ]

  return (
    <Box flexDirection="column" paddingX={1}>
      <Static items={staticItems}>
        {(item, idx) => (
          <Box key={idx} flexDirection="column">
            {item.tag === 'welcome' ? (
              <Welcome session={session} />
            ) : (
              <TranscriptItem entry={item.entry} />
            )}
          </Box>
        )}
      </Static>

      {debate.running || debate.error ? (
        <Box flexDirection="column" marginTop={1}>
          <DebateView debate={debate} />
        </Box>
      ) : null}

      {conversation.length > 0 && !debate.running && !debate.error ? (
        <Box marginTop={1}>
          <Text dimColor>thread · </Text>
          <Text color={COLORS.accent}>{conversation.length}</Text>
          <Text dimColor>{conversation.length === 1 ? ' prior turn' : ' prior turns'}  ·  </Text>
          <Text color={COLORS.accent}>/new</Text>
          <Text dimColor> to reset</Text>
        </Box>
      ) : null}

      {suspended ? (
        <Box marginTop={1}>
          <Text dimColor>oauth running — TUI resumes on child exit</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <InputBox
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          disabled={debate.running || suspended}
          placeholder={debate.running ? '(running — ctrl-c to cancel)' : 'type a task or /help'}
        />
      </Box>
    </Box>
  )
}

// ── Entry point ────────────────────────────────────────────────────────────

export function startTUI(): void {
  render(<App />)
}
