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
 */

import { readFile, writeFile, rename } from 'node:fs/promises'

export class JsonFileCache<T> {
  private cache: T | null = null
  private loadPromise: Promise<T> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private writesInFlight = 0
  // 4.5.0-107 data-safety guard: true if the cache loaded as fallback
  // because the file existed but couldn't be read/parsed. In that mode
  // we REFUSE writes — otherwise a one-time read failure would let the
  // next mutate flush an empty-fallback over real on-disk data, wiping
  // it permanently. The user can resolve by quitting (no writes occur)
  // and re-trying after fixing the underlying disk/permission issue.
  private loadedAsErrorFallback = false

  constructor(
    private readonly pathFn: () => string,
    private readonly fallback: () => T,
    private readonly label: string,
  ) {}

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

  /** Number of writes currently queued or in-flight (for diagnostics). */
  pendingWrites(): number {
    return this.writesInFlight
  }

  private scheduleFlush(): void {
    const snapshot = this.cache
    if (snapshot === null) return
    if (this.loadedAsErrorFallback) {
      // Safety lock: a real on-disk file existed but we couldn't read
      // it. Flushing our empty-fallback would silently wipe whatever's
      // on disk. Drop the write instead and log so the user / future
      // diagnostic notices.
      console.warn(`[state-cache:${this.label}] WRITE DROPPED — initial load failed; refusing to overwrite existing on-disk file.`)
      return
    }
    this.writesInFlight++
    this.writeChain = this.writeChain.then(async () => {
      const path = this.pathFn()
      const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
      try {
        await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf-8')
        await rename(tmp, path)
      } catch (err) {
        console.warn(`[state-cache:${this.label}] flush failed:`, err instanceof Error ? err.message : err)
      } finally {
        this.writesInFlight--
      }
    })
  }
}
