/**
 * Each boot, while library.streamSource is homemini, ALAC masters still
 * sitting on the laptop go onto the same stream-convert queue new
 * imports use.
 *
 * A symlink is already streamed and is skipped. A missing file was
 * already evicted and is skipped. A real file with a sha1 fingerprint
 * is ready to enqueue. A real file with no fingerprint is NOT left on
 * the laptop: the caller hashes the 256KB window, throttled, off the
 * boot path, then enqueues. That window is only a pre-filter.
 * convertTrackToStreamed still refuses to drop the bytes until the raw
 * homemini body matches the local file's size and full sha1.
 *
 * Do not run this against a live library from a dev machine.
 */
export interface AlacMigrateTrack {
  path?: string
  codec?: string
  audioFingerprint?: string
  /** Milliseconds, same as Track.duration. The hash window does not use it to match. */
  duration?: number
}

export interface StreamConvertEnqueueItem {
  ipodPath: string
  fingerprint: string
  enqueuedAt: number
}

export interface AlacFingerprintJob {
  ipodPath: string
  abs: string
  durationMs: number
}

export interface AlacMigrationPlan {
  ready: StreamConvertEnqueueItem[]
  needsFingerprint: AlacFingerprintJob[]
}

/** Pause between fingerprint hashes so a large library does not peg the disk at boot. */
export const FINGERPRINT_THROTTLE_MS = 250

export function isLibraryAlac(track: AlacMigrateTrack): boolean {
  const path = String(track.path || '')
  const codec = String(track.codec || '').toLowerCase()
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return codec === 'alac' || ext === '.alac'
}

export async function planLocalAlacMigration(
  tracks: AlacMigrateTrack[],
  lstat: (abs: string) => Promise<{ isSymbolicLink(): boolean; isFile(): boolean }>,
  colonToAbs: (colon: string) => string,
  now: number,
): Promise<AlacMigrationPlan> {
  const ready: StreamConvertEnqueueItem[] = []
  const needsFingerprint: AlacFingerprintJob[] = []
  for (const t of tracks) {
    if (!isLibraryAlac(t)) continue
    const colon = String(t.path || '').trim()
    if (!colon) continue
    const abs = colonToAbs(colon)
    try {
      const st = await lstat(abs)
      if (st.isSymbolicLink()) continue
      if (!st.isFile()) continue
    } catch {
      continue
    }
    const fp = typeof t.audioFingerprint === 'string' ? t.audioFingerprint : ''
    if (fp.startsWith('sha1:')) {
      ready.push({ ipodPath: colon, fingerprint: fp, enqueuedAt: now })
    } else {
      needsFingerprint.push({
        ipodPath: colon,
        abs,
        durationMs: Number(t.duration) || 0,
      })
    }
  }
  return { ready, needsFingerprint }
}

/**
 * Hash local ALAC that has no stored fingerprint, then enqueue.
 * `hash` must be computeAudioFingerprint (sha1 of the first 256KB).
 * The caller does not await this on the boot path.
 */
export async function backfillAlacFingerprints(
  jobs: AlacFingerprintJob[],
  hash: (abs: string, durationMs: number) => Promise<string | null>,
  enqueue: (item: StreamConvertEnqueueItem) => Promise<void>,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  throttleMs = FINGERPRINT_THROTTLE_MS,
): Promise<number> {
  let queued = 0
  for (const job of jobs) {
    try {
      const fp = await hash(job.abs, job.durationMs)
      if (fp && fp.startsWith('sha1:')) {
        await enqueue({ ipodPath: job.ipodPath, fingerprint: fp, enqueuedAt: now() })
        queued++
      }
    } catch (err) {
      console.warn(
        `[stream-convert] fingerprint failed for ${job.ipodPath}:`,
        err instanceof Error ? err.message : err,
      )
    }
    await sleep(throttleMs)
  }
  return queued
}
