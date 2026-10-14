/**
 * Brief 168 — fsync helpers for the canonical save path.
 *
 * rename() protects against app crashes, not power loss: without an
 * fsync of the staged file BEFORE the rename and of the directory
 * AFTER it, an outage can bring the renamed file back empty or stale.
 * (The NAS staging path already fsyncs — `fh.sync()` in
 * atomicPublishToNas's stage helper; the local path was the odd one
 * out.)
 *
 * fsyncFile is strict: if the staged bytes cannot be forced to disk,
 * the save should fail loudly rather than rename unverified data.
 * fsyncParentDir is best-effort: some filesystems/platforms refuse to
 * open or sync a directory, and by the time it runs the rename has
 * already landed — failing the save then would misreport a completed
 * write. Atomicity never depends on it; durability does, where the
 * platform allows it.
 */
import { open } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Force a file's bytes to stable storage. Throws on failure. */
export async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, 'r')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

/** Best-effort fsync of the directory containing `filePath`. Never throws. */
export async function fsyncParentDir(filePath: string): Promise<void> {
  try {
    const fh = await open(dirname(filePath), 'r')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
  } catch { /* platform/filesystem refuses directory fsync — rename still atomic */ }
}
