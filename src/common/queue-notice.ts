/**
 * The one line the app says after "Play Next" / "Add to Up Next" from a
 * context menu (approved by Jake). Before this both were silent at
 * every call site — the queue changed with no sign anything happened.
 * One song names itself; several say how many.
 *
 * Drag-drops onto the queue stay quiet on purpose (Jake 9/2: "it should
 * just work" — the panel itself is the feedback); this is menu-only.
 */
export type QueueMode = 'next' | 'later'

export function queueNoticeText(mode: QueueMode, tracks: readonly { title?: string; artist?: string }[]): string {
  const head = mode === 'next' ? 'Playing next' : 'Added to Up Next'
  if (tracks.length === 1) {
    const t = tracks[0]
    const title = (t.title || '').trim() || 'Untitled'
    const artist = (t.artist || '').trim()
    return `${head}: ${title}${artist ? ` — ${artist}` : ''}`
  }
  return `${head}: ${tracks.length} songs`
}
