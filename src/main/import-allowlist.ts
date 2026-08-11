/**
 * Session allowlist for filesystem paths that may be imported.
 *
 * WHY: after PR #21, `import-track` / `import-tracks` still accepted any
 * readable path once the sender was the main window. A compromised
 * renderer could exfiltrate arbitrary files by "importing" them into the
 * library. Paths must now be granted by a trusted main-process source
 * before import handlers will touch them.
 *
 * Trusted grant sources:
 *   - `dialog.showOpenDialog` results (`import-pick-files`)
 *   - Inbox watcher emissions (main already owns those paths)
 *   - Drag-drop via preload `webUtils.getPathForFile` →
 *     `import-allow-dropped-paths` (synthetic File objects yield '')
 *   - Children discovered while resolving an already-allowed folder
 *
 * Session-scoped: cleared only on process restart (or tests).
 */
import { resolve } from 'node:path'
import { isPathInside } from './path-safety.ts'

const allowed = new Set<string>()

function normalizeCandidate(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (raw.includes('\0')) return null
  return resolve(raw)
}

/** Grant one or more paths. Returns the normalized paths that were added. */
export function allowImportPaths(paths: Iterable<string>): string[] {
  const out: string[] = []
  for (const raw of paths) {
    const abs = normalizeCandidate(raw)
    if (!abs) continue
    allowed.add(abs)
    out.push(abs)
  }
  return out
}

/**
 * True when `rawPath` was explicitly granted, or sits under a granted
 * directory (folder pick / folder drop → expand to audio files).
 */
export function isImportPathAllowed(rawPath: string): boolean {
  const abs = normalizeCandidate(rawPath)
  if (!abs) return false
  if (allowed.has(abs)) return true
  for (const root of allowed) {
    if (isPathInside(abs, root)) return true
  }
  return false
}

/** Test helper — empty the session set. */
export function clearImportAllowlist(): void {
  allowed.clear()
}

/** Test helper — current grant count. */
export function importAllowlistSize(): number {
  return allowed.size
}
