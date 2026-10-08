/**
 * play-cache-serve-pin — one media load, one byte stream (2026-09-02).
 *
 * The ipod-audio:// handler decides PER REQUEST whether a track is served
 * from its raw file, its play-cache transcode, or homemini. The media
 * element, though, treats every Range request for a URL as more bytes of
 * the SAME file. When a FLAC transcode landed mid-play, the next Range
 * request for the still-playing ALAC set got FLAC bytes where MP4 chunks
 * were expected: garbage decoding (crackle), a wandering clock, then a
 * re-sync. (Jake's video, 40 s after the cache entry's mtime.)
 *
 * So: the first request of a load (no Range, or Range from byte 0) picks
 * the source and PINS it for that URL; every later Range request serves
 * from the pinned source as long as it still exists. A new load re-picks.
 */
export type ServedSource = { kind: 'local'; path: string } | { kind: 'remote' }

export interface ServePin {
  /** Byte offset the request starts at (0 for no Range). */
  rangeStart(rangeHeader: string | null): number
  /** Called with the source the handler WOULD pick now; returns the source to actually use. */
  resolve(key: string, candidate: ServedSource, start: number, exists: (p: string) => boolean): ServedSource
  /** What is pinned for a key (for the remote-vs-local branch decision). */
  pinned(key: string): ServedSource | null
  forget(key: string): void
}

export function createServePin(): ServePin {
  const pins = new Map<string, ServedSource>()
  return {
    rangeStart(rangeHeader) {
      if (!rangeHeader) return 0
      const m = /bytes=(\d+)-/.exec(rangeHeader)
      return m ? parseInt(m[1], 10) : 0
    },
    resolve(key, candidate, start, exists) {
      if (start === 0) { pins.set(key, candidate); return candidate }
      const p = pins.get(key)
      if (!p) { pins.set(key, candidate); return candidate }
      if (p.kind === 'local' && !exists(p.path)) { pins.set(key, candidate); return candidate }
      return p
    },
    pinned(key) { return pins.get(key) ?? null },
    forget(key) { pins.delete(key) },
  }
}
