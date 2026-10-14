/**
 * 4.5.0-117 — Library backup/restore (Phase 0 of the next-level roadmap).
 *
 * Thin wrapper: supplies the real local-primary STATE_DIR paths to the pure,
 * Electron-free logic in backup-core.ts (unit-tested in __tests__/backup.test.ts).
 * Public API unchanged — index.ts imports these.
 *
 * Brief 171 — every library snapshot point also snapshots
 * metadata-overrides.json into the same rotation (same semantics), so the
 * overrides data gets the same protection without any caller change.
 */
import { join } from 'path'
import { STATE_DIR } from './state-dir'
import {
  snapshotLibraryAt, listBackupsAt, restoreBackupAt,
  snapshotOverridesAt, listOverridesBackupsAt, restoreOverridesBackupAt,
} from './backup-core'
import type { BackupInfo } from './backup-core'

const LIBRARY_PATH = join(STATE_DIR, 'library.json')
const OVERRIDES_PATH = join(STATE_DIR, 'metadata-overrides.json')
const BACKUP_DIR = join(STATE_DIR, 'backups')
const AUTO_THROTTLE_MS = 30 * 60 * 1000  // at most one auto-snapshot per 30 min

let lastAutoSnapshotMs = 0

export async function snapshotLibrary(reason = 'manual'): Promise<BackupInfo | null> {
  const info = await snapshotLibraryAt(LIBRARY_PATH, BACKUP_DIR, reason)
  // Brief 171: metadata-overrides.json rides every library snapshot point.
  // A missing/empty overrides file simply yields no snapshot (null).
  await snapshotOverridesAt(OVERRIDES_PATH, BACKUP_DIR, reason)
  return info
}

export async function snapshotOverrides(reason = 'manual'): Promise<BackupInfo | null> {
  return snapshotOverridesAt(OVERRIDES_PATH, BACKUP_DIR, reason)
}

export async function listOverridesBackups(): Promise<BackupInfo[]> {
  return listOverridesBackupsAt(BACKUP_DIR)
}

export async function restoreOverridesBackup(file: string): Promise<{ ok: boolean; trackCount?: number; error?: string }> {
  return restoreOverridesBackupAt(OVERRIDES_PATH, BACKUP_DIR, file)
}

/** Throttled auto-snapshot for the save hook — at most one per AUTO_THROTTLE_MS. */
export async function maybeAutoSnapshot(reason = 'save'): Promise<void> {
  const now = Date.now()
  if (now - lastAutoSnapshotMs < AUTO_THROTTLE_MS) return
  lastAutoSnapshotMs = now
  await snapshotLibrary(reason)
}

export async function listBackups(): Promise<BackupInfo[]> {
  return listBackupsAt(BACKUP_DIR)
}

export async function restoreBackup(file: string): Promise<{ ok: boolean; trackCount?: number; error?: string }> {
  return restoreBackupAt(LIBRARY_PATH, BACKUP_DIR, file)
}

export type { BackupInfo }
