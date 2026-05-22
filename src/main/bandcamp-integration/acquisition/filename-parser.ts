// ════════════════════════════════════════════════════════════════════════
//  Filename fallback parser (Brief 036 v2.2, Layer 4)
//
//  music-metadata tags (read inside importOneFile) are the PRIMARY source
//  of artist/album/title/track#. This parser is a fallback for the rare
//  case a Bandcamp file ships with sparse tags. Bandcamp album-zip members
//  are typically named "<Artist> - <Album> - <NN> <Title>.<ext>"; single
//  tracks "<Artist> - <Title>.<ext>".
// ════════════════════════════════════════════════════════════════════════

export interface ParsedName {
  trackNumber?: number
  artist?: string
  album?: string
  title?: string
}

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|alac|wav|aiff|aif|ogg)$/i

export function parseFilename(filename: string): ParsedName {
  const base = filename.replace(/^.*[/\\]/, '').replace(AUDIO_EXT, '')
  const parts = base.split(' - ').map((s) => s.trim()).filter(Boolean)

  // "<Artist> - <Album> - <NN> <Title>"
  if (parts.length >= 3) {
    const last = parts[parts.length - 1]
    const m = last.match(/^(\d{1,3})[.\s]+(.*)$/)
    return {
      artist: parts[0],
      album: parts.slice(1, -1).join(' - '),
      trackNumber: m ? Number(m[1]) : undefined,
      title: m ? m[2] : last,
    }
  }
  // "<Artist> - <Title>" (optionally "NN Title")
  if (parts.length === 2) {
    const m = parts[1].match(/^(\d{1,3})[.\s]+(.*)$/)
    return {
      artist: parts[0],
      trackNumber: m ? Number(m[1]) : undefined,
      title: m ? m[2] : parts[1],
    }
  }
  return { title: base }
}
