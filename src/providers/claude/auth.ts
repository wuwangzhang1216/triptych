/**
 * Claude OAuth PKCE flow (mirrors claude-code-source-all-in-one/src/services/oauth/).
 * Uses claude.ai subscription — no API key needed.
 */

import { createHash, randomBytes } from 'crypto'
import http from 'http'
import { getClaudeTokens, saveClaudeTokens } from '../../config.js'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback'

const SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
]

const CALLBACK_PORT = 7823
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`

let refreshLock: Promise<void> | null = null

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function generateState(): string {
  return randomBytes(16).toString('hex')
}

export function buildAuthUrl(codeVerifier: string): { url: string; state: string } {
  const state = generateState()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return { url: url.toString(), state }
}

export function buildManualAuthUrl(codeVerifier: string): { url: string; state: string } {
  const state = generateState()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', MANUAL_REDIRECT_URL)
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return { url: url.toString(), state }
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  state: string,
  isManual: boolean,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: isManual ? MANUAL_REDIRECT_URL : REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
      state,
    }),
  })

  if (!res.ok) {
    throw new Error(`Claude token exchange failed: ${await res.text()}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

export async function refreshAccessToken(): Promise<void> {
  if (refreshLock) {
    await refreshLock
    return
  }

  const tokens = getClaudeTokens()
  if (!tokens?.refreshToken) {
    throw new Error('No Claude refresh token. Please run: pj login claude')
  }

  refreshLock = (async () => {
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
          client_id: CLIENT_ID,
          scope: SCOPES.join(' '),
        }),
      })

      if (!res.ok) {
        throw new Error(`Claude token refresh failed: ${await res.text()}`)
      }

      const data = (await res.json()) as {
        access_token: string
        refresh_token?: string
        expires_in: number
      }

      saveClaudeTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? tokens.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
      })
    } finally {
      refreshLock = null
    }
  })()

  await refreshLock
}

export async function ensureValidToken(): Promise<string> {
  let tokens = getClaudeTokens()
  if (!tokens) {
    throw new Error('Claude not authenticated. Run: pj login claude')
  }

  // Proactive refresh with 5-minute buffer
  if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
    await refreshAccessToken()
    tokens = getClaudeTokens()!
  }

  return tokens.accessToken
}

/** Start OAuth flow: open browser, wait for callback, save tokens. Returns email. */
export async function startClaudeOAuthFlow(
  openUrl: (url: string) => void,
  printManualUrl: (url: string) => void,
): Promise<void> {
  const codeVerifier = generateCodeVerifier()
  const { url: automaticUrl, state: automaticState } = buildAuthUrl(codeVerifier)
  const { url: manualUrl } = buildManualAuthUrl(codeVerifier)

  printManualUrl(manualUrl)

  return new Promise((resolve, reject) => {
    let resolved = false

    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404).end()
        return
      }

      const params = new URL(req.url, `http://localhost:${CALLBACK_PORT}`).searchParams
      const code = params.get('code')
      const state = params.get('state')

      if (!code || state !== automaticState) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(
          '<h1>Login Failed</h1><p>Invalid state or missing code.</p>',
        )
        return
      }

      try {
        const tkns = await exchangeCode(code, codeVerifier, state, false)
        saveClaudeTokens(tkns)
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
          '<h1>Claude Login Successful</h1><p>You can close this tab.</p>',
        )
        if (!resolved) {
          resolved = true
          server.close()
          resolve()
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' }).end('<h1>Login Error</h1>')
        if (!resolved) {
          resolved = true
          server.close()
          reject(err)
        }
      }
    })

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      openUrl(automaticUrl)
    })

    server.once('error', (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    })

    // Timeout after 10 minutes
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        server.close()
        reject(new Error('Claude OAuth timed out after 10 minutes'))
      }
    }, 10 * 60 * 1000)
  })
}
