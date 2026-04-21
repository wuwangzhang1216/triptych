/**
 * Dashboard — a live multi-row status board that updates in place during a
 * phase. One row per concurrent worker (provider, or reviewer→target pair in
 * R2), showing: spinner / checkmark, label, status, elapsed, char count.
 *
 * Rendering is throttled: a 120ms ticker advances the spinner frame and
 * re-renders. Token updates mutate internal counters cheaply; the ticker
 * does the actual draw so a burst of 500 delta chunks doesn't repaint 500×.
 *
 * When stdout is not a TTY (piped output, CI), the Dashboard degrades to
 * a plain "event log" — each state transition is written as one line
 * without any cursor control.
 */

import {
  dim,
  formatChars,
  formatElapsed,
  green,
  hideCursor,
  IS_TTY,
  red,
  showCursor,
} from './ui.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const UP = (n: number) => `\x1B[${n}A`
const CLEAR_LINE = '\x1B[2K\r'

type RowStatus = 'running' | 'done' | 'failed'

interface Row {
  key: string
  label: string           // pre-colored label text shown to user
  status: RowStatus
  startedAt: number
  finishedAt?: number
  chars: number
  extra?: string          // e.g. reviewer→target decoration
  message?: string
}

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
      status: 'running',
      startedAt: Date.now(),
      chars: 0,
    })
    this.order.push(key)
    if (!IS_TTY) {
      console.log(`  ${dim('⋯')} ${label} ${dim('started')}`)
    } else {
      this.render()
    }
  }

  /** Add to the char counter for a row. Rendering is handled by the ticker. */
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
      const el = formatElapsed((r.finishedAt ?? 0) - r.startedAt)
      console.log(`  ${green('✓')} ${r.label} ${dim(`${el} · ${formatChars(r.chars)}`)}`)
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
      console.log(`  ${red('✗')} ${r.label} ${red(message)}`)
    } else {
      this.render()
    }
  }

  /** Stop the ticker, repaint once with the final frame, release the cursor. */
  finalize(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = undefined
    if (IS_TTY) this.render()
    showCursor()
    this.running = false
  }

  /** Prepare for the next phase. Keeps prior output on screen; zeroes state. */
  reset(): void {
    this.rows.clear()
    this.order = []
    this.lastHeight = 0
    this.frame = 0
  }

  private render(): void {
    if (!IS_TTY) return
    const lines = this.order.map(k => this.formatRow(this.rows.get(k)!))
    let out = ''
    if (this.lastHeight > 0) out += UP(this.lastHeight)
    for (const line of lines) out += CLEAR_LINE + line + '\n'
    process.stdout.write(out)
    this.lastHeight = lines.length
  }

  private formatRow(r: Row): string {
    const elapsed = formatElapsed((r.finishedAt ?? Date.now()) - r.startedAt)
    let glyph: string
    let statusText: string
    if (r.status === 'running') {
      glyph = dim(FRAMES[this.frame]!)
      statusText = dim('streaming')
    } else if (r.status === 'done') {
      glyph = green('✓')
      statusText = green('done')
    } else {
      glyph = red('✗')
      statusText = red('failed')
    }
    // Pad the raw (uncolored) label to align columns; label passed in has color codes.
    const labelRendered = r.label
    const tail: string[] = []
    tail.push(dim(elapsed))
    if (r.chars > 0) tail.push(dim(formatChars(r.chars)))
    if (r.message) tail.push(red(truncate(r.message, 60)))
    return `  ${glyph}  ${labelRendered}  ${statusText}  ${tail.join(dim(' · '))}`
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
