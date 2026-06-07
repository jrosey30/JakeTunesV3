/**
 * 4.5.0-118 — Pure, path-injected backup/restore logic (no Electron import,
 * so `node --test` can drive it). `backup.ts` wraps these with the real
 * STATE_DIR paths; tests call them with a temp dir.
 */
import { join } from 'path'
import { readdir, readFile, writeFile, stat, mkdir, rename, unlink } from 'fs/promises'

export interface BackupInfo {
  file: string
  date: string        // ISO mtime
  mtimeMs: number
  trackCount: number
  sizeBytes: number
  reason: string
}

export const DEFAULT_KEEP = 20

export function stamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function parseTrackCount(file: string): number {
  const m = file.match(/-(\d+)tracks/)
  return m ? Number(m[1]) : -1
}
function parseReason(file: string): string {
  const m = file.match(/tracks-([a-z0-9-]+)\.json$/i)
  return m ? m[1].replace(/-\d+$/, '') : 'snapshot'
}

/**
 * Verified snapshot of libraryPath → backupDir. Copies exact bytes; refuses an
 * empty/unreadable library. Collision-safe filename (same-second snapshots get
 * a -N suffix). Prunes to `keep` newest afterward. Returns info or null.
 * `stampStr` overridable for deterministic tests.
 */
export async function snapshotLibraryAt(
  libraryPath: string, backupDir: string, reason = 'manual', keep = DEFAULT_KEEP, stampStr?: string,
): Promise<BackupInfo | null> {
  try {
    const raw = await readFile(libraryPath, 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: unknown[] }
    const count = Array.isArray(lib.tracks) ? lib.tracks.length : 0
    if (count === 0) return null
    await mkdir(backupDir, { recursive: true })
    const safeReason = (reason || 'snapshot').replace(/[^a-z0-9-]/gi, '') || 'snapshot'
    const base = `library-${stampStr || stamp()}-${count}tracks-${safeReason}`
    let file = `${base}.json`
    let n = 2
    // collision-safe: never overwrite an existing snapshot
    while (await stat(join(backupDir, file)).then(() => true).catch(() => false)) {
      file = `${base}-${n++}.json`
    }
    const dest = join(backupDir, file)
    const tmp = dest + '.tmp'
    await writeFile(tmp, raw)
    await rename(tmp, dest)
    await pruneOldAt(backupDir, keep)
    const s = await stat(dest)
    return { file, date: s.mtime.toISOString(), mtimeMs: s.mtimeMs, trackCount: count, sizeBytes: s.size, reason: safeReason }
  } catch {
    return null
  }
}

/** Newest-first list of valid snapshots in backupDir. */
export async function listBackupsAt(backupDir: string): Promise<BackupInfo[]> {
  const names = await readdir(backupDir).catch(() => [] as string[])
  const out: BackupInfo[] = []
  for (const file of names) {
    if (!file.startsWith('library-') || !file.endsWith('.json')) continue
    const p = join(backupDir, file)
    try {
      const s = await stat(p)
      if (!s.isFile()) continue
      let count = parseTrackCount(file)
      if (count < 0) { try { count = (JSON.parse(await readFile(p, 'utf-8')).tracks || []).length } catch { count = 0 } }
      out.push({ file, date: s.mtime.toISOString(), mtimeMs: s.mtimeMs, trackCount: count, sizeBytes: s.size, reason: parseReason(file) })
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * Restore a snapshot over libraryPath. Snapshots CURRENT state first
 * (reversible), validates the snapshot is a real non-empty library, and treats
 * `file` as a bare name in backupDir (path-traversal stripped).
 */
export async function restoreBackupAt(
  libraryPath: string, backupDir: string, file: string,
): Promise<{ ok: boolean; trackCount?: number; error?: string }> {
  try {
    const safe = String(file).replace(/[/\\]/g, '')
    if (!safe.startsWith('library-') || !safe.endsWith('.json')) return { ok: false, error: 'Not a backup file.' }
    const raw = await readFile(join(backupDir, safe), 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: unknown[] }
    const count = Array.isArray(lib.tracks) ? lib.tracks.length : -1
    if (count <= 0) return { ok: false, error: 'That backup has no tracks — refusing to restore it.' }
    await snapshotLibraryAt(libraryPath, backupDir, 'pre-restore')
    const tmp = libraryPath + '.restore.tmp'
    await writeFile(tmp, raw)
    await rename(tmp, libraryPath)
    return { ok: true, trackCount: count }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'restore failed' }
  }
}

async function pruneOldAt(backupDir: string, keep: number): Promise<void> {
  try {
    const all = await listBackupsAt(backupDir)
    for (const b of all.slice(keep)) { try { await unlink(join(backupDir, b.file)) } catch { /* gone */ } }
  } catch { /* non-fatal */ }
}
