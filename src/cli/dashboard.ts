/**
 * Dashboard — live multi-row status board that updates in place during a
 * phase. One row per concurrent worker, rendered as a single column-aligned
 * line:
 *
 *     ⠋  claude          7.4s     1.2K
 *     ✓  codex          14.3s     3.2K
 *     ·  oai             queued
 *
 * Design:
 * - Single glyph carries all state (spinner / check / cross / bullet). No
 *   redundant "streaming"/"done"/"failed" word.
 * - Numeric columns right-aligned to fixed widths so values line up vertically.
 * - 120ms ticker advances the spinner and re-renders; token deltas mutate
 *   counters cheaply, the ticker does the draw.
 * - Non-TTY degrades to one line per state transition (no cursor motion).
 */

import {
  dim,
  displayWidth,
  err,
  formatChars,
  formatElapsed,
  GLYPH,
  hideCursor,
  IS_TTY,
  ok,
  padLeft,
  padRight,
  showCursor,
} from './ui.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const UP = (n: number) => `\x1B[${n}A`
const CLEAR_LINE = '\x1B[2K\r'

type RowStatus = 'pending' | 'running' | 'done' | 'failed'

interface Row {
  key: string
  label: string          // pre-rendered label (may contain ANSI); raw width tracked separately
  rawWidth: number
  status: RowStatus
  startedAt?: number
  finishedAt?: number
  chars: number
  message?: string
}

const LABEL_MIN = 10
const ELAPSED_W = 7
const CHARS_W = 6

export class Dashboard {
  private rows = new Map<string, Row>()
  private order: string[] = []
  private lastHeight = 0
  private frame = 0
  private ticker?: ReturnType<typeof setInterval>
  private running = false

  start(): void {
    if (this.running) return
    this.running = true
    hideCursor()
    if (IS_TTY) {
      this.ticker = setInterval(() => {
        this.frame = (this.frame + 1) % FRAMES.length
        this.render()
      }, 120)
    }
  }

  addRow(key: string, label: string): void {
    if (this.rows.has(key)) return
    this.rows.set(key, {
      key,
      label,
      rawWidth: displayWidth(label),
      status: 'running',
      startedAt: Date.now(),
      chars: 0,
    })
    this.order.push(key)
    if (!IS_TTY) {
      process.stdout.write(`    ${dim('·')}  ${label}\n`)
    } else {
      this.render()
    }
  }

  incrementChars(key: string, delta: number): void {
    const r = this.rows.get(key)
    if (!r || r.status !== 'running') return
    r.chars += delta
  }

  markDone(key: string, finalChars?: number): void {
    const r = this.rows.get(key)
    if (!r) return
    r.status = 'done'
    r.finishedAt = Date.now()
    if (typeof finalChars === 'number') r.chars = finalChars
    if (!IS_TTY) {
      const el = formatElapsed((r.finishedAt ?? 0) - (r.startedAt ?? 0))
      process.stdout.write(`    ${ok('✓')}  ${r.label}  ${dim(el)}  ${dim(formatChars(r.chars))}\n`)
    } else {
      this.render()
    }
  }

  markFailed(key: string, message: string): void {
    const r = this.rows.get(key)
    if (!r) return
    r.status = 'failed'
    r.finishedAt = Date.now()
    r.message = message
    if (!IS_TTY) {
      process.stdout.write(`    ${err('×')}  ${r.label}  ${err(truncate(message, 60))}\n`)
    } else {
      this.render()
    }
  }

  /** Mark any rows still running as failed. Call before finalize() on error. */
  failAllRunning(message: string): void {
    for (const r of this.rows.values()) {
      if (r.status === 'running') this.markFailed(r.key, message)
    }
  }

  /** Stop the ticker, paint one final frame, restore the cursor. */
  finalize(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = undefined
    if (IS_TTY) this.render()
    showCursor()
    this.running = false
  }

  /** Prepare for the next phase. Keeps the prior output on screen. */
  reset(): void {
    this.rows.clear()
    this.order = []
    this.lastHeight = 0
    this.frame = 0
  }

  private render(): void {
    if (!IS_TTY) return
    const labelCol = Math.max(LABEL_MIN, ...this.order.map(k => this.rows.get(k)!.rawWidth))
    const lines = this.order.map(k => this.formatRow(this.rows.get(k)!, labelCol))
    let out = ''
    if (this.lastHeight > 0) out += UP(this.lastHeight)
    for (const line of lines) out += CLEAR_LINE + line + '\n'
    process.stdout.write(out)
    this.lastHeight = lines.length
  }

  private formatRow(r: Row, labelCol: number): string {
    let glyph: string
    if (r.status === 'running')      glyph = dim(FRAMES[this.frame]!)
    else if (r.status === 'done')    glyph = GLYPH.check
    else if (r.status === 'failed')  glyph = GLYPH.fail
    else                             glyph = GLYPH.pending

    const label = padRight(r.label, labelCol)

    const elapsedMs = (r.finishedAt ?? Date.now()) - (r.startedAt ?? Date.now())
    const elapsedStr = r.status === 'pending' ? '' : formatElapsed(elapsedMs)
    const elapsed = padLeft(dim(elapsedStr), ELAPSED_W)

    // Only show chars once we have real data; blank during pending and
    // early-streaming avoids a noisy "0" flash.
    const charsStr = r.chars > 0 ? formatChars(r.chars) : ''
    const chars = padLeft(dim(charsStr), CHARS_W)

    const msg = r.status === 'failed' && r.message
      ? `  ${err(truncate(r.message, 60))}`
      : ''

    return `    ${glyph}  ${label}  ${elapsed}  ${chars}${msg}`
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
