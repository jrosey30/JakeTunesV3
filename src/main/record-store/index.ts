// Music Man's Record Store — main-process registration (Brief 037 §6)
//
// PHASE 0 SCOPE: this module ships IPC handlers and a heuristic shelf
// builder (no LLM, no day-theme, no blurbs). Goal is to prove the
// plumbing end-to-end: open the store → see 3 shelves of real library
// albums → click an item → it plays.
//
// Phase 1 will replace heuristicBuildShelves() with the day-theme +
// library-grounded Sonnet call described in Brief 037 §3.

import { ipcMain, BrowserWindow } from 'electron'
import { readFile } from 'fs/promises'
import { RecordStoreCache } from './cache'
import type {
  Persona,
  Shelf,
  ShelfBundle,
  ShelfItem,
  Blurb,
} from './types'

// ── Public registration surface ──────────────────────────────────────

export interface RecordStoreDeps {
  /** Absolute path to library.json (already loaded elsewhere; this
   *  module reads it lazily on each shelf request in Phase 0). */
  libraryPath: string
  /** Absolute path of the JakeTunes user-data dir (where the cache
   *  lives). Pass app.getPath('userData'). */
  userDataDir: string
  getMainWindow: () => BrowserWindow | null
}

let registered = false

export function registerRecordStoreIntegration(deps: RecordStoreDeps): void {
  // electron-vite main-process HMR can call this twice; the second call
  // would re-register handlers and crash. Guard with module-level flag.
  if (registered) return
  registered = true

  const cache = new RecordStoreCache(deps.userDataDir)

  // record-store:get-shelves — Phase 0 returns a heuristic ShelfBundle
  // built from the live library. Cached for 24h per local-calendar-date
  // so the store has stable content all day (the "first-open-of-day"
  // rule from §2 D1).
  ipcMain.handle('record-store:get-shelves', async (_e, opts?: { forceRefresh?: boolean }) => {
    const dateISO = todayLocalISODate()

    if (!opts?.forceRefresh) {
      const cached = await cache.getShelfBundle(dateISO)
      if (cached) return cached
    }

    const tracks = await loadLibraryTracks(deps.libraryPath)
    const bundle = heuristicBuildShelves(tracks, dateISO)
    await cache.putShelfBundle(bundle)
    // Best-effort housekeeping; doesn't block the response.
    void cache.pruneOldShelves()
    return bundle
  })

  // record-store:get-blurb — Phase 0 stub. Returns a placeholder string
  // so the renderer can still wire the click-to-speak path. Phase 1
  // replaces this with a Haiku call wrapped in MUSIC_MAN_CORE.
  ipcMain.handle(
    'record-store:get-blurb',
    async (_e, args: { itemId: string; persona: Persona }): Promise<Blurb> => {
      const existing = await cache.getBlurb(args.persona, args.itemId)
      if (existing) return existing
      const blurb: Blurb = {
        itemId: args.itemId,
        persona: args.persona,
        text: '[blurb engine — Phase 1 stub. Real Music Man take coming.]',
        generatedAt: Date.now(),
        source: 'cached',
      }
      await cache.putBlurb(blurb)
      return blurb
    },
  )

  // record-store:speak-blurb — Phase 0 stub. Phase 2 wires this to the
  // existing ElevenLabs TTS bridge + the duck pattern from Radio Mode.
  ipcMain.handle(
    'record-store:speak-blurb',
    async (_e, _args: { blurb: Blurb }): Promise<{ ok: true; audioId: string }> => {
      // Phase 2 will fan out to TTS + dispatch the musicman-speaking-*
      // CustomEvents so playback ducks/restores correctly. For now just
      // ack with a synthetic audio id so the renderer's cancel path is
      // exercisable.
      return { ok: true, audioId: `phase0-stub-${Date.now()}` }
    },
  )

  ipcMain.handle(
    'record-store:cancel-speech',
    async (_e, _args: { audioId: string }): Promise<{ ok: true }> => {
      return { ok: true }
    },
  )
}

// ── Internals ────────────────────────────────────────────────────────

/** Local-time YYYY-MM-DD so the cache rolls over at the user's
 *  midnight, not UTC midnight. */
function todayLocalISODate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Minimal Track shape this module needs. Mirror of the renderer
 *  Track interface but importing from there would cross the
 *  main/renderer barrier — duplicate the few fields we use here. */
interface LibTrack {
  id: number
  title: string
  artist: string
  albumArtist?: string
  album: string
  dateAdded: string
  playCount: number
}

async function loadLibraryTracks(libraryPath: string): Promise<LibTrack[]> {
  try {
    const raw = await readFile(libraryPath, 'utf-8')
    const parsed = JSON.parse(raw) as { tracks?: LibTrack[] }
    return Array.isArray(parsed.tracks) ? parsed.tracks : []
  } catch (err) {
    console.warn('[record-store] loadLibraryTracks failed:', err)
    return []
  }
}

// ── Heuristic shelf builder (Phase 0) ────────────────────────────────
//
// Phase 0 ships 3 shelves of 5 albums each, picked deterministically
// from the library. Tracks are grouped into "album units" keyed by
// `${album}::${albumArtist || artist}`. The brief's "tears of joy"
// quality bar applies to Phase 1 (the LLM-driven curator) — Phase 0
// just exists to prove plumbing and never crashes.

interface AlbumUnit {
  albumKey: string
  album: string
  artist: string
  trackIds: number[]
  totalPlays: number
  maxDateAdded: string
}

function groupAlbums(tracks: LibTrack[]): AlbumUnit[] {
  const map = new Map<string, AlbumUnit>()
  for (const t of tracks) {
    if (!t.album) continue
    const artist = (t.albumArtist && t.albumArtist.trim()) || (t.artist || '').trim()
    if (!artist) continue
    const key = `${t.album}::${artist}`
    let unit = map.get(key)
    if (!unit) {
      unit = {
        albumKey: key,
        album: t.album,
        artist,
        trackIds: [],
        totalPlays: 0,
        maxDateAdded: t.dateAdded || '',
      }
      map.set(key, unit)
    }
    unit.trackIds.push(t.id)
    unit.totalPlays += Number(t.playCount) || 0
    if (t.dateAdded && t.dateAdded > unit.maxDateAdded) {
      unit.maxDateAdded = t.dateAdded
    }
  }
  return Array.from(map.values())
}

function unitToShelfItem(u: AlbumUnit, placement: string): ShelfItem {
  return {
    id: `lib:album:${u.albumKey}`,
    kind: 'library-album',
    coverUrl: null, // Phase 0 — art comes in Phase 2
    title: u.album,
    subtitle: u.artist,
    placement,
    payload: { trackIds: u.trackIds.map(String) },
  }
}

function heuristicBuildShelves(tracks: LibTrack[], dateISO: string): ShelfBundle {
  const albums = groupAlbums(tracks)

  // mm-picks: top 5 by total playCount (your most-loved records).
  const mmPicks = [...albums].sort((a, b) => b.totalPlays - a.totalPlays).slice(0, 5)

  // new-arrivals: top 5 by max dateAdded (most recently imported).
  const newArrivals = [...albums]
    .filter((a) => a.maxDateAdded)
    .sort((a, b) => b.maxDateAdded.localeCompare(a.maxDateAdded))
    .slice(0, 5)

  // deep-cuts: 5 from the bottom 30% by playCount, with at least one
  // play recorded (filters out things that were never played at all
  // OR things that are just metadata-stubs). Pick deterministically
  // so the same date yields the same picks all day.
  const eligible = albums.filter((a) => a.totalPlays > 0)
  eligible.sort((a, b) => a.totalPlays - b.totalPlays)
  const longTail = eligible.slice(0, Math.max(5, Math.floor(eligible.length * 0.3)))
  const deepCuts = pickDeterministic(longTail, dateISO, 5)

  const shelves: Shelf[] = [
    {
      id: 'mm-picks',
      curator: 'music-man',
      title: "Music Man's Picks",
      tagline: 'The records I keep reaching for. No comment.',
      items: mmPicks.map((u) =>
        unitToShelfItem(u, 'top of the rotation right now'),
      ),
    },
    {
      id: 'new-arrivals',
      curator: 'house',
      title: 'New Arrivals',
      tagline: "What's come in lately.",
      items: newArrivals.map((u) =>
        unitToShelfItem(u, 'just landed on the shelf'),
      ),
    },
    {
      id: 'deep-cuts',
      curator: 'music-man',
      title: 'Deep Cuts',
      tagline: "Records you bought and then didn't quite get to.",
      items: deepCuts.map((u) =>
        unitToShelfItem(u, "from the back of the bin — give it another listen"),
      ),
    },
  ]

  const now = Date.now()
  return {
    date: dateISO,
    generatedAt: now,
    validUntil: now + 24 * 60 * 60 * 1000,
    theme: {
      date: dateISO,
      theme: "Today's wall",
      rationale: 'Phase 0 heuristic — real day-theme engine lands in Phase 1.',
      source: 'mood',
    },
    shelves,
    source: 'heuristic',
  }
}

/** Deterministic per-date pick from a candidate set. Uses a simple
 *  string-hash of (dateISO + index) so today's deep-cuts are stable
 *  for the whole day but rotate across days. */
function pickDeterministic<T>(pool: T[], dateISO: string, n: number): T[] {
  if (pool.length <= n) return pool
  const scored = pool.map((item, i) => ({
    item,
    score: hash32(`${dateISO}::${i}`),
  }))
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, n).map((s) => s.item)
}

function hash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}
