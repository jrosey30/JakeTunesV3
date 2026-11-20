/**
 * Downloads you can trust (Brief 258, Record Shop Phase 5). Pure rules for
 * the one scheduler: which lane a job runs in, how the waiting list is saved
 * and brought back after a restart, the "7 of 12" line, and which section of
 * the Downloads list a job sits in. No I/O, so every rule is node-tested.
 *
 *  - Two lanes: albums in one, songs (and everything else) in the other.
 *    Each lane runs one job at a time, so at most two downloads at once.
 *  - The list is saved whole on every change. On load, a job that was
 *    downloading at quit is queued again at the front of its lane; one that
 *    main finished before the quit (its arm id is in main's ledger) is done,
 *    never downloaded twice.
 */

export type Lane = 'album' | 'song'

/** An album request (by query or by a picked/pasted album id) runs in the album lane; anything else in the song lane. */
export function laneOf(r: { mediaType?: string }): Lane {
  return r.mediaType === 'album' ? 'album' : 'song'
}

/** The next job a lane starts: the first queued one in list order. */
export function nextInLane<T extends { status: string; result: { mediaType?: string } }>(queue: readonly T[], lane: Lane): T | undefined {
  return queue.find((q) => q.status === 'queued' && laneOf(q.result) === lane)
}

// ── The saved list ─────────────────────────────────────────────────────

export const SAVED_QUEUE_VERSION = 1
/** Kept on disk: everything still to do, today's finished jobs, and what needs Jake (up to two weeks). */
export const KEEP_NEEDS_YOU_MS = 14 * 24 * 3600_000
export const MAX_SAVED_JOBS = 400

/** The job fields that survive a restart. A later phase that adds a field to a job adds its name here. */
export const SAVED_FIELDS = [
  'key', 'result', 'status', 'armId', 'attempt', 'imported', 'dupes', 'error', 'outcome', 'alternatives',
  'primary', 'detail', 'matchDesc', 'completion', 'startedAt', 'endedAt',
] as const

export interface SavedJob {
  key: string
  result: { mediaType?: string; [k: string]: unknown }
  status: 'queued' | 'downloading' | 'done' | 'failed' | 'canceled'
  armId?: string
  [k: string]: unknown
}

/** What main wrote the moment a job's import finished (keyed by the job's arm id). */
export interface FinishedJob {
  at: number
  imported?: number
  dupes?: number
  matchDesc?: string
  completion?: string
}

export interface SavedQueueDoc {
  version: number
  savedAt: number
  jobs: SavedJob[]
  finished: Record<string, FinishedJob>
}

export function emptyQueueDoc(now = 0): SavedQueueDoc {
  return { version: SAVED_QUEUE_VERSION, savedAt: now, jobs: [], finished: {} }
}

const STATUSES = new Set(['queued', 'downloading', 'done', 'failed', 'canceled'])

/** A job as it goes to disk: only the saved fields, plain JSON. */
export function toSavedJob(q: Record<string, unknown>): SavedJob | null {
  if (typeof q.key !== 'string' || !q.result || typeof q.result !== 'object' || !STATUSES.has(String(q.status))) return null
  const out: Record<string, unknown> = {}
  for (const f of SAVED_FIELDS) if (q[f] !== undefined) out[f] = q[f]
  // The usage-log click time belongs to the session it was clicked in.
  const { clickedAt: _c, ...result } = q.result as Record<string, unknown>
  out.result = result
  return out as unknown as SavedJob
}

export function toSavedJobs(queue: readonly object[]): SavedJob[] {
  return queue.map((q) => toSavedJob(q as Record<string, unknown>)).filter((j): j is SavedJob => j != null)
}

/** Read a file's JSON back as a doc, or null when it isn't one (a newer version, a foreign shape). */
export function parseSavedQueue(raw: unknown): SavedQueueDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Partial<SavedQueueDoc>
  if (d.version !== SAVED_QUEUE_VERSION || !Array.isArray(d.jobs)) return null
  const jobs = d.jobs.map((j) => toSavedJob(j as Record<string, unknown>)).filter((j): j is SavedJob => j != null)
  const finished: Record<string, FinishedJob> = {}
  if (d.finished && typeof d.finished === 'object') {
    for (const [id, f] of Object.entries(d.finished)) if (f && typeof f === 'object' && typeof (f as FinishedJob).at === 'number') finished[id] = f as FinishedJob
  }
  return { version: SAVED_QUEUE_VERSION, savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0, jobs, finished }
}

/** Local midnight of `now`'s day. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** What a saved job keeps on disk: unfinished work always; today's finished; what needs Jake for two weeks. */
export function keepSaved(j: Pick<SavedJob, 'status'> & { endedAt?: unknown }, now: number): boolean {
  if (j.status === 'queued' || j.status === 'downloading') return true
  const ended = typeof j.endedAt === 'number' ? j.endedAt : 0
  if (j.status === 'failed') return now - ended < KEEP_NEEDS_YOU_MS
  return ended >= startOfDay(now)
}

export interface RestoredJob extends SavedJob {
  /** Was mid-download when the app quit, and starts again. */
  interrupted?: boolean
}

/**
 * The list after a restart, from the saved doc.
 *  - A job main finished (its arm id in `finished`) is done, whatever the list said.
 *  - A job that was downloading is queued again, first in its lane (it was the lane's head).
 *  - Otherwise the saved order is kept; old finished jobs are let go.
 */
export function restoreJobs(doc: SavedQueueDoc, now: number): RestoredJob[] {
  const out: RestoredJob[] = []
  for (const j of doc.jobs) {
    const fin = j.armId ? doc.finished[j.armId] : undefined
    if (fin && (j.status === 'queued' || j.status === 'downloading')) {
      out.push({ ...j, status: 'done', imported: fin.imported ?? 0, dupes: fin.dupes ?? 0, matchDesc: fin.matchDesc, completion: fin.completion, endedAt: fin.at, error: undefined, outcome: undefined, primary: undefined, detail: undefined, alternatives: undefined })
      continue
    }
    if (j.status === 'downloading') { out.push({ ...j, status: 'queued', interrupted: true, startedAt: undefined }); continue }
    if (!keepSaved(j, now)) continue
    out.push({ ...j })
  }
  // The interrupted job goes back to the head of its lane; everything else keeps its place.
  const interrupted = out.filter((j) => j.interrupted)
  return [...interrupted, ...out.filter((j) => !j.interrupted)]
}

/** The list to write: at most MAX_SAVED_JOBS, the oldest finished let go first. */
export function capSaved(jobs: SavedJob[], now: number): SavedJob[] {
  const kept = jobs.filter((j) => keepSaved(j, now))
  if (kept.length <= MAX_SAVED_JOBS) return kept
  const settled = kept.filter((j) => j.status !== 'queued' && j.status !== 'downloading')
    .sort((a, b) => Number(a.endedAt ?? 0) - Number(b.endedAt ?? 0))
  const drop = new Set(settled.slice(0, kept.length - MAX_SAVED_JOBS))
  return kept.filter((j) => !drop.has(j))
}

/** Main's ledger keeps a finished arm while the list still names it, and for a day after. */
export function pruneFinished(finished: Record<string, FinishedJob>, jobs: readonly SavedJob[], now: number): Record<string, FinishedJob> {
  const named = new Set(jobs.map((j) => j.armId).filter(Boolean) as string[])
  const out: Record<string, FinishedJob> = {}
  for (const [id, f] of Object.entries(finished)) if (named.has(id) || now - f.at < 24 * 3600_000) out[id] = f
  return out
}

// ── Album progress ─────────────────────────────────────────────────────

/** "7 of 12" while an album's songs land; nothing for a song or an unknown size. */
export function songProgressLine(p: { have: number; of: number } | null | undefined): string | null {
  if (!p || !(p.of > 1)) return null
  return `${Math.max(0, Math.min(p.have, p.of))} of ${p.of}`
}

/**
 * Songs that have landed in a staging folder: files whose size held still
 * between two looks (streamrip writes each song under its final name, so a
 * growing file is still arriving). Never more than `of`, never fewer than
 * last time.
 */
export function landedCount(prev: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>, last: number, of: number): number {
  let n = 0
  for (const [f, size] of now) if (size > 0 && prev.get(f) === size) n++
  const cap = of > 0 ? of : n
  return Math.min(cap, Math.max(last, n))
}

// ── The Downloads list ─────────────────────────────────────────────────

export type DownloadsSection = 'inProgress' | 'doneToday' | 'needsYou'
export const SECTION_ORDER: readonly DownloadsSection[] = ['inProgress', 'doneToday', 'needsYou']
export const SECTION_TITLE: Record<DownloadsSection, string> = { inProgress: 'In progress', doneToday: 'Done today', needsYou: 'Needs you' }

/** Where a row sits: moving → In progress; failed or refused → Needs you; finished today (or canceled) → Done today; older finished → not shown. */
export function sectionOf(row: { status: string; endedAt?: number | null; groupInFlight?: number }, now: number): DownloadsSection | null {
  if (row.status === 'downloading' || row.status === 'queued' || (row.groupInFlight ?? 0) > 0) return 'inProgress'
  if (row.status === 'failed' || row.status === 'refused') return 'needsYou'
  if (row.status === 'done' || row.status === 'canceled') return (row.endedAt ?? now) >= startOfDay(now) ? 'doneToday' : null
  return null
}

export function groupBySection<T>(rows: readonly T[], sectionFor: (r: T) => DownloadsSection | null): Array<{ id: DownloadsSection; title: string; rows: T[] }> {
  const by = new Map<DownloadsSection, T[]>()
  for (const r of rows) {
    const s = sectionFor(r)
    if (!s) continue
    const list = by.get(s) ?? []
    list.push(r)
    by.set(s, list)
  }
  return SECTION_ORDER.filter((s) => by.has(s)).map((s) => ({ id: s, title: SECTION_TITLE[s], rows: by.get(s)! }))
}
