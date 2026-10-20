/**
 * Mobile-state read IPC: windowed play counts, phone stars,
 * homemini daily mixes + vibe mix (with the desktop-side decade/orbit
 * safety net). Phone playlists: phone-playlist-sync.ts.
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
import {
  normalizeStarSidecar,
  mergeStarStates,
  applyStarChange,
  starSidecarForWrite,
  type StarSidecarData,
} from '../mobile-stars-merge'
import { safeIpcError } from '../safe-ipc-error'
import { withCompanionInit } from '../hub-companion.ts'
import { registerPlaysElsewhereIpc } from './plays-elsewhere-ipc.ts'
import { addWindowed } from '../../common/plays-elsewhere.ts'

export interface MobileReadsIpcHost {
  getPlayEventsPath: () => string
  libraryCache: { get: () => Promise<unknown> }
  // Brief 172: the sidecar is format v2 ({v, trackIds, removed, added});
  // the cache stores it whole. v1 files ({trackIds} only) still satisfy
  // this shape — normalizeStarSidecar handles them at every read.
  mobileStarsCache: {
    get: () => Promise<StarSidecarData>
    update: (fn: (current: StarSidecarData) => StarSidecarData) => Promise<void>
  }
  ragTrackYearMap: () => Promise<Map<number, string | number | undefined>>
  /** true on a replica (workmini): plays heard elsewhere are not added there. */
  isReplica: () => Promise<boolean>
}

export function registerMobileReadsIpc(ipc: IpcRegistrar, host: MobileReadsIpcHost): { writeMobileStarSidecar: (trackId: number, starred: boolean) => Promise<void> } {
  // 2026-10-20 — the phone's and workmini's plays count here too (display only).
  const elsewhere = registerPlaysElsewhereIpc(ipc, { isReplica: host.isReplica })
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
      return { ok: true, counts: addWindowed(counts, await elsewhere.windowed(cutoff).catch(() => ({}))) }
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
    return new Set(normalizeStarSidecar(parsed).trackIds)
  }
  async function writeMobileStarSidecar(trackId: number, starred: boolean): Promise<void> {
    // Brief 172: an un-star now writes a tombstone (removed[id] = now) and
    // a star writes an add timestamp, so the change survives the sync
    // round-trip instead of resurrecting from the other device's copy.
    // First write also migrates a v1 sidecar to v2 (removed starts {} —
    // removals the old format never recorded stay unknown).
    await host.mobileStarsCache.update((current) => {
      const next = applyStarChange(normalizeStarSidecar(current), String(trackId), starred, Date.now())
      return starSidecarForWrite(next)
    })
  }

  // Sync B-pass (2026-06-07) — fold phone-side stars in under local-primary.
  // The app is the SOLE writer of the local mobile-stars.json (via the cache), so
  // the sync script must NOT write it directly (that would race the cache). The
  // script instead stages homemini's set at mobile-stars.incoming.json; this
  // merges it into the local set on the app's own terms, then consumes the file.
  // Brief 172: the merge is tombstone-aware last-writer-wins per id
  // (mobile-stars-merge.ts) — an un-star on EITHER device now survives,
  // where the 2026-06-07 additive union resurrected it. The staging file
  // may be v1 or v2; both parse. Returns the count of NEW ids added
  // (0 = nothing was pending).
  async function mergeIncomingMobileStars(): Promise<number> {
    const incomingPath = join(STATE_DIR, 'mobile-stars.incoming.json')
    let incomingRaw: unknown
    try {
      incomingRaw = JSON.parse(await readFile(incomingPath, 'utf-8')) as unknown
    } catch {
      return 0   // no staging file (the common case) — nothing to merge
    }
    const incoming = normalizeStarSidecar(incomingRaw)
    let added = 0
    if (incoming.trackIds.length > 0 || Object.keys(incoming.removed).length > 0 || Object.keys(incoming.added).length > 0) {
      await host.mobileStarsCache.update((current) => {
        const local = normalizeStarSidecar(current)
        const merged = mergeStarStates(local, incoming)
        added = merged.trackIds.filter((id) => !local.trackIds.includes(id)).length
        return starSidecarForWrite(merged)
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

  // Brief 121's read-mobile-playlists / read-playlist-additions lived here.
  // Retired 2026-10-20: main folds the phone's playlist files in itself
  // (phone-playlist-sync.ts), newest edit wins per track, at launch AND live.
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
      const res = await fetch(`${MOBILE_MIXES_BACKEND}/api/mixes`, withCompanionInit({ signal: AbortSignal.timeout(20000) }))
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
      const res = await fetch(`${MOBILE_MIXES_BACKEND}/api/mixes/vibe`, withCompanionInit({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vibe: String(vibe ?? '').slice(0, 200) }),
        signal: AbortSignal.timeout(25000),
      }))
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

  return { writeMobileStarSidecar }
}
