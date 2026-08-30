/**
 * Evicted-track playback fallback (2026-08-30).
 *
 * Pass-through storage (library-eviction.ts) trashes local audio once
 * homemini's copy is hash-proven — by design this Mac does not keep the
 * library on disk. But the fully-local branch of the ipod-audio handler
 * served ONLY from disk, so the moment library.streamRoot went back to
 * null (canonical mode, 2026-08-30) every evicted track 404'd — 1,132
 * of 9,851 tracks were unplayable when this shipped.
 *
 * This is the missing half of the eviction contract: local file gone →
 * serve the SAME bytes homemini already proved it holds, over the
 * phone-proven HTTP path. Never SMB, never a mount — homemini down or
 * missing the id returns null and the caller keeps its clean 404 (fail
 * closed, per the workmini postmortem).
 *
 * Streaming clients (streamRoot/streamSource set) never reach this —
 * they take the homemini-FIRST block at the top of the handler. This
 * module exists for machines where that block is off.
 *
 * Deps are injected so node --test exercises the retry shape without
 * Electron.
 */

export interface EvictedServeDeps {
  /** library.json lookup — abs path → track id (null when not a library file). */
  trackIdForAbsPath: (abs: string) => Promise<string | number | null>
  /** The established homemini HTTP fetch (spool-aware). Null on miss/down. */
  fetchAudioFromHomemini: (id: string | number, range: string | null, wantFlac: boolean) => Promise<Response | null>
  /** True when the source codec needs homemini's FLAC transcode to decode. */
  wantsFlac: (abs: string) => boolean
}

/**
 * Serve a locally-missing library file from homemini, or null to let the
 * caller 404. Mirrors the streaming-client retry shape: a FLAC-transcode
 * miss gets one raw retry (an AAC source wrongly routed to ?fmt=flac
 * still decodes raw; raw ALAC won't, but that stays a clean 404).
 */
export async function serveEvictedFromHomemini(
  rawPath: string,
  rangeHeader: string | null,
  deps: EvictedServeDeps,
): Promise<Response | null> {
  const id = await deps.trackIdForAbsPath(rawPath)
  if (id == null) return null
  const wantFlac = deps.wantsFlac(rawPath)
  const first = await deps.fetchAudioFromHomemini(id, rangeHeader, wantFlac)
  if (first) return first
  if (wantFlac) {
    const raw = await deps.fetchAudioFromHomemini(id, rangeHeader, false)
    if (raw) return raw
  }
  console.warn(`[evicted-playback] local file missing and homemini miss for id=${id} — unplayable until homemini serves it`)
  return null
}
