/**
 * Pure history-stack logic for NavigationContext, extracted so the tricky
 * "new navigation vs back/forward landing" decision can be unit-tested (the
 * React context + effect that drive it can't be exercised headlessly).
 *
 * `view` is kept as a plain string here to stay dependency-free; the context
 * casts back to ViewName/SmartPlaylistId at dispatch time (every value stored
 * originated from those typed fields).
 */
export interface NavLocation {
  view: string
  playlistId: string | null
  smartPlaylistId: string | null
  artist: string | null
  albumKey: string | null
}

export interface NavHistory {
  history: NavLocation[]
  index: number
}

export function sameLoc(a: NavLocation | undefined, b: NavLocation | undefined): boolean {
  return (
    !!a && !!b &&
    a.view === b.view &&
    a.playlistId === b.playlistId &&
    a.smartPlaylistId === b.smartPlaylistId &&
    a.artist === b.artist &&
    a.albumKey === b.albumKey
  )
}

/**
 * Record a location change. If it equals the entry at the current index (a
 * back/forward landing, or a redundant re-dispatch), returns the SAME state
 * object unchanged (identity-comparable). Otherwise it's a NEW navigation:
 * drop any forward entries and push, capping the stack length.
 */
export function recordLocation(state: NavHistory, loc: NavLocation, max = 100): NavHistory {
  if (sameLoc(loc, state.history[state.index])) return state
  const next = state.history.slice(0, state.index + 1)
  next.push(loc)
  const trimmed = next.length > max ? next.slice(next.length - max) : next
  return { history: trimmed, index: trimmed.length - 1 }
}

export function canGoBack(state: NavHistory): boolean {
  return state.index > 0
}

export function canGoForward(state: NavHistory): boolean {
  return state.index < state.history.length - 1
}
