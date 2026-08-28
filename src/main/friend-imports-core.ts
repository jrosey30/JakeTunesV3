/**
 * Friend import credit — pure core (2026-07-19, Jake: "keep track on which
 * friends songs i import the most from the list. just because they send me
 * a song doesnt mean ill like it").
 *
 * The Scouts ledger's 'got' ticks on the download CLICK — intent, not
 * outcome. This module computes the outcome: a friend's reco earns an
 * `imported` credit only when the song is ACTUALLY in the library, and the
 * library copy arrived AFTER the reco existed (a song Jake already owned
 * when it was texted proves nothing about the friend's ear).
 *
 * Honesty rules:
 *  - song+artist (raw or iTunes-matched pair) must both match — an
 *    artist-less jot is never text-match-credited.
 *  - one credit per reco, ever (the caller persists creditedRecoIds).
 *  - a reco deleted before a sweep runs earns nothing — credits are
 *    granted from evidence present at sweep time, never reconstructed.
 */

import { recoNorm } from './reco-match.ts'

export interface CreditableReco {
  id: string
  song?: string
  artist?: string
  matchedTitle?: string
  matchedArtist?: string
  note?: string
  createdAt?: string
}

export interface LibTrackLite {
  title?: string
  artist?: string
  albumArtist?: string
  dateAdded?: string
}

/** Who sent this reco, parsed from the synced note.
 *  ⚠️ TWIN: renderer ListenToTheListView friendOf() — same regex, same
 *  note format ("… · from Ben · …"); change both or neither. */
export function friendOfNote(note: string | undefined): string | null {
  const m = String(note || '').match(/(?:^|· )from ([^·]+?)(?: ·|$)/)
  return m ? m[1].trim() : null
}

/** Exported for the standings sweep: a CreditRecord must carry the SAME keys
 *  the credit was granted on, or deletion checks would use a different
 *  identity than the award did. */
export function pairKeys(r: CreditableReco): string[] {
  const keys: string[] = []
  const raw = recoNorm(r.song || '') && recoNorm(r.artist || '')
    ? `${recoNorm(r.song || '')}|${recoNorm(r.artist || '')}` : null
  const matched = recoNorm(r.matchedTitle || '') && recoNorm(r.matchedArtist || '')
    ? `${recoNorm(r.matchedTitle || '')}|${recoNorm(r.matchedArtist || '')}` : null
  if (raw) keys.push(raw)
  if (matched && matched !== raw) keys.push(matched)
  return keys
}

export interface ImportCredit { recoId: string; friend: string }

export function computeImportCredits(
  recos: CreditableReco[],
  tracks: LibTrackLite[],
  alreadyCredited: ReadonlySet<string>,
): ImportCredit[] {
  // Library index: normalized title|artist → newest arrival time of any
  // matching copy (artist AND albumArtist both index the track).
  const arrival = new Map<string, number>()
  for (const t of tracks) {
    const title = recoNorm(t.title || '')
    if (!title) continue
    const when = Date.parse(t.dateAdded || '') || 0
    for (const artist of [t.artist, t.albumArtist]) {
      const a = recoNorm(artist || '')
      if (!a) continue
      const key = `${title}|${a}`
      if ((arrival.get(key) ?? -1) < when) arrival.set(key, when)
    }
  }

  const credits: ImportCredit[] = []
  for (const r of recos) {
    if (!r.id || alreadyCredited.has(String(r.id))) continue
    const friend = friendOfNote(r.note)
    if (!friend) continue
    const recoAt = Date.parse(r.createdAt || '')
    if (!Number.isFinite(recoAt) || recoAt <= 0) continue   // no timeline = no proof
    const landed = pairKeys(r).some((k) => {
      const when = arrival.get(k)
      return when !== undefined && when >= recoAt
    })
    if (landed) credits.push({ recoId: String(r.id), friend })
  }
  return credits
}

// ── Attribution credits (2026-08-28) ─────────────────────────────────
// Jake: "it is not doing a good job tracking when a song suggestion comes
// through from a friend." Two ways a real send used to vanish:
//   1. the capture DEDUPED against a row already on the list — the friend's
//      name was dropped on the floor (Lorin texted "Til the Right One
//      Comes" on 8/24, it deduped, Jake imported it on 8/25, no credit);
//   2. the reco left the list before a credit sweep ran, and sweeps only
//      read live rows.
// The fix is a durable ATTRIBUTION record written the moment a friend's
// send arrives (added OR deduped): raw song/artist/friend/timestamp. The
// sweep then credits from attributions independently of the list. The
// honesty rules are unchanged — the library copy must arrive AFTER the
// send ("Last Train Home" was in the library three days before Lorin
// suggested it, and that must never earn a point), and one credit per
// friend+song, ever.

export interface RecoAttribution {
  song?: string
  artist?: string
  friend: string
  /** ISO timestamp of the SEND (message arrival), not of the recording. */
  at: string
  url?: string
}

export function attributionKey(a: { song?: string; artist?: string }): string | null {
  const t = recoNorm(a.song || '')
  const ar = recoNorm(a.artist || '')
  return t && ar ? `${t}|${ar}` : null
}

export function attributionRecoId(a: RecoAttribution): string | null {
  const key = attributionKey(a)
  const friend = a.friend?.trim().toLowerCase()
  return key && friend ? `attr:${key}:${friend}` : null
}

export function computeAttributionCredits(
  attributions: RecoAttribution[],
  tracks: LibTrackLite[],
  alreadyCredited: ReadonlySet<string>,
  /** `${friend lowercase}|${pair key}` pairs already covered by reco-based
   *  credits — an import must never earn twice through two ledgers. */
  coveredPairs: ReadonlySet<string>,
): Array<ImportCredit & { key: string; label: string }> {
  const arrival = new Map<string, number>()
  for (const t of tracks) {
    const title = recoNorm(t.title || '')
    if (!title) continue
    const when = Date.parse(t.dateAdded || '') || 0
    for (const artist of [t.artist, t.albumArtist]) {
      const a = recoNorm(artist || '')
      if (!a) continue
      const key = `${title}|${a}`
      if ((arrival.get(key) ?? -1) < when) arrival.set(key, when)
    }
  }
  const out: Array<ImportCredit & { key: string; label: string }> = []
  const seen = new Set<string>()
  for (const a of attributions) {
    const recoId = attributionRecoId(a)
    const key = attributionKey(a)
    if (!recoId || !key) continue
    if (alreadyCredited.has(recoId) || seen.has(recoId)) continue
    const friend = a.friend.trim()
    if (coveredPairs.has(`${friend.toLowerCase()}|${key}`)) continue
    const sentAt = Date.parse(a.at || '')
    if (!Number.isFinite(sentAt) || sentAt <= 0) continue   // no timeline = no proof
    const when = arrival.get(key)
    if (when === undefined || when < sentAt) continue        // owned-before or absent
    seen.add(recoId)
    out.push({ recoId, friend, key, label: a.artist ? `${a.song} — ${a.artist}` : String(a.song || '') })
  }
  return out
}
