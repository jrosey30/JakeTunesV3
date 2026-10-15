/**
 * Star sidecar (mobile-stars.json) parse / merge — Brief 172.
 *
 * ⚠️ TWIN: JakeTunesMobile `backend/src/util/starSidecar.ts` implements
 * the same format and merge rule for the phone backend, and the star
 * section of `Dr. Claude/scripts/jaketunes-homemini-sync.sh` implements
 * it a third time in Python for the homemini-side merge. Change the
 * rule in one place, change it in all three.
 *
 * FORMAT v2: { v: 2, trackIds: [...], removed: {id: ts}, added: {id: ts} }
 *   - trackIds — the resolved star set (ids whose latest event is a star).
 *   - removed  — tombstones: id → epoch ms of the latest known un-star.
 *   - added    — id → epoch ms of the latest known star. OPTIONAL for
 *     readers (a v2 file without it still parses), but load-bearing for
 *     correctness: the brief's shape ({trackIds, removed}) alone cannot
 *     resolve "un-starred on the phone at t2, re-starred on the desktop
 *     at t3" — without an add timestamp there is nothing to compare the
 *     tombstone against, so every re-star after any un-star would lose.
 *     `added` is the minimal completion of the brief's last-writer-wins
 *     rule; unknown-field-tolerant readers (all of ours) ignore it.
 *
 * RESOLUTION (per id, last-writer-wins): an id is starred iff it is
 * asserted present (listed in trackIds or present in `added`) AND its
 * add time (0 when unknown — every legacy/v1 star) is >= its tombstone
 * time. So a tombstone beats a legacy star of unknown age, an explicit
 * re-star beats an older tombstone, and a newer tombstone beats an
 * older explicit star.
 *
 * BACKWARD-COMPATIBLE READ: v1 shapes — a bare array, or {trackIds}
 * with no maps — normalize to a state with empty maps (every listed id
 * is a legacy star). On first write the caller persists v2 (migration:
 * removals the old file never recorded stay unknown → removed = {}).
 *
 * History: v1 was ADDITIVE BY DESIGN (sync B-pass 2026-06-07) — a star
 * on either device survived every merge, so an un-starred track
 * resurrected on the next sync round-trip. Brief 172 removes that
 * ceiling; mergeStarIds below is kept as the v1-shaped wrapper.
 */

export interface StarSidecarData {
  v?: number
  trackIds: string[]
  removed?: Record<string, number>
  added?: Record<string, number>
}

export interface StarState {
  /** Resolved (currently starred) ids, sorted. */
  trackIds: string[]
  /** id → epoch ms of latest known un-star. */
  removed: Record<string, number>
  /** id → epoch ms of latest known star. */
  added: Record<string, number>
}

function cleanIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const x of raw) if (typeof x === 'string' && x) out.push(x)
  return out
}

function cleanTsMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k && typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
    }
  }
  return out
}

function isStarred(state: StarState, id: string, asserted: boolean): boolean {
  const removedTs = state.removed[id]
  if (!asserted) return false
  if (removedTs === undefined) return true
  return (state.added[id] ?? 0) >= removedTs
}

function buildState(listed: Set<string>, removed: Record<string, number>, added: Record<string, number>): StarState {
  const draft: StarState = { trackIds: Array.from(listed), removed, added }
  const candidates = new Set<string>([...listed, ...Object.keys(removed), ...Object.keys(added)])
  const trackIds: string[] = []
  for (const id of candidates) {
    if (isStarred(draft, id, listed.has(id) || added[id] !== undefined)) trackIds.push(id)
  }
  trackIds.sort()
  return { trackIds, removed, added }
}

/** Parse any historical sidecar shape into a resolved v2 state. Never throws. */
export function normalizeStarSidecar(raw: unknown): StarState {
  if (Array.isArray(raw)) {
    return buildState(new Set(cleanIds(raw)), {}, {})
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    return buildState(new Set(cleanIds(o['trackIds'])), cleanTsMap(o['removed']), cleanTsMap(o['added']))
  }
  return { trackIds: [], removed: {}, added: {} }
}

/**
 * Merge two sidecars (any mix of v1/v2) into one resolved v2 state.
 * Per id the newest add and the newest removal both survive; the
 * resolution rule above decides which one wins.
 */
export function mergeStarStates(a: StarState, b: StarState): StarState {
  const removed: Record<string, number> = { ...a.removed }
  for (const [k, v] of Object.entries(b.removed)) removed[k] = Math.max(removed[k] ?? 0, v)
  const added: Record<string, number> = { ...a.added }
  for (const [k, v] of Object.entries(b.added)) added[k] = Math.max(added[k] ?? 0, v)
  const listed = new Set<string>([...a.trackIds, ...b.trackIds])
  return buildState(listed, removed, added)
}

/** Apply one star/un-star event at time `ts` (epoch ms) to a state. */
export function applyStarChange(state: StarState, id: string, starred: boolean, ts: number): StarState {
  const removed = { ...state.removed }
  const added = { ...state.added }
  if (starred) added[id] = Math.max(added[id] ?? 0, ts)
  else removed[id] = Math.max(removed[id] ?? 0, ts)
  const listed = new Set<string>(state.trackIds)
  if (starred) listed.add(id)
  return buildState(listed, removed, added)
}

/** The on-disk v2 shape for a resolved state. */
export function starSidecarForWrite(state: StarState): StarSidecarData & { v: 2 } {
  return { v: 2, trackIds: [...state.trackIds].sort(), removed: { ...state.removed }, added: { ...state.added } }
}

/**
 * Legacy v1 wrapper (kept for the original call sites/tests): union of
 * two id lists. Equivalent to merging two tombstone-free states.
 */
export function mergeStarIds(local: string[], incoming: string[]): string[] {
  const a = normalizeStarSidecar(local)
  const b = normalizeStarSidecar(incoming)
  return mergeStarStates(a, b).trackIds
}
