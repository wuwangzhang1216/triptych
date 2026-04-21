import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { JudgeStrategy } from './types.js'

const CONFIG_DIR = join(homedir(), '.triptych')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

// Legacy path used when the package was named `planing-judeger`. We transparently
// migrate on first read so existing OAuth tokens / API keys survive the rename.
const LEGACY_CONFIG_DIR = join(homedir(), '.planing-judeger')
const LEGACY_CONFIG_FILE = join(LEGACY_CONFIG_DIR, 'config.json')

export interface Config {
  // Claude OAuth tokens (via claude.ai subscription)
  claude_access_token?: string
  claude_refresh_token?: string
  claude_expires_at?: number      // ms since epoch
  claude_model?: string           // default: 'claude-opus-4-7'
  claude_web_search?: boolean     // default: false — server-side web_search_20250305 tool
  claude_agent?: boolean          // default: false — enables multi-turn agent loop with Read/Grep/Glob/WebFetch tools

  // Codex OAuth tokens (via ChatGPT subscription)
  codex_access_token?: string
  codex_refresh_token?: string
  codex_account_id?: string
  codex_expires_at?: number
  codex_email?: string
  codex_model?: string            // default: 'gpt-5.4'
  codex_web_search?: boolean      // default: false — native WHAM web_search tool
  codex_agent?: boolean           // default: false — multi-turn agent loop with Read/Grep/Glob/WebFetch tools

  // OpenRouter
  openrouter_api_key?: string
  openrouter_model?: string       // default: 'minimax/minimax-m2.7'
  openrouter_web_search?: boolean // default: false — appends ':online' to model
  openrouter_agent?: boolean      // default: false — multi-turn agent loop with Read/Grep/Glob/WebFetch tools

  // Debate settings
  default_judge?: JudgeStrategy
  debate_rounds?: number
  verbose?: boolean

  // Internal: round-robin judge index
  _judge_index?: number
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

function migrateLegacyIfNeeded(): void {
  if (existsSync(CONFIG_FILE)) return
  if (!existsSync(LEGACY_CONFIG_FILE)) return
  ensureConfigDir()
  try {
    const legacy = readFileSync(LEGACY_CONFIG_FILE, 'utf-8')
    writeFileSync(CONFIG_FILE, legacy, 'utf-8')
  } catch {
    // If migration fails, proceed with an empty new config rather than crashing.
  }
}

export function readConfig(): Config {
  migrateLegacyIfNeeded()
  ensureConfigDir()
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Config
  } catch {
    return {}
  }
}

export function writeConfig(updater: (current: Config) => Config): void {
  ensureConfigDir()
  const current = readConfig()
  const next = updater(current)
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8')
}

export function setConfigValue<K extends keyof Config>(key: K, value: Config[K]): void {
  writeConfig(c => ({ ...c, [key]: value }))
}

export function getConfigDir(): string {
  return CONFIG_DIR
}

// --- Convenience getters ---

export function getClaudeTokens() {
  const c = readConfig()
  if (!c.claude_access_token) return null
  return {
    accessToken: c.claude_access_token,
    refreshToken: c.claude_refresh_token ?? '',
    expiresAt: c.claude_expires_at ?? 0,
  }
}

export function saveClaudeTokens(tokens: {
  accessToken: string
  refreshToken: string
  expiresAt: number
}): void {
  writeConfig(c => ({
    ...c,
    claude_access_token: tokens.accessToken,
    claude_refresh_token: tokens.refreshToken,
    claude_expires_at: tokens.expiresAt,
  }))
}

export function getCodexTokens() {
  const c = readConfig()
  if (!c.codex_access_token) return null
  return {
    accessToken: c.codex_access_token,
    refreshToken: c.codex_refresh_token ?? '',
    accountId: c.codex_account_id ?? '',
    expiresAt: c.codex_expires_at ?? 0,
    email: c.codex_email ?? '',
  }
}

export function saveCodexTokens(tokens: {
  accessToken: string
  refreshToken: string
  accountId: string
  expiresAt: number
  email: string
}): void {
  writeConfig(c => ({
    ...c,
    codex_access_token: tokens.accessToken,
    codex_refresh_token: tokens.refreshToken,
    codex_account_id: tokens.accountId,
    codex_expires_at: tokens.expiresAt,
    codex_email: tokens.email,
  }))
}

export function getOpenRouterKey(): string | null {
  return readConfig().openrouter_api_key ?? null
}

export function getClaudeModel(): string {
  return readConfig().claude_model ?? 'claude-opus-4-7'
}

export function getClaudeWebSearch(): boolean {
  return readConfig().claude_web_search === true
}

export function getClaudeAgentMode(): boolean {
  return readConfig().claude_agent === true
}

export function getCodexModel(): string {
  return readConfig().codex_model ?? 'gpt-5.4'
}

export function getCodexWebSearch(): boolean {
  return readConfig().codex_web_search === true
}

export function getCodexAgentMode(): boolean {
  return readConfig().codex_agent === true
}

export function getOpenRouterAgentMode(): boolean {
  return readConfig().openrouter_agent === true
}

export function getOpenRouterModel(): string {
  const c = readConfig()
  const base = c.openrouter_model ?? 'minimax/minimax-m2.7'
  return c.openrouter_web_search && !base.endsWith(':online') ? `${base}:online` : base
}

export function getOpenRouterWebSearch(): boolean {
  return readConfig().openrouter_web_search === true
}
