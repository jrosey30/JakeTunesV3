/**
 * The playlists ON one iPod, as the desktop shows them (2026-11-14) — PURE.
 *
 * Jake (the plan he approved, ~/concert-repair/ipod-playlists-plan.md):
 * "default playlists on top, on the go, then the per ipod playlists in a to z
 * order. same rules as we have for songs, artists albums etc"; "i also have the
 * ability to create my own per ipod playlist, if i so choose".
 *
 * homemini keeps every playlist that belongs to one iPod (JakeTunesMobile
 * backend/src/util/ipodPlaylists.ts, GET /api/ipod-playlists?device=) and serves
 * them On-The-Go first (oldest first), then the rest A to Z. This Mac lays what
 * it is still waiting to tell homemini (main/ipod-playlists-outbox.ts) over its
 * last answer and puts the result in the SAME order, with the app's one name
 * sort (injected: renderer/utils/artistSort.ts compareNames, or its main twin).
 * The defaults are not here: they are worked out from the iPod's songs
 * (renderer/utils/ipodDeviceDefaults.ts) and go above all of this.
 *
 * ⚠️ TWIN of homemini's orderForDevice (util/ipodPlaylists.ts): same order, so a
 * playlist doesn't move when homemini's answer replaces this Mac's guess.
 */

export type IpodPlaylistSource = 'jake' | 'on-the-go' | 'cast' | 'brain'

/** One playlist as homemini keeps it. */
export interface StoredIpodPlaylist {
  id: string
  device: string
  name: string
  source: IpodPlaylistSource
  trackIds: number[]
  createdAt: string
  updatedAt?: string
}

/** Why a waiting write is held until Jake answers (homemini said no for a reason he can fix). */
export type IpodPlaylistHold =
  | { kind: 'not-on-ipod'; trackIds: number[] }
  | { kind: 'name-taken'; name: string }

/** One write this Mac hasn't told homemini yet: what Jake wants the playlist to be now. */
export interface PendingIpodPlaylist {
  device: string
  id: string
  /** Moves on every edit: a send clears the entry only if it is still the edit that was sent. */
  rev: number
  op: 'save' | 'delete'
  name: string
  trackIds: number[]
  createdAt: string
  /** homemini has never had it: it goes as a PUT (create), not a PATCH. */
  isNew: boolean
  hold?: IpodPlaylistHold
  /** Plain lines for Jake ("punkPod is full…"), shown on the playlist until it lands. */
  notices?: string[]
}

/** A "yes, put it on the iPod too": sent before that iPod's playlists. */
export interface PendingIpodAdd {
  opId: string
  device: string
  trackIds: number[]
  /** The playlist it was for, named in the reason homemini keeps. */
  forName: string
}

export interface IpodPlaylistsPendingDoc {
  version: 1
  /** By `${device}/${id}`. */
  saves: Record<string, PendingIpodPlaylist>
  adds: PendingIpodAdd[]
}

/** One row of the list as shown. */
export interface IpodPlaylistRow extends StoredIpodPlaylist {
  /** Something about it hasn't reached homemini yet. */
  waiting: boolean
  hold: IpodPlaylistHold | null
  notices: string[]
}

export const NAME_MAX = 60
export const TRACKS_MAX = 5000
/** homemini's id rule (util/ipodPlaylists.ts): the device key and the playlist id. */
export const IPOD_PLAYLIST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
export const isIpodPlaylistKey = (s: unknown): s is string => typeof s === 'string' && IPOD_PLAYLIST_ID.test(s)

export const pendingKey = (device: string, id: string): string => `${device}/${id}`

export const emptyPending = (): IpodPlaylistsPendingDoc => ({ version: 1, saves: {}, adds: [] })

/** homemini's name rule: whitespace folded, 1 to 60 characters. */
export function cleanPlaylistName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s.length >= 1 && s.length <= NAME_MAX ? s : null
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Can Jake call a playlist on this iPod `raw`? Not a name another of its playlists
 * has, nor one of its defaults: the sync writes one name once, and the second
 * one would silently not reach the iPod.
 */
export function checkPlaylistName(
  raw: unknown,
  ipodName: string,
  taken: { defaults: readonly string[]; others: readonly string[] },
): { ok: true; name: string } | { ok: false; error: string } {
  const name = cleanPlaylistName(raw)
  if (!name) return { ok: false, error: `A playlist’s name is 1 to ${NAME_MAX} characters.` }
  if ([...taken.defaults, ...taken.others].some((n) => sameName(n, name))) {
    return { ok: false, error: `${ipodName} already has a playlist called “${name}”.` }
  }
  return { ok: true, name }
}

/** Track ids, each once, in order; null when it isn't a list of ids. */
export function cleanTrackIds(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length > TRACKS_MAX) return null
  const seen = new Set<number>()
  const out: number[] = []
  for (const x of v) {
    const n = Number(x)
    if (!Number.isSafeInteger(n) || n < 0) return null
    if (!seen.has(n)) { seen.add(n); out.push(n) }
  }
  return out
}

/** homemini's GET answer, checked. A row that isn't a playlist is left out; null = not an answer. */
export function parseStoredPlaylists(body: unknown, device: string): StoredIpodPlaylist[] | null {
  const rows = (body as { playlists?: unknown } | null)?.playlists
  if (!Array.isArray(rows)) return null
  const out: StoredIpodPlaylist[] = []
  for (const r of rows as Array<Partial<StoredIpodPlaylist>>) {
    if (!r || !isIpodPlaylistKey(r.id) || typeof r.name !== 'string' || !r.name.trim()) continue
    if (r.device !== undefined && r.device !== device) continue
    const source = r.source === 'on-the-go' || r.source === 'cast' || r.source === 'brain' ? r.source : r.source === 'jake' ? 'jake' : null
    const ids = cleanTrackIds(r.trackIds)
    if (!source || !ids) continue
    out.push({ id: r.id, device, name: r.name, source, trackIds: ids, createdAt: typeof r.createdAt === 'string' ? r.createdAt : '', ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {}) })
  }
  return out
}

/** homemini's order: On-The-Go oldest first, then the rest A to Z by the one name sort. */
export function orderIpodPlaylists<T extends Pick<StoredIpodPlaylist, 'id' | 'name' | 'source' | 'createdAt'>>(
  rows: readonly T[],
  compareNames: (a: string, b: string) => number,
): T[] {
  const time = (s: string): number => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0 }
  const otg = rows.filter((p) => p.source === 'on-the-go')
    .sort((a, b) => time(a.createdAt) - time(b.createdAt) || compareNames(a.name, b.name) || a.id.localeCompare(b.id))
  const rest = rows.filter((p) => p.source !== 'on-the-go')
    .sort((a, b) => compareNames(a.name, b.name) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return [...otg, ...rest]
}

/**
 * homemini's last answer for one iPod with what this Mac is still waiting to
 * send laid over it, in the one order. Safe to fold twice.
 */
export function foldIpodPlaylists(
  device: string,
  stored: readonly StoredIpodPlaylist[],
  pending: IpodPlaylistsPendingDoc,
  compareNames: (a: string, b: string) => number,
): IpodPlaylistRow[] {
  const rows = new Map<string, IpodPlaylistRow>()
  for (const s of stored) {
    if (s.device !== device) continue
    rows.set(s.id, { ...s, trackIds: [...s.trackIds], waiting: false, hold: null, notices: [] })
  }
  for (const p of Object.values(pending.saves)) {
    if (p.device !== device) continue
    if (p.op === 'delete') { rows.delete(p.id); continue }
    const had = rows.get(p.id)
    rows.set(p.id, {
      id: p.id,
      device,
      name: p.name,
      source: had?.source ?? 'jake',
      trackIds: [...p.trackIds],
      createdAt: had?.createdAt || p.createdAt,
      ...(had?.updatedAt ? { updatedAt: had.updatedAt } : {}),
      waiting: true,
      hold: p.hold ?? null,
      notices: [...(p.notices ?? [])],
    })
  }
  return orderIpodPlaylists([...rows.values()], compareNames)
}

/** What a skipped add means in words (homemini's /api/ipod-lists/:id/add `skipped`). */
export function skippedAddNotice(ipodName: string, cap: number | null, reason: string, songTitle: string): string {
  if (reason === 'full') {
    return `${ipodName} is full${cap ? ` (${cap.toLocaleString('en-US')} songs)` : ''}, so “${songTitle}” couldn’t go on it.`
  }
  if (reason === 'not-in-library') return `homemini doesn’t have “${songTitle}” in the library, so it couldn’t go on ${ipodName}.`
  return `“${songTitle}” couldn’t go on ${ipodName}.`
}

/** The question when a song isn't on the iPod. The Original never takes one by hand. */
export function notOnIpodQuestion(device: string, ipodName: string, songTitles: readonly string[]):
  { canAdd: true; message: string } | { canAdd: false; message: string } {
  const what = songTitles.length === 1 ? `“${songTitles[0]}” isn’t` : `${songTitles.length} of these songs aren’t`
  if (device === 'top1000') {
    return { canAdd: false, message: `The Original carries the Top 1000 only, and ${songTitles.length === 1 ? `“${songTitles[0]}” isn’t` : `${songTitles.length} of these songs aren’t`} in it.` }
  }
  return { canAdd: true, message: `${what} on ${ipodName}. Add ${songTitles.length === 1 ? 'it' : 'them'} to ${ipodName} too?` }
}

/** 'ipod-playlists:get': one iPod's playlists as this Mac shows them. */
export type IpodPlaylistsAnswer =
  | { ok: true; device: string; playlists: IpodPlaylistRow[]; from: 'homemini' | 'kept' | 'none' }
  | { ok: false; error: string }

/** 'ipod-playlists:save' / ':delete' / ':answer'. */
export type IpodPlaylistWriteAnswer =
  | { ok: true; id: string; view: Extract<IpodPlaylistsAnswer, { ok: true }> }
  | { ok: false; error: string }
