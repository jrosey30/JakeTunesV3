/**
 * Map internal errors to stable UI-facing codes.
 *
 * Renderer surfaces should never receive filesystem paths, tool stderr,
 * stack traces, or raw API bodies. Pass through only short known-safe
 * strings; everything else collapses to a stable code.
 */
const SAFE_CODES = new Set([
  'refused-sender',
  'api-unavailable',
  'api-failed',
  'rate-limited',
  'invalid-input',
  'not-found',
  'io-failed',
  'tool-failed',
  'cancelled',
  'path-not-allowed',
  'unknown',
])

/** Short user-facing phrases already used by AI / TTS handlers. */
const SAFE_PHRASES = [
  'ANTHROPIC_API_KEY missing — Cynthia is on break.',
  'Cynthia needs a prompt and at least one track in scope.',
  'Cynthia needs a scope and at least one message.',
  'Empty report',
  'TTS rate limit — try again in a moment.',
  'Nothing to search for.',
  'Library is empty — nothing to sync.',
  'Python 3 is not installed.',
  'mobile backend unreachable',
  'No iPod detected',
  'Eject failed',
  'No audio CD found',
  'Audio device selection is not supported on this platform yet.',
  'This library is fully local — nothing to un-download.',
  'no output from audio_analysis.py',
]

const PATH_LEAK = /(?:\/(?:Users|home|tmp|var|private|Volumes|opt|Applications)\/|[A-Za-z]:\\|ENOENT|EACCES|EPERM|Traceback|stderr)/i

export type SafeIpcErrorCode =
  | 'refused-sender'
  | 'api-unavailable'
  | 'api-failed'
  | 'rate-limited'
  | 'invalid-input'
  | 'not-found'
  | 'io-failed'
  | 'tool-failed'
  | 'cancelled'
  | 'path-not-allowed'
  | 'unknown'

function looksLikeSafePhrase(msg: string): boolean {
  if (SAFE_CODES.has(msg)) return true
  if (SAFE_PHRASES.includes(msg)) return true
  // Short stable codes / kebab tokens without path separators
  if (/^[a-z][a-z0-9-]{1,40}$/.test(msg)) return true
  return false
}

function classifyMessage(msg: string): SafeIpcErrorCode {
  const m = msg.toLowerCase()
  if (/rate.?limit|too many requests|429/.test(m)) return 'rate-limited'
  if (/api[_ ]?key|unauthorized|401|403|missing —|on break/.test(m)) return 'api-unavailable'
  // JSON / structured API bodies (ElevenLabs, Anthropic, etc.)
  if (/^\s*[{[]/.test(msg) || /"detail"\s*:|"error"\s*:|"type"\s*:/.test(m)) return 'api-failed'
  if (/econnrefused|enotfound|fetch failed|network|timeout|timed out|502|503|504/.test(m)) {
    return 'api-failed'
  }
  if (/enoent|eacces|eperm|eisdir|enospc|io error|write failed|read failed/.test(m)) {
    return 'io-failed'
  }
  if (/exited with code|stderr|spawn|python|ffmpeg|streamrip|yt-dlp|tool/.test(m)) {
    return 'tool-failed'
  }
  if (/cancel|abort/.test(m)) return 'cancelled'
  if (/invalid|required|empty|nothing to|needs a /.test(m)) return 'invalid-input'
  if (/not found|no such/.test(m)) return 'not-found'
  return 'unknown'
}

/**
 * Convert an unknown thrown value (or already-string message) into a
 * renderer-safe error string. Prefer a known phrase / code; otherwise a
 * stable code. Never returns path-bearing text.
 */
export function safeIpcError(
  err: unknown,
  fallback: SafeIpcErrorCode = 'unknown',
): string {
  const raw =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : err == null
          ? ''
          : String(err)
  const msg = raw.trim()
  if (!msg) return fallback
  if (looksLikeSafePhrase(msg) && !PATH_LEAK.test(msg)) return msg
  if (PATH_LEAK.test(msg)) {
    if (fallback !== 'unknown') return fallback
    const classified = classifyMessage(msg)
    // Path-bearing text with no more specific class still must not
    // round-trip — collapse to io-failed rather than 'unknown'.
    return classified === 'unknown' ? 'io-failed' : classified
  }
  // Longer free-form messages that don't look like paths still get
  // classified — Anthropic / ElevenLabs bodies must not round-trip.
  if (msg.length > 80 || /[{[]/.test(msg) || /\n/.test(msg)) {
    return classifyMessage(msg)
  }
  return classifyMessage(msg)
}
