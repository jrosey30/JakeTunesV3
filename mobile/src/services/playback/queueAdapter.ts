// Maps a JakeTunes Track to a TrackPlayer Track. Stream URL is built
// per-track at queue time so transport headers (Basic auth for WebDAV,
// _sid for Audio Station) are fresh.

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
    duration: track.duration,
    // artwork is filled by the library context once we wire art
    // fetching against Audio Station's cover endpoint.
  }
  // WebDAV transport requires Basic auth via headers.
  if (config.transport === 'webdav') {
    // The password is applied at playback-context level where it's
    // pulled from Keychain. Leaving the property here makes the seam
    // explicit so the eventual real value lands in one place.
    tp.headers = {}
  }
  return tp
}
