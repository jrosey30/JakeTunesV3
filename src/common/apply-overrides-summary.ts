/**
 * What "Apply Overrides to Files…" says when it is done (review of #427).
 *
 * A song the player is using is not written then: it goes on the per-edit
 * line, which writes it once the player is done with it. Those songs are
 * part of the total, and the dialog says how many are waiting, so a count
 * that looks short never reads as a failure.
 */
export interface ApplyOverridesCounts {
  /** Files handed to the writer now. */
  total: number
  succeeded: number
  failed: number
  /** Playing songs, written later by the per-edit line. */
  waitingForPlayback: number
  skippedNoTrack: number
  skippedFpMismatch: number
  skippedNoWritable: number
  failures: Array<{ filePath: string; error?: string }>
}

const n = (x: number): string => x.toLocaleString('en-US')

export function applyOverridesSummary(r: ApplyOverridesCounts): { message: string; detail: string } {
  const all = r.total + r.waitingForPlayback
  let message = `Wrote tags to ${n(r.succeeded)} of ${n(all)} files`
  message += r.failed > 0 ? `; ${n(r.failed)} failed.` : '.'
  if (r.waitingForPlayback > 0) {
    const one = r.waitingForPlayback === 1
    message += ` ${n(r.waitingForPlayback)} ${one ? 'song is' : 'songs are'} playing and will be written when the player is done with ${one ? 'it' : 'them'}.`
  }
  let detail =
    `Skipped: ${n(r.skippedNoTrack)} missing-track, ` +
    `${n(r.skippedFpMismatch)} fingerprint-mismatch, ` +
    `${n(r.skippedNoWritable)} analysis-only.`
  if (r.failures.length > 0) {
    detail += `\n\nFirst failures:\n${r.failures.slice(0, 5).map((f) => `• ${f.filePath.split('/').pop()}: ${f.error || 'unknown'}`).join('\n')}`
  }
  return { message, detail }
}
