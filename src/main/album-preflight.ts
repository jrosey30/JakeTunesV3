/**
 * The album preflight's judge (Brief 255): does Qobuz have THIS edition, as
 * the walk in streamrip-store/index.ts would see it, before anything
 * downloads?
 *
 * It reads Qobuz's own listings of the candidates the walk would rank and
 * holds each to the SAME identity contract (album-identity.ts
 * verifyAlbumCandidate, unchanged). It mirrors the walk's choices and no
 * more: the explicit gate when the row is explicit, explicit-first
 * otherwise, and the first three candidates (the walk stages at most three).
 * Where the walk would look at something this didn't, the answer is
 * "unknown" and the walk runs as it always has.
 *
 * What it adds that the walk can't know before a byte moves: a listed track
 * Qobuz can't stream. streamrip skips those, so the walk would download the
 * rest of the album and then refuse it as incomplete.
 *
 * Pure: listings in, an answer out. The wiring is streamrip-store/index.ts
 * ('check-qobuz-album').
 */
import { packagingMarkersOf, verifyAlbumCandidate, albumAlternativeDesc, type CandidateAlbum, type RequestedAlbum, type AlbumVerdict } from './album-identity.ts'
import { parseStreamripDesc, titleReads, unwantedVersionOf } from './streamrip-match.ts'
import type { AlbumPreflight } from '../common/album-preflight.ts'
import type { Alternative } from '../common/acquisition-identity.ts'

/** One candidate the walk would rank, with Qobuz's own listing of it. */
export interface PreflightListing {
  cand: CandidateAlbum
  /** Tracks in the listing, and how many of them Qobuz says can be streamed. */
  listed: number
  streamable: number
}

/** The listing as the walk's albumListing reads it (streamrip-store/index.ts). */
export interface QobuzListingLike {
  title?: string; artist?: string; version?: string | null; tracksCount?: number; mediaCount?: number; upc?: string
  releaseYear?: number; parentalWarning?: boolean
  tracks: Array<{ title: string; durationSec?: number; streamable?: boolean; trackNumber?: number; discNumber?: number }>
}

/** ⚠️ TWIN: streamrip-store/index.ts albumListing (inside the walk). */
export function listingCandidate(hit: { id: string; desc: string }, tl: QobuzListingLike): PreflightListing {
  const parsed = parseStreamripDesc(hit.desc)
  return {
    cand: {
      provider: 'qobuz', desc: hit.desc, id: hit.id,
      title: tl.title ?? parsed.title, artist: tl.artist ?? parsed.artist, version: tl.version ?? null,
      trackCount: tl.tracksCount ?? (tl.tracks.length || undefined), discCount: tl.mediaCount,
      tracks: tl.tracks.length ? tl.tracks.map((t) => ({ title: t.title, trackNumber: t.trackNumber, discNumber: t.discNumber, durationSec: t.durationSec })) : undefined,
      releaseYear: tl.releaseYear, upc: tl.upc, parentalWarning: tl.parentalWarning,
    },
    listed: tl.tracks.length,
    streamable: tl.tracks.filter((t) => t.streamable !== false).length,
  }
}

const PACKAGING_WORDS: Record<string, string> = {
  bonus: 'bonus track edition', deluxe: 'Deluxe', expanded: 'Expanded edition', anniversary: 'anniversary edition',
  special: 'special edition', collector: 'collector’s edition', legacy: 'Legacy edition', super: 'Super Deluxe',
  complete: 'complete edition', definitive: 'definitive edition', ultimate: 'ultimate edition', redux: 'Redux',
}

/** What Qobuz has instead, in words that fit "Only the … is on Qobuz", or null. */
export function otherEditionWords(req: RequestedAlbum, cand: CandidateAlbum, v: AlbumVerdict): string | null {
  if (v.verdict !== 'reject') return null
  if (v.kind === 'explicit') return 'clean edition'
  if (v.kind === 'version') {
    const marker = (cand.title ? unwantedVersionOf(req.title, cand.title) : null) || (cand.version ? unwantedVersionOf(req.title, cand.version) : null)
    return marker ? `${marker} version` : null
  }
  const theirs = packagingMarkersOf(cand.title || '', cand.version).filter((m) => !req.packaging.includes(m))
  if (!theirs.length) return null
  if (theirs.includes('super')) return PACKAGING_WORDS.super
  return PACKAGING_WORDS[theirs[0]] ?? null
}

const alternativeOf = (cand: CandidateAlbum, reason: string): Alternative => {
  const tracks = cand.tracks?.map((t) => ({ title: t.title, trackNumber: t.trackNumber, discNumber: t.discNumber, durationSec: t.durationSec ?? null }))
  return { provider: 'qobuz', desc: albumAlternativeDesc(cand), reason, tracks, trackCount: cand.trackCount ?? tracks?.length }
}

/**
 * The answer. `listings` are the walk's ranked candidates (Qobuz's 404s left
 * out) in rank order; `beyond` says the walk ranked more than the listings
 * cover; `rejectedVersions` are the search hits the ranking set aside as
 * other versions of the record.
 */
export function judgeQobuzAlbum(req: RequestedAlbum, o: { listings: readonly PreflightListing[]; rejectedVersions?: readonly string[]; explicitSource?: boolean; beyond?: boolean }): AlbumPreflight {
  let pool = [...o.listings]
  // The walk's explicit gate (an explicit row) and explicit-first (any other row).
  if (o.explicitSource) {
    const kept = pool.filter((l) => l.cand.parentalWarning !== false)
    if (kept.length === 0 && pool.length > 0 && !o.beyond) {
      return { answer: 'no', why: 'clean-only', alternatives: pool.map((l) => alternativeOf(l.cand, 'is the clean edition; this record is explicit')) }
    }
    pool = kept
  } else if (pool.some((l) => l.cand.parentalWarning === true && verifyAlbumCandidate(req, l.cand).verdict !== 'reject')) {
    pool = pool.filter((l) => l.cand.parentalWarning !== false)
  }
  const considered = pool.slice(0, 3)
  // The walk would reach candidates these listings don't cover.
  if (considered.length < 3 && o.beyond) return { answer: 'unknown', why: 'unsure' }

  if (considered.length === 0) {
    const rv = (o.rejectedVersions ?? []).map((d) => unwantedVersionOf(req.title, parseStreamripDesc(d).title)).find(Boolean)
    return rv ? { answer: 'no', why: 'edition-differs', other: `${rv} version` } : { answer: 'no', why: 'not-on-qobuz' }
  }

  const judged = considered.map((l) => ({ l, v: verifyAlbumCandidate(req, l.cand) }))
  // This edition, every song streamable: the walk downloads it.
  let short: { have: number; of: number } | null = null
  for (const { l, v } of judged) {
    if (v.verdict === 'reject') continue
    if (l.listed > 0 && l.streamable < l.listed) {
      const of = req.trackCount ?? l.cand.trackCount ?? l.listed
      if (!short || l.streamable > short.have) short = { have: l.streamable, of }
      continue
    }
    return { answer: 'found' }
  }
  const alternatives = judged.filter(({ v }) => v.verdict === 'reject').map(({ l, v }) => alternativeOf(l.cand, (v as { reason: string }).reason))
  if (short) return { answer: 'no', why: 'partial', have: short.have, of: short.of, alternatives }

  const rejects = judged.map(({ l, v }) => ({ cand: l.cand, v: v as Extract<AlbumVerdict, { verdict: 'reject' }> }))
  const sameRecord = rejects.filter((r) => r.v.kind !== 'artist' && r.v.kind !== 'title')
  if (sameRecord.length === 0) return { answer: 'no', why: 'not-on-qobuz', alternatives }

  const wantCount = req.trackCount ?? (req.tracks.length || undefined)
  const countOf = (c: CandidateAlbum): number | undefined => c.trackCount ?? (c.tracks?.length || undefined)
  // The same edition, one song reading differently: Compare editions can lay them side by side.
  // Also any edition the size of this one that fell on its tracklist or count: Apple's list
  // of the edition can be short of its own count (De La Soul's skits), and "only the
  // anniversary edition" would then be untrue.
  const near = sameRecord.find((r) => (r.v.kind === 'tracklist' || r.v.kind === 'track-count' || r.v.kind === 'disc') && wantCount != null && countOf(r.cand) === wantCount)
  if (near) return { answer: 'no', why: 'edition-differs', near: true, alternatives }
  // A smaller edition whose every song is one of this one's: "Qobuz has 10 of 11 songs".
  // At least half of it: a two-song single of the title track is not part of the album.
  for (const r of sameRecord) {
    const n = countOf(r.cand)
    if (!n || !wantCount || n >= wantCount || n * 2 < wantCount || !r.cand.tracks?.length || !req.tracks.length) continue
    if (r.cand.tracks.every((t) => req.tracks.some((w) => titleReads(w.title, t.title)))) return { answer: 'no', why: 'partial', have: n, of: wantCount, alternatives }
  }
  for (const r of sameRecord) {
    const words = otherEditionWords(req, r.cand, r.v)
    if (words === 'clean edition') return { answer: 'no', why: 'clean-only', alternatives }
    if (words) return { answer: 'no', why: 'edition-differs', other: words, ...(countOf(r.cand) ? { otherCount: countOf(r.cand) } : {}), alternatives }
  }
  const counted = sameRecord.map((r) => countOf(r.cand)).find((n) => n != null && n !== wantCount)
  return { answer: 'no', why: 'edition-differs', ...(counted ? { otherCount: counted } : {}), alternatives }
}
