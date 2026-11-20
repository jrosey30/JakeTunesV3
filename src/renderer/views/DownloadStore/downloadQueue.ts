// Download queue — the "no surprises" engine for the Download view. You can
// queue as many results as you want. Brief 258: two lanes, albums in one and
// songs in the other, each one job at a time — so a long album never holds a
// song up, and at most two rips run at once (main keeps each job's cancel and
// rips apart, and imports them one after the other). The list is saved to
// disk on every change and picks up where it left off after a restart. Every
// item carries its OWN visible lifecycle so nothing is ever a black box:
//   queued → downloading (with a live elapsed clock) → done (✓ in your library,
//   N tracks) OR failed (with one-click retry).
// Module-level + pub/sub so the state survives navigating away and back (same
// pattern as the view's pageCache) and any mounted view re-renders on change.

// Two kinds of queue entries:
//  - id: a raw streamrip catalog id (legacy path, still used by pasted links)
//  - query: an iTunes-picked song/album resolved on Qobuz at download time
//    (artist+title or artist+album) — the v2 search flow.
import { norm } from './downloadKeys.ts'
import { laneOf, nextInLane, nextProgress, restoreJobs, toSavedJobs, type JobEndResult, type Lane, type SavedQueueDoc } from '../../../common/download-lanes.ts'
import { PREFLIGHT_BUDGET_MS, albumSaveEvent, preflightVerdict, type AlbumPreflight, type AlbumSaveEdition, type AlbumSaveSurface } from '../../../common/album-preflight.ts'

/** Where a job came from (the Record Shop's saved list, a feed shelf…) —
 *  carried on the job so every presentation can find it by recommendation
 *  id, and so "recommended by Alex" survives resolution on Qobuz. The queue
 *  KEY stays the recording/edition identity: a Get from the Download view
 *  and a Get from the list for the same recording are ONE job, and later
 *  origins are adopted onto it. (6.0 Record Shop: one scheduler.) */
export interface QueueOrigin {
  recommendationIds: string[]
  entryId?: string
  /** 'user' | 'mm' | 'radar' — the list's own vocabulary; a person's name when known. */
  sourceKind?: string
  sourceLabel?: string
  /** The Listen List row's share source key ('tiktok', 'savant', …): main
   *  stamps it on every row this job imports as `addedVia`. */
  addedVia?: string
  /** Matching-track Gets (Compare editions, action A): this song job is one
   *  of a group recovered from a refused album request. The group hangs off
   *  the refused album job (`parentKey`) in the Downloads panel; it carries
   *  NO recommendationIds, so nothing about it can fulfil the album jot. */
  group?: QueueGroup
  /** Action B: this source edition was chosen instead of a picked (iTunes) edition. Display only. */
  chosenInsteadOf?: { parentKey: string; label: string }
}
export interface QueueGroup {
  parentKey: string
  label: string
  /** How many tracks the picked edition has, and which positions were never selected (with why). */
  of: number
  position: number
  notAcquired: Array<{ position: number; title: string; reason: string }>
  skippedOwned: number
  collectionId?: number
}

const normKey = (s: string): string => norm(String(s || ''))   // any script — see downloadKeys.ts
/** ⚠️ TWIN: DownloadView.songQ/albumQ build their ids through these. */
export const trackQueryId = (artist: string, title: string): string => `q|track|${normKey(artist)}|${normKey(title)}`
export const albumQueryId = (artist: string, album: string): string => `q|album|${normKey(artist)}|${normKey(album)}`

export interface QResult {
  source: string
  mediaType: string
  id: string
  desc: string
  kind?: 'id' | 'query'
  origin?: QueueOrigin
  artist?: string
  /** Who the Listen List row itself names, when `artist` is Apple's match of it. */
  askedArtist?: string
  title?: string
  album?: string
  /** Exact-version length from the iTunes pick — main verifies the Qobuz
   *  file against it before import (wrong-version guard, 2026-08-07). */
  durationMs?: number
  /** Apple labels the iTunes row this came from cleaned, so its runtime says
   *  nothing about the explicit master we are actually going to fetch: Sky's
   *  the Limit is 277.1 s amended and 329.4 s explicit. Main drops the length
   *  (exact-recording.ts requestedLength). */
  cleanedSource?: boolean
  explicitSource?: boolean
  /** Release year of the clicked row — part of the identity contract. */
  releaseYear?: number
  /** Album rows: the iTunes collection id and its track count — main fetches
   *  the ordered tracklist by id and verifies the EDITION before import
   *  (album identity contract, 6.0 Phase 1). */
  collectionId?: number
  trackCount?: number
  /** Action B: the album is selected by its source identity and tracklist snapshot, not an iTunes edition. */
  sourceEdition?: import('../../../common/source-edition').SourceEdition
  /** Brief 255, for the usage log only (never sent to main): when Save album
   *  was clicked, on which screen, and how its edition was named. */
  clickedAt?: number
  surface?: AlbumSaveSurface
  editionFrom?: AlbumSaveEdition
}
export type QStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'canceled'
export interface QItem {
  key: string
  result: QResult
  status: QStatus
  imported?: number
  dupes?: number
  error?: string
  /** Structured verdict behind `error` (6.0 Phase 1): 'exact-not-found'
   *  means sources answered and every candidate was judged and refused —
   *  `alternatives` lists them with the reason each failed. */
  outcome?: string
  alternatives?: Array<{ provider: string; desc: string; reason: string; tracks?: Array<{ title: string; trackNumber?: number; discNumber?: number; durationSec?: number | null }>; trackCount?: number; url?: string }>
  /** Short readable status ("Exact version not found") + the full,
   *  never-truncated explanation for the details panel. */
  primary?: string
  detail?: string
  /** What main matched, and for albums the completion line
   *  ("12 tracks · 10 imported, 2 already in your library"). */
  matchDesc?: string
  completion?: string
  startedAt?: number
  endedAt?: number
  /** How many times this job has been armed (1 = first try). */
  attempt?: number
  /** The album preflight (Brief 255): still asking, or what Qobuz answered. */
  preflight?: 'asking' | AlbumPreflight['answer']
  preflightAnswer?: AlbumPreflight
  /** When this arm of the job began (the click, for the first), and whether its usage line is written. */
  armedAt?: number
  logged?: boolean
  /** Brief 258: this arm of the job, as main knows it (its cancel, its "7 of 12", its finished ledger). New on every arm. */
  armId?: string
  /** An album's songs landed so far, from main. */
  progress?: { have: number; of: number }
  /** Brief 258: main was still running this arm when the window reloaded; it is
   *  followed (main's end event, main's live list) instead of started again. Not saved. */
  attached?: boolean
}

export function queueKey(r: QResult): string {
  return `${r.source}|${r.mediaType}|${r.id}`
}

let queue: QItem[] = []
const running: Record<Lane, boolean> = { album: false, song: false }
const subs = new Set<() => void>()
// Jobs are mutated in place (pump/cancel/retry hold the object across
// awaits), so every emit hands out a FRESH array: useSyncExternalStore
// readers (sidebar badge, Downloads panel) compare snapshots by reference
// and would otherwise miss queued→downloading→done on the same object.
const emit = (): void => { queue = [...queue]; for (const f of subs) f(); scheduleSave() }

let armSeq = 0
function newArmId(): string {
  const rnd = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return `arm-${Date.now().toString(36)}-${(armSeq++).toString(36)}-${rnd}`
}

// ── The saved list (Brief 258) ──────────────────────────────────────────
// Every change is written (main: download-queue-store.ts, atomic, coalesced).
// Nothing is written until the saved list has actually been read back, so a
// fresh start (or a load that failed: main not ready yet, a read error) can
// never overwrite yesterday's waiting list with an empty one. A failed load is
// asked again with backoff, for as long as it takes; after a few tries the
// lanes may start meanwhile, but nothing is saved until a load succeeds.
let restored = false
/** The load has failed a few times: downloads run meanwhile, still unsaved. */
let pumpWithoutList = false
let saveQueued = false
let retryBaseMs = 250
const RETRY_MAX_MS = 15_000
const PUMP_AFTER_FAILED_LOADS = 5
function scheduleSave(): void {
  if (!restored || saveQueued) return
  const save = typeof window !== 'undefined' ? window.electronAPI?.downloadQueueSave : undefined
  if (typeof save !== 'function') return
  saveQueued = true
  queueMicrotask(() => {
    saveQueued = false
    void Promise.resolve(save(toSavedJobs(queue))).catch(() => { /* the next change saves again */ })
  })
}

/** How a job ended, when main said so before the saved list was back (a reload mid-job). */
const endedEarly = new Map<string, JobEndResult>()

/**
 * Bring the saved list back (app start, or a window reload while main runs).
 * A job main is still running (its arm id in `live`) is followed, never
 * started again: a reload mid-import must not download the album twice. A job
 * that was downloading and is no longer running starts again from nothing,
 * first in its lane; one main finished just before is done; everything else
 * keeps its place. Jobs queued before the list came back stay, after it. Album
 * jobs ask their preflight again; none writes a second usage line.
 */
export async function restoreSavedQueue(doc?: SavedQueueDoc | null): Promise<void> {
  let d: SavedQueueDoc | null | undefined
  if (doc !== undefined) d = doc
  else {
    const load = window.electronAPI?.downloadQueueLoad
    for (let attempt = 0; ; attempt++) {
      try { d = typeof load === 'function' ? await load() : null; break } catch {
        // main isn't answering yet (or the file couldn't be read): ask again, never save meanwhile.
        if (attempt + 1 >= PUMP_AFTER_FAILED_LOADS && !pumpWithoutList) { pumpWithoutList = true; void pump() }
        await new Promise((r) => setTimeout(r, Math.min(RETRY_MAX_MS, retryBaseMs * 2 ** attempt)))
      }
    }
  }
  try { applySaved(d) } catch { /* a list that can't be applied: start with what there is */ }
  restored = true
  emit()
  void pump()
}

function applySaved(d: SavedQueueDoc | null | undefined): void {
  if (!d || !Array.isArray(d.jobs)) return
  const live = new Set(Array.isArray(d.live) ? d.live : [])
  const have = new Set(queue.map((q) => q.key))
  const back: QItem[] = []
  const following = new Set<string>()
  for (const j of restoreJobs(d, Date.now())) {
    if (have.has(j.key)) continue
    const { interrupted: _i, ...job } = j
    const it = job as unknown as QItem
    const early = it.armId ? endedEarly.get(it.armId) : undefined
    if (early && (it.status === 'queued' || it.status === 'downloading')) {
      // It ended while the window was away: its end, not a second download.
      endedEarly.delete(it.armId!)
      it.startedAt = it.startedAt ?? Date.now()
      applyEnd(it, early)
      it.endedAt = Date.now()
    } else if (it.status === 'queued' && it.armId && live.has(it.armId)) {
      // Main is still on it (mid-rip or mid-import): follow it.
      it.status = 'downloading'
      it.attached = true
      it.startedAt = Date.now()
      if (laneOf(it.result) === 'album' && (it.result.trackCount ?? 0) > 1) it.progress = { have: 0, of: it.result.trackCount! }
      following.add(it.armId)
    } else if (it.status === 'queued') it.armId = newArmId()
    back.push(it)
  }
  // A rip main runs that no job here names: stop it. A job this window started
  // while the list couldn't be read is already in `queue`: it is ours, never stopped.
  const ours = new Set(following)
  for (const q of queue) if (q.armId) ours.add(q.armId)
  for (const id of live) if (!ours.has(id)) void window.electronAPI?.streamripCancelActive?.(id)?.catch(() => {})
  queue = [...back, ...queue]
  for (const it of back) if (it.status === 'queued') { askPreflight(it); it.logged = true }
  if (following.size) watchFollowed()
}

/** Write a job's end onto it (the pump's answer, or main's end event for a followed job). */
function applyEnd(it: QItem, r: JobEndResult | undefined): void {
  if (r?.ok) {
    it.status = 'done'
    it.imported = r.imported ?? 0
    it.dupes = r.dupes ?? 0
    it.matchDesc = r.matchDesc
    it.completion = r.completion
  } else {
    it.status = 'failed'
    it.error = r?.error || 'Download failed.'
    it.outcome = r?.outcome
    it.alternatives = r?.alternatives
    it.primary = r?.primary || primaryFor(r?.outcome, it.error)
    it.detail = r?.detail || it.error
  }
}

/** A followed job's end arrived from main. */
function endFollowed(it: QItem, r: JobEndResult | null): void {
  it.attached = false
  if (it.status === 'downloading') {
    if (r) applyEnd(it, r)
    else { it.status = 'queued'; it.armId = newArmId(); it.startedAt = undefined }   // gone without an end: start it again
    it.endedAt = r ? Date.now() : undefined
    it.progress = undefined
  }
  emit()
  void pump()
}

/**
 * The safety net under main's end event (it can be lost while the window is
 * reloading again): every so often ask main which jobs it still runs. A
 * followed job that isn't running any more is done if main's ledger has it,
 * otherwise it starts again.
 */
let followTimer: ReturnType<typeof setInterval> | null = null
let followEveryMs = 20_000
function watchFollowed(): void {
  if (followTimer) return
  followTimer = setInterval(() => {
    const followed = queue.filter((q) => q.attached && q.status === 'downloading')
    if (!followed.length) { clearInterval(followTimer!); followTimer = null; return }
    void Promise.resolve(window.electronAPI?.downloadQueueLoad?.()).then((d) => {
      if (!d) return
      const live = new Set(Array.isArray(d.live) ? d.live : [])
      for (const it of followed) {
        if (!it.attached || it.status !== 'downloading' || live.has(it.armId!)) continue
        const fin = d.finished?.[it.armId!]
        endFollowed(it, fin ? { ok: true, imported: fin.imported, dupes: fin.dupes, matchDesc: fin.matchDesc, completion: fin.completion } : null)
      }
    }).catch(() => { /* asked again next time */ })
  }, followEveryMs)
  ;(followTimer as { unref?: () => void }).unref?.()
}


export function subscribeQueue(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}
export function getQueue(): QItem[] { return queue }
export function itemFor(r: QResult): QItem | undefined { return queue.find((q) => q.key === queueKey(r)) }
/** The job a recommendation is riding on, if any. */
export function itemForRecommendation(recommendationId: string): QItem | undefined {
  return queue.find((q) => q.result.origin?.recommendationIds.includes(recommendationId))
}

/** Adopt a second origin onto an existing job (same recording, another
 *  recommender). Ids are unioned; the first source label is kept. */
export function mergeOrigin(into: QResult, from?: QueueOrigin): void {
  if (!from) return
  if (!into.origin) { into.origin = { ...from, recommendationIds: [...from.recommendationIds] }; return }
  for (const id of from.recommendationIds) if (!into.origin.recommendationIds.includes(id)) into.origin.recommendationIds.push(id)
  if (!into.origin.entryId && from.entryId) into.origin.entryId = from.entryId
  if (!into.origin.sourceLabel && from.sourceLabel) { into.origin.sourceLabel = from.sourceLabel; into.origin.sourceKind = from.sourceKind }
  if (!into.origin.addedVia && from.addedVia) into.origin.addedVia = from.addedVia
}

export function queueSummary(): { active: number; queued: number; done: number; failed: number } {
  let active = 0, queued = 0, done = 0, failed = 0
  for (const q of queue) {
    if (q.status === 'downloading') active++
    else if (q.status === 'queued') queued++
    else if (q.status === 'done') done++
    else if (q.status === 'failed') failed++
  }
  return { active, queued, done, failed }
}

/** Add a result to the queue (or re-arm a failed one). No-op if already queued,
 *  running, or done — clicking twice never double-grabs. */
export function enqueue(r: QResult): void {
  const key = queueKey(r)
  const existing = queue.find((q) => q.key === key)
  if (existing) {
    mergeOrigin(existing.result, r.origin)
    if (existing.status === 'failed' || existing.status === 'canceled') { existing.status = 'queued'; existing.error = undefined; existing.attempt = (existing.attempt ?? 1) + 1; existing.armId = newArmId(); askPreflight(existing, r.clickedAt); emit(); void pump() }
    else emit()
    return
  }
  const it: QItem = { key, result: r, status: 'queued', armId: newArmId() }
  queue = [...queue, it]
  askPreflight(it, r.clickedAt)
  emit()
  void pump()
}

// ── The album preflight (Brief 255) ─────────────────────────────────────
// An album job asks main, the moment it is queued, whether Qobuz has that
// edition (main 'check-qobuz-album'). The question runs beside the one
// download in flight, so a "no" lands in seconds even with songs ahead of it:
// the job ends there with one plain line, and the walk never runs. "found"
// and "unknown" (no login, no answer, too slow, a Bandcamp page worth trying)
// leave it queued, and it downloads in its turn exactly as before. The pump
// waits for an album's answer before starting it.
const asking = new Map<QItem, Promise<void>>()

function wantsPreflight(r: QResult): boolean {
  return r.kind === 'query' && r.mediaType === 'album' && !r.sourceEdition && !r.origin?.group
    && Boolean((r.album || '').trim() && (r.artist || '').trim())
    && typeof window !== 'undefined' && typeof window.electronAPI?.checkQobuzAlbum === 'function'
}

/** One `shop.album-save` line, at the first answer (usage log, never words). */
function logAlbumSave(it: QItem, answer: 'found' | 'no' | 'done' | 'failed', p?: AlbumPreflight): void {
  if (it.armedAt == null || it.logged) return
  it.logged = true
  const ev = albumSaveEvent({
    clickedAt: it.armedAt, answeredAt: Date.now(), answer,
    why: p && 'why' in p ? p.why : undefined,
    surface: it.result.surface, edition: it.result.editionFrom,
    have: p?.answer === 'no' ? p.have : undefined, of: p?.answer === 'no' ? p.of : undefined,
  })
  try { window.electronAPI.usageLog?.([{ t: new Date().toISOString(), ...ev }]) } catch { /* observation only */ }
}

function askPreflight(it: QItem, clickedAt?: number): void {
  if (!wantsPreflight(it.result)) return
  // The first arm is timed from the click (an edition lookup may sit between); a re-arm from now.
  it.armedAt = it.attempt && it.attempt > 1 ? Date.now() : (clickedAt ?? Date.now())
  it.logged = false
  it.preflight = 'asking'
  it.preflightAnswer = undefined
  const r = it.result
  const unknown = (why: 'timeout' | 'error'): AlbumPreflight => ({ answer: 'unknown', why })
  const ask = window.electronAPI.checkQobuzAlbum!({
    artist: (r.artist || '').trim(), album: (r.album || '').trim(),
    collectionId: r.collectionId, trackCount: r.trackCount, releaseYear: r.releaseYear, explicitSource: r.explicitSource,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled: Promise<void> = Promise.race([
    Promise.resolve(ask).catch(() => unknown('error')),
    new Promise<AlbumPreflight>((res) => { timer = setTimeout(() => res(unknown('timeout')), PREFLIGHT_BUDGET_MS + 5000) }),
  ]).then((p) => {
    if (timer) clearTimeout(timer)
    // Asked again since: this answer is nobody's.
    if (asking.get(it) !== settled) return
    asking.delete(it)
    // Canceled while asking.
    if (!queue.includes(it) || it.status !== 'queued') return
    it.preflight = p?.answer ?? 'unknown'
    it.preflightAnswer = p
    const v = p ? preflightVerdict(p) : null
    if (v) {
      it.status = 'failed'
      it.outcome = v.outcome
      it.primary = v.primary
      it.detail = v.detail
      it.error = v.error
      it.alternatives = v.alternatives
      it.startedAt = it.armedAt
      it.endedAt = Date.now()
    }
    if (p?.answer === 'found' || p?.answer === 'no') logAlbumSave(it, p.answer, p)
    emit()
  })
  asking.set(it, settled)
}

/** Cancel a queued item (drop it) or an in-flight one (kill the rip
 *  process; main's staging cleanup handles the partial files). */
export async function cancel(key: string): Promise<void> {
  const it = queue.find((q) => q.key === key)
  if (!it) return
  if (it.status === 'queued') {
    queue = queue.filter((q) => q.key !== key)
    emit()
    return
  }
  if (it.status === 'downloading') {
    it.status = 'canceled'
    it.endedAt = Date.now()
    const followed = it.attached
    it.attached = false
    emit()
    // Only this job: the other lane keeps going.
    await window.electronAPI.streamripCancelActive?.(it.armId).catch(() => {})
    if (followed) void pump()
  }
}

export function retry(key: string): void {
  const it = queue.find((q) => q.key === key)
  if (!it || it.status === 'downloading' || it.status === 'queued') return
  it.status = 'queued'
  it.error = undefined
  it.imported = undefined
  it.dupes = undefined
  it.attempt = (it.attempt ?? 1) + 1
  it.armId = newArmId()
  askPreflight(it)
  emit()
  void pump()
}

/** Re-arm every failed/canceled item. The queue bar's Retry uses this so
 *  three stacked misses aren't a click-each-one scavenger hunt. */
export function retryFailed(): void {
  let any = false
  for (const it of queue) {
    if (it.status !== 'failed' && it.status !== 'canceled') continue
    it.status = 'queued'
    it.error = undefined
    it.imported = undefined
    it.dupes = undefined
    it.attempt = (it.attempt ?? 1) + 1
    it.armId = newArmId()
    askPreflight(it)
    any = true
  }
  if (!any) return
  emit()
  void pump()
}

/** Drop the done/failed items — a "clear finished" affordance. */
export function clearFinished(): void {
  queue = queue.filter((q) => q.status === 'queued' || q.status === 'downloading')
  emit()
}

/** Start whatever each lane can start: one album and one song at a time, side by side. */
function pump(): Promise<void> {
  return Promise.all([pumpLane('album'), pumpLane('song')]).then(() => undefined)
}

async function pumpLane(lane: Lane): Promise<void> {
  if (running[lane]) return
  running[lane] = true
  try {
    for (;;) {
      if (!restored && !pumpWithoutList) break   // the saved list first, then its order
      // A job main kept running through a window reload holds its lane until it ends.
      if (queue.some((q) => q.attached && q.status === 'downloading' && laneOf(q.result) === lane)) break
      const it = nextInLane(queue, lane)
      if (!it) break
      // An album still asking Qobuz: its answer first (seconds). A "no" ends it there.
      const pending = asking.get(it)
      if (pending) { await pending; continue }
      it.status = 'downloading'
      it.startedAt = Date.now()
      it.imported = undefined
      it.dupes = undefined
      it.error = undefined
      it.outcome = undefined
      it.alternatives = undefined
      it.primary = undefined
      it.detail = undefined
      it.matchDesc = undefined
      it.completion = undefined
      it.progress = laneOf(it.result) === 'album' && (it.result.trackCount ?? 0) > 1 ? { have: 0, of: it.result.trackCount! } : undefined
      if (!it.armId) it.armId = newArmId()
      emit()
      try {
        const r: { ok: boolean; imported?: number; dupes?: number; error?: string; outcome?: string; alternatives?: Array<{ provider: string; desc: string; reason: string; tracks?: Array<{ title: string; trackNumber?: number; discNumber?: number; durationSec?: number | null }>; trackCount?: number; url?: string }>; primary?: string; detail?: string; matchDesc?: string; completion?: string } | undefined = it.result.kind === 'query'
          ? await window.electronAPI.streamripDownloadByQuery?.({ artist: it.result.artist, askedArtist: it.result.askedArtist, title: it.result.title, album: it.result.album, durationMs: it.result.durationMs, cleanedSource: it.result.cleanedSource, explicitSource: it.result.explicitSource, releaseYear: it.result.releaseYear, collectionId: it.result.collectionId, trackCount: it.result.trackCount, sourceEdition: it.result.sourceEdition, addedVia: it.result.origin?.addedVia, jobId: it.armId })
          : await window.electronAPI.streamripDownloadId?.(it.result.source, it.result.mediaType, it.result.id, it.result.origin?.addedVia, it.armId)
        // Read through a widened alias. TypeScript narrows it.status to
        // 'downloading' before the await and cannot see that cancel() mutates
        // it DURING the await, so it calls this comparison unreachable. The
        // runtime behaviour is correct and load-bearing — without this branch a
        // download the user cancelled mid-flight would be overwritten with
        // 'done' or 'failed' and the cancel would appear to do nothing.
        const statusNow = it.status as QStatus
        if (statusNow === 'canceled') { /* user killed it mid-flight — keep that verdict */ }
        else applyEnd(it, r)
      } catch (e) {
        const statusAfterThrow = it.status as QStatus
        if (statusAfterThrow !== 'canceled') {
          it.status = 'failed'
          it.error = e instanceof Error ? e.message : 'Download failed.'
          it.primary = 'Download failed'
          it.detail = it.error
        }
      }
      it.endedAt = Date.now()
      it.progress = undefined
      // The preflight couldn't tell: the walk's own end is the first answer.
      const ended = it.status as QStatus   // applyEnd set it; TypeScript still sees 'downloading'
      if (it.preflight === 'unknown' && (ended === 'done' || ended === 'failed')) logAlbumSave(it, ended, it.preflightAnswer)
      emit()
    }
  } finally {
    running[lane] = false
  }
}

/** Tests: forget the list and both lanes (a quit), then `restoreSavedQueue` brings the saved one back. */
export function resetQueueForTests(opts: { restored?: boolean; retryMs?: number; followMs?: number } = {}): void {
  queue = []
  running.album = false
  running.song = false
  asking.clear()
  endedEarly.clear()
  if (followTimer) { clearInterval(followTimer); followTimer = null }
  restored = opts.restored ?? true
  pumpWithoutList = false
  retryBaseMs = opts.retryMs ?? 250
  followEveryMs = opts.followMs ?? 20_000
}

/** The short status for an outcome when main did not send one (older
 *  paths, thrown errors). ⚠️ TWIN: src/main/exact-recording.ts describeOutcome. */
export function primaryFor(outcome: string | undefined, error?: string): string {
  switch (outcome) {
    case 'exact-not-found': return 'Exact version not found'
    case 'unverifiable': return 'Couldn’t verify recording'
    case 'provider-unavailable': return 'Provider unavailable'
    case 'not-found': return 'Not found'
    case 'not-released': return 'Not out yet'
    case 'canceled': return 'Canceled'
    case 'provider-failed': return 'Download failed'
    default: return /not out yet/i.test(error || '') ? 'Not out yet' : 'Download failed'
  }
}

// App start: hear an album's songs landing, and bring the saved list back.
if (typeof window !== 'undefined' && window.electronAPI) {
  try {
    window.electronAPI.onStreamripJobProgress?.((p) => {
      const it = queue.find((q) => q.armId === p.jobId)
      if (!it || it.status !== 'downloading') return
      // Never backwards on screen; main's reset (the walk moved to Bandcamp) starts it over.
      it.progress = nextProgress(it.progress, p)
      queue = [...queue]
      for (const f of subs) f()
    })
  } catch { /* observation only */ }
  try {
    window.electronAPI.onStreamripJobEnded?.((p) => {
      const it = queue.find((q) => q.armId === p.jobId)
      if (it) { if (it.attached) endFollowed(it, p.result); return }   // a job this window started hears its own answer
      if (!restored) {
        endedEarly.set(p.jobId, p.result)
        if (endedEarly.size > 50) endedEarly.delete(endedEarly.keys().next().value!)
      }
    })
  } catch { /* observation only */ }
  if (typeof window.electronAPI.downloadQueueLoad === 'function') void restoreSavedQueue()
  else restored = true
} else restored = true
