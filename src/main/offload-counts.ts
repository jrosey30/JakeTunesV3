/**
 * Settings › Storage's numbers for the offload switch (V7): what "Check first"
 * shows and what the native confirm before Start names. Words only; every
 * refusal stays in offload-audio.ts and runStart (ipc/offload-ipc.ts).
 */
/** The counts Settings shows ("Check first"), in plain numbers. */
export interface OffloadCounts { ready: number; notYet: number; alreadyMoved: number }
export function countsFromReport(r: { matchingOnHomemini: number; missingOnHomemini: number; differentOnHomemini: number; needsFingerprint: number; notProbed: number; alreadyStreamed: number }): OffloadCounts {
  return { ready: r.matchingOnHomemini, notYet: r.missingOnHomemini + r.differentOnHomemini + r.needsFingerprint + r.notProbed, alreadyMoved: r.alreadyStreamed }
}

/** The native confirm before Start names how many songs would leave this Mac. */
export function startConfirmMessage(c: OffloadCounts): string {
  const n = c.ready === 1 ? 'one song' : `${c.ready.toLocaleString()} songs`
  return `Move ${n} to the home server? Each one leaves this Mac only once the home server has the exact same file.`
}

