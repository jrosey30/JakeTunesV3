/**
 * Synced picks (2026-10-18) — Jake's TOP 10 ISLAND ALBUMS and his 5 FAVORITE
 * ARTISTS, one document each, shared by the desktop and the phone. Jake: "when
 * i update one, the other changes. and vice versa."
 *
 * The homemini backend is the ONLY writer (single-writer contract, same as
 * recommendations.json): the desktop GETs and PUTs whole documents and keeps a
 * cached copy + a queued edit locally (src/main/synced-picks-client.ts). Last
 * write wins on the whole document.
 *
 *   GET /api/island-albums    → { version: 1, slots: [{artist, album} | null] ×10, updatedAt, updatedBy }
 *   PUT /api/island-albums    ← { slots: [...10], updatedBy: 'desktop' }   (400 + message if invalid)
 *   GET /api/favorite-artists → { version: 1, artists: [string | null] ×5, updatedAt, updatedBy }
 *   PUT /api/favorite-artists ← { artists: [...5], updatedBy: 'desktop' }
 *
 * Pure — no electron, no fs. Validation, tolerant parsing and slot editing
 * live here so main, preload and renderer share one definition.
 *
 * ⚠️ TWIN: JakeTunesMobile backend — the PUT validation of /api/island-albums
 *    and /api/favorite-artists (branch feat/synced-island-favorites). Same
 *    rules both sides: exact slot count, no empty strings, no album twice by
 *    nameKey(albumArtist || artist)|nameKey(album), no artist twice by
 *    nameKey. nameKey itself is already twinned byte-for-byte
 *    (src/common/fold-text.ts ↔ JakeTunesMobile backend/src/util/nameKey.ts).
 */
import { nameKey } from './fold-text.ts'

export const ISLAND_SLOT_COUNT = 10
export const FAVORITE_ARTIST_SLOT_COUNT = 5

export type PicksKind = 'island-albums' | 'favorite-artists'
export type PicksAuthor = 'phone' | 'desktop'

/** One island pick. `artist` is the album artist (albumArtist || artist). */
export interface IslandAlbum { artist: string; album: string }
export type IslandSlot = IslandAlbum | null
export type FavoriteSlot = string | null

/** The document, normalized: `values` is `slots` (island) or `artists`
 *  (favorites) — always exactly the kind's slot count. */
export interface PicksDoc<V> {
  version: 1
  values: V[]
  updatedAt: string | null
  updatedBy: PicksAuthor | null
}

/** What main hands the renderer: the doc to draw plus how fresh it is. */
export interface PicksState<V> {
  kind: PicksKind
  values: V[]
  updatedAt: string | null
  updatedBy: PicksAuthor | null
  /** A desktop edit is queued and has not landed on homemini yet. */
  pending: boolean
  /** Last network verdict: true = homemini answered, false = it didn't, null = not tried yet. */
  reachable: boolean | null
  /** ms epoch of the last good GET/PUT reply; null = never (shelf is drawing the cache or nothing). */
  syncedAt: number | null
  /** The backend refused the last edit (400) — its message. Cleared by the next accepted edit. */
  rejected?: string
}

export type AnyPicksState = PicksState<IslandSlot> | PicksState<FavoriteSlot>

/** IPC reply: a state, or a refusal (bad kind / refused sender / invalid edit
 *  — an invalid edit still carries the unchanged state to redraw). */
export type PicksReply =
  | { ok: true; state: AnyPicksState }
  | { ok: false; error: string; state?: AnyPicksState }

export type Validation<V> = { ok: true; values: V[] } | { ok: false; error: string }

export interface PicksSpec<V> {
  kind: PicksKind
  path: string
  /** Wire field name for the values array. */
  field: 'slots' | 'artists'
  count: number
  validate: (raw: unknown) => Validation<V>
  /** Tolerant per-entry read (bad entry → null). */
  entry: (raw: unknown) => V | null
  /** Identity key of a filled slot (dedupe). */
  keyOf: (v: NonNullable<V>) => string
}

const isText = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0

// ── Keys ─────────────────────────────────────────────────────────────────

export function islandAlbumKey(a: IslandAlbum): string {
  return `${nameKey(a.artist)}|${nameKey(a.album)}`
}

export function favoriteArtistKey(name: string): string {
  return nameKey(name)
}

// ── Validation (strict: what the desktop is willing to PUT) ──────────────

export function validateIslandSlots(raw: unknown): Validation<IslandSlot> {
  if (!Array.isArray(raw)) return { ok: false, error: `slots must be an array of ${ISLAND_SLOT_COUNT}` }
  if (raw.length !== ISLAND_SLOT_COUNT) return { ok: false, error: `slots must be exactly ${ISLAND_SLOT_COUNT} entries (got ${raw.length})` }
  const values: IslandSlot[] = []
  const seen = new Map<string, number>()
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as unknown
    if (s === null) { values.push(null); continue }
    const o = s as Partial<IslandAlbum> | undefined
    if (!o || typeof o !== 'object' || !isText(o.artist) || !isText(o.album)) {
      return { ok: false, error: `slot ${i + 1}: artist and album must be non-empty strings` }
    }
    const pick = { artist: o.artist, album: o.album }
    const key = islandAlbumKey(pick)
    const prior = seen.get(key)
    if (prior !== undefined) return { ok: false, error: `"${pick.album}" is in slots ${prior + 1} and ${i + 1} — one album, one slot` }
    seen.set(key, i)
    values.push(pick)
  }
  return { ok: true, values }
}

export function validateFavoriteArtists(raw: unknown): Validation<FavoriteSlot> {
  if (!Array.isArray(raw)) return { ok: false, error: `artists must be an array of ${FAVORITE_ARTIST_SLOT_COUNT}` }
  if (raw.length !== FAVORITE_ARTIST_SLOT_COUNT) return { ok: false, error: `artists must be exactly ${FAVORITE_ARTIST_SLOT_COUNT} entries (got ${raw.length})` }
  const values: FavoriteSlot[] = []
  const seen = new Map<string, number>()
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as unknown
    if (s === null) { values.push(null); continue }
    if (!isText(s)) return { ok: false, error: `slot ${i + 1}: an artist must be a non-empty string` }
    const key = favoriteArtistKey(s)
    const prior = seen.get(key)
    if (prior !== undefined) return { ok: false, error: `${s} is in slots ${prior + 1} and ${i + 1} — one artist, one slot` }
    seen.set(key, i)
    values.push(s)
  }
  return { ok: true, values }
}

// ── Specs ────────────────────────────────────────────────────────────────

export const ISLAND_ALBUMS_SPEC: PicksSpec<IslandSlot> = {
  kind: 'island-albums',
  path: '/api/island-albums',
  field: 'slots',
  count: ISLAND_SLOT_COUNT,
  validate: validateIslandSlots,
  entry: (raw) => {
    const o = raw as Partial<IslandAlbum> | null
    return o && typeof o === 'object' && isText(o.artist) && isText(o.album) ? { artist: o.artist, album: o.album } : null
  },
  keyOf: islandAlbumKey,
}

export const FAVORITE_ARTISTS_SPEC: PicksSpec<FavoriteSlot> = {
  kind: 'favorite-artists',
  path: '/api/favorite-artists',
  field: 'artists',
  count: FAVORITE_ARTIST_SLOT_COUNT,
  validate: validateFavoriteArtists,
  entry: (raw) => (isText(raw) ? raw : null),
  keyOf: favoriteArtistKey,
}

export function specFor(kind: PicksKind): PicksSpec<IslandSlot> | PicksSpec<FavoriteSlot> {
  return kind === 'island-albums' ? ISLAND_ALBUMS_SPEC : FAVORITE_ARTISTS_SPEC
}

export function isPicksKind(k: unknown): k is PicksKind {
  return k === 'island-albums' || k === 'favorite-artists'
}

// ── Tolerant parse (what the desktop is willing to DRAW) ─────────────────

/** Read a stored/served document. Never throws. Length is forced to the slot
 *  count, a malformed entry becomes an empty slot, and a duplicate keeps its
 *  first slot — so whatever we hold is always valid to PUT back. null = not a
 *  document at all (no values array). */
export function parsePicksDoc<V>(spec: PicksSpec<V>, raw: unknown): PicksDoc<V> | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const arr = o[spec.field]
  if (!Array.isArray(arr)) return null
  return {
    version: 1,
    values: normalizeValues(spec, arr),
    updatedAt: typeof o.updatedAt === 'string' && o.updatedAt ? o.updatedAt : null,
    updatedBy: o.updatedBy === 'phone' || o.updatedBy === 'desktop' ? o.updatedBy : null,
  }
}

export function normalizeValues<V>(spec: PicksSpec<V>, arr: unknown[]): V[] {
  const out: V[] = []
  const seen = new Set<string>()
  for (let i = 0; i < spec.count; i++) {
    const v = i < arr.length ? spec.entry(arr[i]) : null
    if (v === null) { out.push(null as V); continue }
    const key = spec.keyOf(v as NonNullable<V>)
    if (seen.has(key)) { out.push(null as V); continue }
    seen.add(key)
    out.push(v)
  }
  return out
}

export function emptyPicksDoc<V>(spec: PicksSpec<V>): PicksDoc<V> {
  return { version: 1, values: Array.from({ length: spec.count }, () => null as V), updatedAt: null, updatedBy: null }
}

/** The wire shape of a document (what GET serves and the cache file holds). */
export function toWireDoc<V>(spec: PicksSpec<V>, doc: PicksDoc<V>): Record<string, unknown> {
  return { version: 1, [spec.field]: doc.values, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy }
}

// ── Slot editing (pure; every function returns a new array) ─────────────

/** Put `value` in slot `index`. Like the phone's IslandAlbumsPrefs.set: one
 *  pick may only occupy one slot, so any other slot holding the same key is
 *  cleared first. Out-of-range index → unchanged copy. */
export function placeInSlot<V>(values: Array<V | null>, index: number, value: V, keyOf: (v: V) => string): Array<V | null> {
  const next = [...values]
  if (index < 0 || index >= next.length) return next
  const key = keyOf(value)
  for (let i = 0; i < next.length; i++) {
    const cur = next[i]
    if (i !== index && cur !== null && keyOf(cur) === key) next[i] = null
  }
  next[index] = value
  return next
}

export function clearSlot<V>(values: Array<V | null>, index: number): Array<V | null> {
  const next = [...values]
  if (index >= 0 && index < next.length) next[index] = null
  return next
}

/** Swap slot `index` with its neighbour (`delta` −1 = left, +1 = right). An
 *  edge move is a no-op copy. Moving into an empty neighbour just moves it. */
export function moveSlot<V>(values: Array<V | null>, index: number, delta: -1 | 1): Array<V | null> {
  const next = [...values]
  const to = index + delta
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next
  const t = next[index]
  next[index] = next[to]
  next[to] = t
  return next
}

/** Which slot holds `key` (−1 = none). */
export function slotOf<V>(values: Array<V | null>, key: string, keyOf: (v: V) => string): number {
  return values.findIndex((v) => v !== null && keyOf(v) === key)
}

export function firstEmptySlot<V>(values: Array<V | null>): number {
  return values.findIndex((v) => v === null)
}

/** Same document content? (ignores updatedAt/By — used to skip no-op PUTs). */
export function sameValues<V>(a: Array<V | null>, b: Array<V | null>, keyOf: (v: V) => string): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x === null || y === null) { if (x !== y) return false; continue }
    if (keyOf(x) !== keyOf(y)) return false
  }
  return true
}
