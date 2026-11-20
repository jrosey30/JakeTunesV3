/**
 * A record's editions, for one-click Save album (Brief 255).
 *
 * A For You card or a Listen List row names an album by artist and title
 * only. main lists Apple's real editions of it and names the one a save takes
 * (main/album-editions.ts); this keeps the answer for the session, lets the
 * card's Edition menu change the pick, and turns the pick into the queue job
 * the Search tab's Save album would make for that edition.
 *
 * One lookup at a time, a little apart: a Listen List with forty albums must
 * not burst Apple's search (it answers 403 to a burst). Nothing is asked on
 * mount: hovering or focusing an album card or row asks (in turn), and opening
 * the menu, opening the songs, or a Save album click asks at the front of the
 * line, ahead of every lookup still waiting. A lookup that failed is not asked
 * again by a hover for a minute (FAILED_QUIET_MS); a click still asks.
 */
import { albumQueryId, trackQueryId, type QResult, type QueueOrigin } from './downloadQueue.ts'
import { norm } from './downloadKeys.ts'
import type { AlbumEdition, AlbumEditions, AlbumSaveEdition, AlbumSaveSurface } from '../../../common/album-preflight.ts'

export interface EditionsState {
  /** failed: the last lookup got no answer. Not kept: a click asks again at once, a hover after a minute. */
  state: 'idle' | 'loading' | 'ready' | 'failed'
  editions: AlbumEdition[]
  /** Jake's pick from the menu, else main's choice, else null (no edition named). */
  chosenId: number | null
  picked: boolean
}

const SPACING_MS = 250
/** A failed lookup: hovers leave it alone this long (a click, Save album or the songs still ask). */
export const FAILED_QUIET_MS = 60_000
let now: () => number = () => Date.now()
const IDLE: EditionsState = { state: 'idle', editions: [], chosenId: null, picked: false }

const answers = new Map<string, AlbumEditions>()
const inflight = new Map<string, Promise<AlbumEditions>>()
const picks = new Map<string, number>()
/** A failed lookup's key → when it failed. */
const failed = new Map<string, number>()
const states = new Map<string, EditionsState>()
const subs = new Set<() => void>()

/** The lookups waiting their turn, front first. One runs at a time. */
interface Waiting { key: string; run: () => Promise<void> }
let waiting: Waiting[] = []
let running = false

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    for (let next = waiting.shift(); next; next = waiting.shift()) {
      // A subscriber that throws must not stop the line.
      try { await next.run() } catch { await new Promise((r) => setTimeout(r, SPACING_MS)) }
    }
  } finally { running = false }
}

/** Moves a waiting lookup to the front of the line (no-op once it has started). */
function toFront(key: string): void {
  const i = waiting.findIndex((w) => w.key === key)
  if (i > 0) waiting.unshift(...waiting.splice(i, 1))
}

const keyOf = (artist: string, album: string): string => albumQueryId(artist, album)
/** Every subscriber hears; one that throws is logged and never stops the others or the caller. */
const emit = (): void => {
  for (const f of subs) { try { f() } catch (err) { console.error('[album-editions] subscriber threw', err) } }
}

function rebuild(key: string): void {
  const a = answers.get(key)
  const loading = inflight.has(key)
  const pick = picks.get(key)
  const editions = a?.editions ?? []
  const picked = pick != null && editions.some((e) => e.collectionId === pick)
  states.set(key, {
    state: a ? 'ready' : loading ? 'loading' : failed.has(key) ? 'failed' : 'idle',
    editions,
    chosenId: picked ? pick! : a?.chosenId ?? null,
    picked,
  })
}

export function subscribeEditions(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/** Stable between changes (useSyncExternalStore). */
export function editionsState(artist: string, album: string): EditionsState {
  return states.get(keyOf(artist, album)) ?? IDLE
}

/**
 * The editions of a record, asked once per session (in turn with the others).
 * `front`: Jake is waiting on this one (a Save album click, the menu or the
 * songs opened), so it goes ahead of every lookup still waiting.
 */
export function loadEditions(artist: string, album: string, o: { front?: boolean } = {}): Promise<AlbumEditions> {
  const key = keyOf(artist, album)
  const have = answers.get(key)
  if (have) return Promise.resolve(have)
  const inFlight = inflight.get(key)
  if (inFlight) {
    if (o.front) toFront(key)
    return inFlight
  }
  const failedAt = failed.get(key)
  if (!o.front && failedAt != null && now() - failedAt < FAILED_QUIET_MS) {
    return Promise.resolve({ ok: false, editions: [], chosenId: null })
  }
  const api = typeof window !== 'undefined' ? window.electronAPI?.listAlbumEditions : undefined
  if (!api) {
    failed.set(key, now())
    rebuild(key); emit()
    return Promise.resolve({ ok: false, editions: [], chosenId: null })
  }
  failed.delete(key)
  const p = new Promise<AlbumEditions>((resolve) => {
    const task: Waiting = {
      key,
      run: async () => {
        let out: AlbumEditions = { ok: false, editions: [], chosenId: null }
        try {
          try { out = (await api(artist, album)) ?? out } catch { /* no answer: failed */ }
          inflight.delete(key)
          // A failed lookup is not kept: a click asks again, a hover after FAILED_QUIET_MS.
          if (out.ok) answers.set(key, out)
          else failed.set(key, now())
          rebuild(key); emit()
        } finally {
          // A subscriber that throws must not leave Save album (or the line) waiting.
          inflight.delete(key)
          resolve(out)
        }
        await new Promise((r) => setTimeout(r, SPACING_MS))
      },
    }
    if (o.front) waiting.unshift(task)
    else waiting.push(task)
  })
  inflight.set(key, p)
  rebuild(key); emit()
  void pump()
  return p
}

/**
 * The Edition menu shows only once Apple has answered with two or more
 * editions: never a placeholder that later disappears and slides the buttons
 * beside it under the pointer. Pure.
 */
export const showEditionMenu = (s: EditionsState): boolean => s.state === 'ready' && s.editions.length >= 2

/**
 * Which tracklist the songs sheet should show: an edition's id, 'name' (the
 * record by name, when no edition is named or the lookup failed), or null
 * (still looking, nothing loaded). `loaded` is what the sheet has loaded. It
 * changes only when the edition actually changes: a lookup asked again after
 * a failure (loading, then an answer) never swaps the songs, and the ticks,
 * from under Jake; only his pick from the menu does. Pure.
 */
export function tracklistSource(loaded: number | 'name' | null, s: EditionsState): number | 'name' | null {
  const resolved = s.state === 'ready' ? (s.chosenId ?? 'name') : s.state === 'failed' ? 'name' : null
  if (resolved == null) return loaded
  if (loaded === 'name' && resolved !== 'name' && !s.picked) return loaded
  return resolved
}

/** The Edition menu's pick. */
export function pickEdition(artist: string, album: string, collectionId: number): void {
  const key = keyOf(artist, album)
  picks.set(key, collectionId)
  rebuild(key); emit()
}

/** Apple's " - Single" / " - EP" stamp off the name, as the Search tab asks Qobuz.
 *  ⚠️ TWIN: DownloadView.tsx displayAlbumTitle. */
const plainName = (name: string): string => name.replace(/\s[-–—]\s*(EP|Single)$/i, '').trim() || name

/**
 * The job a Save album makes for this edition: the Search tab's albumQ for
 * that edition (its name, collection id, size, year and explicitness), or,
 * with no edition named, the record by name, which main resolves as it always
 * has. Pure.
 */
export function albumJobFor(o: {
  artist: string
  album: string
  edition: AlbumEdition | null
  editionFrom: AlbumSaveEdition
  surface: AlbumSaveSurface
  origin?: QueueOrigin
  clickedAt: number
}): QResult {
  const name = o.edition ? plainName(o.edition.name) : o.album
  return {
    kind: 'query', source: 'qobuz', mediaType: 'album',
    id: albumQueryId(o.artist, o.edition?.name ?? o.album),
    desc: `${name} — ${o.artist} (album)`,
    artist: o.artist,
    album: name,
    ...(o.edition ? {
      collectionId: o.edition.collectionId,
      trackCount: o.edition.trackCount,
      releaseYear: o.edition.releaseYear,
      cleanedSource: o.edition.explicitness === 'cleaned',
      explicitSource: o.edition.explicitness === 'explicit',
    } : {}),
    ...(o.origin ? { origin: o.origin } : {}),
    clickedAt: o.clickedAt,
    surface: o.surface,
    editionFrom: o.edition ? o.editionFrom : 'none',
  }
}

/** The edition a save takes right now (waits for the lookup, at most a few seconds). */
export async function editionToSave(artist: string, album: string): Promise<{ edition: AlbumEdition | null; from: AlbumSaveEdition }> {
  await loadEditions(artist, album, { front: true }).catch(() => null)
  const s = editionsState(artist, album)
  const edition = s.editions.find((e) => e.collectionId === s.chosenId) ?? null
  return { edition, from: edition ? (s.picked ? 'picked' : 'resolved') : 'none' }
}

// ── A few songs from the album (Brief 255, Jake: "saving only a few songs
// from the album if i want") ─────────────────────────────────────────────

/** One song of an edition's tracklist, as main's itunesAlbumTracks lists it. */
export interface EditionTrack { song: string; artist: string; album?: string; durationSecs?: number; releaseYear?: number; explicitness?: string; trackNumber?: number; discNumber?: number }

/** The library's ownership key for a song. ⚠️ TWIN: DownloadView libIndex / asSongRow. */
export const ownedKey = (title: string, artist: string): string => `${norm(title)}|${norm(artist)}`

/** "Save 1 song", "Save 3 songs". */
export const saveSongsLabel = (n: number): string => `Save ${n} song${n === 1 ? '' : 's'}`

/**
 * The song saves for the ticked songs of an edition: each is the Search tab's
 * own song save (DownloadView songQ) of that row of THIS edition, so its length
 * and album pin the recording on that record. Songs already in the library are
 * left out. A Listen List row's sender and share source ride along, but not the
 * row itself: a few songs don't fulfil an album jot, which stays on the list.
 */
export function songJobsFor(o: { tracks: readonly EditionTrack[]; ticked: Iterable<number>; owned: ReadonlySet<string>; albumName?: string; origin?: QueueOrigin }): QResult[] {
  const out: QResult[] = []
  const seen = new Set<number>()
  for (const i of o.ticked) {
    if (seen.has(i)) continue
    seen.add(i)
    const t = o.tracks[i]
    if (!t || !t.song || !t.artist || o.owned.has(ownedKey(t.song, t.artist))) continue
    const album = t.album || o.albumName
    out.push({
      kind: 'query', source: 'qobuz', mediaType: 'track',
      id: trackQueryId(t.artist, t.song),
      desc: `${t.song} — ${t.artist}`,
      artist: t.artist, title: t.song,
      album: album ? plainName(album) : undefined,
      durationMs: t.durationSecs ? t.durationSecs * 1000 : undefined,
      cleanedSource: t.explicitness === 'cleaned',
      explicitSource: t.explicitness === 'explicit',
      releaseYear: t.releaseYear,
      ...(o.origin ? { origin: { ...o.origin, recommendationIds: [], entryId: undefined } } : {}),
    })
  }
  return out
}

/** Tests only. */
export function resetEditionsForTests(): void {
  answers.clear(); inflight.clear(); picks.clear(); states.clear(); failed.clear(); waiting = []
  now = () => Date.now()
}

/** Tests only: the clock the failure memory reads. */
export function setEditionsClockForTests(clock: () => number): void { now = clock }

// ── The Record Shop's album page (Brief 256) ──────────────────────────────

/**
 * The editions the album page offers: Apple's editions of the record, with the
 * edition Jake clicked always among them (first, when Apple's list for the name
 * doesn't carry it: a search hit can be an edition the name lookup filters out).
 * Pure.
 */
export function editionsWithCard(editions: readonly AlbumEdition[], card: AlbumEdition | null): AlbumEdition[] {
  if (!card) return [...editions]
  if (editions.some((e) => e.collectionId === card.collectionId)) return [...editions]
  return [card, ...editions]
}
