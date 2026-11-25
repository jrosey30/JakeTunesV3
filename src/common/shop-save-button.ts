/**
 * The Save album button on a For You card that isn't on the Listening List
 * (Record Shop Phase 2): one click saves the album, with no trip to Search
 * and nothing added to the list, and the button then follows that save. Pure.
 */
export type SaveJobStatus = 'queued' | 'downloading' | 'done' | 'failed' | 'canceled'

export interface SaveButton {
  label: string
  /** A click saves (or, failed, saves again). */
  clickable: boolean
  /** The save was refused or failed: its one-tap offers show beside it. */
  failed: boolean
}

export function albumSaveButton(status: SaveJobStatus | undefined, waiting = false): SaveButton {
  if (waiting) return { label: 'Saving…', clickable: false, failed: false }
  switch (status) {
    case 'queued': return { label: 'Queued…', clickable: false, failed: false }
    case 'downloading': return { label: 'Saving…', clickable: false, failed: false }
    case 'done': return { label: 'In your library ✓', clickable: false, failed: false }
    case 'failed': return { label: 'Retry', clickable: true, failed: true }
    default: return { label: 'Save album', clickable: true, failed: false }
  }
}
