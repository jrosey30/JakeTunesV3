/**
 * Path containment helpers for custom-protocol and destructive FS ops.
 * Rejects traversal, absolute escapes, and targets outside approved roots.
 */

import { resolve, normalize, sep, isAbsolute } from 'path'
import { realpath, stat } from 'fs/promises'

/** True when `candidate` resolves strictly inside (or equal to) `root`. */
export function isPathInside(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate)
  const resolvedRoot = resolve(root)
  if (resolvedCandidate === resolvedRoot) return true
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep
  return resolvedCandidate.startsWith(prefix)
}

/**
 * Resolve `rawPath` and require it to sit under one of `allowedRoots`.
 * Uses realpath when the file exists (blocks symlink escapes); falls back
 * to normalize+resolve for not-yet-created paths.
 * Returns the absolute path to use, or null if rejected.
 */
export async function resolveContainedPath(
  rawPath: string,
  allowedRoots: string[],
): Promise<string | null> {
  if (!rawPath || typeof rawPath !== 'string') return null
  // Reject null bytes and empty roots early.
  if (rawPath.includes('\0')) return null
  const roots = allowedRoots.filter((r) => typeof r === 'string' && r.length > 0)
  if (roots.length === 0) return null

  let candidate = rawPath
  // Custom protocols sometimes pass leading slashes oddly on Windows;
  // normalize first so resolve() is predictable.
  try {
    candidate = normalize(rawPath)
  } catch {
    return null
  }

  // If relative, join against each root and test; if absolute, test as-is.
  const candidates: string[] = []
  if (isAbsolute(candidate)) {
    candidates.push(resolve(candidate))
  } else {
    for (const root of roots) {
      candidates.push(resolve(root, candidate))
    }
  }

  for (const abs of candidates) {
    let real = abs
    try {
      real = await realpath(abs)
    } catch {
      // File may not exist yet — still require logical containment.
      real = abs
    }
    for (const root of roots) {
      let realRoot = root
      try {
        realRoot = await realpath(root)
      } catch {
        realRoot = resolve(root)
      }
      if (isPathInside(real, realRoot)) {
        // Prefer existing files; for non-existent paths still return abs
        // if contained (callers may be writing).
        try {
          const s = await stat(real)
          if (s.isDirectory()) return null
        } catch {
          /* may not exist */
        }
        return real
      }
    }
  }
  return null
}

/** Artwork / cache filenames: only hex (optionally with underscore+digits cache-bust). */
export function sanitizeArtworkHash(raw: string): string | null {
  const cleaned = String(raw || '').replace(/\.jpe?g$/i, '')
  // Allow "abc123" or "abc123_1713100000000"
  const m = cleaned.match(/^([a-f0-9]+)(?:_\d+)?$/i)
  return m ? m[1].toLowerCase() : null
}
