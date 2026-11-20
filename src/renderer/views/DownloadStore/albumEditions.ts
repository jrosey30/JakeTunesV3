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
 * not burst Apple's search (it answers 403 to a burst).
 */
import { albumQueryId, trackQueryId, type QResult, type QueueOrigin } from './downloadQueue.ts'
import { norm } from './downloadKeys.ts'
import type { AlbumEdition, AlbumEditions, AlbumSaveEdition, AlbumSaveSurface } from '../../../common/album-preflight.ts'

export interface EditionsState {
  state: 'idle' | 'loading' | 'ready'
  editions: AlbumEdition[]
  /** Jake's pick from the menu, else main's choice, else null (no edition named). */
  chosenId: number | null
  picked: boolean
}

const SPACING_MS = 250
const IDLE: EditionsState = { state: 'idle', editions: [], chosenId: null, picked: false }

const answers = new Map<string, AlbumEditions>()
const inflight = new Map<string, Promise<AlbumEditions>>()
const picks = new Map<string, number>()
const states = new Map<string, EditionsState>()
const subs = new Set<() => void>()
let line: Promise<unknown> = Promise.resolve()

const keyOf = (artist: string, album: string): string => albumQueryId(artist, album)
const emit = (): void => { for (const f of subs) f() }

function rebuild(key: string): void {
  const a = answers.get(key)
  const loading = inflight.has(key)
  const pick = picks.get(key)
  const editions = a?.editions ?? []
  const picked = pick != null && editions.some((e) => e.collectionId === pick)
  states.set(key, {
    state: a ? 'ready' : loading ? 'loading' : 'idle',
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

/** The editions of a record, asked once per session (in turn with the others). */
export function loadEditions(artist: string, album: string): Promise<AlbumEditions> {
  const key = keyOf(artist, album)
  const have = answers.get(key)
  if (have) return Promise.resolve(have)
  const running = inflight.get(key)
  if (running) return running
  const api = typeof window !== 'undefined' ? window.electronAPI?.listAlbumEditions : undefined
  if (!api) return Promise.resolve({ ok: false, editions: [], chosenId: null })
  const p = line.then(async () => {
    let out: AlbumEditions
    try { out = (await api(artist, album)) ?? { ok: false, editions: [], chosenId: null } } catch { out = { ok: false, editions: [], chosenId: null } }
    await new Promise((r) => setTimeout(r, SPACING_MS))
    return out
  })
  line = p.catch(() => undefined)
  inflight.set(key, p)
  rebuild(key); emit()
  void p.then((out) => {
    inflight.delete(key)
    // A failed lookup is not kept: the next look asks again.
    if (out.ok) answers.set(key, out)
    rebuild(key); emit()
  })
  return p
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
  await loadEditions(artist, album).catch(() => null)
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
  answers.clear(); inflight.clear(); picks.clear(); states.clear(); line = Promise.resolve()
}
