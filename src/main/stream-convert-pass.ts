/**
 * One pass over the stream-convert queue (2026-11-09). Out of index.ts, which
 * is ratcheted; every effect is injected (__tests__/stream-convert-pass.test.ts).
 *
 * What changed, and why (~/concert-repair/refused-copies-diagnosis.md):
 *   • A row is judged on the library's record of the song NOW. 254 rows carried
 *     the fingerprint saved when they were queued, the files were retagged
 *     since, and they could never convert.
 *   • A row whose path is no longer in the library is dropped (124 rows that
 *     never left). A row holds a path and no id, so the match is the exact path
 *     string against a library song that has an id: no case folding, no
 *     normalising, and a song that moved to another path is not this row. Not
 *     in its first hour: an import is queued before the library that names it
 *     is saved. Never when the library read came back empty. Each dropped path
 *     is logged. Dropping a row only edits the queue; no audio file is touched.
 *   • homemini is asked what it holds for the due rows in one small request
 *     (audio-identity.ts). No answer at all: the rows are left exactly as they
 *     were. No such route (an older backend): the old check runs, but never
 *     while away from home, where it means downloading every file whole.
 *   • A file homemini hasn't hashed yet (`pending`) leaves its row as it was:
 *     asking is what makes homemini hash it, and the next pass has the answer.
 *   • A refusal is remembered on its row, so nothing is hashed or fetched for
 *     it again until this Mac's file or homemini's copy changes.
 */
import { decideStreamConvertAttempt, decideStreamConvertMiss, type StreamConvertRetryItem } from './stream-convert-retry.ts'
import type { IdentityAnswer, OneIdentity } from './audio-identity.ts'
import type { RefusalMemo } from './offload-confirm.ts'

export interface StreamConvertItem extends StreamConvertRetryItem {
  ipodPath: string
  /** The fingerprint when the row was queued. Kept for old readers; never judged on. */
  fingerprint?: string
  /** The last refusal (offload-confirm.ts). */
  refused?: RefusalMemo
}

export interface QueueTrack { id?: unknown; path?: unknown; audioFingerprint?: unknown }

export interface QueueRow<T extends StreamConvertItem = StreamConvertItem> {
  item: T
  id: string | number
  /** The library's fingerprint of the song now. */
  fingerprint?: string
}

/** A row not in the library is left alone this long: an import is queued before the library is saved. */
export const QUEUE_ORPHAN_GRACE_MS = 60 * 60 * 1000

/**
 * Match the queue to the library. null = the library read is empty, which says
 * nothing about any row. `waiting` rows aren't in the library yet (young);
 * `dropped` rows aren't in it and are old enough that they never will be.
 */
export function reconcileQueueWithLibrary<T extends StreamConvertItem>(
  items: readonly T[],
  tracks: ReadonlyArray<QueueTrack>,
  now: number,
  graceMs = QUEUE_ORPHAN_GRACE_MS,
): { rows: Map<T, QueueRow<T>>; waiting: T[]; dropped: T[] } | null {
  const byPath = new Map<string, QueueTrack>()
  for (const t of tracks) {
    const p = typeof t?.path === 'string' ? t.path : ''
    if (p && t.id != null && t.id !== '') byPath.set(p, t)
  }
  if (byPath.size === 0) return null
  const out = { rows: new Map<T, QueueRow<T>>(), waiting: [] as T[], dropped: [] as T[] }
  for (const item of items) {
    const t = byPath.get(item.ipodPath)
    if (!t) {
      const age = now - Number(item.enqueuedAt)
      // A row with no usable timestamp is treated as young: it is never dropped on a guess.
      ;(Number.isFinite(age) && age > graceMs ? out.dropped : out.waiting).push(item)
      continue
    }
    const fp = typeof t.audioFingerprint === 'string' && t.audioFingerprint.startsWith('sha1:') ? t.audioFingerprint : undefined
    out.rows.set(item, { item, id: t.id as string | number, ...(fp ? { fingerprint: fp } : {}) })
  }
  return out
}

export type ConvertOutcome =
  | { ok: true }
  | { ok: false; reason?: string; refused?: RefusalMemo; error?: string }

export interface ConvertPassDeps<T extends StreamConvertItem> {
  now: number
  items: readonly T[]
  tracks: ReadonlyArray<QueueTrack>
  maxAgeMs: number
  /** At most this many tries in one pass; null = no limit. */
  batch: number | null
  /** true = this song stays on this Mac (an iPod's list). */
  kept: (item: T) => boolean
  away: () => Promise<boolean>
  askIdentity: (ids: Array<string | number>) => Promise<IdentityAnswer>
  /** `allowWholeFile` false: the old whole-file compare must not run. */
  convert: (row: QueueRow<T>, identity: OneIdentity, allowWholeFile: boolean) => Promise<ConvertOutcome>
  log: (msg: string) => void
}

export interface ConvertPassResult<T extends StreamConvertItem> {
  keep: T[]
  changed: boolean
  converted: number
  dropped: number
  tried: number
}

export async function runConvertPass<T extends StreamConvertItem>(deps: ConvertPassDeps<T>): Promise<ConvertPassResult<T>> {
  const untouched: ConvertPassResult<T> = { keep: [...deps.items], changed: false, converted: 0, dropped: 0, tried: 0 }
  const rec = reconcileQueueWithLibrary(deps.items, deps.tracks, deps.now)
  if (!rec) return untouched
  const dropped = new Set<T>(rec.dropped)
  // Only the queue's own rows leave. Nothing here can reach an audio file: this module has no file access.
  if (dropped.size) deps.log(`[stream-convert] ${dropped.size} queue row(s) dropped: the path is no longer in the library`)
  for (const it of dropped) deps.log(`[stream-convert] dropped from the queue (no library song has this exact path; the file, if any, is untouched): ${it.ipodPath}`)
  const afterDrop = (): ConvertPassResult<T> => ({
    keep: deps.items.filter((it) => !dropped.has(it)), changed: dropped.size > 0, converted: 0, dropped: dropped.size, tried: 0,
  })

  const due: Array<QueueRow<T>> = []
  for (const it of deps.items) {
    const row = rec.rows.get(it)
    if (!row) continue
    if (decideStreamConvertAttempt(it, deps.now) === 'wait' || deps.kept(it)) continue
    if (deps.batch != null && due.length >= deps.batch) break
    due.push(row)
  }
  if (!due.length) return afterDrop()

  let answer: IdentityAnswer
  try { answer = await deps.askIdentity(due.map((r) => r.id)) } catch { answer = { kind: 'unreachable' } }
  if (answer.kind === 'unreachable') {
    deps.log('[stream-convert] homemini didn’t say what it holds; nothing checked this pass')
    return afterDrop()
  }
  let allowWholeFile = true
  if (answer.kind === 'unsupported') {
    if (await deps.away().catch(() => true)) {
      deps.log(`[stream-convert] away from home and homemini can’t say what it holds without sending it: ${due.length} song(s) not checked`)
      return afterDrop()
    }
  } else {
    // homemini answered: nothing here ever needs the whole file.
    allowWholeFile = false
  }

  const dueSet = new Set(due.map((r) => r.item))
  const out: ConvertPassResult<T> = { keep: [], changed: dropped.size > 0, converted: 0, dropped: dropped.size, tried: 0 }
  for (const it of deps.items) {
    if (dropped.has(it)) continue
    if (!dueSet.has(it)) { out.keep.push(it); continue }
    const row = rec.rows.get(it)!
    const identity: OneIdentity = answer.kind === 'unsupported' ? 'unsupported' : (answer.byId.get(String(row.id)) ?? null)
    out.tried++
    let r: ConvertOutcome
    try { r = await deps.convert(row, identity, allowWholeFile) } catch (err) { r = { ok: false, error: err instanceof Error ? err.message : String(err) } }
    if (r.ok) {
      deps.log(`[stream-convert] converted to streamed: ${it.ipodPath}`)
      out.converted++
      out.changed = true
      continue
    }
    // Nothing was learned about the song: the row stays as it was and is asked about next pass.
    if (r.reason === 'away' || r.reason === 'pending') { out.keep.push(it); continue }
    const miss = decideStreamConvertMiss(it, deps.now, deps.maxAgeMs)
    let next: T = miss.item
    const sameMemo = !!r.refused && it.refused?.local === r.refused.local && it.refused?.remote === r.refused.remote
    if (r.refused && !sameMemo) {
      next = { ...next, refused: r.refused }
      out.changed = true
      deps.log(`[stream-convert] homemini holds other bytes for this song; not checked again until its copy or this Mac’s changes: ${it.ipodPath}`)
    } else if (!r.refused && it.refused && (r.reason === 'different' || r.reason === 'missing')) {
      // The old refusal no longer describes what was found.
      const { refused: _gone, ...rest } = next
      next = rest as T
      out.changed = true
    }
    if (miss.rescheduled) {
      out.changed = true
      if (!r.refused) deps.log(`[stream-convert] no homemini match yet (${r.reason ?? r.error ?? 'unknown'}), will retry: ${it.ipodPath}`)
    }
    out.keep.push(next)
  }
  return out
}
