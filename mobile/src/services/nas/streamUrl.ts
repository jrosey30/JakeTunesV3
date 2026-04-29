// Builds an HTTP(S) URL the audio engine can stream from, given a
// desktop-authored Track.path.
//
// ⚠️ Path-format contract:
//   - The desktop's library-snapshot exporter writes Track.path as
//     SLASH-separated, NO leading slash, e.g.
//         "iPod_Control/Music/F12/ABCD.m4a"
//     (See src/main/library-snapshot.ts::colonPathToSlashRelative.)
//   - This module PREPENDS `config.libraryRootPath` (the NAS-side
//     prefix where the user's music share lives, e.g. "/music") to
//     produce the absolute NAS path the transport API expects.
//   - The opposite direction was attempted in an earlier draft (strip
//     a prefix from an already-absolute path). That contract is
//     wrong: the snapshot format does NOT include a prefix to strip.
//     Don't reintroduce a strip step here without changing the
//     exporter contract on the desktop side first.
//
// ⚠️ TWIN: src/main/library-snapshot.ts (the producer of these
// paths). When that exporter changes the path shape, this builder
// must change in the same commit.

import type { NasConnectionConfig, Track } from '@/types'
import type { SynologyClient } from '@/services/nas/synologyClient'

// Join the NAS prefix to the snapshot's slash-relative path, normalizing
// adjacent / leading slashes so we always emit exactly one separator.
function joinNasPath(prefix: string, rel: string): string {
  const p = (prefix || '').replace(/\/+$/, '')
  const r = (rel || '').replace(/^\/+/, '')
  return p ? `${p}/${r}` : `/${r}`
}

export function buildStreamUrl(
  client: SynologyClient,
  track: Track,
  config: NasConnectionConfig,
): string {
  const absolute = joinNasPath(config.libraryRootPath, track.path)
  switch (config.transport) {
    case 'synology-audio-station': {
      // SYNO.AudioStation.Stream supports range requests, which
      // TrackPlayer's iOS native player needs for seek/scrub.
      // method=stream takes id; transcode=raw plays the original file.
      // For Phase 0 we use the simpler download endpoint of File
      // Station — Audio Station id-mapping requires a separate library
      // scan call we'll add when we wire real playback.
      return client.webapiUrl('SYNO.FileStation.Download', 'download', {
        path: encodeURI(absolute),
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
      // absolute already starts with '/' from joinNasPath when prefix
      // is empty, or is "/<prefix>/<rel>" otherwise; encode each
      // segment so spaces / unicode survive.
      const encoded = absolute.split('/').map((seg) => encodeURIComponent(seg)).join('/')
      return `${scheme}://${auth}@${config.host}:${port}${encoded}`
    }
    case 'auto':
      // Resolved at config save time. If we hit this branch, the
      // config wasn't normalized — fail loudly rather than guessing.
      throw new Error('streamUrl called with transport="auto" — normalize config first')
  }
}
