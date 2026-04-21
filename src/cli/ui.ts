/**
 * Shared CLI UI primitives. Design stance: single accent color, grayscale
 * base, muted per-provider tints, no emoji, no box drawing, consistent
 * middot `·` separators. ANSI is gated behind IS_TTY so piped output and
 * NO_COLOR degrade cleanly.
 *
 * Palette draws from Catppuccin Mocha — muted enough to blend with terminal
 * grayscale, saturated enough to differentiate providers at a glance.
 */

import chalkDefault, { Chalk } from 'chalk'
import type { ProviderName } from '../types.js'

export const IS_TTY = process.stdout.isTTY === true && !process.env.NO_COLOR

const c = IS_TTY ? chalkDefault : new Chalk({ level: 0 })

// ── Terminal width ──────────────────────────────────────────────────────────

export function termWidth(cap = 84): number {
  const w = process.stdout.columns ?? 80
  return Math.min(Math.max(w, 40), cap)
}

/** Horizontal rule that respects terminal width (indented 2, capped at 84). */
export function hr(): string {
  return c.dim('─'.repeat(Math.max(0, termWidth() - 2)))
}

// ── Accent + grayscale ──────────────────────────────────────────────────────

export const accent  = (s: string) => c.hex('#89b4fa')(s)   // sky-blue (Catppuccin sky)
export const ok      = (s: string) => c.hex('#a6e3a1')(s)   // muted green (Catppuccin green)
export const warn    = (s: string) => c.hex('#f9e2af')(s)   // muted yellow
export const err     = (s: string) => c.hex('#f38ba8')(s)   // muted red (Catppuccin red)
export const dim     = (s: string) => c.dim(s)
export const bold    = (s: string) => c.bold(s)

// ── Provider palette (muted, per-provider hue) ─────────────────────────────

const PROVIDER_TINT: Record<ProviderName, (s: string) => string> = {
  claude: c.hex('#fab387'),   // peach
  codex:  c.hex('#a6e3a1'),   // green
  oai:    c.hex('#cba6f7'),   // mauve
}

export function tint(name: ProviderName, s: string): string {
  return (PROVIDER_TINT[name] ?? ((x: string) => x))(s)
}

const PROVIDER_LABEL: Record<ProviderName, string> = {
  claude: 'claude',
  codex:  'codex',
  oai:    'oai',
}

export function providerName(name: ProviderName): string {
  return PROVIDER_LABEL[name] ?? name
}

// ── Phase banner (lowercase, single accent) ─────────────────────────────────
//
// Format:  "  r0  task framing  · <tail dim>"
//
// Phase id is bold + accent; title is dim; tail (optional extra info) is dim
// with a middot leader.

const PHASE_TITLE: Record<string, string> = {
  r0: 'task framing',
  r1: 'independent plans',
  r2: 'cross-critique',
  r3: 'revision',
  r4: 'final judgment',
}

export function phaseBanner(phase: 'r0' | 'r1' | 'r2' | 'r3' | 'r4', tail?: string): string {
  const title = PHASE_TITLE[phase] ?? phase
  const head = `  ${accent(bold(phase))}  ${dim(title)}`
  return tail ? `${head}  ${dim('·')} ${dim(tail)}` : head
}

// ── Middot separator ───────────────────────────────────────────────────────

export const sep = dim(' · ')

// ── Elapsed / char formatting (fixed-width strings for column alignment) ────

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return `${m}m${rs.toString().padStart(2, '0')}s`
}

export function formatChars(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`
  return `${Math.round(n / 1000)}K`
}

// ── ANSI-aware alignment ────────────────────────────────────────────────────

const ANSI_RE = /\x1B\[[0-9;]*m/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export function displayWidth(s: string): number {
  return stripAnsi(s).length
}

export function padRight(s: string, width: number): string {
  const w = displayWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

export function padLeft(s: string, width: number): string {
  const w = displayWidth(s)
  return w >= width ? s : ' '.repeat(width - w) + s
}

// ── Markdown highlighter for the final plan ─────────────────────────────────
// Not a full renderer — we just color headings, bold, italics, inline code,
// and fenced code so the plan is skimmable in the terminal. Lists, tables,
// and links pass through as-is.

export function renderMarkdownForTerminal(md: string): string {
  if (!IS_TTY) return md
  const lines = md.split('\n')
  const out: string[] = []
  let inFence = false

  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence
      out.push(dim(line))
      continue
    }
    if (inFence) {
      out.push(c.hex('#94e2d5')(line))
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1]!.length
      if (level === 1)      out.push(c.bold.hex('#89b4fa')(line))
      else if (level === 2) out.push(c.bold.hex('#89dceb')(line))
      else if (level === 3) out.push(c.bold.hex('#cba6f7')(line))
      else                  out.push(c.bold(line))
      continue
    }

    let s = line
    s = s.replace(/`([^`]+)`/g, (_, g: string) => c.hex('#94e2d5')(`\`${g}\``))
    s = s.replace(/\*\*([^*]+)\*\*/g, (_, g: string) => c.bold(g))
    s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, (_, g: string) => c.italic(g))
    s = s.replace(/^(\s*)([-*+])\s/, (_m, pad: string, bullet: string) => `${pad}${dim(bullet)} `)
    s = s.replace(/^(\s*)(\d+)\.\s/, (_m, pad: string, num: string) => `${pad}${dim(num + '.')} `)
    out.push(s)
  }
  return out.join('\n')
}

// ── Cursor visibility ──────────────────────────────────────────────────────

export function hideCursor(): void { if (IS_TTY) process.stdout.write('\x1B[?25l') }
export function showCursor(): void { if (IS_TTY) process.stdout.write('\x1B[?25h') }

// ── Glyphs ─────────────────────────────────────────────────────────────────

export const GLYPH = {
  pending: dim('·'),
  check:   ok('✓'),
  fail:    err('×'),
  bullet:  dim('●'),
  rightArrow: dim('→'),
} as const
