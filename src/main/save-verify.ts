/**
 * Brief 166 — save-library self-heal: verify by HASH, heal atomically.
 *
 * The old post-rename check re-read library.json and compared only the
 * landed TRACK COUNT, then "healed" a mismatch with a direct in-place
 * writeFile on the live file — a crash during the heal leaves exactly
 * the torn file the staged partial+rename design exists to prevent, and
 * a landing with the right count but wrong content passed verification.
 *
 * This module is the fix, kept out of index.ts so it is unit-testable:
 *   - hashPayload: sha256 of the exact payload string being written.
 *   - verifyLandedFile: hash what actually landed and compare.
 *   - stagePayloadAndRename: the ONLY sanctioned heal — re-run the
 *     staged write + rename path. Never an in-place write on the live
 *     file.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { fsyncFile, fsyncParentDir } from './fs-durability.ts'

/** sha256 hex of the exact payload string (utf-8) that will be written. */
export function hashPayload(payload: string): string {
  return createHash('sha256').update(payload, 'utf-8').digest('hex')
}

/**
 * Hash the file currently at `path`. Returns ok:false with a null hash
 * when the file is missing or unreadable — a vanished landing (the
 * 2026-05-29 SMB rename incident) is a mismatch, not an exception.
 */
export async function verifyLandedFile(
  path: string,
  expectedHash: string,
): Promise<{ ok: boolean; actualHash: string | null }> {
  try {
    const actualHash = hashPayload(await readFile(path, 'utf-8'))
    return { ok: actualHash === expectedHash, actualHash }
  } catch {
    return { ok: false, actualHash: null }
  }
}

/**
 * Write `payload` to the staging path, then rename it over `destPath`.
 * The rename is what makes the heal atomic: readers see the whole old
 * file or the whole new one, never a mid-heal slice.
 */
export async function stagePayloadAndRename(
  stagingPath: string,
  destPath: string,
  payload: string,
): Promise<void> {
  await writeFile(stagingPath, payload, 'utf-8')
  // Brief 168: same durability discipline as the canonical save — fsync
  // the staged file before the rename, the directory after.
  await fsyncFile(stagingPath)
  await rename(stagingPath, destPath)
  await fsyncParentDir(destPath)
}
