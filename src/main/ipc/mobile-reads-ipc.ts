/**
 * Mobile-state read IPC: windowed play counts, phone stars/playlists,
 * homemini daily mixes + vibe mix (with the desktop-side decade/orbit
 * safety net), playlist additions.
 *
 * Extracted from main/index.ts (6.0 Phase 1 IPC migration) — bodies
 * verbatim; sidecar caches + rag year map arrive via the host.
 */
import { join } from 'path'
import { open, readFile, unlink } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { STATE_DIR } from '../state-dir'
import { parseDecadeConstraint, yearInDecade } from '../ai/decade-query'
import { getEmbeddingsMap as ragGetEmbeddingsMap } from '../ai/embeddings'
import { filterOrbitNeighbors, parseOrbitSeed, resolveOrbitSeedIds } from '../ai/orbit-quality'
import { mergeStarIds } from '../mobile-stars-merge'
import { safeIpcError } from '../safe-ipc-error'
import { tombstonesPath as playlistTombstonesPath, loadTombstones as loadPlaylistTombstones } from '../playlist-tombstones.ts'
import type { MobilePlaylistRecord } from '../index.ts'

export interface MobileReadsIpcHost {
  getPlayEventsPath: () => string
  libraryCache: { get: () => Promise<unknown> }
  mobileStarsCache: {
    get: () => Promise<{ trackIds: string[] }>
    update: (fn: (current: { trackIds: string[] }) => { trackIds: string[] }) => Promise<void>
  }
  mobilePlaylistsCache: { get: () => Promise<{ playlists: MobilePlaylistRecord[] }> }
  ragTrackYearMap: () => Promise<Map<number, string | number | undefined>>
  playlistAdditionsCache: { get: () => Promise<Record<string, string[]>> }
}

export function registerMobileReadsIpc(ipc: IpcRegistrar, host: MobileReadsIpcHost): { writeMobileStarSidecar: (trackId: number, starred: boolean) => Promise<void> } {
  ipc.handle('get-windowed-play-counts', async (_e, windowMs: number): Promise<{ ok: boolean; counts: Record<string, number> }> => {
    try {
      const cutoff = Date.now() - Math.max(0, windowMs)
      const raw = await readFile(host.getPlayEventsPath(), 'utf-8').catch(() => '')
      const counts: Record<string, number> = {}
      let parseErrors = 0
      for (const line of raw.split('\n')) {
        if (!line) continue
        try {
          const evt = JSON.parse(line) as { id?: number; ts?: number }
          if (typeof evt.id !== 'number' || typeof evt.ts !== 'number') continue
          if (evt.ts < cutoff) continue
          const k = String(evt.id)
          counts[k] = (counts[k] || 0) + 1
        } catch { parseErrors++ }
      }
      if (parseErrors > 0) console.warn(`[play-events] ${parseErrors} malformed lines (skipped)`)
      return { ok: true, counts }
    } catch (err) {
      console.warn('[play-events] read failed:', err)
      return { ok: false, counts: {} }
    }
  }, { public: true })
  // 4.5.0-106 Phase 2.5: now backed by host.mobileStarsCache. The legacy
  // "writeMobileStarSidecar -> readFile NAS / rename" chain was a per-star
  // SMB round-trip; the cache makes the read free, the mutate synchronous,
  // and the NAS flush a fire-and-forget background job.
  async function readMobileStarsSet(): Promise<Set<string>> {
    const parsed = await host.mobileStarsCache.get()
    const ids = Array.isArray(parsed?.trackIds) ? parsed.trackIds : []
    return new Set(ids.filter((x): x is string => typeof x === 'string'))
  }
  async function writeMobileStarSidecar(trackId: number, starred: boolean): Promise<void> {
    await host.mobileStarsCache.update((current) => {
      const set = new Set(Array.isArray(current?.trackIds) ? current.trackIds : [])
      const key = String(trackId)
      if (starred) set.add(key); else set.delete(key)
      return { trackIds: Array.from(set).sort() }
    })
  }

  // Sync B-pass (2026-06-07) — fold phone-side stars in under local-primary.
  // The app is the SOLE writer of the local mobile-stars.json (via the cache), so
  // the sync script must NOT write it directly (that would race the cache). The
  // script instead stages homemini's set at mobile-stars.incoming.json; this
  // unions it into the local set on the app's own terms, then consumes the file.
  // Additive (mobile-stars-merge.ts) — a star on either device survives. Returns
  // the count of NEW ids added (0 = nothing was pending).
  async function mergeIncomingMobileStars(): Promise<number> {
    const incomingPath = join(STATE_DIR, 'mobile-stars.incoming.json')
    let incoming: string[] = []
    try {
      const parsed = JSON.parse(await readFile(incomingPath, 'utf-8')) as { trackIds?: unknown }
      incoming = Array.isArray(parsed?.trackIds)
        ? parsed.trackIds.filter((x): x is string => typeof x === 'string')
        : []
    } catch {
      return 0   // no staging file (the common case) — nothing to merge
    }
    let added = 0
    if (incoming.length > 0) {
      await host.mobileStarsCache.update((current) => {
        const local = Array.isArray(current?.trackIds) ? current.trackIds : []
        const merged = mergeStarIds(local, incoming)
        added = merged.length - new Set(local).size
        return { trackIds: merged }
      })
    }
    // Consume the staging file so the same set isn't re-merged on every read.
    await unlink(incomingPath).catch(() => { /* already gone — fine */ })
    if (added > 0) console.log(`[mobile-stars] merged ${added} incoming phone star(s) from sync`)
    return added
  }

  ipc.handle('load-mobile-stars', async (): Promise<{ ok: boolean; trackIds: string[] }> => {
    await mergeIncomingMobileStars()   // fold in any phone stars the last sync staged
    const set = await readMobileStarsSet()
    return { ok: true, trackIds: Array.from(set) }
  }, { public: true })

  // Brief 121 — read iOS-created playlists. Schema on disk:
  //   { playlists: [{ id: "mobile:UUID", name, trackIds: string[], createdAt, source: "mobile" }] }
  // Always returns ok:true with an empty list on missing/torn file — the
  // JsonFileCache fallback path already handles that, and the renderer
  // merges whatever it gets into the sidebar playlist list.
  ipc.handle('read-mobile-playlists', async (): Promise<{ ok: boolean; playlists: MobilePlaylistRecord[] }> => {
    try {
      const data = await host.mobilePlaylistsCache.get()
      const playlists = Array.isArray(data?.playlists) ? data.playlists : []
      // Tombstone gate (2026-08-28): a mobile playlist Jake deleted on the
      // desktop must not resurrect on the next boot merge — the Brief-121
      // append was gated on existence, not deletion ("existence is not
      // memory"). The mirror stays read-only; only the VIEW filters.
      const dead = new Set((await loadPlaylistTombstones(playlistTombstonesPath(STATE_DIR))).map((t: { id: string | number }) => String(t.id)))
      return { ok: true, playlists: playlists.filter((p) => !dead.has(String(p.id))) }
    } catch {
      return { ok: true, playlists: [] }
    }
  }, { public: true })

  // 4.5: "Your Mixes" — pull the SAME daily mixes the iOS app shows, from the
  // mobile backend on homemini (single source of truth so desktop ↔ mobile match
  // exactly). The backend themes + caches them daily and merges phone+desktop
  // play history. We return only trackIds; the renderer resolves them to local
  // Track objects for playback. Any failure (backend down / off-tailnet) → ok:false
  // and the Home section quietly hides. See JakeTunesMobile backend/src/routes/mixes.ts.
  //
  // Desktop safety nets until Mobile twins land at generation time:
  //   1. Decade hard-gate — title/subtitle claims an era → strip out-of-year tracks.
  //   2. Orbit quality floor — "orbit of X" / "Because You Played Y" → re-score
  //      neighbors against the seed embedding and drop weak false matches
  //      (RHCP in a Robson Jorge orbit). Same lesson as playlist-vibes SOAD floor.
  const MOBILE_MIXES_BACKEND = 'http://homemini:3000'

  async function applyOrbitQualityFloor(
    title: string,
    subtitle: string,
    trackIds: number[],
  ): Promise<number[]> {
    const seedRef = parseOrbitSeed(title, subtitle)
    if (!seedRef || trackIds.length === 0) return trackIds
    try {
      const emb = await ragGetEmbeddingsMap()
      if (emb.size === 0) return trackIds
      const lib = (await host.libraryCache.get()) as {
        tracks?: Array<{ id: number; title?: string; artist?: string; albumArtist?: string }>
      }
      const library = lib.tracks || []
      const seedIds = resolveOrbitSeedIds(seedRef, library)
      const seedVecs = seedIds.map((id) => emb.get(id)).filter((v): v is Float32Array => !!v)
      if (seedVecs.length === 0) return trackIds
      const candidates = trackIds
        .map((id) => {
          const vec = emb.get(id)
          return vec ? { trackId: id, vec } : null
        })
        .filter((c): c is { trackId: number; vec: Float32Array } => !!c)
      const kept = filterOrbitNeighbors(seedVecs, candidates, {
        alwaysKeep: new Set(seedIds),
      })
      if (kept.length === 0) return trackIds // fail open — don't blank the card
      if (kept.length < trackIds.length) {
        console.warn(
          `[mobile-mixes] orbit quality floor on "${title}": kept ${kept.length}/${trackIds.length} ` +
            `(seed=${seedRef.kind}:${seedRef.query})`,
        )
      }
      // Preserve original mix order among survivors (not re-rank by score) so
      // the tape's sequencing intent survives; only the junk is removed.
      const keepSet = new Set(kept.map((k) => k.trackId))
      return trackIds.filter((id) => keepSet.has(id))
    } catch (err) {
      console.warn('[mobile-mixes] orbit floor skipped:', err instanceof Error ? err.message : err)
      return trackIds
    }
  }

  ipc.handle('get-mobile-mixes', async (): Promise<{ ok: boolean; date?: string; mixes?: Array<{ id: string; title: string; subtitle: string; trackIds: number[] }>; error?: string }> => {
    try {
      const res = await fetch(`${MOBILE_MIXES_BACKEND}/api/mixes`, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) return { ok: false, error: `backend ${res.status}` }
      const body = await res.json() as { date?: string; mixes?: Array<{ id?: string; title?: string; subtitle?: string; tracks?: Array<{ id?: string | number }> }> }
      const years = await host.ragTrackYearMap()
      const mixes: Array<{ id: string; title: string; subtitle: string; trackIds: number[] }> = []
      for (const m of body.mixes || []) {
        const title = String(m.title ?? 'Mix')
        const subtitle = String(m.subtitle ?? '')
        const decade = parseDecadeConstraint(`${title} ${subtitle}`)
        let trackIds = (m.tracks || []).map(t => Number(t.id)).filter(n => Number.isFinite(n))
        if (decade && trackIds.length) {
          const before = trackIds.length
          trackIds = trackIds.filter(id => yearInDecade(years.get(id), decade))
          if (trackIds.length < before) {
            console.warn(`[mobile-mixes] decade hard-gate ${decade.label} on "${title}": kept ${trackIds.length}/${before} (stripped ${before - trackIds.length} out-of-era)`)
          }
        }
        trackIds = await applyOrbitQualityFloor(title, subtitle, trackIds)
        if (trackIds.length > 0) mixes.push({ id: String(m.id ?? ''), title, subtitle, trackIds })
      }
      return { ok: true, date: body.date, mixes }
    } catch (e) {
      return { ok: false, error: safeIpcError(e, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })
  ipc.handle('get-mobile-vibe-mix', async (_e, vibe: string): Promise<{ ok: boolean; mix?: { id: string; title: string; subtitle: string; trackIds: number[] }; error?: string }> => {
    try {
      const res = await fetch(`${MOBILE_MIXES_BACKEND}/api/mixes/vibe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vibe: String(vibe ?? '').slice(0, 200) }),
        signal: AbortSignal.timeout(25000),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        return { ok: false, error: err.error || `backend ${res.status}` }
      }
      const m = await res.json() as { id?: string; title?: string; subtitle?: string; tracks?: Array<{ id?: string | number }> }
      return { ok: true, mix: {
        id: String(m.id ?? ''),
        title: String(m.title ?? vibe),
        subtitle: String(m.subtitle ?? ''),
        trackIds: (m.tracks || []).map(t => Number(t.id)).filter(n => Number.isFinite(n)),
      } }
    } catch (e) {
      return { ok: false, error: safeIpcError(e, 'api-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  // Brief 121 — read iOS-side additions to V3-owned playlists. Schema:
  //   { [v3PlaylistId: string]: trackId[] }   (trackIds as strings)
  // Same error tolerance as mobile-playlists.
  ipc.handle('read-playlist-additions', async (): Promise<{ ok: boolean; additions: Record<string, string[]> }> => {
    try {
      const data = await host.playlistAdditionsCache.get()
      const additions: Record<string, string[]> = {}
      if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
          if (Array.isArray(v)) additions[k] = v.filter((x): x is string => typeof x === 'string')
        }
      }
      return { ok: true, additions }
    } catch {
      return { ok: true, additions: {} }
    }
  }, { public: true })

  return { writeMobileStarSidecar }
}
