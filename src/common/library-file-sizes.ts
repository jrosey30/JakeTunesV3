/**
 * Refresh File Sizes (Brief 016): measure each track's audio file on
 * disk. Main measures; the renderer applies the differences with
 * UPDATE_TRACKS, so the normal save-library writes them.
 *
 * Two bugs this replaced (2026-10-12):
 *  - stat() followed the offload symlinks to the empty `.jt-streamed`
 *    sentinel and recorded 0 bytes for every streamed track (169 that
 *    day). A streamed track's bytes live on homemini; it keeps the size
 *    it was imported with.
 *  - main wrote library.json itself and stamped the write as its own, so
 *    the renderer never reloaded, and its next save-library put every
 *    old size back. 1,255 local files carried a stale size that day.
 */

export interface MeasuredFileSize {
  id: number
  fileSize: number
}

export interface FileSizeScan {
  /** Every regular file measured, whether or not its size changed. */
  measured: MeasuredFileSize[]
  /** How many measured sizes differ from the list that was scanned. */
  stale: number
  /** Symlinks (offloaded to homemini): not measured, size kept. */
  streamed: number
  /** No file at the path (evicted, or gone): not measured, size kept. */
  missing: number
}

type LstatLike = (path: string) => Promise<{ size: number; isFile(): boolean; isSymbolicLink(): boolean }>

export interface FileSizeProgress {
  scanned: number
  refreshed: number
  total: number
}

export async function measureLibraryFileSizes(
  tracks: ReadonlyArray<{ id?: unknown; path?: unknown; fileSize?: unknown }>,
  toAbsolute: (colonPath: string) => string,
  shouldMeasure: (absPath: string) => boolean,
  lstat: LstatLike,
  onProgress?: (p: FileSizeProgress) => void,
): Promise<FileSizeScan> {
  const scan: FileSizeScan = { measured: [], stale: 0, streamed: 0, missing: 0 }
  let scanned = 0
  const report = () => onProgress?.({ scanned, refreshed: scan.stale, total: tracks.length })
  for (const t of tracks) {
    const colonPath = String(t.path || '')
    const id = Number(t.id)
    if (!colonPath || !Number.isFinite(id)) continue
    const abs = toAbsolute(colonPath)
    scanned++
    if (shouldMeasure(abs)) {
      let s: Awaited<ReturnType<LstatLike>> | null = null
      try {
        s = await lstat(abs)
      } catch {
        scan.missing++
      }
      if (s?.isSymbolicLink()) scan.streamed++
      else if (s && !s.isFile()) scan.missing++
      else if (s) {
        scan.measured.push({ id, fileSize: s.size })
        if (Number(t.fileSize) !== s.size) scan.stale++
      }
    }
    if (scanned % 200 === 0) report()
  }
  report()
  return scan
}

/** UPDATE_TRACKS entries for the measured sizes that differ from the
 *  tracks the renderer holds now (not the disk copy main scanned). */
export function fileSizeUpdates(
  tracks: ReadonlyArray<{ id: number; fileSize?: number }>,
  measured: ReadonlyArray<MeasuredFileSize>,
): Array<{ id: number; field: 'fileSize'; value: string }> {
  const current = new Map(tracks.map((t) => [t.id, t.fileSize]))
  const updates: Array<{ id: number; field: 'fileSize'; value: string }> = []
  for (const m of measured) {
    if (!current.has(m.id)) continue
    if (current.get(m.id) === m.fileSize) continue
    updates.push({ id: m.id, field: 'fileSize', value: String(m.fileSize) })
  }
  return updates
}
