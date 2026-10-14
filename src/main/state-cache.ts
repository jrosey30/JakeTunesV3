/**
 * 4.5.0-106 — Phase 2.5: in-memory cache + write-through for NAS state files.
 *
 * Phase 2 (4.5.0-90) moved state files to /Volumes/JakeShared/JakeTunesState/
 * over SMB. Every read = 50-500ms NAS round-trip; the main process awaited
 * those round-trips inside IPC handlers, which blocked the renderer's await
 * AND occasionally hitched the audio thread during page navigation (the
 * Bandcamp-preview-skips bug Jake reported in 4.5.0-104).
 *
 * This module's contract:
 *   - First .get() lazily loads from NAS once. Subsequent .get() calls
 *     resolve in microseconds from the in-memory snapshot.
 *   - .update(mutate) applies the mutation to the cache synchronously
 *     and queues a serialized background flush to NAS. The caller does
 *     NOT await the NAS flush — the cache IS the source of truth from
 *     the moment the synchronous mutation returns. NAS catches up
 *     eventually (usually within the next event loop tick).
 *   - .invalidate() drops the cache so the next .get() re-reads from
 *     NAS. Used after external writes the cache wouldn't know about
 *     (the library.json save-tracks path still does its own atomic
 *     write with a prev-snapshot diff that needs fresh disk reads).
 *
 * Why per-file serialized chain: even backgrounded, two concurrent
 * read-modify-writes against the same file would race. The chain keeps
 * writes in submission order without ever blocking the IPC reply.
 *
 * Brief 173: flushes are awaitable and their failures are inspectable.
 * .whenIdle() / the module-level flushAllCaches() let the quit path wait
 * for every pending flush to settle (bounded by a timeout, so a wedged
 * SMB flush can't trap the app open), and every flush failure or
 * safety-lock dropped write is counted in .flushStats() with the last
 * error recorded — instead of being logged once and dropped.
 */

import { readFile, writeFile, rename } from 'node:fs/promises'

export class JsonFileCache<T> {
  private cache: T | null = null
  private loadPromise: Promise<T> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writesInFlight = 0
  /** A flush is queued but hasn't begun serializing — further updates ride it. */
  private flushQueued = false
  // 4.5.0-107 data-safety guard: true if the cache loaded as fallback
  // because the file existed but couldn't be read/parsed. In that mode
  // we REFUSE writes — otherwise a one-time read failure would let the
  // next mutate flush an empty-fallback over real on-disk data, wiping
  // it permanently. The user can resolve by quitting (no writes occur)
  // and re-trying after fixing the underlying disk/permission issue.
  private loadedAsErrorFallback = false

  // Brief 173: flush outcome bookkeeping. A background flush that fails
  // (or a write dropped by the error-fallback safety lock) used to be a
  // lone console.warn; now it is counted and the last error is kept, so
  // the quit path — or any diagnostic — can see that state was lost.
  private flushFailureCount = 0
  private droppedWriteCount = 0
  private lastFlushError: { message: string; at: number } | null = null

  // Plain fields, not constructor parameter properties. Node's
  // --experimental-strip-types (what `npm test` runs on) cannot parse
  // parameter properties, so the shorthand made this file impossible to
  // import from a test — which is why the app's most data-critical writer
  // had no coverage. Behaviour is identical; it is just spellable now.
  private readonly pathFn: () => string
  private readonly fallback: () => T
  private readonly label: string

  constructor(pathFn: () => string, fallback: () => T, label: string) {
    this.pathFn = pathFn
    this.fallback = fallback
    this.label = label
  }

  /** Returns the cached value, loading from disk on first access. */
  async get(): Promise<T> {
    if (this.cache !== null) return this.cache
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      const path = this.pathFn()
      try {
        const raw = await readFile(path, 'utf-8')
        this.cache = JSON.parse(raw) as T
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT') {
          // File doesn't exist (fresh install / cleared profile). Safe
          // to fall back to default + allow writes; first .update() will
          // create the file.
          this.cache = this.fallback()
        } else {
          // Read or parse failed against an existing file. Lock writes
          // so we don't clobber whatever's there.
          console.warn(`[state-cache:${this.label}] read failed (${code || 'parse'}), DISABLING writes to protect on-disk data:`, err instanceof Error ? err.message : err)
          this.cache = this.fallback()
          this.loadedAsErrorFallback = true
        }
      }
      return this.cache!
    })()
    return this.loadPromise
  }

  /** Synchronous read — returns null if cache hasn't been warmed yet. */
  peek(): T | null {
    return this.cache
  }

  /**
   * Mutate the cache and queue a background NAS write. Resolves AFTER the
   * synchronous mutate runs (cache is updated) but does NOT wait for the
   * NAS flush. Use .flush() if you genuinely need disk to catch up.
   */
  async update(mutate: (current: T) => T): Promise<void> {
    const current = await this.get()
    this.cache = mutate(current)
    this.scheduleFlush()
  }

  /**
   * Replace the cache wholesale and queue a flush. Use when the caller
   * already has the new value (e.g. it just computed a full snapshot).
   */
  set(next: T): void {
    this.cache = next
    this.scheduleFlush()
  }

  /**
   * 4.5.0-109: Update the in-memory cache ONLY — do not write to disk.
   * Use for cases where another code path is the canonical writer
   * (e.g. library.json has its own atomic-save with a prev-snapshot
   * diff that needs to stay the single source of truth). Pre-fix, the
   * library cache's .set() raced with the atomic save's rename, and
   * SMB's non-atomic rename behavior left the NAS library.json as 0
   * bytes one morning. Caller calls prime() after their own write to
   * keep the cache hot without double-writing.
   */
  prime(next: T): void {
    this.cache = next
  }

  /** Drop the in-memory cache. Next .get() re-reads from disk. */
  invalidate(): void {
    this.cache = null
    this.loadPromise = null
  }

  /**
   * Wait for any queued background writes to finish hitting NAS. Useful
   * before app quit, or in tests. Normal IPC paths shouldn't call this —
   * the whole point of the cache is to not wait.
   */
  async flush(): Promise<void> {
    await this.writeChain
  }

  /**
   * Brief 173: alias of flush() with quit-path semantics — resolves when
   * every flush queued so far has settled (succeeded OR failed; failures
   * are visible via flushStats(), never as a rejection here).
   */
  async whenIdle(): Promise<void> {
    await this.writeChain
  }

  /** Brief 173: snapshot of this cache's flush outcomes. */
  flushStats(): FlushStats {
    return {
      pendingWrites: this.writesInFlight,
      flushFailures: this.flushFailureCount,
      droppedWrites: this.droppedWriteCount,
      lastFlushError: this.lastFlushError,
    }
  }

  /** Number of writes currently queued or in-flight (for diagnostics). */
  pendingWrites(): number {
    return this.writesInFlight
  }

  private scheduleFlush(): void {
    if (this.cache === null) return
    if (this.loadedAsErrorFallback) {
      // Safety lock: a real on-disk file existed but we couldn't read
      // it. Flushing our empty-fallback would silently wipe whatever's
      // on disk. Drop the write instead and log so the user / future
      // diagnostic notices.
      this.droppedWriteCount++
      this.lastFlushError = { message: 'write dropped: initial load failed; refusing to overwrite existing on-disk file', at: Date.now() }
      console.warn(`[state-cache:${this.label}] WRITE DROPPED — initial load failed; refusing to overwrite existing on-disk file.`)
      return
    }
    // COALESCE: one pending write absorbs every update queued behind it.
    //
    // Each flush serializes the WHOLE file, so a bulk path paid the full size
    // per item: the audio-analysis sweep calls persistOverrideFields once per
    // track, which against a 4.1 MB metadata-overrides.json meant ~37 GB of
    // writes to record 8,812 results. Imports and the Cynthia sweeps pay the
    // same tax. Disk never fell behind, but it is pure waste.
    //
    // Safe because the write reads `this.cache` when it RUNS, not when it was
    // scheduled — so a collapsed write persists the latest state, not a stale
    // snapshot. `queued` clears at the START of the task, so an update that
    // lands mid-serialize schedules a fresh write instead of being swallowed.
    if (this.flushQueued) return
    this.flushQueued = true
    this.writesInFlight++
    this.writeChain = this.writeChain.then(async () => {
      this.flushQueued = false
      const snapshot = this.cache
      if (snapshot === null) { this.writesInFlight--; return }
      const path = this.pathFn()
      const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
      try {
        await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf-8')
        await rename(tmp, path)
      } catch (err) {
        this.flushFailureCount++
        this.lastFlushError = { message: err instanceof Error ? err.message : String(err), at: Date.now() }
        console.warn(`[state-cache:${this.label}] flush failed:`, err instanceof Error ? err.message : err)
      } finally {
        this.writesInFlight--
      }
    })
  }
}

/** Brief 173: inspectable flush outcomes for one cache. */
export interface FlushStats {
  pendingWrites: number
  flushFailures: number
  droppedWrites: number
  lastFlushError: { message: string; at: number } | null
}

/** The slice of JsonFileCache flushAllCaches needs — structural, so any
 *  cache (or a test double) qualifies. */
export interface FlushableCache {
  flush(): Promise<void>
  flushStats(): FlushStats
}

export interface FlushAllResult {
  /** True when the timeout fired before every flush settled. */
  timedOut: boolean
  /** Total flush failures recorded across the given caches. */
  failures: number
  /** Total safety-lock dropped writes recorded across the given caches. */
  dropped: number
}

/**
 * Brief 173: await every given cache's pending flushes, bounded by
 * `timeoutMs` so a wedged flush can't trap the caller (the quit path)
 * forever. Never rejects: per-cache flush chains already absorb their
 * own errors, and outcomes are reported in the result + flushStats().
 */
export async function flushAllCaches(
  caches: ReadonlyArray<FlushableCache>,
  timeoutMs = 2000,
): Promise<FlushAllResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = Promise.all(caches.map((c) => c.flush())).then(() => false)
  const timeout = new Promise<boolean>((resolve) => {
    // Not unref'd: bounded and always cleared below, and unref'ing it let
    // Node exit mid-wait when a wedged flush was the only other work.
    timer = setTimeout(() => resolve(true), timeoutMs)
  })
  const timedOut = await Promise.race([settled, timeout])
  if (timer) clearTimeout(timer)
  let failures = 0
  let dropped = 0
  for (const c of caches) {
    const s = c.flushStats()
    failures += s.flushFailures
    dropped += s.droppedWrites
  }
  return { timedOut, failures, dropped }
}
