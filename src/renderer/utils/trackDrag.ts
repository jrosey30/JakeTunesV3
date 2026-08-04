/**
 * Dragging songs onto a playlist, from anywhere.
 *
 * The drop side has existed for a while — SidebarItem accepts
 * `application/jaketunes-tracks` (a JSON array of track ids) and dispatches
 * ADD_TRACKS_TO_PLAYLIST. What was missing is that only some views bothered to
 * PUT that payload on the drag, so the same gesture worked in Songs and Albums
 * and did nothing in Daily Mixes, Artists, Discovery or Concerts.
 *
 * This is the one place that writes the payload, so every list agrees on the
 * format and on the selection rule. Copy-pasting `dataTransfer.setData` into
 * each view is how they drifted apart in the first place.
 *
 * ⚠️ TWIN: src/renderer/components/sidebar/SidebarItem.tsx reads this exact MIME
 * type, as does components/playback/QueuePanel.tsx. Changing the string here
 * without changing it there silently breaks every drop target.
 */

export const TRACK_DRAG_TYPE = 'application/jaketunes-tracks'

/**
 * Put a set of track ids on a drag.
 *
 * `dragged` is the row the user actually grabbed; `selectedIds` is the current
 * multi-selection if the view has one. Dragging a row INSIDE the selection
 * carries the whole selection (what every file manager does); dragging a row
 * outside it carries just that row, because grabbing an unselected item and
 * getting somebody else's selection is a nasty surprise.
 */
export function setTrackDragPayload(
  e: React.DragEvent,
  draggedId: number,
  selectedIds?: Iterable<number> | null,
): number[] {
  const sel = selectedIds ? Array.from(selectedIds) : []
  const ids = sel.length > 1 && sel.includes(draggedId) ? sel : [draggedId]
  e.dataTransfer.setData(TRACK_DRAG_TYPE, JSON.stringify(ids))
  // text/plain as a courtesy for anything outside the app; harmless here, and
  // some drop targets refuse a drag that carries no recognised text flavour.
  e.dataTransfer.setData('text/plain', String(ids.length))
  e.dataTransfer.effectAllowed = 'copy'
  return ids
}

/**
 * Put a whole album (or any pre-ordered run of tracks) on a drag.
 *
 * Separate from setTrackDragPayload because there is no "dragged row" and no
 * selection to reconcile — the caller already knows the exact list and its
 * order, and that order matters: a playlist built from a dragged album should
 * read the way the record does.
 */
export function setAlbumDragPayload(e: React.DragEvent, ids: number[]): void {
  if (ids.length === 0) return
  e.dataTransfer.setData(TRACK_DRAG_TYPE, JSON.stringify(ids))
  e.dataTransfer.setData('text/plain', String(ids.length))
  e.dataTransfer.effectAllowed = 'copy'
}
