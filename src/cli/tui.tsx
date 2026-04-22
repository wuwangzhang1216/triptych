/**
 * Interactive Ink-based TUI for triptych. Shape modeled on Claude Code:
 * welcome banner + transcript of past prompts/results + bordered input box
 * pinned at the bottom + slash commands.
 */

import React, { useEffect, useReducer, useRef, useState } from 'react'
import { Box, Static, Text, render, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'

import { Orchestrator, type ProgressEvent } from '../orchestrator/index.js'
import { ClaudeProvider } from '../providers/claude/index.js'
import { CodexProvider } from '../providers/codex/index.js'
import { OAIProvider } from '../providers/oai/index.js'
import type { JudgeStrategy, ProviderName } from '../types.js'
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
      <Text>    </Text>
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
        <Text>  </Text>
        <Text color={COLORS.accent} bold>{phase.id}</Text>
        <Text>  </Text>
        <Text dimColor>{PHASE_TITLE[phase.id]}</Text>
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
        <Text color={COLORS.accent}>› </Text>
        <Text>{debate.task}</Text>
      </Box>
      {debate.phases.map(p => <PhaseView key={p.id} phase={p} />)}
      {debate.error ? (
        <Box marginTop={1}>
          <Text color={COLORS.err}>  ×  {debate.error}</Text>
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

function Welcome({ session }: { session: SessionConfig }): JSX.Element {
  const claude = getClaudeTokens()
  const codex = getCodexTokens()
  const oaiKey = getOAIKey()
  const config = readConfig()

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Box>
        <Text>  </Text>
        <Text bold>triptych</Text>
        <Text dimColor>  0.2.0</Text>
        <Text>   </Text>
        {PROVIDER_ORDER.map((p, i) => (
          <React.Fragment key={p}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text color={providerHex(p)}>{p}</Text>
          </React.Fragment>
        ))}
        <Text dimColor>   judge: </Text>
        <Text color={COLORS.accent}>{session.judge}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text>    </Text>
          <Text color={claude ? COLORS.ok : COLORS.err}>{claude ? '✓' : '×'}</Text>
          <Text>  </Text>
          <Box width={8}><Text color={providerHex('claude')}>claude</Text></Box>
          <Text>  </Text>
          {claude ? (
            <Text dimColor>model {config.claude_model ?? 'claude-opus-4-7'}</Text>
          ) : (
            <Text dimColor>pj login claude</Text>
          )}
        </Box>
        <Box>
          <Text>    </Text>
          <Text color={codex ? COLORS.ok : COLORS.err}>{codex ? '✓' : '×'}</Text>
          <Text>  </Text>
          <Box width={8}><Text color={providerHex('codex')}>codex</Text></Box>
          <Text>  </Text>
          {codex ? (
            <>
              <Text dimColor>model {config.codex_model ?? 'gpt-5.4'}</Text>
              <Text dimColor>  ·  {codex.email}</Text>
            </>
          ) : (
            <Text dimColor>pj login codex</Text>
          )}
        </Box>
        <Box>
          <Text>    </Text>
          <Text color={oaiKey ? COLORS.ok : COLORS.err}>{oaiKey ? '✓' : '×'}</Text>
          <Text>  </Text>
          <Box width={8}><Text color={providerHex('oai')}>oai</Text></Box>
          <Text>  </Text>
          {oaiKey ? (
            <>
              <Text dimColor>model {getOAIModel()}</Text>
              <Text dimColor>  ·  {getOAIDisplayName()}</Text>
            </>
          ) : (
            <Text dimColor>pj config preset &lt;deepseek|kimi|glm|…&gt;</Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>  Type a task and press Enter. </Text>
        <Text color={COLORS.accent}>/help</Text>
        <Text dimColor> for commands. </Text>
        <Text color={COLORS.accent}>ctrl-c</Text>
        <Text dimColor> to cancel, </Text>
        <Text color={COLORS.accent}>ctrl-d</Text>
        <Text dimColor> or </Text>
        <Text color={COLORS.accent}>/exit</Text>
        <Text dimColor> to quit.</Text>
      </Box>
    </Box>
  )
}

// ── Input box ───────────────────────────────────────────────────────────────

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
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={disabled ? 'gray' : COLORS.accent} paddingX={1}>
        <Text color={disabled ? 'gray' : COLORS.accent}>› </Text>
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
  exit: () => void
}

function noteText(lines: React.ReactNode[]): React.ReactNode {
  return (
    <>
      {lines.map((line, i) => <Box key={i}>{line as any}</Box>)}
    </>
  )
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
      ctx.clearTranscript()
      return

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
    ['<task>',                   'run a three-model planning debate on the given task'],
    ['/help',                    'show this help'],
    ['/status',                  'provider authentication and config status'],
    ['/providers <csv>',         'set active providers for this session (e.g. claude,oai)'],
    ['/judge <strategy>',        'set judge: rotate | claude | codex | oai | vote'],
    ['/verbose [on|off]',        'toggle verbose mode'],
    ['/config show',             'print saved configuration (secrets redacted)'],
    ['/config set <k> <v>',      'persist a config value'],
    ['/config preset [name]',    'list presets, or apply an OpenAI-compatible endpoint preset'],
    ['/preset <name>',           'shortcut for /config preset <name>'],
    ['/clear',                   'clear the transcript'],
    ['/exit · /quit · ctrl-d',   'exit triptych'],
    ['ctrl-c',                   'cancel the current debate (keeps app running)'],
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
  const [session, setSession] = useState<SessionConfig>(defaultSession)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [input, setInput] = useState('')
  const [debate, dispatch] = useReducer(debateReducer, INITIAL_DEBATE)

  const acRef = useRef<AbortController | null>(null)
  const ctrlCPressedAt = useRef(0)

  const addEntry = (e: TranscriptEntry) => setTranscript(t => [...t, e])
  const clearTranscript = () => setTranscript([])

  useInput((inputChar, key) => {
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
    }
    if (key.ctrl && inputChar === 'd') {
      exit()
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
          message: `${p} is not authenticated — ${p === 'oai' ? '/preset <name> then /config set oai_api_key <key>' : `run \`pj login ${p}\` outside the TUI`}`,
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
      const result = await orchestrator.run({ task }, onProgress, ac.signal)
      dispatch({
        type: 'finish',
        finalPlan: result.rounds.r4_judgment.finalPlan,
        judge: result.rounds.r4_judgment.judge,
      })
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

  const onSubmit = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    setInput('')
    if (text.startsWith('/')) {
      addEntry({ id: nextId(), kind: 'prompt', text })
      handleCommand(text, {
        session,
        setSession,
        addEntry,
        clearTranscript,
        exit,
      })
      return
    }
    // Task submission
    // We don't add a transcript prompt entry here because the debate view
    // itself shows the active task; on completion we add a consolidated
    // debate entry.
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
    <Box flexDirection="column">
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

      <Box marginTop={1}>
        <InputBox
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          disabled={debate.running}
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
