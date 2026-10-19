/**
 * Thumbnail freshness. Electron-free so node --test loads it; used by the
 * artwork:// protocol (index.ts) and the 320px pregeneration pass.
 */
import { readFile, stat } from 'fs/promises'
import { join } from 'path'

// ── Thumbnail freshness (2026-10-19) ──────────────────────────────────────
// Jake on workmini: Nirvana / Paul McCartney / Rush posters "has to be the
// same eye for eye". The poster jpgs were byte-identical to the laptop's, but
// workmini kept serving 320px thumbs generated on Jul 10 from the covers those
// posters replaced on Sep 2: a thumb was used whenever it EXISTED. Replaced
// art only swept thumbs on the machine that replaced it (invalidateArtBytes);
// art that arrived by copy (deploy rsync, the replica poster mirror) never
// did. The laptop had the same bug for Geese "Getting Killed Again" (thumbs
// Oct 8, poster Oct 12). Rule: a thumb is good only if it was written after
// its source art LANDED on this disk. ctime, not just mtime, because a copy
// that preserves the poster's original mtime can't fake its own ctime.
export async function thumbIsFresh(thumbPath: string, fullPath: string): Promise<boolean> {
  try {
    const [t, f] = await Promise.all([stat(thumbPath), stat(fullPath)])
    return t.mtimeMs >= Math.max(f.mtimeMs, f.ctimeMs)
  } catch {
    return false
  }
}

/** The cached thumb's bytes, or a throw when it's missing or older than its art
 *  (the caller then regenerates from the full image and overwrites it). */
export async function readFreshThumb(thumbPath: string, fullPath: string): Promise<Buffer> {
  if (!(await thumbIsFresh(thumbPath, fullPath))) throw new Error('thumb missing or older than its art')
  return readFile(thumbPath)
}

/** Art files whose 320px thumb is missing or stale — the pregeneration list. */
export async function thumbsToBuild(artDir: string, thumbDir: string, arts: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const f of arts) {
    if (!/^[^.].*\.jpg$/.test(f)) continue
    if (!(await thumbIsFresh(join(thumbDir, f.replace(/\.jpg$/, '_320.jpg')), join(artDir, f)))) out.push(f)
  }
  return out
}
