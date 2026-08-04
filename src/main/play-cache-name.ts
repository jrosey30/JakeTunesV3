import { createHash } from 'crypto'

/**
 * Naming rule for the ALAC→AAC play cache.
 *
 * Chromium cannot decode ALAC, so the app transcodes each ALAC source to AAC
 * once and serves the copy. The question this module answers is the only hard
 * part of that: given a source file, which cache entry is allowed to stand in
 * for it?
 *
 * The answer used to be "the entry at sha1(path), as long as its mtime is not
 * older than the source's". That is an ordering test, and ordering is the wrong
 * tool — mtime routinely moves BACKWARD:
 *
 *   - unzipping a Bandcamp archive restores the archive's original timestamps
 *   - rsync -a, cp -p, Finder copies and Time Machine restores preserve mtime
 *   - a file pulled back off the NAS carries the NAS's idea of the time
 *
 * So replacing a bad file with a good one left the stale entry looking "fresh"
 * forever and the app kept serving the bad audio no matter how many times the
 * user re-downloaded it. An audit found 11 tracks in this state, including two
 * 30-second preview clips still standing in for full songs months after the
 * real files had been put in place.
 *
 * Encoding size+mtime into the NAME instead removes the direction that could be
 * wrong. A changed file produces a different name, misses the cache, and gets
 * re-transcoded. Identical size and mtime means the same file. The path hash
 * stays a stable prefix so every entry for one source can still be found — used
 * both to evict superseded entries and to keep the pruner from mistaking live
 * entries for orphans.
 */

/** Stable per-source prefix. Every cache entry for `src` starts with this. */
export function pathHashFor(src: string): string {
  return createHash('sha1').update(src).digest('hex').slice(0, 16)
}

/** Full cache file name for one exact version of one source file. */
export function playCacheName(src: string, size: number, mtimeMs: number): string {
  const tag = createHash('sha1')
    .update(`${size}:${Math.round(mtimeMs)}`)
    .digest('hex')
    .slice(0, 10)
  return `${pathHashFor(src)}-${tag}.m4a`
}

/**
 * Does this cache file belong to this source?
 *
 * Prefix, not equality. An equality test written against one name format
 * classifies every entry in the other format as an orphan — which, in the
 * pruner, means deleting the entire cache.
 */
export function isEntryFor(fileName: string, pathHash: string): boolean {
  return fileName.startsWith(pathHash)
}

/** Pre-content-tag name, kept so existing entries can be adopted, not redone. */
export function legacyPlayCacheName(src: string): string {
  return `${pathHashFor(src)}.m4a`
}
