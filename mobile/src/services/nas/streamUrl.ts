// Builds an HTTP(S) URL the audio engine can stream from, given a
// desktop-authored Track.path. The desktop writes paths relative to a
// known NAS mount root (config.libraryRootPath) — we strip that prefix
// and append the rest to the configured transport's stream endpoint.

import type { NasConnectionConfig, Track } from '@/types'
import type { SynologyClient } from '@/services/nas/synologyClient'

function trimPrefix(path: string, prefix: string): string {
  if (!prefix) return path
  if (path.startsWith(prefix)) return path.slice(prefix.length).replace(/^\/+/, '')
  // Desktop paths may be macOS-absolute (/Volumes/Music/...) or already
  // server-relative. If the prefix doesn't match, return the path
  // as-is and let the caller handle the mismatch.
  return path
}

export function buildStreamUrl(
  client: SynologyClient,
  track: Track,
  config: NasConnectionConfig,
): string {
  const rel = trimPrefix(track.path, config.libraryRootPath)
  switch (config.transport) {
    case 'synology-audio-station': {
      // SYNO.AudioStation.Stream supports range requests, which
      // TrackPlayer's iOS native player needs for seek/scrub.
      // method=stream takes id; transcode=raw plays the original file.
      // For Phase 0 we use the simpler download endpoint of File
      // Station — Audio Station id-mapping requires a separate library
      // scan call we'll add when we wire real playback.
      return client.webapiUrl('SYNO.FileStation.Download', 'download', {
        path: encodeURI(`/${rel}`),
        mode: 'open',
      })
    }
    case 'webdav': {
      const scheme = config.https ? 'https' : 'http'
      const port = config.port ?? (config.https ? 5006 : 5005) // DSM WebDAV defaults
      const auth = encodeURIComponent(config.username)
      // Password is NOT URL-embedded — TrackPlayer source headers must
      // carry Basic auth instead. Caller is expected to attach the
      // header via the playback layer's `headers` option.
      return `${scheme}://${auth}@${config.host}:${port}/${rel}`
    }
    case 'auto':
      // Resolved at config save time. If we hit this branch, the
      // config wasn't normalized — fail loudly rather than guessing.
      throw new Error('streamUrl called with transport="auto" — normalize config first')
  }
}
