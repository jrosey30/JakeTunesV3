/**
 * Where a song came from — the three "auto playlists" Jake asked for on
 * 2026-11-01: "an auto playlist that captures songs i import from tiktok,
 * another one for bandcamp and another through savant."
 *
 * Two track fields carry provenance:
 *   - `source`   — the STORE the desktop importer pulled the file from
 *                  ('bandcamp' | 'streamrip' | 'squid'; main/import-pipeline.ts
 *                  stamps it on the library row).
 *   - `addedVia` — how the song was ASKED for on the phone ('tiktok' |
 *                  'instagram' | 'savant' | 'search' | 'spotify' | …): the share
 *                  source of the Listen List row it came from. Whoever downloads
 *                  that row stamps it: homemini on the import row (JakeTunesMobile
 *                  backend util/streamrip.ts → mobileImports.ts), absorbed here
 *                  with the rest of the row; or this app on the library row
 *                  (renderer ltlDownload.ts recoOrigin → main/import-pipeline.ts).
 *
 * Order: newest import first (dateAdded desc), like Recently Added — these are
 * "what did I just bring in from X" lists. No cap. Pure and import-free so the
 * node test runner loads it directly.
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/sourcePlaylists.ts — homemini's copy
 * (the phone's built-in playlists). Same keys, same names, same predicates,
 * same order.
 */

export type SourcePlaylistKey = 'tiktok' | 'bandcamp' | 'savant'

export const SOURCE_PLAYLISTS: ReadonlyArray<{ key: SourcePlaylistKey; name: string }> = [
  { key: 'tiktok', name: 'TikTok' },
  { key: 'bandcamp', name: 'Bandcamp' },
  { key: 'savant', name: 'Savant' },
]

export function isSourcePlaylistKey(v: unknown): v is SourcePlaylistKey {
  return SOURCE_PLAYLISTS.some((p) => p.key === v)
}

export interface SourcedTrack {
  source?: string | null
  addedVia?: string | null
  dateAdded?: string | null
}

function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

/** Does this song belong on the `key` playlist? */
export function isFromSource(t: SourcedTrack, key: SourcePlaylistKey): boolean {
  if (norm(t.addedVia) === key) return true
  // A Bandcamp purchase lands through the desktop's own store: the file's `source`.
  return key === 'bandcamp' && norm(t.source) === 'bandcamp'
}

/** dateAdded desc. ISO strings compare lexically ('2026-10-31' and
 *  '2026-10-31T19:14:…' both occur); a missing date sinks. Stable for ties. */
export function byNewestAdded(a: SourcedTrack, b: SourcedTrack): number {
  return (b.dateAdded || '').localeCompare(a.dateAdded || '')
}

/** The playlist: every song from `key`, newest import first. */
export function sourcePlaylistTracks<T extends SourcedTrack>(tracks: readonly T[], key: SourcePlaylistKey): T[] {
  return tracks.filter((t) => isFromSource(t, key)).sort(byNewestAdded)
}

/** The phone's share sources, by key (what "via <Label>" notes say).
 *  ⚠️ TWIN: JakeTunesMobile backend/src/util/shareResolve.ts ADD_SOURCE_LABEL. */
export const ADD_SOURCE_LABEL: Record<string, string> = {
  spotify: 'Spotify', apple: 'Apple Music', youtube: 'YouTube', deezer: 'Deezer', shazam: 'Shazam',
  tiktok: 'TikTok', instagram: 'Instagram', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp',
  savant: 'Savant', search: 'Search',
}

/** A share source key as the phone sends it ('tiktok', 'savant', …): trimmed,
 *  lowercased, short and plain — or nothing.
 *  ⚠️ TWIN: JakeTunesMobile backend/src/util/sourcePlaylists.ts shareSourceKey. */
export function shareSourceKey(v: unknown): string | undefined {
  const s = norm(v)
  return s && /^[a-z][a-z0-9-]{1,30}$/.test(s) ? s : undefined
}

/** The share source key a Listen List row carries, as the imported row's
 *  `addedVia`: the row's own `via` (2026-11-01+), else the "via <Label>" note
 *  older rows carry. `labels` is ADD_SOURCE_LABEL.
 *  ⚠️ TWIN: JakeTunesMobile backend/src/util/sourcePlaylists.ts addedViaOf. */
export function addedViaOf(rec: { via?: string; note?: string }, labels: Record<string, string>): string | undefined {
  const via = shareSourceKey(rec.via)
  if (via) return via
  const m = /^via (.+)$/.exec((rec.note ?? '').trim())
  if (!m) return undefined
  return Object.entries(labels).find(([, label]) => label === m[1])?.[0]
}
