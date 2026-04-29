// react-native-track-player background service. Registered in index.js
// via TrackPlayer.registerPlaybackService — runs in a separate JS
// context with no React tree, so it can ONLY use TrackPlayer APIs and
// any pure utilities. No hooks, no contexts.
//
// In addition to remote-control wiring, this service is the single
// source of truth for "did the user actually finish a song?" — it
// listens for PlaybackActiveTrackChanged and classifies the OUTGOING
// track as natural-completion vs skip vs partial-listen, then
// enqueues an override via services/overrides/queue. The classifier
// runs even when the app is backgrounded (lock-screen play, AirPlay,
// CarPlay) which is exactly when we want it to.

import TrackPlayer, { Event } from 'react-native-track-player'
import { recordPlayCompletion } from '@/services/overrides/queue'
import type { JakeTunesTPExtras } from './queueAdapter'

// Treat anything within this many seconds of the duration as "natural
// completion." Real audio files often report duration slightly off
// from where TrackPlayer's onend fires; 2s avoids false negatives on
// otherwise-completed plays.
const NATURAL_END_TOLERANCE_S = 2

export async function playbackService(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play())
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause())
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext())
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious())
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop())
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) => TrackPlayer.seekTo(position))
  TrackPlayer.addEventListener(Event.RemoteJumpForward, ({ interval }) =>
    TrackPlayer.seekBy(interval ?? 15),
  )
  TrackPlayer.addEventListener(Event.RemoteJumpBackward, ({ interval }) =>
    TrackPlayer.seekBy(-(interval ?? 15)),
  )

  // Active-track-changed fires when playback advances (natural end →
  // next), when the user skips, or when the user picks a new track.
  // The event payload's `lastTrack` + `lastPosition` describe the
  // OUTGOING track — exactly what we need to classify the previous
  // play. (TrackPlayer durations are SECONDS in this context — see
  // mobile/README.md "Unit contracts".)
  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async (event) => {
    const last = event.lastTrack as (typeof event.lastTrack & Partial<JakeTunesTPExtras>) | undefined
    const lastPosition = event.lastPosition ?? 0
    const lastDurationS = (last?.duration as number | undefined) ?? 0
    if (!last || !last.jakeTrackId) return  // no prior track or not one we own
    if (lastDurationS <= 0) return            // unknown duration — can't classify
    const reachedEnd = lastPosition >= lastDurationS - NATURAL_END_TOLERANCE_S
    if (reachedEnd) {
      try {
        await recordPlayCompletion({
          trackId: last.jakeTrackId,
          audioFingerprint: last.audioFingerprint,
        })
      } catch (err) {
        console.warn('[overrides] failed to record completion:', err)
      }
    }
    // Skip-detection (lastPosition < 30) is intentionally NOT enqueued
    // in Phase 0 — desktop's skip semantics gate on "first 30s" but
    // also require the track to have been STARTED, not just queued
    // and skipped. Sorting that out needs more event correlation;
    // deferring until we have real test data from a Mac dev loop.
  })

  // PlaybackQueueEnded fires when the queue runs out. The final
  // track's natural completion isn't covered by ActiveTrackChanged
  // (since there's no successor track), so handle it here.
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, async (event) => {
    const track = event.track as (typeof event.track & Partial<JakeTunesTPExtras>) | undefined
    const position = event.position ?? 0
    const durationS = (track?.duration as number | undefined) ?? 0
    if (!track || !track.jakeTrackId || durationS <= 0) return
    if (position >= durationS - NATURAL_END_TOLERANCE_S) {
      try {
        await recordPlayCompletion({
          trackId: track.jakeTrackId,
          audioFingerprint: track.audioFingerprint,
        })
      } catch (err) {
        console.warn('[overrides] failed to record final completion:', err)
      }
    }
  })
}
