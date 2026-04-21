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

  // OpenAI-compatible third provider. Any endpoint that speaks OpenAI Chat
  // Completions works: OpenRouter, DeepSeek, Moonshot/Kimi, Zhipu/GLM,
  // DashScope/Qwen, MiniMax, xAI Grok, Mistral, Groq, Together, Fireworks,
  // Cerebras, DeepInfra, SiliconFlow, Doubao, Perplexity, OpenAI direct, …
  oai_api_key?: string
  oai_base_url?: string           // default: 'https://openrouter.ai/api/v1'
  oai_model?: string              // default: 'minimax/minimax-m2.7'
  oai_web_search?: boolean        // only OpenRouter honors this (appends ':online')
  oai_agent?: boolean             // multi-turn agent loop
  oai_display_name?: string       // optional friendly label for status output
  oai_extra_headers?: Record<string, string>  // optional per-provider custom headers

  // Deprecated openrouter_* aliases — still honored on read for existing installs.
  openrouter_api_key?: string
  openrouter_model?: string
  openrouter_web_search?: boolean
  openrouter_agent?: boolean

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

// ── OpenAI-compatible provider getters ──────────────────────────────────────

export const DEFAULT_OAI_BASE_URL = 'https://openrouter.ai/api/v1'
export const DEFAULT_OAI_MODEL = 'minimax/minimax-m2.7'

export function getOAIKey(): string | null {
  const c = readConfig()
  return c.oai_api_key ?? c.openrouter_api_key ?? null
}

export function getOAIBaseUrl(): string {
  return readConfig().oai_base_url ?? DEFAULT_OAI_BASE_URL
}

export function getOAIWebSearch(): boolean {
  const c = readConfig()
  return (c.oai_web_search ?? c.openrouter_web_search) === true
}

export function getOAIAgentMode(): boolean {
  const c = readConfig()
  return (c.oai_agent ?? c.openrouter_agent) === true
}

/**
 * Returns the model id, with the OpenRouter-specific `:online` suffix appended
 * only when (a) web search is enabled AND (b) the base URL is openrouter.ai.
 * Other OpenAI-compatible endpoints don't understand `:online` and would 400.
 */
export function getOAIModel(): string {
  const c = readConfig()
  const base = c.oai_model ?? c.openrouter_model ?? DEFAULT_OAI_MODEL
  if (!getOAIWebSearch()) return base
  const isOpenRouter = getOAIBaseUrl().includes('openrouter.ai')
  if (isOpenRouter && !base.endsWith(':online')) return `${base}:online`
  return base
}

export function getOAIExtraHeaders(): Record<string, string> {
  return readConfig().oai_extra_headers ?? {}
}

/**
 * Best-effort friendly name for the configured endpoint. Used in `status`
 * output. User can override with `oai_display_name`.
 */
export function getOAIDisplayName(): string {
  const c = readConfig()
  if (c.oai_display_name) return c.oai_display_name
  const url = getOAIBaseUrl()
  let host = ''
  try { host = new URL(url).host } catch { host = url }
  const preset = OAI_PRESETS.find(p => p.base_url === url) ??
                 OAI_PRESETS.find(p => {
                   try { return new URL(p.base_url).host === host } catch { return false }
                 })
  if (preset) return preset.display_name
  return host || 'OAI-compatible'
}

// ── Deprecated aliases (library back-compat) ────────────────────────────────

/** @deprecated use getOAIKey */
export const getOpenRouterKey = getOAIKey
/** @deprecated use getOAIModel */
export const getOpenRouterModel = getOAIModel
/** @deprecated use getOAIAgentMode */
export const getOpenRouterAgentMode = getOAIAgentMode
/** @deprecated use getOAIWebSearch */
export const getOpenRouterWebSearch = getOAIWebSearch

// ── Built-in presets for popular OpenAI-compatible endpoints ────────────────

export interface OAIPreset {
  name: string
  base_url: string
  default_model: string
  display_name: string
  notes?: string
}

export const OAI_PRESETS: OAIPreset[] = [
  { name: 'openrouter',  base_url: 'https://openrouter.ai/api/v1',                              default_model: 'minimax/minimax-m2.7',                       display_name: 'OpenRouter' },
  { name: 'deepseek',    base_url: 'https://api.deepseek.com',                                  default_model: 'deepseek-chat',                              display_name: 'DeepSeek' },
  { name: 'kimi',        base_url: 'https://api.moonshot.ai/v1',                                default_model: 'kimi-k2-turbo-preview',                      display_name: 'Kimi (Moonshot, intl)' },
  { name: 'kimi-cn',     base_url: 'https://api.moonshot.cn/v1',                                default_model: 'kimi-k2-turbo-preview',                      display_name: 'Kimi (Moonshot, CN)' },
  { name: 'glm',         base_url: 'https://api.z.ai/api/paas/v4/',                             default_model: 'glm-5.1',                                    display_name: 'GLM (Z.AI, intl)' },
  { name: 'glm-cn',      base_url: 'https://open.bigmodel.cn/api/paas/v4/',                     default_model: 'glm-5.1',                                    display_name: 'GLM (Zhipu, CN)' },
  { name: 'qwen',        base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',    default_model: 'qwen3-coder-plus',                           display_name: 'Qwen (DashScope, intl)' },
  { name: 'qwen-cn',     base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',         default_model: 'qwen3-coder-plus',                           display_name: 'Qwen (DashScope, CN)' },
  { name: 'minimax',     base_url: 'https://api.minimax.io/v1',                                 default_model: 'MiniMax-M2',                                 display_name: 'MiniMax (intl)' },
  { name: 'minimax-cn',  base_url: 'https://api.minimaxi.com/v1',                               default_model: 'MiniMax-M2',                                 display_name: 'MiniMax (CN)' },
  { name: 'groq',        base_url: 'https://api.groq.com/openai/v1',                            default_model: 'llama-3.3-70b-versatile',                    display_name: 'Groq' },
  { name: 'mistral',     base_url: 'https://api.mistral.ai/v1',                                 default_model: 'mistral-large-latest',                       display_name: 'Mistral' },
  { name: 'xai',         base_url: 'https://api.x.ai/v1',                                       default_model: 'grok-4',                                     display_name: 'xAI Grok' },
  { name: 'together',    base_url: 'https://api.together.xyz/v1',                               default_model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',    display_name: 'Together AI' },
  { name: 'fireworks',   base_url: 'https://api.fireworks.ai/inference/v1',                     default_model: 'accounts/fireworks/models/deepseek-v3',      display_name: 'Fireworks' },
  { name: 'cerebras',    base_url: 'https://api.cerebras.ai/v1',                                default_model: 'llama-3.3-70b',                              display_name: 'Cerebras' },
  { name: 'deepinfra',   base_url: 'https://api.deepinfra.com/v1/openai',                       default_model: 'MiniMaxAI/MiniMax-M2',                       display_name: 'DeepInfra' },
  { name: 'siliconflow', base_url: 'https://api.siliconflow.com/v1',                            default_model: 'deepseek-ai/DeepSeek-V3',                    display_name: 'SiliconFlow' },
  { name: 'doubao',      base_url: 'https://ark.cn-beijing.volces.com/api/v3',                  default_model: 'doubao-seed-pro',                            display_name: 'Doubao (Volcengine)' },
  { name: 'perplexity',  base_url: 'https://api.perplexity.ai',                                 default_model: 'sonar-pro',                                  display_name: 'Perplexity' },
  { name: 'openai',      base_url: 'https://api.openai.com/v1',                                 default_model: 'gpt-5.4-mini',                               display_name: 'OpenAI (direct)' },
]

export function findOAIPreset(name: string): OAIPreset | undefined {
  const n = name.toLowerCase().trim()
  return OAI_PRESETS.find(p => p.name === n)
}

/** Apply a preset: writes base_url, default model (if user hasn't set one yet), and display_name. API key is never touched. */
export function applyOAIPreset(name: string, opts: { overrideModel?: boolean } = {}): OAIPreset {
  const preset = findOAIPreset(name)
  if (!preset) {
    throw new Error(
      `Unknown preset: "${name}". Available: ${OAI_PRESETS.map(p => p.name).join(', ')}`,
    )
  }
  writeConfig(c => ({
    ...c,
    oai_base_url: preset.base_url,
    oai_display_name: preset.display_name,
    // Overwrite the model unless the user explicitly opts out. Different
    // presets have incompatible model ids, so carrying over an old model id
    // usually breaks the new endpoint.
    oai_model: (opts.overrideModel === false && c.oai_model)
      ? c.oai_model
      : preset.default_model,
  }))
  return preset
}
