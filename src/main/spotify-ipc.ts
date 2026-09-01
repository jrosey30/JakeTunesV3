/**
 * Spotify IPC + the weekly Discover Weekly pull (2026-08-28).
 *
 * Flow: Jake creates a free Spotify dev app once (redirect URI
 * http://127.0.0.1:48213/callback), pastes its Client ID in Settings,
 * clicks Connect (PKCE, loopback — no client secret exists), and from
 * then on the pull runs weekly: every Discover Weekly track is scored by
 * the brain and the shelf-worthy ones land on Listen to the List tagged
 * source 'spotify' ("get Discover Weekly into the brain", 2026-07-14).
 * Dedupe/tombstones ride the normal add path, so a tossed track stays
 * tossed.
 */
import type { IpcRegistrar } from './ipc-register.ts'
import { REFUSED_SENDER } from './ipc-register.ts'
import {
  loadAuth, saveAuth, connectSpotify, fetchTopTracks, fetchLikedRecent, SPOTIFY_REDIRECT_URI,
} from './spotify-connect.ts'
import { aggregateTopArtists, saveSpotifyTaste } from './spotify-taste.ts'
import { pullCuratorPool } from './spotify-curators.ts'

export interface SpotifyIpcHost {
  authFile: string
  /** Where the weekly taste pull lands (read by the shop's anchor pool). */
  tasteFile: string
  /** Curator roster + harvested pool (read by the shop's New Songs lane). */
  curatorsFile: string
  curatorPoolFile: string
  openExternal: (url: string) => void
}

const PULL_EVERY_MS = 6 * 24 * 3600 * 1000   // "weekly", tolerant of drift

/**
 * The taste pull (2026-08-28, "wire in the taste signal they use"):
 * Discover Weekly itself is API-dead for personal apps (Nov 2024), but
 * his OWN Spotify listening — the input DW fed on — is still readable.
 * Top tracks (short + medium term) and recent likes land in
 * spotify-taste.json; the Record Shop's anchor pool reads the ranked
 * artists so the Deezer graph digs from the Spotify side of his ear.
 */
export async function pullSpotifyTaste(host: SpotifyIpcHost): Promise<{ ok: boolean; topArtists?: string[]; tracks?: number; error?: string }> {
  const [short, medium, liked] = await Promise.all([
    fetchTopTracks(host.authFile, 'short_term'),
    fetchTopTracks(host.authFile, 'medium_term'),
    fetchLikedRecent(host.authFile, 2),
  ])
  const total = short.length + medium.length + liked.length
  if (total === 0) return { ok: false, error: 'Spotify returned no listening — connected?' }
  const topArtists = aggregateTopArtists([
    { tracks: short, weight: 3 },
    { tracks: medium, weight: 2 },
    { tracks: liked, weight: 1 },
  ], 8)
  await saveSpotifyTaste({ topArtists, topTracks: [...short, ...medium], likedRecent: liked, pulledAt: new Date().toISOString() }, host.tasteFile)
  const auth = await loadAuth(host.authFile)
  auth.lastPullAt = new Date().toISOString()
  await saveAuth(auth, host.authFile)
  console.log(`[spotify] taste pull: ${total} tracks → top artists: ${topArtists.slice(0, 5).join(', ')}`)
  return { ok: true, topArtists, tracks: total }
}

/** Weekly cadence check — called on boot and every 12h. */
export async function pullIfDue(host: SpotifyIpcHost): Promise<void> {
  const auth = await loadAuth(host.authFile)
  if (!auth.refreshToken) return   // not connected — silent
  const last = Date.parse(auth.lastPullAt || '') || 0
  if (Date.now() - last < PULL_EVERY_MS) return
  const r = await pullSpotifyTaste(host)
  if (!r.ok) console.warn('[spotify] weekly taste pull failed:', r.error)
  const c = await pullCuratorPool({ authFile: host.authFile, curatorsFile: host.curatorsFile, poolFile: host.curatorPoolFile })
  if (!c.ok) console.warn('[spotify] curator pool pull failed:', c.error)
}

export function registerSpotifyIpc(ipc: IpcRegistrar, host: SpotifyIpcHost): void {
  ipc.handle('spotify-status', async () => {
    const auth = await loadAuth(host.authFile)
    return {
      ok: true,
      hasClientId: Boolean(auth.clientId),
      connected: Boolean(auth.refreshToken),
      connectedAt: auth.connectedAt,
      lastPullAt: auth.lastPullAt,
      redirectUri: SPOTIFY_REDIRECT_URI,
    }
  }, { public: true })

  ipc.handle('spotify-set-client-id', async (_e, clientId: string) => {
    const clean = String(clientId || '').trim()
    if (!/^[a-f0-9]{32}$/i.test(clean)) return { ok: false, error: 'That does not look like a Spotify Client ID.' }
    const auth = await loadAuth(host.authFile)
    auth.clientId = clean
    await saveAuth(auth, host.authFile)
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('spotify-connect', async () => {
    return await connectSpotify(host.authFile, host.openExternal)
  }, { refuse: REFUSED_SENDER })

  ipc.handle('spotify-disconnect', async () => {
    const auth = await loadAuth(host.authFile)
    await saveAuth({ clientId: auth.clientId }, host.authFile)
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('spotify-pull-now', async () => {
    const taste = await pullSpotifyTaste(host)
    const curators = await pullCuratorPool({ authFile: host.authFile, curatorsFile: host.curatorsFile, poolFile: host.curatorPoolFile })
    return { ...taste, curatorSongs: curators.songs ?? 0 }
  }, { refuse: REFUSED_SENDER })

  setTimeout(() => { void pullIfDue(host) }, 90_000)
  setInterval(() => { void pullIfDue(host) }, 12 * 3600 * 1000)
}
