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
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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

/**
 * The ONE derivation of a streamed track's homemini URL and spool key.
 * fetchAudioFromHomemini (playback) and the overnight pre-load
 * (overnight-preload.ts) both call it, so a file pre-loaded at night is
 * byte-for-byte the key a daytime play looks up — they cannot drift.
 */
export function homeminiStreamTarget(
  audioBase: string,
  id: string | number,
  opts: { compressed: boolean; kbps?: number; wantFlac: boolean },
): { variant: ReturnType<typeof streamVariant>; url: string; spoolKey: string } {
  const variant = streamVariant(opts)
  return {
    variant,
    url: `${audioBase}/${encodeURIComponent(String(id))}${variant.query}`,
    spoolKey: `${id}${variant.spoolSuffix}`,
  }
}

// Compressed-stream marker: a machine on a link too thin for lossless
// carries ~/.config/jaketunes/stream-compressed (optionally containing a
// kbps number). Cached like streamSource — this is the playback hot path.
// Absent = unchanged behaviour, which is what every machine but workmini
// wants. (Moved out of index.ts 2026-10-19 so the overnight pre-load reads
// the marker the same way playback does.)
export const STREAM_COMPRESSED_MARKER = '.config/jaketunes/stream-compressed'

export async function readStreamCompressed(home: string = process.env.HOME || ''): Promise<{ on: boolean; kbps: number }> {
  let on = false
  let kbps = STREAM_KBPS_DEFAULT
  try {
    const raw = await readFile(join(home, STREAM_COMPRESSED_MARKER), 'utf8')
    on = true
    const n = parseInt(raw.trim(), 10)
    if (Number.isFinite(n)) kbps = normalizeStreamKbps(n)
  } catch { /* no marker — fat link, serve the original */ }
  return { on, kbps }
}

let _streamCompressedCache: { on: boolean; kbps: number; t: number } | null = null
export async function readStreamCompressedCached(): Promise<{ on: boolean; kbps: number }> {
  const now = Date.now()
  if (_streamCompressedCache && now - _streamCompressedCache.t < 5000) return _streamCompressedCache
  _streamCompressedCache = { ...(await readStreamCompressed()), t: now }
  return _streamCompressedCache
}
