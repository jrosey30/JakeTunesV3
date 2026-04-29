// Maps a JakeTunes Track to a TrackPlayer Track. Stream URL is built
// per-track at queue time so transport headers (Basic auth for WebDAV,
// _sid for Audio Station) are fresh — never cached on the model.
//
// ⚠️ Unit contract: This is the boundary between two unit systems.
//   • JakeTunes `Track.duration` is MILLISECONDS (src/main/index.ts
//     stores `durationMs` into that field). All cross-platform JSON
//     and the desktop's display layer treat it as ms.
//   • react-native-track-player's `Track.duration` is SECONDS, and
//     `useProgress()` returns position/duration in SECONDS too.
// The conversion happens HERE (ms → s on the way in) and in
// NowPlayingView (s → ms on the way out, for formatDuration). Don't
// add a third site — every conversion is a chance to forget one.

import type { Track as TPTrack } from 'react-native-track-player'
import type { NasConnectionConfig, Track } from '@/types'
import type { SynologyClient } from '@/services/nas/synologyClient'
import { buildStreamUrl } from '@/services/nas/streamUrl'

export function trackToTrackPlayer(
  client: SynologyClient,
  config: NasConnectionConfig,
  track: Track,
): TPTrack {
  const url = buildStreamUrl(client, track, config)
  const tp: TPTrack = {
    id: String(track.id),
    url,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    // ms → s for TrackPlayer.
    duration: track.duration > 0 ? track.duration / 1000 : 0,
    // artwork is filled by the library context once we wire art
    // fetching against Audio Station's cover endpoint.
  }
  // WebDAV transport requires Basic auth via headers. The password is
  // applied at playback-context level where it's pulled from Keychain.
  // Leaving an empty headers object here makes the seam explicit so
  // the eventual real value lands in one place.
  if (config.transport === 'webdav') {
    tp.headers = {}
  }
  return tp
}
