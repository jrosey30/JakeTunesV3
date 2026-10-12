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
import type { RecoIdentityInput } from './reco-match.ts'

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

/**
 * The `isOnList` predicate for rankCandidates, built from the Listen List
 * rows: same song|artist identity the list itself keys by (raw fields first,
 * iTunes-matched as fallback). ⚠️ The key is SONG first — the radar hands us
 * (artist, title), so it must be flipped. index.ts passed (artist, title)
 * straight into a (song, artist) key and the guard never matched (2026-10-11).
 */
export function listenListPredicate(
  records: Array<Pick<RecoIdentityInput, 'song' | 'artist' | 'matchedTitle' | 'matchedArtist'>>,
): (artist: string, title: string) => boolean {
  const listKeys = new Set<string>()
  for (const r of records) {
    const k = recoIdentityPairKey(r.song || r.matchedTitle, r.artist || r.matchedArtist)
    if (k) listKeys.add(k)
  }
  return (artist, title) => {
    const k = recoIdentityPairKey(title, artist)
    return k != null && listKeys.has(k)
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
