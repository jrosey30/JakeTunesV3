// Synology DSM client. Wraps the auth + URL-building primitives the
// rest of the NAS layer depends on.
//
// DSM auth flow (DSM 7.x):
//   GET /webapi/entry.cgi?api=SYNO.API.Auth&version=6&method=login
//        &account=<user>&passwd=<pass>&session=AudioStation&format=sid
//   → { data: { sid: "..." } }   (sid threaded as ?_sid= on later calls)
//
// We don't ship the actual fetch yet — Phase 0 scaffolds the surface
// area and validates URL shape. The first real call goes in Phase 1
// when the user has the DS224 online.

import type { NasConnectionConfig } from '@/types'
import { secureStore } from '@/services/secureStore'

export interface AuthSession {
  sid: string
  // Epoch ms. DSM sessions expire after ~24h of idle by default.
  issuedAt: number
}

export interface SynologyClient {
  config: NasConnectionConfig
  baseUrl(): string
  webapiUrl(api: string, method: string, params?: Record<string, string | number>): string
  login(): Promise<AuthSession>
  logout(): Promise<void>
  isAuthenticated(): boolean
}

export function createSynologyClient(config: NasConnectionConfig): SynologyClient {
  let session: AuthSession | null = null

  function baseUrl(): string {
    const scheme = config.https ? 'https' : 'http'
    const port = config.port ?? (config.https ? 5001 : 5000)
    return `${scheme}://${config.host}:${port}`
  }

  function webapiUrl(
    api: string,
    method: string,
    params: Record<string, string | number> = {},
  ): string {
    const search = new URLSearchParams({
      api,
      method,
      version: '1',
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    })
    if (session?.sid) search.set('_sid', session.sid)
    return `${baseUrl()}/webapi/entry.cgi?${search.toString()}`
  }

  async function login(): Promise<AuthSession> {
    const password = await secureStore.getNasPassword()
    if (!password) throw new Error('No NAS password in keychain')
    const url = `${baseUrl()}/webapi/entry.cgi?${new URLSearchParams({
      api: 'SYNO.API.Auth',
      version: '6',
      method: 'login',
      account: config.username,
      passwd: password,
      session: 'AudioStation',
      format: 'sid',
    }).toString()}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`DSM login failed: HTTP ${res.status}`)
    const json = (await res.json()) as { success: boolean; data?: { sid: string }; error?: { code: number } }
    if (!json.success || !json.data?.sid) {
      throw new Error(`DSM login refused (error ${json.error?.code ?? 'unknown'})`)
    }
    session = { sid: json.data.sid, issuedAt: Date.now() }
    return session
  }

  async function logout(): Promise<void> {
    if (!session) return
    try {
      await fetch(webapiUrl('SYNO.API.Auth', 'logout', { session: 'AudioStation' }))
    } finally {
      session = null
    }
  }

  return {
    config,
    baseUrl,
    webapiUrl,
    login,
    logout,
    isAuthenticated: () => session != null,
  }
}
