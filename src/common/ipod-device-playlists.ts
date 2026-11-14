/**
 * What playlists one iPod carries (2026-11-13) — PURE, no I/O, no clock.
 *
 * Jake: "the only playlists each ipod gets are the default and its specific
 * ipod assigned playlists". So a sync writes exactly, in this order:
 *
 *   1. the iPod's own list (the set the sync just built, in its order)
 *   2. the DEFAULTS, each worked out from THAT iPod's songs:
 *        Top 25 Most Played, Starred, Recently Added, Recently Played,
 *        Best of <year>            (evaluated by renderer/utils/smartPlaylists.ts
 *                                   against the iPod's songs, kept here by name)
 *        60's Music … 20's Music   (a decade with DECADE_MIN songs or more)
 *        BPM 060-089 … BPM 170+    (verified foot-tap BPM only)
 *   3. On-The-Go read-backs, in the order they were numbered
 *   4. every other playlist assigned to that iPod (AI ones Jake approved and
 *      his own, mixed), A to Z by the app's one name-sort rule.
 *
 * The old firmwares list playlists in database order, so this order IS the
 * order of the mhyp records (core/db_reader.py writes them as handed).
 *
 * Nothing else: none of the library's general playlists reach an iPod.
 *
 * ⚠️ THAT LAST LINE IS BEHIND A SWITCH, PER iPOD, OFF UNTIL JAKE SAYS YES
 * (`onlyOwn`, read by main/ipod-playlist-rule.ts from that iPod's state
 * folder). Taking the library's playlists off his iPods is a visible change he
 * has to approve iPod by iPod. With the switch OFF a sync writes exactly what
 * it wrote before (same playlists, same order) and ADDS the new ones after
 * them: decades, BPM, On-The-Go, assigned. Either way the result says which
 * playlists are new (`added`) and which library playlists are, or would be,
 * left off (`removed` / `wouldRemove`).
 *
 * A default that would be empty is not written, and neither is one that
 * would hold NEARLY_ALL of the iPod (the 1990's iPod needs no "90's Music").
 * The iPod's own list is exempt: it is the whole iPod on purpose.
 *
 * Membership is by library track id; ids not on the iPod are dropped, so the
 * database never references a song that didn't land.
 */

/** Where a playlist on an iPod comes from. `library` = one of the library's general
 *  playlists, which reach an iPod only while that iPod's switch is off. */
export type DevicePlaylistKind = 'set' | 'default' | 'on-the-go' | 'assigned' | 'library'

export interface DevicePlaylist {
  id: string
  name: string
  trackIds: number[]
  kind?: DevicePlaylistKind
}

export interface DeviceTrack {
  id: number
  year?: number | string | null
  artist?: string | null
  title?: string | null
}

/** A decade list needs this many songs on the iPod. */
export const DECADE_MIN = 10
/** A default holding this share of the iPod (or more) is just Songs again. */
export const NEARLY_ALL = 0.9
/** The Original has no list row on homemini; its playlists are kept under this key. */
export const ORIGINAL_DEVICE_KEY = 'top1000'
/** The key an iPod's playlists are kept under: 'top1000' for the Original, its id for any other. */
export function deviceKeyOf(device: { id: string; primary: boolean } | null | undefined): string {
  return device ? (device.primary ? ORIGINAL_DEVICE_KEY : device.id) : 'unknown-ipod'
}
/** The id the renderer gives the iPod's own list (utils/workoutIpodSync.ts). */
export const SET_PLAYLIST_ID = 'workout-sync'

/** The built-in defaults the renderer evaluates against the iPod's songs,
 *  in device order. ⚠️ Names twin BUILTIN_SMART_PLAYLISTS in
 *  renderer/utils/smartPlaylists.ts (pinned by __tests__/ipod-device-playlists.test.ts). */
export function builtinDefaultNames(year: number): string[] {
  return ['Top 25 Most Played', 'Starred', 'Recently Added', 'Recently Played', `Best of ${year}`]
}

/** "90's Music", the way an iPod named it. 2000 → "00's Music". */
export function decadeName(decadeStart: number): string {
  return `${String(decadeStart % 100).padStart(2, '0')}'s Music`
}

const yearOf = (t: DeviceTrack): number => {
  const y = Math.floor(Number(t.year))
  return Number.isFinite(y) && y >= 1900 && y <= 2100 ? y : 0
}

/** One list per decade with enough songs, oldest decade first; songs in iPod order. */
export function decadePlaylists(tracks: DeviceTrack[]): DevicePlaylist[] {
  const byDecade = new Map<number, number[]>()
  for (const t of tracks) {
    const y = yearOf(t)
    if (!y) continue
    const d = Math.floor(y / 10) * 10
    const ids = byDecade.get(d)
    if (ids) ids.push(t.id)
    else byDecade.set(d, [t.id])
  }
  return [...byDecade.entries()]
    .filter(([, ids]) => ids.length >= DECADE_MIN)
    .sort((a, b) => a[0] - b[0])
    .map(([d, ids]) => ({ id: `default-decade-${d}`, name: decadeName(d), trackIds: ids }))
}

/** The BPM ranges promised on 2026-11-08. `to` is exclusive; the last has none. */
export const BPM_RANGES: ReadonlyArray<{ from: number; to: number | null; name: string }> = [
  { from: 60, to: 90, name: 'BPM 060-089' },
  { from: 90, to: 110, name: 'BPM 090-109' },
  { from: 110, to: 130, name: 'BPM 110-129' },
  { from: 130, to: 150, name: 'BPM 130-149' },
  { from: 150, to: 170, name: 'BPM 150-169' },
  { from: 170, to: null, name: 'BPM 170+' },
]

/** Which range a BPM falls in; null under 60 or for a number that isn't one. */
export function bpmRangeIndex(bpm: number): number | null {
  if (!Number.isFinite(bpm)) return null
  for (let i = 0; i < BPM_RANGES.length; i++) {
    const r = BPM_RANGES[i]
    if (bpm >= r.from && (r.to === null || bpm < r.to)) return i
  }
  return null
}

/**
 * One list per BPM range, slowest song first. `verifiedBpm` holds ONLY songs
 * the nightly check settled (verified or resolved): a song missing from it is
 * in no list. Each song is in at most one.
 */
export function bpmPlaylists(tracks: DeviceTrack[], verifiedBpm: ReadonlyMap<number, number>): DevicePlaylist[] {
  const buckets: Array<Array<{ id: number; bpm: number; order: number }>> = BPM_RANGES.map(() => [])
  tracks.forEach((t, order) => {
    const bpm = verifiedBpm.get(t.id)
    if (bpm === undefined) return
    const i = bpmRangeIndex(bpm)
    if (i !== null) buckets[i].push({ id: t.id, bpm, order })
  })
  return buckets
    .map((rows, i) => ({
      id: `default-bpm-${BPM_RANGES[i].from}`,
      name: BPM_RANGES[i].name,
      trackIds: rows.sort((a, b) => a.bpm - b.bpm || a.order - b.order).map((r) => r.id),
    }))
    .filter((p) => p.trackIds.length > 0)
}

/** The verified BPMs out of homemini's GET /api/bpm-key answer (`tracks` by id). */
export function verifiedBpmFrom(tracks: unknown): Map<number, number> {
  const out = new Map<number, number>()
  if (!tracks || typeof tracks !== 'object') return out
  for (const [k, v] of Object.entries(tracks as Record<string, unknown>)) {
    const e = v as { bpm?: unknown; bpmStatus?: unknown } | null
    const id = Number(k)
    if (!e || !Number.isInteger(id)) continue
    if (e.bpmStatus !== 'verified' && e.bpmStatus !== 'resolved') continue
    const bpm = Number(e.bpm)
    if (typeof e.bpm === 'number' && Number.isFinite(bpm) && bpm > 0) out.set(id, bpm)
  }
  return out
}

/** Which syncs this rule is for: the one Sync button per iPod, and nothing else.
 *  The whole-library mirror is not an iPod's own sync and keeps what it always wrote. */
export function playlistRuleApplies(origin: unknown): boolean {
  return origin === 'activity-click'
}

export interface DevicePlaylistInput {
  /** What the renderer handed the sync: the set, the evaluated built-ins, and
   *  the library's own playlists. */
  passed: ReadonlyArray<{ id?: unknown; name?: unknown; trackIds?: unknown }>
  /** The songs going on the iPod, in catalog order. */
  tracks: DeviceTrack[]
  year: number
  /** THE SWITCH. false (the default everywhere) = today's playlists keep being
   *  written and the new ones are added after them. true = only this iPod's own. */
  onlyOwn: boolean
  verifiedBpm: ReadonlyMap<number, number>
  /** On-The-Go read-backs, in the order they were numbered (1, 2, 3 …). */
  onTheGo: DevicePlaylist[]
  /** Every other playlist assigned to this iPod: AI ones Jake approved and the
   *  ones he made himself, mixed. Sorted here A to Z. */
  assigned: DevicePlaylist[]
  /** The app's ONE name-sort rule (renderer/utils/artistSort.ts compareNames):
   *  injected so this file stays a leaf and nobody writes another sort. */
  compareNames: (a: string, b: string) => number
}

export interface DevicePlaylistResult {
  playlists: DevicePlaylist[]
  /** New playlists this sync writes that the old rule never did (decades, BPM, On-The-Go, assigned). */
  added: string[]
  /** Switch ON: the library playlists this sync leaves off. */
  removed: string[]
  /** Switch OFF: the library playlists that WOULD be left off if it were on. Still written. */
  wouldRemove: string[]
}

const idsOf = (v: unknown): number[] =>
  Array.isArray(v) ? v.map((x) => Number(x)).filter((n) => Number.isInteger(n)) : []

/** Two names the iPod would show as one: the writer folds curly quotes and dashes
 *  (core/db_reader.py), and the menu is case-blind. */
const nameKey = (name: string): string =>
  name.trim().toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-')

/** THE playlist set for one iPod. */
export function devicePlaylistSet(input: DevicePlaylistInput): DevicePlaylistResult {
  const onIpod = new Set(input.tracks.map((t) => t.id))
  const total = input.tracks.length
  const clean = (ids: number[]): number[] => {
    const seen = new Set<number>()
    return ids.filter((id) => onIpod.has(id) && !seen.has(id) && (seen.add(id), true))
  }
  const worthWriting = (n: number): boolean => n > 0 && (total === 0 || n / total < NEARLY_ALL)

  const out: DevicePlaylist[] = []
  const usedNames = new Set<string>()
  const push = (p: DevicePlaylist, kind: DevicePlaylistKind): boolean => {
    const name = String(p.name || '').trim()
    if (!name || usedNames.has(nameKey(name))) return false
    usedNames.add(nameKey(name))
    out.push({ id: p.id, name, trackIds: p.trackIds, kind })
    return true
  }

  const builtinNames = builtinDefaultNames(input.year)
  const libraryNames: string[] = []
  const isSet = (p: { id?: unknown }): boolean => String(p?.id ?? '') === SET_PLAYLIST_ID

  if (!input.onlyOwn) {
    // Switch OFF: exactly what a sync wrote before this rule existed, in the
    // order it was handed over, untouched. (The writer drops ids not on the iPod.)
    for (const p of input.passed) {
      const name = String(p?.name ?? '').trim()
      const kind: DevicePlaylistKind = isSet(p) ? 'set' : builtinNames.includes(name) ? 'default' : 'library'
      // Not deduped, not cleaned: byte for byte what the writer was handed before.
      out.push({ id: String(p?.id ?? name), name, trackIds: idsOf(p.trackIds), kind })
      usedNames.add(nameKey(name))
      if (kind === 'library' && name) libraryNames.push(name)
    }
  } else {
    const passedByName = new Map<string, number[]>()
    for (const p of input.passed) {
      const name = String(p?.name ?? '').trim()
      if (isSet(p)) {
        const ids = clean(idsOf(p.trackIds))
        if (ids.length > 0) push({ id: SET_PLAYLIST_ID, name, trackIds: ids }, 'set')
        continue
      }
      if (builtinNames.includes(name)) {
        if (!passedByName.has(name)) passedByName.set(name, clean(idsOf(p.trackIds)))
        continue
      }
      if (name) libraryNames.push(name)
    }
    for (const name of builtinNames) {
      const ids = passedByName.get(name)
      if (ids && worthWriting(ids.length)) push({ id: `default-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, trackIds: ids }, 'default')
    }
  }

  const added: string[] = []
  const add = (p: DevicePlaylist, kind: DevicePlaylistKind): void => { if (push(p, kind)) added.push(p.name.trim()) }
  for (const p of [...decadePlaylists(input.tracks), ...bpmPlaylists(input.tracks, input.verifiedBpm)]) {
    if (worthWriting(p.trackIds.length)) add(p, 'default')
  }
  // On-The-Go and assigned playlists are Jake's own: written whenever any of
  // their songs is on the iPod, whatever share of it they are. An empty one
  // (none of its songs on this iPod) is never written.
  // Jake, 2026-11-13: "default playlists on top, on the go, then the per ipod
  // playlists in a to z order. same rules as we have for songs, artists albums".
  for (const p of input.onTheGo) {
    const ids = clean(idsOf(p.trackIds))
    if (ids.length > 0) add({ id: p.id, name: p.name, trackIds: ids }, 'on-the-go')
  }
  const rest = [...input.assigned].sort((a, b) => input.compareNames(a.name, b.name) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  for (const p of rest) {
    const ids = clean(idsOf(p.trackIds))
    if (ids.length > 0) add({ id: p.id, name: p.name, trackIds: ids }, 'assigned')
  }
  return {
    playlists: out,
    added,
    removed: input.onlyOwn ? libraryNames : [],
    wouldRemove: input.onlyOwn ? [] : libraryNames,
  }
}
