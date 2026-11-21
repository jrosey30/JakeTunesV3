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
 * A list iPod gets exactly its list (Jake, 2026-11-17), and its Sync gets the songs
 * that aren't on this Mac itself, at once (2026-11-20, Brief 263: main/ipod-sync-fetch.ts).
 * It used to wait on the background download and call itself stuck whenever that
 * download stopped, which it does under 60 GB free. What the Device page does with
 * the fetch's answer and a fresh ready check:
 *   • go: every song is here now, except songs homemini can't give at all
 *     (`gone`: no file, or its file isn't the song). Those are left off, and one
 *     line says so after the sync (unavailableLine): one song never blocks the iPod;
 *   • stopped: Jake pressed Stop;
 *   • stuck: a song that could still be had didn't arrive after every try
 *     (homemini not answering, no room). One error line; nothing on the iPod changed.
 */
export interface SyncFetchAnswer { landed: number[]; gone: number[]; failed: number[]; stopped: boolean }

export type ListFetchOutcome =
  | { kind: 'go'; leftOff: number[] }
  | { kind: 'stopped' }
  | { kind: 'stuck'; error: string }

export function listFetchOutcome(
  answer: SyncFetchAnswer | null,
  after: Pick<ReadyOnMac, 'missing'> | null,
  asked: number,
): ListFetchOutcome {
  if (answer?.stopped) return { kind: 'stopped' }
  if (!answer) return { kind: 'stuck', error: `Can’t get ${songs(Math.max(1, asked))} right now. Try Sync again later.` }
  if (!after) return { kind: 'stuck', error: 'Couldn’t get ready to sync. Press Sync again.' }
  const gone = new Set(answer.gone)
  const still = after.missing.filter((id) => !gone.has(id))
  if (still.length > 0) return { kind: 'stuck', error: `Can’t get ${songs(still.length)} right now. Try Sync again later.` }
  return { kind: 'go', leftOff: after.missing.filter((id) => gone.has(id)) }
}

/** The one line after a sync that left songs off because homemini couldn't give them. */
export function unavailableLine(count: number): string | null {
  if (count <= 0) return null
  return `${songs(count)} ${count === 1 ? 'wasn’t' : 'weren’t'} available, so ${count === 1 ? 'it was' : 'they were'} left off.`
}
