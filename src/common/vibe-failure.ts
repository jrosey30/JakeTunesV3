/**
 * "Make me a vibe" — how long the desktop waits, and what it says when a vibe
 * fails (2026-11-03).
 *
 * Jake: "making a vibe never works. anywhere. macbook, workmini, phone etc".
 * The desktop gave up after 25 s, which was less than a cold hub took: the
 * CLAP helper's model load plus the AI's rounds (his 10:49 "Chill" ran about
 * 30 s on homemini). And a miss said nothing — the sheet just went back to
 * its chips. The hub now answers inside ~40 s whatever happens (its AI
 * deadline, then the fill). Main waits 60 s, names what went wrong, and the
 * sheet says it.
 *
 * ⚠️ TWIN: ~/JakeTunesMobile ios/JakeTunesMobile/MixesSection.swift vibeFailureLine.
 */

/** How long main waits for the hub's set. */
export const VIBE_WAIT_MS = 60_000

/**
 * The reason code main hands the renderer for a failed vibe:
 *   'timeout'      no set within VIBE_WAIT_MS
 *   'unreachable'  the request never got an answer (homemini down, no network)
 *   'http-<code>'  the hub answered with that status
 *   'none-here'    (renderer) the set's songs are not in this Mac's library
 */
export function vibeFailureCode(o: { status?: number; error?: unknown }): string {
  if (typeof o.status === 'number' && Number.isFinite(o.status)) return `http-${o.status}`
  const name = o.error && typeof o.error === 'object' ? (o.error as { name?: unknown }).name : undefined
  if (name === 'TimeoutError') return 'timeout'
  return 'unreachable'
}

/** The line the vibe sheet shows for a reason code. */
export function vibeFailureLine(code: string | undefined | null): string {
  switch (code) {
    case 'timeout': return 'The hub took too long. Try again.'
    case 'unreachable': return 'Can’t reach the hub right now.'
    case 'none-here': return 'None of those songs are on this Mac.'
  }
  const m = /^http-(\d+)$/.exec(code ?? '')
  if (m) {
    const status = Number(m[1])
    if (status === 401) return 'The hub didn’t recognize this Mac.'
    if (status === 422) return 'Nothing in your library matched that vibe.'
    if (status === 503) return 'The hub can’t make vibes right now.'
    return `The hub answered ${status}. Try again.`
  }
  return 'Couldn’t build that vibe. Try a different mood.'
}
