/**
 * New arrivals (2026-10-17) — what happens after songs LAND in the library
 * from an import batch or a phone-download absorb:
 *   • one toast that says how many landed, with the duplicate/failed counts
 *     (until 2026-10-25 it also said whether they rode the next Activity
 *     Sync — Recently Added was a pinned pool list; there are no pinned
 *     lists or locked albums any more: the Original is the Top 1000 plus
 *     Jake's own pool drops)
 *   • a cover-art pass for the albums that arrived without art
 *
 * Pure — node --test loads it. The renderer gathers the live facts.
 */

export type ImportItemStatus = 'pending' | 'running' | 'done' | 'dupe' | 'failed'

export interface ImportItemLike<T> {
  uid: string
  status: ImportItemStatus
  dupeReason?: string
  /** Internal imports (e.g. a Full Live Concert's merged file) — never
   *  announced as songs: they don't ride a sync as songs. */
  quiet?: boolean
  track?: T
}

interface Member<T> { status: ImportItemStatus; dupeReason?: string; quiet: boolean; track?: T }

export interface ImportBatch<T> {
  busy: boolean
  members: Map<string, Member<T>>
}

export function idleImportBatch<T>(): ImportBatch<T> {
  return { busy: false, members: new Map() }
}

export interface ImportBatchSummary<T> {
  imported: number
  /** Already in the library (or already imported this session). */
  dupes: number
  /** Source file vanished before it could be read. */
  gone: number
  failed: number
  /** The tracks that landed, in landing order. */
  tracks: T[]
}

/**
 * Feed every import-queue change. A batch starts when something is queued
 * (idle → busy) and finishes when nothing is pending or running (busy →
 * idle). Members are the items seen pending/running during the batch, and
 * each one's LAST status is what counts — so the counts are this batch's
 * delta even when the queue keeps earlier history, when a new drop purges
 * finished rows mid-batch, or when a failed row is retried.
 */
export function stepImportBatch<T>(
  batch: ImportBatch<T>,
  items: readonly ImportItemLike<T>[],
): { batch: ImportBatch<T>; finished: ImportBatchSummary<T> | null } {
  const inFlight = items.some((i) => i.status === 'pending' || i.status === 'running')
  if (!batch.busy && !inFlight) return { batch, finished: null }
  const members = new Map(batch.members)
  for (const i of items) {
    const live = i.status === 'pending' || i.status === 'running'
    if (!live && !members.has(i.uid)) continue
    members.set(i.uid, { status: i.status, dupeReason: i.dupeReason, quiet: i.quiet === true, track: i.track })
  }
  if (inFlight) return { batch: { busy: true, members }, finished: null }

  const s: ImportBatchSummary<T> = { imported: 0, dupes: 0, gone: 0, failed: 0, tracks: [] }
  let counted = 0
  for (const m of members.values()) {
    if (m.quiet) continue
    if (m.status === 'done') { s.imported++; if (m.track !== undefined) s.tracks.push(m.track); counted++ }
    else if (m.status === 'dupe') { if (m.dupeReason === 'source-gone') s.gone++; else s.dupes++; counted++ }
    else if (m.status === 'failed') { s.failed++; counted++ }
  }
  return { batch: idleImportBatch<T>(), finished: counted > 0 ? s : null }
}

export interface ArrivalCounts {
  /** How many songs landed. */
  landed: number
  /** How many of them are in Recently Added right now. */
  inRecentlyAdded: number
  dupes?: number
  gone?: number
  failed?: number
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** The landing toast. `source` picks the opening words only. */
export function arrivalsMessage(
  source: 'import' | 'phone',
  c: ArrivalCounts,
): { message: string; kind: 'success' | 'info' | 'error' } | null {
  const landed = Math.max(0, c.landed | 0)
  const inRA = Math.max(0, Math.min(landed, c.inRecentlyAdded | 0))
  const dupes = Math.max(0, (c.dupes ?? 0) | 0)
  const gone = Math.max(0, (c.gone ?? 0) | 0)
  const failed = Math.max(0, (c.failed ?? 0) | 0)
  if (landed + dupes + gone + failed === 0) return null

  let head: string
  if (landed > 0) {
    const n = landed.toLocaleString()
    head = source === 'phone'
      ? `${n} phone download${plural(landed, '', 's')} added`
      : `Imported ${n} song${plural(landed, '', 's')}`
    if (inRA === landed) {
      head += ` — in Recently Added, so ${plural(landed, 'it rides', 'they ride')} the next Activity Sync`
    } else if (inRA > 0) {
      head += ` — the newest ${inRA.toLocaleString()} ${plural(inRA, 'is', 'are')} in Recently Added, so ${plural(inRA, 'it rides', 'they ride')} the next Activity Sync`
    }
  } else {
    head = 'Nothing new imported'
  }
  const extras: string[] = []
  if (dupes) extras.push(`${dupes.toLocaleString()} already in your library`)
  if (gone) extras.push(`${gone.toLocaleString()} source file${plural(gone, '', 's')} gone`)
  if (failed) extras.push(`${failed.toLocaleString()} failed — see the import list`)
  const message = [head, ...extras].join(' · ')
  const kind = failed > 0 ? (landed > 0 ? 'info' : 'error') : landed > 0 ? 'success' : 'info'
  return { message, kind }
}

/** Key for "one album": the artwork map's own exact key shape. */
export function albumArtKey(artist: string, album: string): string {
  return `${String(artist ?? '').toLowerCase().trim()}|||${String(album ?? '').toLowerCase().trim()}`
}

/** One entry per artist + album that has no art yet, in arrival order. */
export function albumsNeedingArt(
  tracks: readonly { artist?: string; album?: string }[],
  hasArt: (artist: string, album: string) => boolean,
): { artist: string; album: string }[] {
  const seen = new Set<string>()
  const out: { artist: string; album: string }[] = []
  for (const t of tracks) {
    const artist = typeof t?.artist === 'string' ? t.artist : ''
    const album = typeof t?.album === 'string' ? t.album : ''
    if (!artist.trim() || !album.trim()) continue
    const key = albumArtKey(artist, album)
    if (seen.has(key)) continue
    seen.add(key)
    if (hasArt(artist, album)) continue
    out.push({ artist, album })
  }
  return out
}

/** Run `fn` over `items`, at most `limit` at a time. One item throwing
 *  never stops the rest. */
export async function runLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < items.length) {
      const item = items[next++]
      try { await fn(item) } catch { /* that album stays as it was; the next one still runs */ }
    }
  }))
}
