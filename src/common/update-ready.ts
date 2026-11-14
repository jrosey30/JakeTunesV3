/**
 * "Update ready" (2026-10-30) — what the status bar draws when a newer build
 * is staged on this Mac and waiting at the install gate.
 *
 * ⚠️ TWIN: scripts/install/jaketunes-install-gate.sh writes the marker these
 * fields come from (update-ready.json: v, sha, version, note, stagedAt,
 * gatePid; v 2 adds label, kind, notes, offeredAt). The main process
 * (src/main/update-ready-core.ts) validates the marker and reduces it to this
 * shape for the renderer.
 *
 * The weekly release (2026-11-14, Jake: "Don't force anything, user decides in
 * app whether he wants to update now. update later in middle of night or
 * something (user will tell you when) or skip to next week."): an offer carries
 * a label, a kind and plain one-line notes, and nothing installs until Jake
 * picks one of three: now, at a time he chooses, or skip to next week. The
 * choice is this Mac's alone (update-decision-core.ts).
 */

/** What kind of release this is. ⚠️ CONTRACT with the JakeTunesMobile weekly routine. */
export type UpdateKind = 'weekly' | 'monthly' | 'fix'
export const UPDATE_KINDS: readonly UpdateKind[] = ['weekly', 'monthly', 'fix']

/** Where an offer stands on this Mac. */
export type UpdatePhase =
  /** Offered; nothing decided yet. */
  | 'offered'
  /** "Install at…" chosen; the time has not come. */
  | 'scheduled'
  /** The time has come, but the music is playing or an iPod sync / CD rip runs. */
  | 'waiting'
  /** The go-file is written: the gate quits the app within seconds. Too late to change. */
  | 'installing'

export interface UpdateReadyState {
  /** Commit the staged build was made from — the gate's 4th argument. */
  sha: string
  /** CFBundleShortVersionString of the staged app ('' when the gate could not read it). */
  version: string
  /** Free text from the install pipeline — what is in the update ('' when none). */
  note: string
  /** What the bar calls the release ("This week's fixes"); falls back to the note or the version. */
  label: string
  kind: UpdateKind
  /** Plain one-line strings; may be empty. */
  notes: string[]
  /** ISO time the offer was made. */
  offeredAt: string
  /**
   * True for a v 2 marker: the gate installs only on a decision (never on idle),
   * and "Skip to next week" really ends it. A v 1 gate still installs on idle.
   */
  decides: boolean
  phase: UpdatePhase
  /** ISO time an "Install at…" is set for (phase scheduled / waiting). */
  at: string | null
  /** Why a due install is waiting, in plain words ("the music is playing"). */
  waitingFor: string | null
}

/** The person's answer, sent by the renderer. */
export type UpdateChoice =
  | { choice: 'now' }
  | { choice: 'at'; at: string }
  | { choice: 'skip' }

/** install-update-now's answer while an iPod sync runs: the gate won't quit the app until it ends. */
export const INSTALL_AFTER_SYNC = 'after the sync'

/** "Install at…" may be any time in the next 7 days. */
export const INSTALL_AT_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The default "Install at…" time: 3:00 AM tonight. Past 3:00 AM today that is
 * tomorrow's 3:00 AM; before it (Jake up at 1 AM) it is today's, two hours on.
 * Local time, the clock on the wall.
 */
export function defaultInstallAt(now: number): number {
  const d = new Date(now)
  d.setHours(3, 0, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** Is this a time "Install at…" may be set for? Strictly in the future, at most 7 days on. */
export function installAtAllowed(at: number, now: number): boolean {
  return Number.isFinite(at) && at > now && at <= now + INSTALL_AT_MAX_AHEAD_MS
}

/** "3:00 AM" today or tonight (before noon tomorrow counts as tonight), else "Tue 3:00 AM". */
export function formatInstallAt(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const today = new Date(now)
  const tomorrowNoon = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12, 0, 0, 0).getTime()
  if (at < tomorrowNoon) return time
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}
