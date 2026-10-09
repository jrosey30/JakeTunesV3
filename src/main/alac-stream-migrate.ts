/**
 * One-time (and each-boot, until the disk is clear) pass that puts ALAC
 * masters already sitting on the laptop onto the same stream-convert
 * queue new imports use.
 *
 * Do not run this against a live library from a dev machine. The app
 * calls planLocalAlacMigration at boot when library.streamSource is
 * homemini. A symlink is already streamed and is skipped. A missing
 * file was already evicted and is skipped. A real file with a sha1
 * audioFingerprint is enqueued; convertTrackToStreamed still refuses
 * to drop the bytes until homemini serves that same fingerprint.
 * Tracks with no fingerprint stay local — the destructive convert is
 * gated on identity, not on the codec.
 */
export interface AlacMigrateTrack {
  path?: string
  codec?: string
  audioFingerprint?: string
}

export interface StreamConvertEnqueueItem {
  ipodPath: string
  fingerprint: string
  enqueuedAt: number
}

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
): Promise<StreamConvertEnqueueItem[]> {
  const out: StreamConvertEnqueueItem[] = []
  for (const t of tracks) {
    if (!isLibraryAlac(t)) continue
    const colon = String(t.path || '').trim()
    const fp = typeof t.audioFingerprint === 'string' ? t.audioFingerprint : ''
    if (!colon || !fp.startsWith('sha1:')) continue
    const abs = colonToAbs(colon)
    try {
      const st = await lstat(abs)
      if (st.isSymbolicLink()) continue
      if (!st.isFile()) continue
    } catch {
      continue
    }
    out.push({ ipodPath: colon, fingerprint: fp, enqueuedAt: now })
  }
  return out
}
