// Brief 164 — HTTP Range header parsing for the local ipod-audio://
// serve, as a pure module because the inline versions in the protocol
// handler had the same RFC 9110 §14.2 defects the mobile backend had:
//
//   * Suffix ranges ("bytes=-500", the LAST 500 bytes) were not parsed
//     at all — one serve path ignored them and served from byte 0, the
//     other never matched its regex and fell back to a full serve.
//   * An oversize end ("bytes=0-999999999" on a smaller file) was
//     answered 416, where the RFC says to CLAMP the end to fileSize-1
//     and serve.
//
// ⚠️ TWIN: JakeTunesMobile `backend/src/util/rangeHeader.ts` (Brief
// 154) — the same parser, the same semantics, the same test cases.
// The two implementations must stay in lockstep: a range-semantics
// fix lands in both repos or neither. (The mobile copy lives on the
// Brief 154 branch / PR #411 at the time of this port; the function
// below is byte-equivalent in behaviour to it.)
//
// parseRangeHeader returns:
//   { start, end }   — inclusive byte range, already clamped to the file
//   'unsatisfiable'  — well-formed but cannot be served (start at/past
//                      EOF, suffix length 0, start after end)
//   null             — not a single-range header at all (garbage,
//                      multi-range); the caller keeps its existing
//                      behaviour (the serve paths fall through to a
//                      full-file serve).

export type ParsedRange = { start: number; end: number }

export function parseRangeHeader(
  header: string,
  fileSize: number,
): ParsedRange | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match) return null
  const [, first, last] = match as unknown as [string, string, string]

  if (fileSize <= 0) return 'unsatisfiable'

  if (first === '') {
    // Suffix form: the last `last` bytes of the file.
    if (last === '') return null
    const suffix = Number(last)
    if (suffix <= 0) return 'unsatisfiable'
    return { start: Math.max(0, fileSize - suffix), end: fileSize - 1 }
  }

  const start = Number(first)
  if (start >= fileSize) return 'unsatisfiable'
  const end = last === '' ? fileSize - 1 : Math.min(Number(last), fileSize - 1)
  if (start > end) return 'unsatisfiable'
  return { start, end }
}
