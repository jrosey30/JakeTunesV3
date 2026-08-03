/**
 * Containment for anything that turns an untrusted string into a file read.
 *
 * WHY (2026-08-03, from the Cursor "fortify internal piping" audit, PR #8):
 * the custom protocol handlers take a path straight out of a URL and read it.
 * `ipod-audio://` in particular did `decodeURIComponent(url)` and handed the
 * result to stat/createReadStream with NO containment at all — an absolute
 * path from the URL was served verbatim. `album-art://` joined an unvalidated
 * string onto the artwork dir.
 *
 * That is not theoretical in this app: the Bandcamp store loads a real remote
 * page in a webview inside the same session, so "only our renderer can issue
 * these URLs" is not a boundary we actually have.
 *
 * SYMLINKS ARE THE INTERESTING PART. Streamed tracks are stored as symlinks
 * whose targets live outside the music root (see the `streamed` branch in the
 * ipod-audio handler, and workmini's `library.streamRoot`). A naive realpath
 * containment check would resolve those to the NAS and reject them, silently
 * breaking playback on exactly the machine that streams. So the caller passes
 * EVERY legitimate root — music dir, play-cache, iPod mount, stream root — and
 * a symlink is fine as long as what it points AT is also contained.
 */
import { resolve, sep, isAbsolute } from 'node:path'
import { realpath } from 'node:fs/promises'

/** True when `candidate` is `root` itself or sits underneath it.
 *  Separator-aware so `/music-old` does not count as inside `/music`. */
export function isPathInside(candidate: string, root: string): boolean {
  const c = resolve(candidate)
  const r = resolve(root)
  if (c === r) return true
  return c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Resolve `rawPath` if — and only if — it stays inside one of `roots`.
 * Returns the path to read, or null to refuse.
 *
 * Two checks, deliberately both:
 *   1. LEXICAL, on the resolved path. Kills `../` traversal before touching
 *      the filesystem.
 *   2. REAL, after realpath. Kills symlink escape — a link inside the music
 *      root pointing at ~/.ssh would pass check 1 on its own.
 *
 * A path that doesn't exist yet still passes if it is lexically contained;
 * realpath fails with ENOENT and the caller's own stat produces the 404. That
 * keeps "missing file" and "refused" as distinct outcomes instead of
 * collapsing a normal miss into a security refusal.
 */
export async function resolveContainedPath(
  rawPath: string,
  roots: Array<string | null | undefined>,
): Promise<string | null> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null
  if (rawPath.includes('\0')) return null
  if (!isAbsolute(rawPath)) return null

  const clean = roots.filter((r): r is string => typeof r === 'string' && r.length > 0)
  if (clean.length === 0) return null

  const abs = resolve(rawPath)
  if (!clean.some((r) => isPathInside(abs, r))) return null

  // The ROOTS have to be realpath'd too, not just the candidate. Compare a
  // resolved file against an unresolved root and any symlink ON THE ROOT PATH
  // breaks containment: macOS puts temp dirs under /var -> /private/var, and
  // /Volumes mounts are routinely links, so realpath(file) legitimately lands
  // outside the literal root string and a valid file gets refused. This bit
  // both this module's first draft and the upstream audit's version.
  const realRoots = await Promise.all(clean.map((r) => realpath(r).catch(() => resolve(r))))

  let real: string
  try {
    real = await realpath(abs)
  } catch {
    return abs                      // doesn't exist — contained, let the caller 404
  }
  return realRoots.some((r) => isPathInside(real, r)) ? real : null
}

/** Artwork/artist-image keys are content hashes or slugs we generated. Anything
 *  with a separator, a dot-segment, or exotic characters is not one of ours. */
export function isSafeCacheKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= 128 && /^[A-Za-z0-9._-]+$/.test(key) && !key.includes('..')
}
