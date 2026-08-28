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
  loadAuth, saveAuth, connectSpotify, fetchDiscoverWeekly, SPOTIFY_REDIRECT_URI,
} from './spotify-connect.ts'

export interface SpotifyIpcHost {
  authFile: string
  openExternal: (url: string) => void
  /** Brain scores for candidate tracks (null = brain unavailable). */
  scoreCandidates: (cands: Array<{ artist: string; title: string }>) => Promise<number[] | null>
  /** The normal list-add path — dedupe + tombstones + attribution included. */
  addRecommendation: (input: { song: string; artist: string; album?: string; note: string; source: string }) => Promise<{ ok: boolean; deduped?: boolean }>
}

/** Below this brain score a DW track stays off the list — the same
 *  hard floor the Record Shop uses for a shelf spot. */
export const DW_BRAIN_FLOOR = 52
const PULL_EVERY_MS = 6 * 24 * 3600 * 1000   // "weekly", tolerant of drift

export async function pullDiscoverWeekly(host: SpotifyIpcHost): Promise<{ ok: boolean; added?: number; scored?: number; error?: string }> {
  const dw = await fetchDiscoverWeekly(host.authFile)
  if (!dw.ok || !dw.tracks) return { ok: false, error: dw.error }
  if (dw.tracks.length === 0) return { ok: true, added: 0, scored: 0 }
  const pcts = await host.scoreCandidates(dw.tracks.map((t) => ({ artist: t.artist, title: t.song })))
  let added = 0
  for (let i = 0; i < dw.tracks.length; i++) {
    const pct = pcts?.[i]
    // Brain down = don't gate blind; brain up = the floor decides.
    if (pcts && (pct === undefined || pct < DW_BRAIN_FLOOR)) continue
    const t = dw.tracks[i]
    const note = pcts ? `Discover Weekly · brain ${Math.round(pcts[i])}%` : 'Discover Weekly'
    const r = await host.addRecommendation({ song: t.song, artist: t.artist, album: t.album, note, source: 'spotify' })
    if (r.ok && !r.deduped) added++
  }
  const auth = await loadAuth(host.authFile)
  auth.lastPullAt = new Date().toISOString()
  await saveAuth(auth, host.authFile)
  console.log(`[spotify] Discover Weekly: ${dw.tracks.length} tracks, ${added} added (floor ${DW_BRAIN_FLOOR})`)
  return { ok: true, added, scored: dw.tracks.length }
}

/** Weekly cadence check — called on boot and every 12h. */
export async function pullIfDue(host: SpotifyIpcHost): Promise<void> {
  const auth = await loadAuth(host.authFile)
  if (!auth.refreshToken) return   // not connected — silent
  const last = Date.parse(auth.lastPullAt || '') || 0
  if (Date.now() - last < PULL_EVERY_MS) return
  const r = await pullDiscoverWeekly(host)
  if (!r.ok) console.warn('[spotify] weekly pull failed:', r.error)
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
    return await pullDiscoverWeekly(host)
  }, { refuse: REFUSED_SENDER })

  setTimeout(() => { void pullIfDue(host) }, 90_000)
  setInterval(() => { void pullIfDue(host) }, 12 * 3600 * 1000)
}
