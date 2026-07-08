/** Hashes we've already kicked off a warm fetch for this session. */
const prefetched = new Set<string>()

/** Max concurrent album-art:// loads — unbounded prefetch flooded main. */
const MAX_IN_FLIGHT = 4
let inFlight = 0
const queue: string[] = []

function drainPrefetchQueue(): void {
  while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    const url = queue.shift()!
    inFlight++
    const img = new Image()
    img.decoding = 'async'
    const done = () => {
      inFlight = Math.max(0, inFlight - 1)
      drainPrefetchQueue()
    }
    img.onload = done
    img.onerror = done
    img.src = url
  }
}

/**
 * Warm the Chromium + main-process artwork caches for a batch of hashes.
 * Fire-and-forget — rate-limited so grid mounts don't stampede main.
 * Pass `size` matching what the consuming view renders (grids use the
 * thumbnail tier) so the warmed bytes are the ones actually displayed.
 */
export function prefetchAlbumArtHashes(hashes: Iterable<string | undefined | null>, size?: number): void {
  for (const hash of hashes) {
    if (!hash) continue
    const key = size ? `${hash}@${size}` : hash
    if (prefetched.has(key)) continue
    prefetched.add(key)
    queue.push(`album-art://${hash}.jpg${size ? `?s=${size}` : ''}`)
  }
  drainPrefetchQueue()
}
