/**
 * Client-side tools for the agent loop. Each tool is self-contained and returns
 * a string that will be fed back to the model as a tool_result content block.
 *
 * Deliberately minimal: Read / Grep / Glob / WebFetch. No Edit, no Bash, no MCP.
 * The planner is read-only by design.
 */

import { readFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { spawn } from 'child_process'
import fg from 'fast-glob'
import TurndownService from 'turndown'

export interface Tool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  run(args: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<string>
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
turndown.remove(['script', 'style', 'noscript', 'iframe'] as unknown as Parameters<typeof turndown.remove>[0])

const MAX_OUTPUT_BYTES = 30_000

function truncate(s: string, limit = MAX_OUTPUT_BYTES): string {
  if (s.length <= limit) return s
  return s.slice(0, limit) + `\n\n[truncated: output was ${s.length} bytes, showing first ${limit}]`
}

// ── Read ─────────────────────────────────────────────────────────────────────

export const readTool: Tool = {
  name: 'read',
  description:
    'Read a file from the local filesystem. Returns content with line numbers (cat -n format). ' +
    'Use offset and limit for large files. Only for text files.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      offset: { type: 'integer', description: '1-based line to start from', minimum: 1 },
      limit: { type: 'integer', description: 'Max number of lines to read', minimum: 1 },
    },
    required: ['file_path'],
  },
  async run(args) {
    const path = args.file_path as string
    const offset = (args.offset as number) ?? 1
    const limit = (args.limit as number) ?? 2000
    let content: string
    try {
      content = await readFile(path, 'utf-8')
    } catch (err) {
      return `Error reading ${path}: ${(err as Error).message}`
    }
    const lines = content.split('\n')
    const start = offset - 1
    const end = Math.min(start + limit, lines.length)
    const out = lines
      .slice(start, end)
      .map((l, i) => `${(start + i + 1).toString().padStart(6)}\t${l}`)
      .join('\n')
    const header = `File: ${path} (lines ${offset}-${end} of ${lines.length})\n`
    return truncate(header + out)
  },
}

// ── Grep (via ripgrep) ───────────────────────────────────────────────────────

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents using ripgrep. Supports regex. Returns matching lines with file:line:content. ' +
    'Use `glob` parameter to scope the search (e.g. "*.ts").',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern (ripgrep syntax)' },
      path: { type: 'string', description: 'Directory or file to search. Defaults to cwd.' },
      glob: { type: 'string', description: 'File glob filter, e.g. "*.ts"' },
      case_insensitive: { type: 'boolean' },
      max_results: { type: 'integer', description: 'Max matching lines to return', default: 200 },
    },
    required: ['pattern'],
  },
  async run(args, { signal }) {
    const pattern = String(args.pattern)
    const path = (args.path as string) ?? process.cwd()
    const max = (args.max_results as number) ?? 200
    const caseInsensitive = Boolean(args.case_insensitive)
    const glob = args.glob as string | undefined

    // Try ripgrep first (fast + glob-aware); fall back to POSIX grep -r if rg
    // is not on PATH (common on machines without ripgrep installed).
    const rgArgs = ['--line-number', '--no-heading', '--with-filename']
    if (caseInsensitive) rgArgs.push('-i')
    if (glob) rgArgs.push('--glob', glob)
    rgArgs.push('--max-count', String(Math.max(1, Math.floor(max / 10))))
    rgArgs.push('--', pattern, path)

    const rgResult = await runCommand('rg', rgArgs, signal)
    if (rgResult.code === 0) return truncate(rgResult.stdout || '(no matches)')
    if (rgResult.code === 1) return '(no matches)'
    if (rgResult.code !== 127 && rgResult.error === undefined) {
      // rg ran and reported an error we can show
      return `rg exited ${rgResult.code}: ${rgResult.stderr}`
    }

    // Fallback: grep -r
    const grepArgs = ['-rn']
    if (caseInsensitive) grepArgs.push('-i')
    if (glob) grepArgs.push('--include', glob)
    grepArgs.push('-E', '--', pattern, path)
    const grepResult = await runCommand('grep', grepArgs, signal)
    if (grepResult.code === 0) return truncate(grepResult.stdout || '(no matches)')
    if (grepResult.code === 1) return '(no matches)'
    return `grep fallback failed: ${grepResult.stderr || grepResult.error || 'unknown'}`
  },
}

interface CmdResult { code: number; stdout: string; stderr: string; error?: string }

function runCommand(cmd: string, argv: string[], signal: AbortSignal): Promise<CmdResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    try {
      const child = spawn(cmd, argv, { signal })
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      child.on('error', (e) => {
        // ENOENT = binary not on PATH → code 127
        const code = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : -1
        resolve({ code, stdout, stderr, error: e.message })
      })
    } catch (e) {
      resolve({ code: -1, stdout, stderr, error: (e as Error).message })
    }
  })
}

// ── Glob ─────────────────────────────────────────────────────────────────────

export const globTool: Tool = {
  name: 'glob',
  description:
    'List files matching a glob pattern (e.g. "src/**/*.ts"). Returns paths sorted by modification time.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      cwd: { type: 'string', description: 'Directory to resolve pattern against' },
      max_results: { type: 'integer', default: 500 },
    },
    required: ['pattern'],
  },
  async run(args) {
    const pattern = String(args.pattern)
    const cwd = (args.cwd as string) ?? process.cwd()
    const max = (args.max_results as number) ?? 500
    try {
      const files = await fg(pattern, { cwd, absolute: true, onlyFiles: true, dot: false })
      const sorted = files.slice(0, max).sort()
      return truncate(`${sorted.length} files:\n` + sorted.join('\n'))
    } catch (err) {
      return `glob error: ${(err as Error).message}`
    }
  },
}

// ── WebFetch ────────────────────────────────────────────────────────────────

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a web URL and return the main content as Markdown (HTML stripped). ' +
    'For open research; use alongside the server-side web_search tool.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full http(s) URL' },
    },
    required: ['url'],
  },
  async run(args, { signal }) {
    const url = String(args.url)
    try {
      const res = await fetch(url, {
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (planing-judeger agent)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        },
      })
      if (!res.ok) return `HTTP ${res.status} fetching ${url}`
      const contentType = res.headers.get('content-type') || ''
      const body = await res.text()
      if (contentType.includes('text/html')) {
        return truncate(turndown.turndown(body))
      }
      return truncate(body)
    } catch (err) {
      return `fetch error: ${(err as Error).message}`
    }
  },
}

export const DEFAULT_TOOLS: Tool[] = [readTool, grepTool, globTool, webFetchTool]

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name)
}

// Used when a sandboxed context is needed (not currently enforced).
export function _touchSync(): void {
  void readFileSync
}
