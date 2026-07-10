// Which concert the 'concert-detail' view is showing. A tiny module store so
// ConcertsView can hand the albumKey to ConcertDetailView without touching the
// do-not-touch LibraryContext reducer (concerts are their own thing, routed via
// the generic SET_VIEW).
let currentConcertKey = ''
const listeners = new Set<() => void>()

export function setConcertKey(albumKey: string): void {
  currentConcertKey = albumKey
  for (const l of listeners) l()
}
export function getConcertKey(): string {
  return currentConcertKey
}
export function subscribeConcertKey(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
