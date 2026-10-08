/**
 * MusicManDrawer — the Music Man as a companion: a narrow panel that slides
 * in from the right in the Up Next slot (2026-09-02). The 2008 iTunes Genius
 * sidebar is the ancestor: a panel that reacts to what's selected. This one
 * knows what's playing and which artist/playlist page is open, and sends
 * that with every question so the answer lands on the thing in front of you.
 *
 * The page (MusicManView) stays as the Brain — stats, analysis, the chat
 * archive. Same chat component underneath (MusicManChat), so nothing drifts.
 */
import { useState, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react'
import { usePlayback } from '../context/PlaybackContext'
import { useLibrary } from '../context/LibraryContext'
import MusicManChat from './MusicManChat'
import musicmanAvatar from '../assets/musicman-avatar.png'
import '../styles/musicman.css'
import '../styles/musicman-drawer.css'

export type MusicManDrawerHandle = { requestClose: () => void }

const MusicManDrawer = forwardRef<MusicManDrawerHandle, { onClose: () => void }>(function MusicManDrawer({ onClose }, ref) {
  const { state: pb } = usePlayback()
  const { state: lib } = useLibrary()
  const [exiting, setExiting] = useState(false)

  const requestClose = useCallback(() => {
    if (exiting) return
    setExiting(true)
    window.setTimeout(() => onClose(), 220)
  }, [exiting, onClose])
  useImperativeHandle(ref, () => ({ requestClose }), [requestClose])

  // What the listener is looking at, in plain words. Kept short — it rides
  // into the prompt on every message.
  const context = useMemo(() => {
    const parts: string[] = []
    const np = pb.nowPlaying
    if (np) parts.push(`${pb.isPlaying ? 'Playing' : 'Paused on'}: "${np.title}" by ${np.artist}${np.album ? ` (from ${np.album})` : ''}`)
    if (lib.currentView === 'artist-detail' && lib.activeArtist) parts.push(`Looking at the artist page for ${lib.activeArtist}`)
    else if (lib.currentView === 'playlist' && lib.activePlaylistId) {
      const pl = lib.playlists.find((p) => p.id === lib.activePlaylistId)
      if (pl) parts.push(`Looking at the playlist "${pl.name}" (${pl.trackIds.length} songs)`)
    } else if (lib.currentView === 'smart-playlist' && lib.activeSmartPlaylist) parts.push(`Looking at the "${lib.activeSmartPlaylist}" list`)
    else if (lib.currentView === 'mixtape-detail') parts.push('Looking at a mixtape')
    else if (lib.currentView === 'device') parts.push('Looking at the iPod page')
    return parts.join('. ')
  }, [pb.nowPlaying, pb.isPlaying, lib.currentView, lib.activeArtist, lib.activePlaylistId, lib.activeSmartPlaylist, lib.playlists])

  return (
    <div className={`mm-drawer ${exiting ? 'mm-drawer--exiting' : ''}`} role="complementary" aria-label="The Music Man">
      <div className="mm-drawer-head">
        <img src={musicmanAvatar} alt="" width="26" height="26" className="mm-drawer-avatar" />
        <span className="mm-drawer-title">The Music Man</span>
        <button className="mm-drawer-close" onClick={requestClose} title="Close" aria-label="Close">×</button>
      </div>
      {context && (
        <div className="mm-drawer-context" title="What he can see right now">
          <span className="mm-drawer-context-label">He sees</span>
          <span className="mm-drawer-context-text">{context}</span>
        </div>
      )}
      <MusicManChat variant="drawer" contextLine={context || undefined} />
    </div>
  )
})

export default MusicManDrawer
