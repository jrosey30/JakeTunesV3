// Which MusicBrainz release stands for an album, and which releases Jake
// has ruled out of an artist's discography.
//
// 2026-10-20, Jake on the workmini Geese page: "why is my workmini have 3d
// country like this what a nightmare!!!" The fetch took whichever release
// MusicBrainz listed first for a release group. For 3D Country that was an
// unofficial three-disc bundle (the album + 3 covers + 9 live songs), and
// all three discs were concatenated into one tracklist. MusicBrainz's own
// order is not "the album": the bundle is the group's EARLIEST release, so
// "earliest" can't be the rule either.

export type MbReleaseLite = {
  status?: string | null
  date?: string
  disambiguation?: string
  media?: Array<{ tracks?: unknown[] | null }>
}

function trackCount(r: MbReleaseLite): number {
  return (r.media || []).reduce((n, m) => n + (m.tracks?.length || 0), 0)
}

/// The plain edition: Official releases first (bundles and bootlegs carry
/// no status), then the fewest tracks (deluxe and bonus editions only ever
/// add), then a release with no edition note ("24-Bit", "deluxe"), then the
/// earliest date. Releases with no tracks don't count.
export function pickStandardRelease<R extends MbReleaseLite>(releases: readonly R[] | null | undefined): R | null {
  const withTracks = (releases || []).filter((r) => trackCount(r) > 0)
  if (withTracks.length === 0) return null
  const official = withTracks.filter((r) => (r.status || '').toLowerCase() === 'official')
  const pool = official.length > 0 ? official : withTracks
  return [...pool].sort((a, b) =>
    trackCount(a) - trackCount(b)
    || Number(!!a.disambiguation) - Number(!!b.disambiguation)
    || (a.date || '9999').localeCompare(b.date || '9999'),
  )[0]!
}

// Jake's hidden releases (HIDDEN_RELEASES / isHiddenRelease) moved to
// common/release-gate.ts on 2026-10-20: the gate is the one place a release
// is admitted or turned away.
