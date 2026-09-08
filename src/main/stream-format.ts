// ── Which variant a streaming client asks homemini for ───────────────────
//
// Three answers, and the right one depends on the LINK, not the file:
//
//   raw        LAN, or a source Chromium can already decode.
//   ?fmt=flac  ALAC over a fat link. Chromium has no ALAC decoder; FLAC is
//              lossless, so quality is untouched and size is unchanged.
//   ?fmt=aac   a link too thin for lossless AT ALL. Measured 2026-09-08:
//              workmini's path to homemini carried 70-100 KB/s while a
//              lossless track needs 125+ KB/s, so every song stalled
//              mid-play. 256k AAC needs ~32 KB/s.
//
// AAC also decodes in Chromium, so it subsumes the FLAC rescue: on a
// compressed client the ALAC question stops mattering.
//
// Opt-in per machine by a marker file, the same idiom as the streaming
// marker, so the canonical Mac and the phone are untouched by default. A
// machine on a fat link should NOT carry the marker — there is no reason to
// listen to a transcode when the original fits.
export const STREAM_KBPS_DEFAULT = 256
export const STREAM_KBPS_MIN = 96
export const STREAM_KBPS_MAX = 320

/** ⚠️ TWIN: backend src/util/aacFormat.ts normalizeAacKbps — same band. */
export function normalizeStreamKbps(raw: unknown): number {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return STREAM_KBPS_DEFAULT
  return Math.min(STREAM_KBPS_MAX, Math.max(STREAM_KBPS_MIN, n))
}

/**
 * The query string to append to /audio/:id, and a spool key suffix so a
 * compressed copy can never be served from a spool holding the lossless one
 * (or the reverse) — they are different bytes under the same track id.
 */
export function streamVariant(opts: { compressed: boolean; kbps?: number; wantFlac: boolean }): {
  query: string
  spoolSuffix: string
  transcoding: boolean
  label: string
} {
  if (opts.compressed) {
    const kbps = normalizeStreamKbps(opts.kbps ?? STREAM_KBPS_DEFAULT)
    return {
      query: `?fmt=aac&kbps=${kbps}`,
      spoolSuffix: `-aac${kbps}`,
      transcoding: true,
      label: `homemini-aac${kbps}`,
    }
  }
  if (opts.wantFlac) {
    return { query: '?fmt=flac', spoolSuffix: '-flac', transcoding: true, label: 'homemini-flac' }
  }
  return { query: '', spoolSuffix: '', transcoding: false, label: 'homemini' }
}
