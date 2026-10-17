/**
 * What ⌘I (Get Info) opens in a track-list view.
 *
 * The selection wins: every selected row the view is showing, in list
 * order, with `index` at the first of them. With nothing selected IN THIS
 * LIST (the library selection is global, so ids from another view can
 * linger), fall back to the now-playing song — ⌘I while listening shows
 * the playing track's info instead of doing nothing.
 *
 * `index` points into `list` when the target is in it. A now-playing song
 * the view isn't showing comes back with `allTracks: [song]` so the modal's
 * prev/next walks just that one track instead of indexing a list it isn't in.
 */
export interface GetInfoTarget<T> {
  tracks: T[]
  index: number
  allTracks?: T[]
}

export function getInfoTarget<T extends { id: number }>(
  list: readonly T[],
  selectedIds: ReadonlySet<number>,
  nowPlaying: T | null | undefined,
): GetInfoTarget<T> | null {
  if (selectedIds.size > 0) {
    const selected = list.filter(t => selectedIds.has(t.id))
    if (selected.length > 0) {
      const idx = list.findIndex(t => selectedIds.has(t.id))
      return { tracks: selected, index: idx >= 0 ? idx : 0 }
    }
  }
  if (!nowPlaying) return null
  const idx = list.findIndex(t => t.id === nowPlaying.id)
  if (idx >= 0) return { tracks: [list[idx]], index: idx }
  return { tracks: [nowPlaying], index: 0, allTracks: [nowPlaying] }
}
