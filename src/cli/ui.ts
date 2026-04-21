/**
 * Shared CLI UI primitives: colors, provider tags, phase banners, simple
 * markdown-in-terminal rendering. All ANSI is gated behind `IS_TTY`: when
 * stdout is piped or NO_COLOR is set, every helper falls back to plain text.
 */

import chalkDefault, { Chalk } from 'chalk'
import type { ProviderName } from '../types.js'

export const IS_TTY = process.stdout.isTTY === true && !process.env.NO_COLOR

// Pick between a real chalk (when on a TTY) and a level-0 chalk whose style
// chains are identity functions. This lets every call site use `c.red(s)`
// unconditionally without branching on IS_TTY itself.
const c = IS_TTY ? chalkDefault : new Chalk({ level: 0 })

// ── Provider palette ────────────────────────────────────────────────────────
// Hue-coded per provider so reading a verbose stream at a glance tells you who
// is speaking.

export const PROVIDER_COLORS: Record<ProviderName, (s: string) => string> = {
  claude: c.hex('#CC7B3A'),   // Anthropic amber
  codex:  c.hex('#10A37F'),   // OpenAI green
  oai:    c.hex('#8B7FE8'),   // Generic third-slot purple
}

const PROVIDER_LABEL: Record<ProviderName, string> = {
  claude: 'claude',
  codex:  'codex',
  oai:    'oai',
}

export function providerColor(name: ProviderName, s: string): string {
  const fn = PROVIDER_COLORS[name]
  return fn ? fn(s) : s
}

export function providerTag(name: ProviderName, width = 8): string {
  return providerColor(name, PROVIDER_LABEL[name].padEnd(width))
}

// ── Phase banners ───────────────────────────────────────────────────────────

const PHASE_EMOJI: Record<string, string> = {
  r0: '🎯',
  r1: '📋',
  r2: '🔍',
  r3: '✏️ ',
  r4: '⚖️ ',
}

const PHASE_TITLE: Record<string, string> = {
  r0: 'Task framing',
  r1: 'Independent plans',
  r2: 'Cross-critique',
  r3: 'Revision',
  r4: 'Final judgment',
}

export function phaseBanner(phase: 'r0' | 'r1' | 'r2' | 'r3' | 'r4', tail?: string): string {
  const emoji = PHASE_EMOJI[phase] ?? '•'
  const title = PHASE_TITLE[phase] ?? phase
  const head = c.bold(`${emoji}  ${phase.toUpperCase()}  ${title}`)
  return tail ? `${head}  ${c.dim('— ' + tail)}` : head
}

export function divider(width = 60): string {
  return c.dim('─'.repeat(width))
}

export function heavyDivider(width = 60): string {
  return c.dim('═'.repeat(width))
}

// ── Basic style wrappers ────────────────────────────────────────────────────

export const dim = (s: string) => c.dim(s)
export const bold = (s: string) => c.bold(s)
export const green = (s: string) => c.green(s)
export const red = (s: string) => c.red(s)
export const yellow = (s: string) => c.yellow(s)
export const cyan = (s: string) => c.cyan(s)
export const magenta = (s: string) => c.magenta(s)

export function checkmark(): string { return c.green('✓') }
export function cross(): string { return c.red('✗') }
export function arrow(): string { return c.dim('→') }

export function kv(key: string, value: string, keyWidth = 12): string {
  return `${c.dim(key.padEnd(keyWidth))}${value}`
}

// ── Elapsed / char formatting ───────────────────────────────────────────────

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return `${m}m${rs.toString().padStart(2, '0')}s`
}

export function formatChars(n: number): string {
  if (n < 1000) return `${n}c`
  if (n < 10_000) return `${(n / 1000).toFixed(1)}Kc`
  return `${Math.round(n / 1000)}Kc`
}

// ── Markdown highlighter for the final plan ─────────────────────────────────
// Not a full renderer — we just color headings, bold, italics, inline code,
// and fenced code blocks so the plan is skimmable in the terminal. Lists,
// tables, and links pass through as-is (markdown is readable enough).

export function renderMarkdownForTerminal(md: string): string {
  if (!IS_TTY) return md
  const lines = md.split('\n')
  const out: string[] = []
  let inFence = false

  for (const line of lines) {
    // Fenced code block toggle
    if (/^```/.test(line)) {
      inFence = !inFence
      out.push(c.dim(line))
      continue
    }
    if (inFence) {
      out.push(c.hex('#8fbcbb')(line))
      continue
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1]!.length
      if (level === 1)      out.push(c.bold.underline.cyan(line))
      else if (level === 2) out.push(c.bold.cyan(line))
      else if (level === 3) out.push(c.bold.hex('#7dc4e4')(line))
      else                  out.push(c.bold(line))
      continue
    }

    // Inline: `code`, **bold**, *italic*, list markers
    let s = line
    s = s.replace(/`([^`]+)`/g, (_, g: string) => c.hex('#8fbcbb')(`\`${g}\``))
    s = s.replace(/\*\*([^*]+)\*\*/g, (_, g: string) => c.bold(g))
    s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, (_, g: string) => c.italic(g))
    s = s.replace(/^(\s*)([-*+])\s/, (_m, pad: string, bullet: string) => `${pad}${c.yellow(bullet)} `)
    s = s.replace(/^(\s*)(\d+)\.\s/, (_m, pad: string, num: string) => `${pad}${c.yellow(num + '.')} `)
    out.push(s)
  }
  return out.join('\n')
}

// ── Cursor visibility (for Dashboard) ──────────────────────────────────────

export function hideCursor(): void { if (IS_TTY) process.stdout.write('\x1B[?25l') }
export function showCursor(): void { if (IS_TTY) process.stdout.write('\x1B[?25h') }
