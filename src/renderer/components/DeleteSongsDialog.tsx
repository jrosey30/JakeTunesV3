/**
 * "Delete Song" from a song menu — the Songs view's confirmation, wording and
 * all, shared so the Home's song cards ask exactly the same question
 * (moved from SongsView, 2026-10-20). Confirm deletes from the library
 * (DELETE_TRACKS: every playlist too); either button closes it.
 */
import ConfirmDialog from './ConfirmDialog'
import { useLibrary } from '../context/LibraryContext'

export default function DeleteSongsDialog({ ids, onClose }: { ids: number[]; onClose: () => void }): JSX.Element {
  const { dispatch: libDispatch } = useLibrary()
  const count = ids.length
  return (
    <ConfirmDialog
      message={count === 1
        ? 'Are you sure you want to delete this song from your library?'
        : `Are you sure you want to delete ${count} songs from your library?`}
      detail="This will remove them from all playlists. This cannot be undone."
      confirmLabel="Delete"
      onConfirm={() => {
        libDispatch({ type: 'DELETE_TRACKS', ids })
        onClose()
      }}
      onCancel={onClose}
    />
  )
}
