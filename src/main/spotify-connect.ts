/**
 * Spotify connect (2026-08-28) — the LTL leftover Jake greenlit 7/14:
 * "get Discover Weekly into the brain" / "Spotify OAuth yes (one-time
 * login)."
 *
 * PKCE authorization-code flow with a loopback listener — no client
 * secret anywhere (PKCE apps don't have one), tokens live in
 * userData/spotify-auth.json and never enter the repo. The flow stays
 * INERT until Jake creates a (free) Spotify dev app and pastes its
 * Client ID into Settings; the redirect URI to register is exactly
 * http://127.0.0.1:48213/callback.
 *
 * Weekly: pull Discover Weekly, score every track with the brain, and
 * add the shelf-worthy ones to Listen to the List tagged source
 * 'spotify' — dedupe/tombstones ride the normal add path.
 *
 * Electron-free: opener + fetch injected, node --test loads it.
 */
import { createServer } from 'http'
import { createHash, randomBytes } from 'crypto'
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname } from 'path'

export const SPOTIFY_LOOPBACK_PORT = 48213
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_LOOPBACK_PORT}/callback`
const AUTH_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const API = 'https://api.spotify.com/v1'
const SCOPES = 'playlist-read-private playlist-read-collaborative user-top-read user-library-read'

export interface SpotifyAuthState {
  clientId?: string
  accessToken?: string
  refreshToken?: string
  /** ms epoch when accessToken dies. */
  expiresAt?: number
  connectedAt?: string
  lastPullAt?: string
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(64))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function authorizeUrl(clientId: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: SPOTIFY_REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
  })
  return `${AUTH_URL}?${q}`
}

export async function loadAuth(file: string): Promise<SpotifyAuthState> {
  try {
    const v = JSON.parse(await readFile(file, 'utf-8'))
    return v && typeof v === 'object' ? v as SpotifyAuthState : {}
  } catch {
    return {}
  }
}

export async function saveAuth(state: SpotifyAuthState, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, file)
}

/** True when the token needs a refresh before use (60s safety margin). */
export function tokenStale(auth: SpotifyAuthState, now = Date.now()): boolean {
  return !auth.accessToken || !auth.expiresAt || auth.expiresAt - now < 60_000
}

async function tokenRequest(body: URLSearchParams, fetchFn: typeof fetch): Promise<{ access_token: string; refresh_token?: string; expires_in: number } | null> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    console.warn('[spotify] token endpoint', res.status, (await res.text().catch(() => '')).slice(0, 200))
    return null
  }
  return await res.json() as { access_token: string; refresh_token?: string; expires_in: number }
}

/** Refresh in place; returns a usable access token or null. */
export async function freshAccessToken(file: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const auth = await loadAuth(file)
  if (!auth.clientId || !auth.refreshToken) return null
  if (!tokenStale(auth)) return auth.accessToken ?? null
  const tok = await tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: auth.clientId,
  }), fetchFn)
  if (!tok) return null
  auth.accessToken = tok.access_token
  auth.expiresAt = Date.now() + tok.expires_in * 1000
  if (tok.refresh_token) auth.refreshToken = tok.refresh_token   // Spotify rotates these
  await saveAuth(auth, file)
  return auth.accessToken
}

/**
 * One-time connect: open the consent page, catch the code on loopback,
 * exchange it, persist tokens. Resolves when the browser round-trip lands.
 */
export async function connectSpotify(
  file: string,
  openUrl: (url: string) => void,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5 * 60_000,
): Promise<{ ok: boolean; error?: string }> {
  const auth = await loadAuth(file)
  if (!auth.clientId) return { ok: false, error: 'No Client ID — paste it in Settings first.' }
  const { verifier, challenge } = pkcePair()
  const state = b64url(randomBytes(24))

  return await new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', SPOTIFY_REDIRECT_URI)
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return }
      const gotState = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      const err = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<body style="font-family:sans-serif;background:#f4f0e4;color:#333;text-align:center;padding-top:20vh"><h2>JakeTunes is connected to Spotify.</h2>You can close this tab.</body>')
      server.close()
      void (async () => {
        if (err) { resolve({ ok: false, error: `Spotify said: ${err}` }); return }
        if (!code || gotState !== state) { resolve({ ok: false, error: 'Bad callback (state mismatch).' }); return }
        const tok = await tokenRequest(new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI,
          client_id: auth.clientId!, code_verifier: verifier,
        }), fetchFn)
        if (!tok) { resolve({ ok: false, error: 'Token exchange failed.' }); return }
        await saveAuth({
          ...auth,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          expiresAt: Date.now() + tok.expires_in * 1000,
          connectedAt: new Date().toISOString(),
        }, file)
        resolve({ ok: true })
      })()
    })
    server.on('error', (e) => resolve({ ok: false, error: `Loopback listener failed: ${e.message}` }))
    server.listen(SPOTIFY_LOOPBACK_PORT, '127.0.0.1', () => {
      openUrl(authorizeUrl(auth.clientId!, challenge, state))
    })
    setTimeout(() => { try { server.close() } catch { /* closed */ } resolve({ ok: false, error: 'Login timed out.' }) }, timeoutMs).unref?.()
  })
}

export interface DwTrack { song: string; artist: string; album?: string }

/** Pick Discover Weekly from a playlist listing — Spotify-owned, exact name. */
export function pickDiscoverWeekly(items: Array<{ name?: string; id?: string; owner?: { id?: string } }>): string | null {
  const hit = items.find((p) => p?.name === 'Discover Weekly' && p?.owner?.id === 'spotify')
  return hit?.id ?? null
}

export async function fetchDiscoverWeekly(file: string, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; tracks?: DwTrack[]; error?: string }> {
  const token = await freshAccessToken(file, fetchFn)
  if (!token) return { ok: false, error: 'not connected' }
  const get = async (url: string): Promise<Record<string, unknown> | null> => {
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
    return res.ok ? await res.json() as Record<string, unknown> : null
  }
  // Discover Weekly hides in the user's followed playlists; walk pages.
  let playlistId: string | null = null
  let next: string | null = `${API}/me/playlists?limit=50`
  for (let page = 0; page < 4 && next && !playlistId; page++) {
    const data = await get(next)
    if (!data) break
    playlistId = pickDiscoverWeekly((data.items as never) || [])
    next = typeof data.next === 'string' ? data.next : null
  }
  if (!playlistId) return { ok: false, error: 'Discover Weekly not found — follow it in Spotify once.' }
  const data = await get(`${API}/playlists/${playlistId}/tracks?limit=50&fields=items(track(name,artists(name),album(name)))`)
  if (!data) return { ok: false, error: 'playlist read failed' }
  const tracks: DwTrack[] = []
  for (const item of (data.items as Array<{ track?: { name?: string; artists?: Array<{ name?: string }>; album?: { name?: string } } }>) || []) {
    const t = item?.track
    if (!t?.name || !t.artists?.[0]?.name) continue
    tracks.push({ song: t.name, artist: t.artists[0].name, album: t.album?.name })
  }
  return { ok: true, tracks }
}

/** His own Spotify listening — still readable after the Nov-2024 purge. */
export async function fetchTopTracks(file: string, range: 'short_term' | 'medium_term', fetchFn: typeof fetch = fetch): Promise<DwTrack[]> {
  const token = await freshAccessToken(file, fetchFn)
  if (!token) return []
  const res = await fetchFn(`${API}/me/top/tracks?time_range=${range}&limit=50`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return []
  const data = await res.json() as { items?: Array<{ name?: string; artists?: Array<{ name?: string }>; album?: { name?: string } }> }
  return (data.items || [])
    .filter((t) => t?.name && t.artists?.[0]?.name)
    .map((t) => ({ song: t.name!, artist: t.artists![0].name!, album: t.album?.name }))
}

export async function fetchLikedRecent(file: string, pages = 2, fetchFn: typeof fetch = fetch): Promise<DwTrack[]> {
  const token = await freshAccessToken(file, fetchFn)
  if (!token) return []
  const out: DwTrack[] = []
  let url: string | null = `${API}/me/tracks?limit=50`
  for (let i = 0; i < pages && url; i++) {
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) break
    const data = await res.json() as { items?: Array<{ track?: { name?: string; artists?: Array<{ name?: string }>; album?: { name?: string } } }>; next?: string | null }
    for (const it of data.items || []) {
      const t = it?.track
      if (t?.name && t.artists?.[0]?.name) out.push({ song: t.name, artist: t.artists[0].name, album: t.album?.name })
    }
    url = typeof data.next === 'string' ? data.next : null
  }
  return out
}
