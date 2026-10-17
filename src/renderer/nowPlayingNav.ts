// ⌘L "Go to Current Song" from a view that isn't Songs: App switches to Songs
// and leaves this flag up; SongsView takes it once it has mounted and its
// scroll restore has run, then scrolls to + selects the playing track.
// A module flag (same idea as concertNav.ts) because the pending-key fields
// live in the do-not-touch LibraryContext reducer.
let pending = false

export function requestShowNowPlaying(): void {
  pending = true
}
export function hasPendingShowNowPlaying(): boolean {
  return pending
}
/** Read-and-clear — exactly one consumer acts on a request. */
export function takePendingShowNowPlaying(): boolean {
  const p = pending
  pending = false
  return p
}
