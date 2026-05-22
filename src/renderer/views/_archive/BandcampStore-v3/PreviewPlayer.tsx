import { useEffect, useRef, useState, useCallback } from 'react'
import { Howl } from 'howler'
import { usePlayback } from '../../context/PlaybackContext'

/**
 * 30-second preview playback for the Store. One Howl at a time. Starting a
 * preview pauses the main player (CLAUDE.md: preview must not fight live
 * playback); stopping/unmounting fully tears the Howl down (cancel reverses
 * start — unload, clear ref, clear state).
 */
export function usePreviewPlayer() {
  const { state, dispatch } = usePlayback()
  const howlRef = useRef<Howl | null>(null)
  const [playingUrl, setPlayingUrl] = useState<string | null>(null)

  const stop = useCallback(() => {
    if (howlRef.current) {
      howlRef.current.stop()
      howlRef.current.unload()
      howlRef.current = null
    }
    setPlayingUrl(null)
  }, [])

  const toggle = useCallback((url: string | undefined) => {
    if (!url) return
    if (playingUrl === url) { stop(); return }
    // pause the main player so the two don't overlap
    if (state.isPlaying) dispatch({ type: 'PAUSE' })
    stop()
    const howl = new Howl({ src: [url], html5: true, format: ['mp3'] })
    howl.on('end', () => stop())
    howl.on('loaderror', () => stop())
    howl.on('playerror', () => stop())
    howl.play()
    howlRef.current = howl
    setPlayingUrl(url)
  }, [playingUrl, state.isPlaying, dispatch, stop])

  // Tear down on unmount.
  useEffect(() => stop, [stop])

  return { playingUrl, toggle, stop }
}
