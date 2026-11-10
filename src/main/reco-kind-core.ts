/**
 * What a jot IS, decided on the desktop before it leaves for the hub.
 *
 * 2026-09-05, live: a desktop add of "Little Creatures — Talking Heads" (album,
 * no song) went to the hub as {album, artist} and came back resolved to its
 * first song, so the list showed a song row and the Record Shop's album path
 * (edition selection before acquisition) never saw an album. The hub keeps
 * `kind` when told; the desktop simply never said. Pure, so the rule is
 * testable: an explicit kind wins; an album with no song is an album; a song
 * is a track; anything else (artist-only, note-only) stays unkinded.
 * ⚠️ TWIN: JakeTunesMobile/backend recommendations POST honours `kind` as-is.
 */
/** 'artist' and 'playlist' (2026-11-10) are never typed here: homemini sets
 *  them when it names a link a friend sent that is not one song.
 *  ⚠️ TWIN: JakeTunesMobile/backend/src/util/recoTypes.ts Recommendation.kind. */
export type RecoKind = 'track' | 'album' | 'concert' | 'artist' | 'playlist'

/** A row homemini named from a link: an artist, a playlist, or a page listed
 *  under its own title (note === link). It is taken as homemini wrote it —
 *  the iTunes enrichment would turn an artist into one of his songs. */
export function isHubNamedLink(r: { kind?: string; note?: string; link?: string }): boolean {
  return r.kind === 'artist' || r.kind === 'playlist' || (!!r.link && r.note === r.link)
}

export function recoKindForInput(input: { song?: string; album?: string; kind?: RecoKind }): RecoKind | undefined {
  if (input.kind) return input.kind
  const song = (input.song || '').trim(), album = (input.album || '').trim()
  if (song) return 'track'
  if (album) return 'album'
  return undefined
}

/** An album jot keeps the artist and album it was written with. The iTunes
 *  enrichment may add artwork, a preview and matched* hints, but it must not
 *  rename the record ("Bedouin — Desert Rose (Reimagined)" became "Sting &
 *  Bedouin — … [feat. Cheb Mami]" and the catalogue search that followed
 *  found Sting's records, live 2026-09-05). Tracks keep today's behaviour. */
export function preserveAlbumIdentity<T extends { kind?: string; artist?: string; album?: string; song?: string; matchedTitle?: string }>(record: T, input: { artist?: string; album?: string }): T {
  if (record.kind !== 'album') return record
  return { ...record, artist: input.artist?.trim() || record.artist, album: input.album?.trim() || record.album, song: undefined, matchedTitle: undefined }
}
