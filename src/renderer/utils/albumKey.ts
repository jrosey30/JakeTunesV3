/**
 * 4.5.0-73 — single source of truth for the canonical album key.
 *
 * Pre-fix every view that grouped tracks into albums (AlbumsView,
 * ArtistDetailView, the SearchPanel index) defined its own
 * `${artist}|||${album}` format. They diverged in two ways:
 *   - some used `t.artist` only, others used `t.albumArtist || t.artist`
 *   - some `normalize()`-stripped punctuation, others kept it
 *
 * Net effect Jake hit: search → album result → click → AlbumsView
 * couldn't find a matching album because the search key was built
 * differently than the AlbumsView key. User landed on the full grid
 * with nothing selected. "Embarrassing."
 *
 * Rule: every album-grouping operation in the renderer routes through
 * `albumKeyOf(track)`. Don't inline the format.
 */
interface AlbumKeyTrack {
  artist?: string
  albumArtist?: string
  album?: string
}

export function albumKeyOf(track: AlbumKeyTrack): string {
  const artist = (track.albumArtist || track.artist || 'Unknown Artist').toLowerCase().trim()
  const album = (track.album || 'Unknown').toLowerCase().trim()
  return `${artist}|||${album}`
}

/**
 * Build an album key from the displayed (artist, album) strings used
 * by Album objects in views. Mirror of albumKeyOf for situations where
 * we've already lifted the album-level artist + album name out of the
 * track set.
 */
export function albumKeyFromStrings(artist: string, album: string): string {
  return `${(artist || 'Unknown Artist').toLowerCase().trim()}|||${(album || 'Unknown').toLowerCase().trim()}`
}
