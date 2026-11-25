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

/**
 * After a save from the card: the job it now follows, and a failed job to
 * drop because this save answered it with another edition (review of #486:
 * the red count clears). Never drops a job that isn't failed, or the one
 * just saved. Pure.
 */
export function followSave(prevKey: string | null, prevStatus: SaveJobStatus | undefined, newKey: string | undefined): { key: string | null; drop: string | null } {
  if (!newKey) return { key: prevKey, drop: null }
  const drop = prevKey && prevKey !== newKey && prevStatus === 'failed' ? prevKey : null
  return { key: newKey, drop }
}
