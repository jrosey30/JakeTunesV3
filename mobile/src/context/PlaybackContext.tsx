// Playback state, owned by TrackPlayer. This context is a thin React
// wrapper exposing imperative play/pause/skip + a reactive snapshot of
// what's currently playing. The actual audio engine lives in a
// background JS context (services/playback/playbackService.ts).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import TrackPlayer, {
  Event,
  State,
  useActiveTrack,
  usePlaybackState,
  useProgress,
} from 'react-native-track-player'
import type { Track } from '@/types'
import { ensureTrackPlayerReady } from '@/services/playback/trackPlayerSetup'
import { trackToTrackPlayer } from '@/services/playback/queueAdapter'
import { useConnection } from '@/context/ConnectionContext'

interface PlaybackContextValue {
  ready: boolean
  isPlaying: boolean
  position: number
  duration: number
  activeTrackId: number | null
  playTracks: (tracks: Track[], startIndex?: number) => Promise<void>
  togglePlay: () => Promise<void>
  next: () => Promise<void>
  previous: () => Promise<void>
  seekTo: (seconds: number) => Promise<void>
}

const Ctx = createContext<PlaybackContextValue | null>(null)

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const { client, config } = useConnection()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void ensureTrackPlayerReady().then(() => setReady(true))
  }, [])

  // The end-of-track hook for queueing play-count overrides. A natural
  // PlaybackQueueEnded means "the active track played to its natural
  // end" — that's the desktop's lastPlayedAt signal. Skip-ended plays
  // come through PlaybackActiveTrackChanged with a position that's
  // meaningfully short of duration.
  useEffect(() => {
    if (!ready) return
    const sub = TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => {
      // Phase 0 stub: enqueue an override into storage. A future
      // sync-to-desktop step drains the queue.
    })
    return () => sub.remove()
  }, [ready])

  const playbackState = usePlaybackState()
  const activeTrack = useActiveTrack()
  const progress = useProgress(500)

  const playTracks = useCallback(
    async (tracks: Track[], startIndex = 0) => {
      if (!client || !config) {
        throw new Error('Cannot play: NAS not configured')
      }
      const tpTracks = tracks.map((t) => trackToTrackPlayer(client, config, t))
      await TrackPlayer.reset()
      await TrackPlayer.add(tpTracks)
      if (startIndex > 0) await TrackPlayer.skip(startIndex)
      await TrackPlayer.play()
    },
    [client, config],
  )

  const togglePlay = useCallback(async () => {
    const s = await TrackPlayer.getPlaybackState()
    if (s.state === State.Playing) await TrackPlayer.pause()
    else await TrackPlayer.play()
  }, [])

  const next = useCallback(() => TrackPlayer.skipToNext(), [])
  const previous = useCallback(() => TrackPlayer.skipToPrevious(), [])
  const seekTo = useCallback((s: number) => TrackPlayer.seekTo(s), [])

  const value = useMemo<PlaybackContextValue>(
    () => ({
      ready,
      isPlaying: playbackState.state === State.Playing,
      position: progress.position,
      duration: progress.duration,
      activeTrackId: activeTrack?.id != null ? Number(activeTrack.id) : null,
      playTracks,
      togglePlay,
      next,
      previous,
      seekTo,
    }),
    [ready, playbackState.state, progress.position, progress.duration, activeTrack?.id, playTracks, togglePlay, next, previous, seekTo],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePlayback(): PlaybackContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePlayback must be used inside <PlaybackProvider>')
  return v
}
