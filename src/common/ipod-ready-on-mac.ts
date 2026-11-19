/**
 * "Ready on this Mac" (2026-11-08) — the Device page's words for whether a Sync
 * will need anything from homemini, and the one confirm when it would.
 *
 * Jake: "why cant we know and catch this before it happens". A song the sync
 * needs is ready when its file is on this Mac, or when the last sync's record
 * proves it's already on the iPod (it stays, nothing moves). Anything else would
 * have to be fetched mid-sync over whatever link the Mac has, which is what
 * failed. main/ipod-local-start.ts counts; this says it. Pure — node --test loads it.
 */

export interface ReadyOnMac {
  /** Songs in the plan. */
  total: number
  /** Songs the sync would have to fetch from homemini: not on this Mac, not provably on the iPod. */
  missing: number[]
  /** Not on this Mac, but on the iPod by the last sync's record (no fetch needed). */
  onCard: number
  /** The Original only: songs on this Mac that take the missing songs' seats, so it stays 1,000. */
  fill: number[]
  /** The background download right now. */
  downloading: boolean
  /** Why the background download isn't getting them (plain words), or null. */
  stoppedBecause: string | null
}

const n = (v: number): string => v.toLocaleString('en-US')
const songs = (c: number): string => `${n(c)} ${c === 1 ? 'song' : 'songs'}`

/**
 * The line under the iPod's name, or null when there is nothing to say (every song is
 * ready: the line beside the name already says so). Plain words only (Jake, 2026-11-19:
 * "its AI slop. it needs to be simple"): no reason in brackets, no machine names.
 * A list iPod (`list`) never leaves a song off: its Sync gets them first.
 */
export function readyOnMacLine(r: ReadyOnMac, opts: { list?: boolean } = {}): string | null {
  const c = r.missing.length
  if (c === 0) return null
  const notHere = `${songs(c)} ${c === 1 ? 'isn’t' : 'aren’t'} on this Mac yet.`
  if (opts.list) return `${notHere} Sync gets ${c === 1 ? 'it' : 'them'} first.`
  if (r.downloading) return `${songs(c)} still downloading.`
  return notHere
}

/** The confirm Sync shows before it touches the card. */
export function leaveOffQuestion(r: ReadyOnMac): string {
  const c = r.missing.length
  return `${songs(c)} ${c === 1 ? 'isn’t' : 'aren’t'} on this Mac yet.`
}

/**
 * Sync stops and asks before the card is touched when any song would have to
 * be fetched, unless Jake already chose "Sync now" for at least that many
 * (more missing than he agreed to leave off asks again). null check = the
 * check itself couldn't run: the sync goes ahead as before.
 */
export function mustAskBeforeSync(check: Pick<ReadyOnMac, 'missing'> | null, agreed: Pick<ReadyOnMac, 'missing'> | null | undefined): boolean {
  if (!check || check.missing.length === 0) return false
  return !agreed || check.missing.length > agreed.missing.length
}

export function syncNowLeavingOffLabel(missing: number): string {
  return missing === 1 ? 'Sync without it' : 'Sync without them'
}

/**
 * The ids a "Sync now" sends: the plan without the missing songs, and for the
 * Original the fill songs after them (the Original stays at its count).
 * Order kept; nothing twice.
 */
export function idsLeavingOff(planIds: readonly number[], r: Pick<ReadyOnMac, 'missing' | 'fill'>): number[] {
  const gone = new Set(r.missing)
  const out: number[] = []
  const seen = new Set<number>()
  for (const id of planIds) {
    if (gone.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  for (const id of r.fill.slice(0, r.missing.length)) {
    if (gone.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * A list iPod never leaves a song off because it isn't on this Mac yet (Jake,
 * 2026-11-17: a list iPod gets exactly its list). Its Sync is the Wait path:
 * kick the background download, wait while the songs arrive, then sync, with
 * no "Sync now (N left off)". What the Device page does on each look at the
 * ready check:
 *   • go: every song is on this Mac (or already on the iPod)
 *   • wait: still downloading, or the download has had less than `graceMs` to start
 *   • stuck: the download stopped and says why, or nothing arrived for `stallMs`
 *     (a sync error, said in one line; nothing on the iPod was changed)
 */
export type ListFetchStep =
  | { kind: 'go' }
  | { kind: 'wait'; line: string }
  | { kind: 'stuck'; error: string }

export function listFetchStep(
  check: Pick<ReadyOnMac, 'missing' | 'downloading' | 'stoppedBecause'> | null,
  t: { startedAt: number; lastProgressAt: number; now: number; ipodName: string },
  limits: { graceMs?: number; stallMs?: number } = {},
): ListFetchStep {
  const graceMs = limits.graceMs ?? 15_000
  const stallMs = limits.stallMs ?? 10 * 60_000
  if (!check) return { kind: 'go' }   // the check itself couldn't run: the sync goes ahead as before
  const c = check.missing.length
  if (c === 0) return { kind: 'go' }
  const getting = `Getting ${songs(c)} from homemini…`
  if (t.now - t.startedAt < graceMs) return { kind: 'wait', line: getting }
  if (check.stoppedBecause && !check.downloading) {
    return { kind: 'stuck', error: `Can’t get ${songs(c)} right now. Try Sync again later.` }
  }
  if (t.now - t.lastProgressAt >= stallMs) {
    return { kind: 'stuck', error: `${songs(c)} stopped downloading. Press Sync to try again.` }
  }
  return { kind: 'wait', line: getting }
}
