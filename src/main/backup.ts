/**
 * 4.5.0-117 — Library backup/restore (Phase 0 of the "next level" roadmap).
 *
 * Promotes the manual `.smbdelete`/`.bak` rescue that saved us on 2026-05-29/30
 * into a real, tested feature: verified, timestamped snapshots of library.json
 * to a rotating local store, plus one-click restore (which snapshots the
 * CURRENT state first, so restore is itself reversible).
 *
 * Local-primary: snapshots live next to the source of truth in STATE_DIR
 * (app userData). Pure, dependency-light functions so the test net can drive
 * them directly.
 */
import { join } from 'path'
import { readdir, readFile, writeFile, stat, mkdir, rename, unlink } from 'fs/promises'
import { STATE_DIR } from './state-dir'

const LIBRARY_PATH = join(STATE_DIR, 'library.json')
const BACKUP_DIR = join(STATE_DIR, 'backups')
const KEEP = 20                          // retention: keep the newest N snapshots
const AUTO_THROTTLE_MS = 30 * 60 * 1000  // at most one auto-snapshot per 30 min

export interface BackupInfo {
  file: string
  date: string        // ISO mtime
  mtimeMs: number
  trackCount: number
  sizeBytes: number
  reason: string
}

let lastAutoSnapshotMs = 0

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function parseTrackCount(file: string): number {
  const m = file.match(/-(\d+)tracks/)
  return m ? Number(m[1]) : -1
}
function parseReason(file: string): string {
  const m = file.match(/tracks-([a-z-]+)\.json$/i)
  return m ? m[1] : 'snapshot'
}

/**
 * Write a verified snapshot of the current library.json. Copies the exact
 * bytes (no re-serialization). Refuses to snapshot an empty/unreadable library
 * (an empty snapshot is worse than none — it could mislead a future restore).
 * Returns the BackupInfo, or null if skipped/failed.
 */
export async function snapshotLibrary(reason = 'manual'): Promise<BackupInfo | null> {
  try {
    const raw = await readFile(LIBRARY_PATH, 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: unknown[] }
    const count = Array.isArray(lib.tracks) ? lib.tracks.length : 0
    if (count === 0) { console.warn('[backup] skipped: library is empty/0 tracks'); return null }
    await mkdir(BACKUP_DIR, { recursive: true })
    const safeReason = reason.replace(/[^a-z-]/gi, '') || 'snapshot'
    const file = `library-${stamp()}-${count}tracks-${safeReason}.json`
    const dest = join(BACKUP_DIR, file)
    const tmp = dest + '.tmp'
    await writeFile(tmp, raw)
    await rename(tmp, dest)
    await pruneOld()
    const s = await stat(dest)
    return { file, date: s.mtime.toISOString(), mtimeMs: s.mtimeMs, trackCount: count, sizeBytes: s.size, reason: safeReason }
  } catch (err) {
    console.warn('[backup] snapshot failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Throttled auto-snapshot for the save hook — at most one per AUTO_THROTTLE_MS. */
export async function maybeAutoSnapshot(reason = 'save'): Promise<void> {
  const now = Date.now()
  if (now - lastAutoSnapshotMs < AUTO_THROTTLE_MS) return
  lastAutoSnapshotMs = now
  await snapshotLibrary(reason)
}

/** Newest-first list of valid snapshots. */
export async function listBackups(): Promise<BackupInfo[]> {
  const names = await readdir(BACKUP_DIR).catch(() => [] as string[])
  const out: BackupInfo[] = []
  for (const file of names) {
    if (!file.startsWith('library-') || !file.endsWith('.json')) continue
    const p = join(BACKUP_DIR, file)
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
 * Restore a snapshot over library.json. Snapshots the CURRENT state first
 * (reason 'pre-restore') so the restore is reversible. Validates the snapshot
 * is a real, non-empty library before overwriting. `file` is treated as a
 * bare name inside BACKUP_DIR (path-traversal stripped).
 */
export async function restoreBackup(file: string): Promise<{ ok: boolean; trackCount?: number; error?: string }> {
  try {
    const safe = String(file).replace(/[/\\]/g, '')
    if (!safe.startsWith('library-') || !safe.endsWith('.json')) return { ok: false, error: 'Not a backup file.' }
    const src = join(BACKUP_DIR, safe)
    const raw = await readFile(src, 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: unknown[] }
    const count = Array.isArray(lib.tracks) ? lib.tracks.length : -1
    if (count <= 0) return { ok: false, error: 'That backup has no tracks — refusing to restore it.' }
    await snapshotLibrary('pre-restore')
    const tmp = LIBRARY_PATH + '.restore.tmp'
    await writeFile(tmp, raw)
    await rename(tmp, LIBRARY_PATH)
    return { ok: true, trackCount: count }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'restore failed' }
  }
}

async function pruneOld(): Promise<void> {
  try {
    const all = await listBackups()
    for (const b of all.slice(KEEP)) { try { await unlink(join(BACKUP_DIR, b.file)) } catch { /* gone */ } }
  } catch { /* non-fatal */ }
}
