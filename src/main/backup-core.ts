/**
 * 4.5.0-118 — Pure, path-injected backup/restore logic (no Electron import,
 * so `node --test` can drive it). `backup.ts` wraps these with the real
 * STATE_DIR paths; tests call them with a temp dir.
 *
 * Brief 171 — the same snapshot rotation now covers metadata-overrides.json
 * (play counts, ratings, skip counts, lastPlayedAt, BPM/key analysis,
 * subgenres) with identical semantics: exact-bytes snapshots, newest 20
 * kept per file kind, and a restore snapshots the current state first.
 * Overrides snapshots are named `metadata-overrides-<stamp>-<N>entries-<reason>.json`;
 * for those, BackupInfo.trackCount carries the override ENTRY count.
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
function parseEntryCount(file: string): number {
  const m = file.match(/-(\d+)entries/)
  return m ? Number(m[1]) : -1
}
function parseOverridesReason(file: string): string {
  const m = file.match(/entries-([a-z0-9-]+)\.json$/i)
  return m ? m[1].replace(/-\d+$/, '') : 'snapshot'
}

/** Entry count of a metadata-overrides document, or -1 when it is not a plain object. */
function overridesEntryCount(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return -1
    return Object.keys(parsed as Record<string, unknown>).length
  } catch {
    return -1
  }
}

/**
 * Verified snapshot of a state file → backupDir. Copies exact bytes; refuses
 * an empty/unreadable source (`countOf` returns <= 0). Collision-safe
 * filename (same-second snapshots get a -N suffix). Prunes to `keep` newest
 * of the same kind afterward. Returns info or null.
 * `stampStr` overridable for deterministic tests.
 */
async function snapshotFileAt(
  sourcePath: string,
  backupDir: string,
  reason: string,
  keep: number,
  stampStr: string | undefined,
  kind: { prefix: string; countLabel: string; countOf: (raw: string) => number; list: (dir: string) => Promise<BackupInfo[]> },
): Promise<BackupInfo | null> {
  try {
    const raw = await readFile(sourcePath, 'utf-8')
    const count = kind.countOf(raw)
    if (count <= 0) return null
    await mkdir(backupDir, { recursive: true })
    const safeReason = (reason || 'snapshot').replace(/[^a-z0-9-]/gi, '') || 'snapshot'
    const base = `${kind.prefix}-${stampStr || stamp()}-${count}${kind.countLabel}-${safeReason}`
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
    await pruneOldAt(backupDir, keep, kind.list)
    const s = await stat(dest)
    return { file, date: s.mtime.toISOString(), mtimeMs: s.mtimeMs, trackCount: count, sizeBytes: s.size, reason: safeReason }
  } catch {
    return null
  }
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
  return snapshotFileAt(libraryPath, backupDir, reason, keep, stampStr, {
    prefix: 'library',
    countLabel: 'tracks',
    countOf: (raw) => {
      try {
        const lib = JSON.parse(raw) as { tracks?: unknown[] }
        return Array.isArray(lib.tracks) ? lib.tracks.length : 0
      } catch { return 0 }
    },
    list: listBackupsAt,
  })
}

/**
 * Brief 171 — verified snapshot of metadata-overrides.json → backupDir, same
 * semantics as snapshotLibraryAt. Refuses a missing/unparseable/non-object or
 * empty overrides file. BackupInfo.trackCount carries the entry count.
 */
export async function snapshotOverridesAt(
  overridesPath: string, backupDir: string, reason = 'manual', keep = DEFAULT_KEEP, stampStr?: string,
): Promise<BackupInfo | null> {
  return snapshotFileAt(overridesPath, backupDir, reason, keep, stampStr, {
    prefix: 'metadata-overrides',
    countLabel: 'entries',
    countOf: overridesEntryCount,
    list: listOverridesBackupsAt,
  })
}

/** Newest-first list of valid overrides snapshots in backupDir (Brief 171). */
export async function listOverridesBackupsAt(backupDir: string): Promise<BackupInfo[]> {
  const names = await readdir(backupDir).catch(() => [] as string[])
  const out: BackupInfo[] = []
  for (const file of names) {
    if (!file.startsWith('metadata-overrides-') || !file.endsWith('.json')) continue
    const p = join(backupDir, file)
    try {
      const s = await stat(p)
      if (!s.isFile()) continue
      let count = parseEntryCount(file)
      if (count < 0) { count = overridesEntryCount(await readFile(p, 'utf-8')) }
      if (count < 0) continue
      out.push({ file, date: s.mtime.toISOString(), mtimeMs: s.mtimeMs, trackCount: count, sizeBytes: s.size, reason: parseOverridesReason(file) })
    } catch { /* skip unreadable */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
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

/**
 * Brief 171 — restore an overrides snapshot over overridesPath, same
 * semantics as restoreBackupAt: CURRENT overrides are snapshotted first
 * (reversible), the snapshot must be a non-empty plain object, and `file`
 * is a bare name in backupDir (path-traversal stripped). The returned
 * trackCount carries the restored entry count.
 */
export async function restoreOverridesBackupAt(
  overridesPath: string, backupDir: string, file: string,
): Promise<{ ok: boolean; trackCount?: number; error?: string }> {
  try {
    const safe = String(file).replace(/[/\\]/g, '')
    if (!safe.startsWith('metadata-overrides-') || !safe.endsWith('.json')) return { ok: false, error: 'Not a backup file.' }
    const raw = await readFile(join(backupDir, safe), 'utf-8')
    const count = overridesEntryCount(raw)
    if (count <= 0) return { ok: false, error: 'That backup has no overrides — refusing to restore it.' }
    await snapshotOverridesAt(overridesPath, backupDir, 'pre-restore')
    const tmp = overridesPath + '.restore.tmp'
    await writeFile(tmp, raw)
    await rename(tmp, overridesPath)
    return { ok: true, trackCount: count }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'restore failed' }
  }
}

async function pruneOldAt(backupDir: string, keep: number, list: (dir: string) => Promise<BackupInfo[]> = listBackupsAt): Promise<void> {
  try {
    const all = await list(backupDir)
    for (const b of all.slice(keep)) { try { await unlink(join(backupDir, b.file)) } catch { /* gone */ } }
  } catch { /* non-fatal */ }
}
