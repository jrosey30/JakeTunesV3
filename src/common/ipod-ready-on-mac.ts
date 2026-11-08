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

/** The line under the iPod's name. */
export function readyOnMacLine(r: ReadyOnMac): string {
  const c = r.missing.length
  if (c === 0) return `All ${songs(r.total)} ready on this Mac`
  if (r.stoppedBecause && !r.downloading) return `${songs(c)} not on this Mac yet (${r.stoppedBecause}) — Sync now leaves them off`
  return `${songs(c)} still downloading — Sync will wait / Sync now leaves them off`
}

/** The confirm Sync shows before it touches the card. */
export function leaveOffQuestion(r: ReadyOnMac): string {
  const c = r.missing.length
  return `${songs(c)} ${c === 1 ? 'isn’t' : 'aren’t'} on this Mac yet. Sync now and leave ${c === 1 ? 'it' : 'them'} off, or wait for the download?`
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
  return `Sync now (${n(missing)} left off)`
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
