/**
 * Codex (ChatGPT) OAuth PKCE flow.
 * Ported from claude-code-source-all-in-one/src/services/api/providers/chatgptOAuth.ts
 */

import { createHash, randomBytes } from 'crypto'
import http from 'http'
import { getCodexTokens, saveCodexTokens } from '../../config.js'

// Public Codex community client ID (no secret required)
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const SCOPES = 'openid profile email offline_access'

export const CALLBACK_PORT = 1455
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`

interface PendingFlow {
  codeVerifier: string
  createdAt: number
}

const pendingFlows = new Map<string, PendingFlow>()

let refreshLock: Promise<void> | null = null

export interface CodexTokens {
  accessToken: string
  refreshToken: string
  accountId: string
  expiresAt: number
  email: string
}

export function generateAuthUrl(): { authUrl: string; state: string } {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const state = randomBytes(16).toString('hex')

  // Prune stale flows
  for (const [k, f] of pendingFlows) {
    if (Date.now() - f.createdAt > 10 * 60 * 1000) pendingFlows.delete(k)
  }

  pendingFlows.set(state, { codeVerifier, createdAt: Date.now() })

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex',
  })

  return { authUrl: `${AUTH_URL}?${params}`, state }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.')
    if (parts.length < 2 || !parts[1]) return {}
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function extractAccountId(idToken: string): string {
  const payload = decodeJwtPayload(idToken)
  const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
  if (auth) {
    if (typeof auth.chatgpt_account_id === 'string') return auth.chatgpt_account_id
    const orgs = auth.organizations as Array<Record<string, unknown>> | undefined
    if (Array.isArray(orgs) && orgs[0]) {
      const org = orgs[0] as Record<string, unknown>
      if (typeof org.chatgpt_account_id === 'string') return org.chatgpt_account_id
      if (typeof org.id === 'string') return org.id
    }
  }
  if (typeof payload.chatgpt_account_id === 'string') return payload.chatgpt_account_id
  return typeof payload.sub === 'string' ? payload.sub : ''
}

function extractEmail(idToken: string): string {
  const payload = decodeJwtPayload(idToken)
  return typeof payload.email === 'string' ? payload.email : ''
}

export async function exchangeCode(code: string, state: string): Promise<CodexTokens> {
  const flow = pendingFlows.get(state)
  if (!flow) throw new Error('Invalid or expired OAuth state. Please try logging in again.')
  pendingFlows.delete(state)

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: flow.codeVerifier,
    }).toString(),
  })

  if (!res.ok) throw new Error(`Codex token exchange failed: ${await res.text()}`)

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    id_token: string
    expires_in: number
  }

  const tokens: CodexTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accountId: extractAccountId(data.id_token),
    expiresAt: Date.now() + data.expires_in * 1000,
    email: extractEmail(data.id_token),
  }

  saveCodexTokens(tokens)
  return tokens
}

export async function refreshAccessToken(): Promise<void> {
  if (refreshLock) {
    await refreshLock
    return
  }

  const tokens = getCodexTokens()
  if (!tokens?.refreshToken) {
    throw new Error('No Codex refresh token. Please run: pj login codex')
  }

  refreshLock = (async () => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: tokens.refreshToken,
        }).toString(),
      })

      if (!res.ok) throw new Error(`Codex token refresh failed: ${await res.text()}`)

      const data = (await res.json()) as {
        access_token: string
        refresh_token?: string
        id_token?: string
        expires_in: number
      }

      saveCodexTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? tokens.refreshToken,
        accountId: tokens.accountId,
        expiresAt: Date.now() + data.expires_in * 1000,
        email: tokens.email,
      })
    } finally {
      refreshLock = null
    }
  })()

  await refreshLock
}

export async function ensureValidToken(): Promise<CodexTokens> {
  const tokens = getCodexTokens()
  if (!tokens) throw new Error('Codex not authenticated. Run: pj login codex')

  if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
    await refreshAccessToken()
    return getCodexTokens()!
  }

  return tokens
}

let callbackServer: http.Server | null = null

export function startCallbackListener(
  onComplete: (result: { tokens?: CodexTokens; error?: string }) => void,
): void {
  if (callbackServer) {
    try { callbackServer.close() } catch { /* ignore */ }
    callbackServer = null
  }

  const htmlPage = (title: string, body: string, ok: boolean) =>
    `<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:2rem">
    <h1>${ok ? '✓' : '✗'} ${title}</h1><p>${body}</p><p><small>You can close this tab.</small></p>
    </body></html>`

  callbackServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`)
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404).end('Not found')
      return
    }

    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')

    if (error) {
      const desc = url.searchParams.get('error_description') ?? ''
      onComplete({ error: `${error}: ${desc}` })
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(
        htmlPage('Login Failed', error, false),
      )
      callbackServer?.close()
      callbackServer = null
      return
    }

    if (!code || !state) {
      onComplete({ error: 'Missing code or state' })
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(
        htmlPage('Login Failed', 'Missing code or state', false),
      )
      callbackServer?.close()
      callbackServer = null
      return
    }

    try {
      const tokens = await exchangeCode(code, state)
      onComplete({ tokens })
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        htmlPage('Login Successful', `Signed in as ${tokens.email}`, true),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      onComplete({ error: msg })
      res.writeHead(500, { 'Content-Type': 'text/html' }).end(
        htmlPage('Login Error', msg, false),
      )
    }

    callbackServer?.close()
    callbackServer = null
  })

  callbackServer.listen(CALLBACK_PORT, '127.0.0.1')

  setTimeout(() => {
    callbackServer?.close()
    callbackServer = null
  }, 10 * 60 * 1000)
}
