/**
 * One button per iPod (2026-11-07) — the plan's shape and the Device page's
 * words for it. main/ipod-one-sync.ts decides the plan; the Device page shows
 * it with these lines. Pure — node --test loads it.
 */

export type OneSyncKind = 'original' | 'list'

export interface OneSyncLeftOff { id: number; title: string; artist: string; why: string }

export type OneSyncPlan =
  | {
      ok: true
      kind: OneSyncKind
      ipodName: string
      color: string | null
      /** The playlist name on the iPod. */
      setName: string
      /** What goes on, in order. The Original: 1,000. Another iPod: its list, never more than IPOD_LIST_MAX. */
      trackIds: number[]
      /** What can't go on, each with a plain reason (list-only iPods only). */
      leftOff: OneSyncLeftOff[]
      /** One plain line when something is worth saying (homemini away, filler used). */
      note: string | null
      /** The playlists the next sync writes on this iPod, in the iPod's order: the
       *  defaults, On-The-Go, then the rest A to Z (common/ipod-device-playlists.ts).
       *  Nothing else: never the library's playlists, and no playlist that is just
       *  Songs again. Absent when it couldn't be worked out (an older build). */
      playlists?: string[]
      /** Plain lines about what couldn't be asked while working that out. */
      playlistNotes?: string[]
    }
  | {
      ok: false
      kind: 'none' | 'unknown' | OneSyncKind
      ipodName: string | null
      color: string | null
      error: string
    }

const n = (v: number): string => v.toLocaleString('en-US')

/** "punkPod · 847 songs ready" */
export function readyLine(plan: Extract<OneSyncPlan, { ok: true }>): string {
  const count = plan.trackIds.length
  return `${plan.ipodName} · ${n(count)} ${count === 1 ? 'song' : 'songs'} ready`
}

/**
 * Why a song was left off, as one plain word group (Jake, 2026-11-19: "its AI slop. it needs
 * to be simple"). The engine and the plan keep their own reasons (the ledger, Details); the
 * page only ever shows these. Read from those reasons, so an older ledger reads the same.
 */
export type LeftOffKind = 'damaged' | 'missing' | 'type' | 'untagged' | 'clash' | 'download' | 'other'

export function leftOffKind(why: string | null | undefined): LeftOffKind {
  const w = String(why || '').toLowerCase()
  if (/convert|damaged/.test(w)) return 'damaged'
  if (/file type/.test(w)) return 'type'
  if (/no title|no artist/.test(w)) return 'untagged'
  if (/same file name/.test(w)) return 'clash'
  if (/couldn.t send/.test(w)) return 'download'
  if (/missing|no audio file|not on this mac/.test(w)) return 'missing'
  // Anything else (an older ledger with no reason, a reason added later): no guess.
  return 'other'
}

const KIND_ONE: Record<LeftOffKind, string> = {
  damaged: 'is damaged',
  missing: 'is missing its file',
  type: 'is a kind of file the iPod can’t play',
  untagged: 'has no title or artist',
  clash: 'has the same file name as another song',
  download: 'didn’t download',
  other: 'can’t go on',
}
const KIND_MANY: Record<LeftOffKind, string> = {
  damaged: 'are damaged',
  missing: 'are missing their files',
  type: 'are a kind of file the iPod can’t play',
  untagged: 'have no title or artist',
  clash: 'have the same file name as other songs',
  download: 'didn’t download',
  other: 'can’t go on',
}

/** How many names one line can carry before it says only the count. */
const NAMES_IN_LINE = 3

/**
 * "1 song is damaged and was left off: Breeze." — null when every song can go on.
 * Names only when there are few enough to read in one line; never "and N more".
 */
export function leftOffLine(plan: Extract<OneSyncPlan, { ok: true }>): string | null {
  const off = plan.leftOff
  const c = off.length
  if (c === 0) return null
  const kinds = new Set(off.map((l) => leftOffKind(l.why)))
  const only = kinds.size === 1 ? [...kinds][0] : null
  const kind = only === 'other' ? null : only
  const one = c === 1
  const lead = kind
    ? `${n(c)} ${one ? 'song' : 'songs'} ${one ? KIND_ONE[kind] : KIND_MANY[kind]} and ${one ? 'was' : 'were'} left off`
    : `${n(c)} ${c === 1 ? 'song was' : 'songs were'} left off`
  const names = off.map((l) => l.title).filter((t) => t.trim() !== '')
  return c <= NAMES_IN_LINE && names.length === c ? `${lead}: ${names.join(', ')}.` : `${lead}.`
}

/** The list iPod's line: the same words (it used to be its own "Can’t sync" sentence). */
export function listErrorLine(plan: Extract<OneSyncPlan, { ok: true }>): string | null {
  return leftOffLine(plan)
}

/** "Playlists: Top 25 Most Played, 90's Music, On-The-Go 1, Skate Night" — null when unknown. */
export function playlistsLine(plan: Extract<OneSyncPlan, { ok: true }>): string | null {
  if (!plan.playlists) return null
  return plan.playlists.length ? `Playlists: ${plan.playlists.join(', ')}` : 'No playlists, just Songs'
}

/** "Sync punkPod" */
export function syncButtonLabel(ipodName: string | null): string {
  return ipodName ? `Sync ${ipodName}` : 'Sync'
}

/** "Last synced Nov 7, 1:15 PM" — "Not synced yet" with no record. */
export function lastSyncedLine(when: string | number | null | undefined): string {
  if (when == null || when === '') return 'Not synced yet'
  const d = new Date(when)
  if (Number.isNaN(d.getTime())) return 'Not synced yet'
  return `Last synced ${d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

/** The text the sync status carries into the progress strip. DeviceView hands the
 *  strip its target as a number; this is words only. */
export function syncingStep(setName: string, count: number): string {
  return `Syncing ${n(count)} ${count === 1 ? 'song' : 'songs'} to ${setName}…`
}

/** The plan's left-off songs plus the ones on its list that the last sealed
 *  sync left off on its own (homemini couldn't send a file, a file couldn't be converted):
 *  those are only known once the engine ran, and they are not on the iPod
 *  either. Read from the ledger (Sync History), so they survive the page. */
export function withLastSyncLeftOff(
  plan: Extract<OneSyncPlan, { ok: true }>,
  last: ReadonlyArray<{ id: number; t?: string; a?: string; why?: string }> | null | undefined,
): Extract<OneSyncPlan, { ok: true }> {
  if (!last || last.length === 0) return plan
  // Only songs still on this iPod's list: one dropped from the list since is
  // nobody's business here.
  const onList = new Set(plan.trackIds)
  const seen = new Set(plan.leftOff.map((l) => l.id))
  const extra = last
    .filter((l) => onList.has(l.id) && !seen.has(l.id))
    .map((l) => ({ id: l.id, title: l.t || '', artist: l.a || '', why: l.why || '' }))
  return extra.length === 0 ? plan : { ...plan, leftOff: [...plan.leftOff, ...extra] }
}
