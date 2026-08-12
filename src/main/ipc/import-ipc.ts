/**
 * Import-path IPC: picker, drag-drop grant, folder resolve.
 *
 * The heavy per-file import (`import-track` / `import-tracks`) still
 * lives in main/index.ts next to `importOneFile` — moving that body
 * is a follow-up. This module owns the *path entry* surface and the
 * session allowlist grants those handlers enforce.
 */
import { dialog } from 'electron'
import { join } from 'path'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { allowImportPaths, isImportPathAllowed } from '../import-allowlist.ts'

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.alac', '.wav', '.aiff', '.aif', '.ogg'])

/**
 * Recursively find audio files in directories.
 * Exported so index.ts import-tracks can share one implementation.
 */
export async function resolveAudioPaths(paths: string[]): Promise<string[]> {
  const { readdir: readdirFS, stat: statFS } = await import('fs/promises')
  const results: string[] = []
  // Dedupe by absolute path so a drag that contains the same file twice
  // (e.g. user lassos overlapping selections) doesn't double-enqueue.
  const seen = new Set<string>()
  for (const p of paths) {
    try {
      const s = await statFS(p)
      if (s.isDirectory()) {
        const entries = await readdirFS(p, { withFileTypes: true })
        const childPaths = entries.map(e => join(p, e.name))
        const nested = await resolveAudioPaths(childPaths)
        for (const n of nested) {
          if (!seen.has(n)) { seen.add(n); results.push(n) }
        }
      } else {
        const base = p.substring(p.lastIndexOf('/') + 1)
        // Skip dotfiles: .DS_Store has no audio extension and was already
        // filtered, but AppleDouble metadata forks (._01 Track.m4a, born
        // when a macOS-created zip is unpacked on another OS) DO have
        // audio extensions and would otherwise enter the queue, fail at
        // import, and pad the visible total.
        if (base.startsWith('.')) continue
        const ext = p.substring(p.lastIndexOf('.')).toLowerCase()
        if (AUDIO_EXTS.has(ext) && !seen.has(p)) {
          seen.add(p); results.push(p)
        }
      }
    } catch { /* skip inaccessible */ }
  }
  return results
}

export function registerImportIpc(ipc: IpcRegistrar): void {
  // Pick audio files/folders for the File > Import and Convert flow.
  // Returns absolute paths; mirrors the drag-drop entry point so
  // import-tracks can consume either indistinguishably.
  // Paths from the native dialog are trusted → session-allowlisted.
  ipc.handle('import-pick-files', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import and Convert',
      properties: ['openFile', 'openDirectory', 'multiSelections', 'treatPackageAsDirectory'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'flac', 'alac', 'wav', 'aiff', 'aif', 'ogg'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      defaultPath: process.env.HOME || undefined,
    })
    if (result.canceled) return { ok: false, canceled: true }
    const paths = allowImportPaths(result.filePaths)
    return { ok: true, paths }
  }, { refuse: REFUSED_SENDER })

  /**
   * Grant paths obtained from a real OS drag-drop (preload uses
   * `webUtils.getPathForFile` so synthetic File objects cannot mint
   * arbitrary filesystem paths). Main-window only.
   */
  ipc.handle('import-allow-dropped-paths', async (_e, paths: string[]) => {
    if (!Array.isArray(paths)) return { ok: false, error: 'invalid-paths' }
    const allowed = allowImportPaths(paths.filter((p): p is string => typeof p === 'string'))
    return { ok: true, paths: allowed }
  }, { refuse: REFUSED_SENDER })

  // Resolve folders + filter to audio extensions for the renderer queue.
  // Splits a single drop into its constituent files so the queue can show
  // progress per-file rather than per-folder.
  //
  // Every input path must already be on the session allowlist (picker /
  // drop / inbox). Resolved children are then granted so import-track
  // can consume them.
  ipc.handle('import-resolve-paths', async (_e, paths: string[]) => {
    try {
      if (!Array.isArray(paths)) return { ok: false, error: 'invalid-paths' }
      const input = paths.filter((p): p is string => typeof p === 'string')
      const blocked = input.filter((p) => !isImportPathAllowed(p))
      if (blocked.length > 0) {
        console.warn(`[import] refused resolve of ${blocked.length} non-allowlisted path(s)`)
        return { ok: false, error: 'path-not-allowed' }
      }
      const resolved = await resolveAudioPaths(input)
      allowImportPaths(resolved)
      return { ok: true, paths: resolved }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }, { refuse: REFUSED_SENDER })
}
