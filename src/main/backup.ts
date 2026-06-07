/**
 * 4.5.0-117 — Library backup/restore (Phase 0 of the next-level roadmap).
 *
 * Thin wrapper: supplies the real local-primary STATE_DIR paths to the pure,
 * Electron-free logic in backup-core.ts (unit-tested in __tests__/backup.test.ts).
 * Public API unchanged — index.ts imports these.
 */
import { join } from 'path'
import { STATE_DIR } from './state-dir'
import { snapshotLibraryAt, listBackupsAt, restoreBackupAt } from './backup-core'
import type { BackupInfo } from './backup-core'

const LIBRARY_PATH = join(STATE_DIR, 'library.json')
const BACKUP_DIR = join(STATE_DIR, 'backups')
const AUTO_THROTTLE_MS = 30 * 60 * 1000  // at most one auto-snapshot per 30 min

let lastAutoSnapshotMs = 0

export async function snapshotLibrary(reason = 'manual'): Promise<BackupInfo | null> {
  return snapshotLibraryAt(LIBRARY_PATH, BACKUP_DIR, reason)
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
