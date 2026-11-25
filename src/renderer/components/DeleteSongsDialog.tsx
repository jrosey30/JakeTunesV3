/**
 * "Delete Song" from a song menu or the Delete key — one confirmation for every
 * song list and the Home's song cards (moved from SongsView, 2026-10-20; the
 * words are utils/songTableRules.ts deleteSongsWording). Confirm deletes from the library
 * (DELETE_TRACKS: every playlist too); either button closes it.
 */
import ConfirmDialog from './ConfirmDialog'
import { useLibrary } from '../context/LibraryContext'
import { deleteSongsWording } from '../utils/songTableRules'

export default function DeleteSongsDialog({ ids, onClose }: { ids: number[]; onClose: () => void }): JSX.Element {
  const { dispatch: libDispatch } = useLibrary()
  // Right for one or many (V7: it said "them" for one song).
  const { message, detail } = deleteSongsWording(ids.length)
  return (
    <ConfirmDialog
      message={message}
      detail={detail}
      confirmLabel="Delete"
      onConfirm={() => {
        libDispatch({ type: 'DELETE_TRACKS', ids })
        onClose()
      }}
      onCancel={onClose}
    />
  )
}
