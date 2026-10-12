/**
 * 4.5.0-118 — New-music radar core (Discovery Brain Phase 2), pure + tested.
 *
 * The impure half (Exa search + claudeCall extraction) lives in the
 * get-new-music-radar IPC in index.ts; this is the deterministic half:
 * parse the LLM's candidate list, then rank it against the taste fingerprint
 * (drop owned, dedupe, score, sort). Pure so `node --test` drives it.
 */
import { scoreCandidateForRadar, norm } from './taste-model.ts'
import type { TasteFingerprint, TasteAnchor } from './taste-model.ts'
import { recoIdentityPairKey } from './reco-match.ts'
import { searchTitle } from './streamrip-match.ts'

export interface RawCandidate { artist?: string; title?: string; genre?: string; year?: string | number; why?: string; anchor?: string }
export interface RankedCandidate {
  artist: string
  title: string
  genre: string
  year: string
  why: string
  anchor?: string
  score: number
  reasons: string[]
}

/** Tolerant parse of the LLM's JSON candidate list (handles code fences /
 *  surrounding prose by extracting the first [...] array). */
export function parseCandidates(text: string): RawCandidate[] {
  if (!text) return []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence ? fence[1] : text).trim()
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(body.slice(start, end + 1))
    return Array.isArray(arr) ? (arr as RawCandidate[]) : []
  } catch {
    return []
  }
}

/** A Listen List row, as far as the radar's on-list guard reads it. */
export interface ListenListRow {
  song?: string
  artist?: string
  album?: string
  kind?: string
  matchedTitle?: string
  matchedArtist?: string
  matchedAlbum?: string
}

/** Does the list file this row under Albums? ⚠️ TWIN:
 *  renderer/listen-to-the-list/ltlDownload.ts recoKind ('album' or 'concert')
 *  and views/ListenToTheListView.tsx recoType — same rule, so the radar hides
 *  exactly the albums the list shows. */
function isAlbumRow(r: ListenListRow): boolean {
  if (r.kind === 'album' || r.kind === 'concert') return true
  const title = (r.matchedTitle || r.song || '').trim()
  const album = (r.matchedAlbum || r.album || '').trim()
  return !title && Boolean(album)
}

/**
 * The `isOnList` predicate for rankCandidates, built from the Listen List
 * rows: same song|artist identity the list itself keys by (raw fields first,
 * iTunes-matched as fallback). ⚠️ The key is SONG first — the radar hands us
 * (artist, title), so it must be flipped. index.ts passed (artist, title)
 * straight into a (song, artist) key and the guard never matched (2026-10-11).
 *
 * The radar's "title" is a RELEASE, so album rows key their album the same
 * way (album|artist, raw names, then the iTunes ones). A song row that names
 * its album doesn't hide the album — one saved song isn't the record.
 *
 * Albums compare WITHOUT edition words on both sides (searchTitle — the
 * same strip albumKey uses): "Rat Saw God (Deluxe Edition)" on the list
 * hides "Rat Saw God", and "- EP"/"- Single" fall away. "(Live)"/"(Remix)"
 * survive — those are other recordings. This is a hide-from-radar compare,
 * never stored; the persisted identity keys keep editions apart.
 */
export function listenListPredicate(records: ListenListRow[]): (artist: string, title: string) => boolean {
  const songKeys = new Set<string>()
  const albumKeys = new Set<string>()
  const albumKey = (album: string | undefined, artist: string | undefined): string | null =>
    recoIdentityPairKey(album && (searchTitle(album) || album), artist)
  const add = (set: Set<string>, k: string | null): void => { if (k) set.add(k) }
  for (const r of records) {
    add(songKeys, recoIdentityPairKey(r.song || r.matchedTitle, r.artist || r.matchedArtist))
    if (isAlbumRow(r)) {
      add(albumKeys, albumKey(r.album || r.matchedAlbum, r.artist || r.matchedArtist))
      add(albumKeys, albumKey(r.matchedAlbum, r.matchedArtist))
    }
  }
  return (artist, title) => {
    const song = recoIdentityPairKey(title, artist)
    if (song != null && songKeys.has(song)) return true
    const album = albumKey(title, artist)
    return album != null && albumKeys.has(album)
  }
}

/**
 * Rank raw candidates against the taste fingerprint: drop entries missing
 * artist/title, dedupe by artist+title, drop artists the user already OWNS
 * (this is discovery), drop anything already on the user's list (optional
 * `isOnList` predicate — keeps the radar from re-suggesting a saved jot),
 * score the rest, sort high→low, take top `limit`.
 */
export function rankCandidates(
  fp: TasteFingerprint,
  raw: RawCandidate[],
  limit = 12,
  isOnList?: (artist: string, title: string) => boolean,
  anchors: TasteAnchor[] = [],
): RankedCandidate[] {
  const seen = new Set<string>()
  const out: RankedCandidate[] = []
  for (const c of raw) {
    const artist = (c.artist ?? '').toString().trim()
    const title = (c.title ?? '').toString().trim()
    if (!artist || !title) continue
    const key = `${norm(artist)}|${norm(title)}`
    if (seen.has(key)) continue
    seen.add(key)
    if (isOnList && isOnList(artist, title)) continue
    const s = scoreCandidateForRadar(fp, { artist, genre: c.genre, year: c.year, anchor: c.anchor, why: c.why }, anchors)
    if (s.owned) continue
    out.push({
      artist,
      title,
      genre: (c.genre ?? '').toString().trim(),
      year: (c.year ?? '').toString().trim(),
      why: (c.why ?? '').toString().trim(),
      anchor: (c.anchor ?? '').toString().trim() || undefined,
      score: s.score,
      reasons: s.reasons,
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, Math.max(0, limit))
}
