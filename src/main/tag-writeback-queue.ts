/**
 * Tag write-back, one edit at a time (2026-11-13).
 *
 * An edit Jake makes to a title, artist, album, genre, year or track/disc
 * number is also written into the audio file's own tags. That used to start
 * the moment each edit arrived, and each one read and parsed the whole of
 * library.json to find its one song.
 *
 * 2026-11-13 23:24: Jake fixed the tags on four albums he had just got (41
 * songs, 186 writable fields, one Get Info). 186 reads of a 14 MB file were
 * in flight at once. Node hands a file that size back as 512 KB pieces, two
 * bytes a character when a piece has one character outside Latin-1, so each
 * read held about 28 MB: 4 GB, the main process's whole heap. V8 aborted the
 * app ("CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of
 * memory") six seconds after his next click. Replayed on a copy of his
 * library: 84 MB to the abort in under two seconds, 2.9 of 3.0 GB held by
 * those reads.
 *
 * So:
 *   • The song comes from the library already in memory (`findTrack`). No
 *     edit reads the file.
 *   • One write-back runs at a time, in the order the edits arrived. It also
 *     means one tag-writer process at a time, not one per field.
 *   • What waits is four short strings an edit. The line is capped anyway,
 *     and nothing new starts while the heap is nearly full: a write-back
 *     that is skipped costs a tag in a file (the edit itself is already
 *     saved, and "Apply Overrides to Files…" writes it later). It can never
 *     cost the app.
 *
 * Electron-free; every effect is injected (__tests__/tag-writeback-queue.test.ts).
 */

export interface TagWritebackJob {
  trackId: number
  field: string
  value: string
  fingerprint?: string
}

export interface TagWritebackDeps<T> {
  /** The song with this id, from the library held in memory. Never a read of library.json. */
  findTrack: (trackId: number) => Promise<T | undefined>
  /** Write one edit into the song's file. May reject; the queue goes on. */
  write: (job: TagWritebackJob, track: T) => Promise<void>
  /** Heap in use as a share of its limit, 0 to 1. Absent = never checked. */
  heapShare?: () => number
  warn?: (msg: string) => void
  maxWaiting?: number
  heapCeiling?: number
}

/** More edits than any one action makes (every song in the library, one field). */
export const TAG_WRITEBACK_MAX_WAITING = 20_000
/** Past this share of the heap limit nothing new starts. */
export const TAG_WRITEBACK_HEAP_CEILING = 0.8

export interface TagWritebackStats { waiting: number; written: number; skippedFull: number; skippedHeap: number; failed: number }

export function createTagWritebackQueue<T>(deps: TagWritebackDeps<T>): {
  /** False when the edit was not taken (the line is full). Never throws. */
  enqueue: (job: TagWritebackJob) => boolean
  /** Resolves when nothing is waiting or running (tests, quit). */
  idle: () => Promise<void>
  stats: () => TagWritebackStats
} {
  const maxWaiting = deps.maxWaiting ?? TAG_WRITEBACK_MAX_WAITING
  const heapCeiling = deps.heapCeiling ?? TAG_WRITEBACK_HEAP_CEILING
  const warn = deps.warn ?? (() => {})
  const waiting: TagWritebackJob[] = []
  const s = { written: 0, skippedFull: 0, skippedHeap: 0, failed: 0 }
  let draining: Promise<void> | null = null
  // One line in the log per burst, not one per edit.
  let toldFull = false
  let toldHeap = false

  const heapIsFull = (): boolean => {
    if (!deps.heapShare) return false
    try { return deps.heapShare() > heapCeiling } catch { return false }
  }

  const drain = async (): Promise<void> => {
    // A turn first: the edits of one action arrive in the same turn, and they
    // are then all on the line before the first is looked at.
    await Promise.resolve()
    while (waiting.length) {
      const job = waiting.shift()!
      if (heapIsFull()) {
        s.skippedHeap++
        if (!toldHeap) {
          toldHeap = true
          warn(`[tag-writeback] memory is nearly full: tags are not being written into files for now (first skipped: ${job.trackId} ${job.field}). The edits themselves are saved.`)
        }
        continue
      }
      try {
        const track = await deps.findTrack(job.trackId)
        if (track === undefined) continue
        await deps.write(job, track)
        s.written++
      } catch (err) {
        s.failed++
        warn(`[tag-writeback] hook error for trackId=${job.trackId} field=${job.field}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    toldFull = false
    toldHeap = false
  }
  // An edit that arrives as a drain is ending is never left on the line: when
  // the drain is over and something waits, another starts.
  const kick = (): void => {
    if (draining) return
    draining = drain().finally(() => { draining = null; if (waiting.length) kick() })
  }

  return {
    enqueue(job) {
      if (waiting.length >= maxWaiting) {
        s.skippedFull++
        if (!toldFull) {
          toldFull = true
          warn(`[tag-writeback] ${maxWaiting} edits are already waiting to be written into files: more are not taken until they are (first skipped: ${job.trackId} ${job.field}). The edits themselves are saved.`)
        }
        return false
      }
      waiting.push({ trackId: job.trackId, field: job.field, value: job.value, fingerprint: job.fingerprint })
      kick()
      return true
    },
    async idle() { while (draining) await draining },
    stats: () => ({ waiting: waiting.length, ...s }),
  }
}
