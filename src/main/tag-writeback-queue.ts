/**
 * Tag write-back, one edit at a time (2026-11-13, reviewed 2026-11-14).
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
 * So one write-back runs at a time and no edit reads the file. Doing them in
 * turn makes them slow enough (about 145 ms each) that four more things have
 * to hold, and each was wrong in the first version of this file:
 *
 *   • WHICH SONG is settled when the edit arrives (`resolveTagEdit`), from
 *     the library in memory. The fingerprint that comes with an edit is the
 *     song's title + artist BEFORE the edit; a second later the renderer
 *     saves the library with the new ones, and a write-back that looked the
 *     song up after that found a "different" song and skipped it (59 of that
 *     night's 186, on 10 of the 11 songs whose artist changed). The job
 *     carries the song's id and its exact path; the write is only stopped if
 *     that id no longer has that path.
 *   • What is waiting is ON DISK (`tag-writeback-pending.json`), so a quit,
 *     a crash, or a skip never loses a tag: the line is picked up at the
 *     next launch. A quit writes what it can in its budget and leaves the
 *     rest there.
 *   • Nothing is dropped for memory. With the heap nearly full the line
 *     waits and looks again later.
 *   • A tag writer that hangs is killed by its own clock (tag-writer.ts);
 *     that edit goes to the back to be tried later, and the line moves on.
 *   • The saved line is read before anything is saved over it. (An edit in
 *     the first seconds of a run used to replace it: 25 owed, 0 left.)
 *   • Only the newest edit of a song's field is written. An older one still
 *     waiting, waiting for a retry, or owed from the last run is dropped when
 *     a newer one arrives, so a retry can't put an old value over a new one.
 *
 * metadata-overrides.json stays the truth for what the tags should be; this
 * file is only "which of them still owe the audio file a write".
 *
 * Electron-free; every effect is injected (__tests__/tag-writeback-queue.test.ts).
 */

/** An edit as the renderer sends it. `fingerprint` is the song as it was BEFORE this edit. */
export interface TagEdit {
  trackId: number
  field: string
  value: string
  fingerprint?: string
}

/** An edit whose song has been settled: everything the write needs, nothing looked up later. */
export interface TagWritebackJob {
  trackId: number
  /** The song's library path (colon form) when the edit arrived. With `trackId`, the song's identity. */
  path: string
  field: string
  value: string
  /** What goes into the file: the field, plus its pair (track 3 "of 11"). */
  overrides: Record<string, string | number>
  /** The song's length, for the fingerprint re-measured after the write. */
  duration: number
  /** Times a tag writer has timed out on this edit. */
  tries: number
}

type LibraryRow = Record<string, unknown>

/** `title|artist|duration`, lower-cased and trimmed: the renderer's fingerprint of a library row. */
export function trackFingerprint(track: LibraryRow): string {
  return `${String(track.title || '').toLowerCase().trim()}|${String(track.artist || '').toLowerCase().trim()}|${track.duration || 0}`
}

export type ResolvedTagEdit =
  | { job: TagWritebackJob }
  | { skip: 'no-track' | 'no-path' | 'fingerprint' }

/**
 * Settle an edit against the library row it names, at the moment it arrives.
 * `fingerprint` guards the id: when it is given and the row at that id is not
 * that song, nothing may be written.
 */
export function resolveTagEdit(
  edit: TagEdit,
  track: LibraryRow | undefined,
  augment: (field: string, value: string, track: LibraryRow) => Record<string, string | number>,
): ResolvedTagEdit {
  if (!track) return { skip: 'no-track' }
  const path = String(track.path || '')
  if (!path) return { skip: 'no-path' }
  if (edit.fingerprint && trackFingerprint(track) !== edit.fingerprint) return { skip: 'fingerprint' }
  return {
    job: {
      trackId: edit.trackId,
      path,
      field: edit.field,
      value: edit.value,
      overrides: augment(edit.field, edit.value, track),
      duration: Number(track.duration) || 0,
      tries: 0,
    },
  }
}

/**
 * Does this overrides entry still belong to the song at its id? For "Apply
 * Overrides to Files…", which reads the entry long after the edit.
 *
 * The entry's fingerprint is the song BEFORE its first edit. Comparing it with
 * the library row as it is NOW refused every song whose title or artist Jake
 * had corrected, which is most of what the menu is for. So a title or artist
 * may differ from the fingerprint when the row carries exactly what the entry
 * set it to; the length must always match, and whatever the entry did not
 * change must match as before.
 */
export function overrideNamesTrack(entry: { fp?: string; fields?: Record<string, unknown> } | undefined, track: LibraryRow): boolean {
  const fp = entry?.fp
  if (!fp) return true                                    // no fingerprint was ever recorded: as before
  const now = trackFingerprint(track)
  if (fp === now) return true
  const norm = (v: unknown): string => String(v ?? '').toLowerCase().trim()
  const title = norm(track.title), artist = norm(track.artist)
  const tail = `|${track.duration || 0}`
  if (!fp.endsWith(tail)) return false                    // another length: another recording
  const was = fp.slice(0, fp.length - tail.length)        // "title|artist" as it was
  const fields = entry?.fields || {}
  const setTitle = typeof fields.title === 'string' && fields.title !== '' && norm(fields.title) === title
  const setArtist = typeof fields.artist === 'string' && fields.artist !== '' && norm(fields.artist) === artist
  if (setTitle && setArtist) return true
  if (setArtist) return was.startsWith(`${title}|`)       // the title is the one it had
  if (setTitle) return was.endsWith(`|${artist}`)         // the artist is the one it had
  return false
}

export interface TagWriteOutcome { ok: boolean; timedOut?: boolean; error?: string }

export interface TagWritebackDeps {
  /** The library row with this id, from memory. Never a read of library.json. */
  findTrack: (trackId: number) => Promise<LibraryRow | undefined>
  augment: (field: string, value: string, track: LibraryRow) => Record<string, string | number>
  /** Write one settled edit into its file. Never looks the song up again. May reject. */
  write: (job: TagWritebackJob) => Promise<TagWriteOutcome>
  /** What was waiting when the app last stopped. */
  load?: () => Promise<unknown>
  /** Put the waiting line on disk (whole list, replaced). */
  save?: (jobs: TagWritebackJob[]) => Promise<void>
  /** The same, without waiting: the last thing before the process leaves. */
  saveNow?: (jobs: TagWritebackJob[]) => void
  /** Heap in use as a share of its limit, 0 to 1. Absent = never checked. */
  heapShare?: () => number
  warn?: (msg: string) => void
  now?: () => number
  maxWaiting?: number
  heapCeiling?: number
  /** How long the line waits before looking at a full heap again. */
  heapWaitMs?: number
  /** How long a timed-out edit waits before its next try. */
  retryAfterMs?: number
  maxTries?: number
}

/** More edits than any one action makes (every song in the library, one field). */
export const TAG_WRITEBACK_MAX_WAITING = 20_000
/** Past this share of the heap limit nothing new starts. */
export const TAG_WRITEBACK_HEAP_CEILING = 0.8
export const TAG_WRITEBACK_HEAP_WAIT_MS = 60_000
export const TAG_WRITEBACK_RETRY_AFTER_MS = 10 * 60_000
export const TAG_WRITEBACK_MAX_TRIES = 3
export const TAG_WRITEBACK_PENDING_FILE = 'tag-writeback-pending.json'

export interface TagWritebackStats {
  /** On the line, the one being written included. */
  waiting: number
  /** Timed out, waiting for another try. */
  later: number
  written: number
  failed: number
  /** The song at that id no longer has that path: nothing to write to. */
  gone: number
  /** Refused because the line was full. */
  refused: number
  /** Times the line stopped to wait for memory. */
  heapWaits: number
  /** Dropped because a newer edit of the same song's field arrived. */
  superseded: number
}

/** A job read back from disk, or null when it isn't one. */
export function jobFromDisk(raw: unknown): TagWritebackJob | null {
  const o = raw as Partial<TagWritebackJob> | null
  if (!o || typeof o !== 'object') return null
  if (typeof o.trackId !== 'number' || !Number.isFinite(o.trackId)) return null
  if (typeof o.path !== 'string' || !o.path || typeof o.field !== 'string' || !o.field || typeof o.value !== 'string') return null
  const overrides: Record<string, string | number> = {}
  if (o.overrides && typeof o.overrides === 'object') {
    for (const [k, v] of Object.entries(o.overrides)) if (typeof v === 'string' || typeof v === 'number') overrides[k] = v
  }
  if (!(o.field in overrides)) overrides[o.field] = o.value
  return { trackId: o.trackId, path: o.path, field: o.field, value: o.value, overrides, duration: Number(o.duration) || 0, tries: Number(o.tries) || 0 }
}

export function createTagWritebackQueue(deps: TagWritebackDeps): {
  /**
   * An edit has arrived. Its song is settled now; the write waits its turn.
   * Resolves to the job taken, or to why none was. Never rejects.
   */
  edit: (edit: TagEdit) => Promise<ResolvedTagEdit | { skip: 'full' }>
  /** Put back what was waiting when the app last stopped. Read once, however it is first reached: here, or by the first edit. */
  resume: () => Promise<number>
  /**
   * The app is quitting: write what finishes within `budgetMs`, start nothing
   * after it, and leave the rest on disk for the next launch.
   */
  stop: (budgetMs: number) => Promise<{ written: number; left: number }>
  /** Resolves when nothing is being written and nothing can start right now (tests). */
  idle: () => Promise<void>
  stats: () => TagWritebackStats
} {
  const maxWaiting = deps.maxWaiting ?? TAG_WRITEBACK_MAX_WAITING
  const heapCeiling = deps.heapCeiling ?? TAG_WRITEBACK_HEAP_CEILING
  const heapWaitMs = deps.heapWaitMs ?? TAG_WRITEBACK_HEAP_WAIT_MS
  const retryAfterMs = deps.retryAfterMs ?? TAG_WRITEBACK_RETRY_AFTER_MS
  const maxTries = deps.maxTries ?? TAG_WRITEBACK_MAX_TRIES
  const warn = deps.warn ?? (() => {})
  const now = deps.now ?? Date.now

  const waiting: TagWritebackJob[] = []
  const later: TagWritebackJob[] = []
  let inFlight: TagWritebackJob | null = null
  const s = { written: 0, failed: 0, gone: 0, refused: 0, heapWaits: 0, superseded: 0 }
  let draining: Promise<void> | null = null
  let toldFull = false
  let heapTimer: ReturnType<typeof setTimeout> | null = null
  let laterTimer: ReturnType<typeof setTimeout> | null = null
  let stopAt: number | null = null

  const owed = (): TagWritebackJob[] => [...(inFlight ? [inFlight] : []), ...waiting, ...later]

  // ── only the newest edit of a field is ever written ──
  // Each job has a place in the order edits were made; `newest` is the latest
  // place seen for a song's field (the pair an edit carries counts: "track 3"
  // also writes "of 11"). An older edit of a field a newer one covers is
  // dropped wherever it is waiting, and is not tried again after a time-out:
  // a retry ten minutes later would put the old value over the new one.
  const order = new WeakMap<TagWritebackJob, number>()
  const newest = new Map<string, number>()
  let nextOrder = 0
  let nextOwedOrder = -1e12                                // what was owed from the last run is older than anything made in this one
  const key = (trackId: number, field: string): string => `${trackId}|${field}`
  const stamp = (job: TagWritebackJob, at: number): void => {
    order.set(job, at)
    for (const f of new Set([job.field, ...Object.keys(job.overrides)])) {
      const k = key(job.trackId, f)
      if ((newest.get(k) ?? -Infinity) < at) newest.set(k, at)
    }
  }
  const superseded = (job: TagWritebackJob): boolean => (newest.get(key(job.trackId, job.field)) ?? -Infinity) > (order.get(job) ?? -Infinity)
  const dropSuperseded = (): void => {
    for (const line of [waiting, later]) {
      for (let i = line.length - 1; i >= 0; i--) if (superseded(line[i])) { line.splice(i, 1); s.superseded++ }
    }
  }

  // ── what the last run still owed: read once, BEFORE anything is saved ──
  // The first save of a run used to go out before the saved line had been
  // read, and replaced it: one edit in the first seconds after launch wiped
  // every edit the last run still owed.
  let loading: Promise<number> | null = null
  let loaded = false
  const loadOnce = (): Promise<number> => {
    if (!loading) {
      loading = (async () => {
        let n = 0
        if (deps.load) {
          let raw: unknown
          try { raw = await deps.load() } catch { raw = [] }
          const jobs = (Array.isArray(raw) ? raw : []).map(jobFromDisk).filter((j): j is TagWritebackJob => j !== null)
          for (const j of jobs) stamp(j, nextOwedOrder++)
          // Ahead of anything that arrived since launch (they are older), minus
          // what a newer edit, from that run or this one, has replaced.
          const keep = jobs.filter((j) => !superseded(j))
          s.superseded += jobs.length - keep.length
          const room = Math.max(0, maxWaiting - waiting.length - later.length)
          waiting.unshift(...keep.slice(0, room))
          n = Math.min(keep.length, room)
          if (n) warn(`[tag-writeback] ${n} tag edit(s) from the last run are still owed to their files; writing them now`)
        }
        loaded = true
        return n
      })()
    }
    return loading
  }

  // ── the line on disk: one save at a time, the newest list wins ──
  let saving: Promise<void> | null = null
  let saveAgain = false
  const persist = (): void => {
    if (!deps.save) return
    if (saving) { saveAgain = true; return }
    saving = (async () => {
      await loadOnce()                                     // never rejects; nothing is saved over a line not yet read
      do {
        saveAgain = false
        try { await deps.save!(owed()) } catch (err) { warn(`[tag-writeback] could not save the waiting line: ${err instanceof Error ? err.message : String(err)}`) }
      } while (saveAgain)
      // Cleared here, in the same turn the loop ends: cleared a turn later, a
      // change made in between was told "a save is running" and never saved.
      saving = null
    })()
  }

  const heapIsFull = (): boolean => {
    if (!deps.heapShare) return false
    try { return deps.heapShare() > heapCeiling } catch { return false }
  }

  const drain = async (): Promise<void> => {
    // A turn first: the edits of one action arrive together, and they are then
    // all on the line (and in one save) before the first is looked at.
    await Promise.resolve()
    await loadOnce()                                       // what the last run owed goes first
    while (waiting.length) {
      if (stopAt !== null && now() >= stopAt) return        // quitting: what is left stays on disk
      if (heapIsFull()) {
        // Wait, don't drop: the line is on disk and is looked at again.
        s.heapWaits++
        warn(`[tag-writeback] memory is nearly full: ${waiting.length} tag edit(s) wait to be written into files (next: ${waiting[0].trackId} ${waiting[0].field}). They are kept and tried again.`)
        if (stopAt !== null) stopAt = 0                     // quitting: nothing more starts, the line stays on disk
        else if (!heapTimer) {
          heapTimer = setTimeout(() => { heapTimer = null; kick() }, heapWaitMs)
          heapTimer.unref?.()
        }
        return
      }
      const job = waiting.shift()!
      inFlight = job
      try {
        // The identity guard: the song this edit was made on is the id AND the
        // path it had. A row that has since gone, or moved, is not written to.
        const row = await deps.findTrack(job.trackId)
        if (!row || String(row.path || '') !== job.path) {
          s.gone++
          warn(`[tag-writeback] ${job.trackId} ${job.field}: the song is no longer at ${job.path}; nothing written`)
        } else {
          const r = await deps.write(job)
          if (r.ok) s.written++
          else if (r.timedOut) {
            job.tries++
            if (job.tries >= maxTries) {
              s.failed++
              warn(`[tag-writeback] ${job.trackId} ${job.field} failed: the tag writer timed out ${job.tries} times; given up ("Apply Overrides to Files…" writes it)`)
            } else if (superseded(job)) {
              s.superseded++                              // a newer edit of this field arrived meanwhile: this one is never retried
            } else {
              later.push(job)
              warn(`[tag-writeback] ${job.trackId} ${job.field}: the tag writer timed out and was stopped; the file is untouched, tried again later`)
              if (!laterTimer && stopAt === null) {
                laterTimer = setTimeout(() => { laterTimer = null; waiting.push(...later.splice(0)); kick() }, retryAfterMs)
                laterTimer.unref?.()
              }
            }
          } else {
            s.failed++
            warn(`[tag-writeback] ${job.trackId} ${job.field} failed: ${r.error ?? 'unknown'}`)
          }
        }
      } catch (err) {
        s.failed++
        warn(`[tag-writeback] hook error for trackId=${job.trackId} field=${job.field}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        inFlight = null
        persist()
      }
    }
    toldFull = false
  }
  // An edit that arrives as a drain is ending is never left on the line: when
  // the drain is over and something can run, another starts.
  const kick = (): void => {
    if (draining || heapTimer) return
    if (stopAt !== null && now() >= stopAt) return
    draining = drain().finally(() => { draining = null; if (waiting.length) kick() })
  }

  const take = (job: TagWritebackJob): boolean => {
    if (waiting.length + later.length >= maxWaiting) {
      s.refused++
      if (!toldFull) {
        toldFull = true
        warn(`[tag-writeback] ${maxWaiting} edits are already waiting to be written into files: more are not taken until they are (first refused: ${job.trackId} ${job.field}). The edits themselves are saved; "Apply Overrides to Files…" writes them.`)
      }
      return false
    }
    stamp(job, nextOrder++)
    dropSuperseded()                                       // an older edit of this field, waiting or to be retried, is not written after it
    waiting.push(job)
    persist()
    kick()
    return true
  }

  return {
    async edit(edit) {
      try {
        const r = resolveTagEdit(edit, await deps.findTrack(edit.trackId), deps.augment)
        if ('skip' in r) {
          if (r.skip === 'fingerprint') warn(`[tag-writeback] skipped trackId=${edit.trackId} field=${edit.field} — fingerprint mismatch (track identity changed)`)
          return r
        }
        return take(r.job) ? r : { skip: 'full' }
      } catch (err) {
        warn(`[tag-writeback] hook error for trackId=${edit.trackId} field=${edit.field}: ${err instanceof Error ? err.message : String(err)}`)
        return { skip: 'no-track' }
      }
    },
    async resume() {
      const n = await loadOnce()
      if (n) { persist(); kick() }
      return n
    },
    async stop(budgetMs) {
      const before = s.written
      stopAt = now() + Math.max(0, budgetMs)
      if (heapTimer) { clearTimeout(heapTimer); heapTimer = null }
      if (laterTimer) { clearTimeout(laterTimer); laterTimer = null }
      if (!draining && waiting.length && !heapIsFull()) draining = drain().finally(() => { draining = null })
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        (async () => { while (draining) await draining })(),
        new Promise<void>((r) => { timer = setTimeout(r, Math.max(0, budgetMs)) }),
      ])
      if (timer) clearTimeout(timer)
      const left = owed()
      // A quit before the saved line was read must not replace it with this run's.
      if (!loaded) {
        if (left.length) warn(`[tag-writeback] quit before the waiting line was read: the saved one is left as it is (${left.length} of this run's not added to it)`)
        return { written: s.written - before, left: left.length }
      }
      try { deps.saveNow?.(left) } catch (err) { warn(`[tag-writeback] could not save the waiting line at quit: ${err instanceof Error ? err.message : String(err)}`) }
      const written = s.written - before
      if (written || left.length) warn(`[tag-writeback] quit: ${written} tag edit(s) written into files, ${left.length} left for the next launch`)
      return { written, left: left.length }
    },
    async idle() { while (draining || saving) { await draining; await saving } },
    stats: () => ({ waiting: waiting.length + (inFlight ? 1 : 0), later: later.length, ...s }),
  }
}
