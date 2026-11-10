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

// recoIdNorm, not recoNorm (2026-10-11): these keys are STORED — in
// friend-credits.json (CreditRecord keys / albumKey) and inside attribution
// credit ids in reco-import-credit.json — so a Latin name must keep its
// recoNorm key byte for byte. recoNorm alone erased every Hebrew and
// Cyrillic letter, so a friend's Hebrew or Cyrillic send could never earn a
// credit or show on the standings. Live state on 10/11: 0 such entries in
// any of the four friend files, so nothing stored changes.
import { recoIdNorm } from './reco-match.ts'

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

/** Who sent this row: homemini's `from` field, else the packed note. homemini
 *  moved the friend out of the note for every row that names an artist (its
 *  Brief 132), and a row added on the phone with "who sent it" never had a
 *  packed note, so reading the note alone left those sends without a sender
 *  on the list and without a credit (found 2026-11-10).
 *  ⚠️ TWIN: renderer listen-to-the-list/friend.ts friendOf. */
export function friendOfReco(r: { from?: unknown; note?: unknown }): string | null {
  const from = typeof r.from === 'string' ? r.from.trim() : ''
  return from || friendOfNote(typeof r.note === 'string' ? r.note : undefined)
}

/** The same row with its sender where the credit matchers read it (the note). */
export function withFriendInNote<T extends { from?: unknown; note?: unknown }>(r: T): T {
  const friend = friendOfReco(r)
  const note = typeof r.note === 'string' ? r.note : ''
  if (!friend || friendOfNote(note)) return r
  return { ...r, note: [note.trim(), `from ${friend}`].filter(Boolean).join(' · ') }
}

/** Exported for the standings sweep: a CreditRecord must carry the SAME keys
 *  the credit was granted on, or deletion checks would use a different
 *  identity than the award did. */
export function pairKeys(r: CreditableReco): string[] {
  const keys: string[] = []
  const raw = recoIdNorm(r.song || '') && recoIdNorm(r.artist || '')
    ? `${recoIdNorm(r.song || '')}|${recoIdNorm(r.artist || '')}` : null
  const matched = recoIdNorm(r.matchedTitle || '') && recoIdNorm(r.matchedArtist || '')
    ? `${recoIdNorm(r.matchedTitle || '')}|${recoIdNorm(r.matchedArtist || '')}` : null
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
    const title = recoIdNorm(t.title || '')
    if (!title) continue
    const when = Date.parse(t.dateAdded || '') || 0
    for (const artist of [t.artist, t.albumArtist]) {
      const a = recoIdNorm(artist || '')
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
  /** Absent: the friend sent the ARTIST (computeArtistSendCredits). */
  song?: string
  artist?: string
  friend: string
  /** ISO timestamp of the SEND (message arrival), not of the recording. */
  at: string
  url?: string
}

export function attributionKey(a: { song?: string; artist?: string }): string | null {
  const t = recoIdNorm(a.song || '')
  const ar = recoIdNorm(a.artist || '')
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
    const title = recoIdNorm(t.title || '')
    if (!title) continue
    const when = Date.parse(t.dateAdded || '') || 0
    for (const artist of [t.artist, t.albumArtist]) {
      const a = recoIdNorm(artist || '')
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

// ── A link that is not one song (2026-11-10) ─────────────────────────
// Jake: "someone sends me a song, and they never enter the standings." Avery
// Allen texted a Spotify artist page and a playlist. homemini now names such
// a link (an artist row, a playlist row with its songs), and these are the
// sends those rows stand for. The scoring is Jake's, unchanged: a point is an
// IMPORT, and it must come after the send.
//   a playlist → each of its songs is a song send (the attribution ledger's
//                own shape): 1 point per song of it Jake imports;
//   an artist  → 1 point for the first song by that artist that arrives after
//                the send. One, not one per song: the friend named a band,
//                not a record (an album link is still the 5).

/** `artist:<key>` for a send that names an artist and no song. */
export function artistSendKey(a: { song?: string; artist?: string }): string | null {
  if (recoIdNorm(a.song || '')) return null
  const ar = recoIdNorm(a.artist || '')
  return ar ? `artist:${ar}` : null
}

export interface LinkSendRow {
  kind?: unknown
  artist?: unknown
  from?: unknown
  note?: unknown
  link?: unknown
  createdAt?: unknown
  tracks?: unknown
}

/** The sends a friend's artist or playlist row stands for. */
export function sendsOfLinkRows(recos: LinkSendRow[]): RecoAttribution[] {
  const out: RecoAttribution[] = []
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  for (const r of recos) {
    const friend = friendOfReco(r)
    const at = str(r.createdAt)
    if (!friend || !at) continue
    const url = str(r.link) || undefined
    if (r.kind === 'artist' && str(r.artist)) out.push({ artist: str(r.artist), friend, at, url })
    if (r.kind === 'playlist' && Array.isArray(r.tracks)) {
      for (const t of r.tracks as Array<{ title?: unknown; artist?: unknown }>) {
        if (str(t?.title) && str(t?.artist)) out.push({ song: str(t.title), artist: str(t.artist), friend, at, url })
      }
    }
  }
  return out
}

export function artistSendRecoId(a: RecoAttribution): string | null {
  const key = artistSendKey(a)
  const friend = a.friend?.trim().toLowerCase()
  return key && friend ? `attr-${key}:${friend}` : null
}

/** One credit per friend + artist: the first song by that artist to arrive
 *  after the send, unless that song already earned this friend a point. */
export function computeArtistSendCredits(
  attributions: RecoAttribution[],
  tracks: LibTrackLite[],
  alreadyCredited: ReadonlySet<string>,
  coveredPairs: ReadonlySet<string>,
): Array<ImportCredit & { key: string; label: string }> {
  const out: Array<ImportCredit & { key: string; label: string }> = []
  const seen = new Set<string>()
  for (const a of attributions) {
    const recoId = artistSendRecoId(a)
    if (!recoId || alreadyCredited.has(recoId) || seen.has(recoId)) continue
    const artist = recoIdNorm(a.artist || '')
    const friend = a.friend.trim()
    const sentAt = Date.parse(a.at || '')
    if (!Number.isFinite(sentAt) || sentAt <= 0) continue   // no timeline = no proof
    let best: { when: number; key: string; title: string } | null = null
    for (const t of tracks) {
      const title = recoIdNorm(t.title || '')
      if (!title) continue
      if (recoIdNorm(t.artist || '') !== artist && recoIdNorm(t.albumArtist || '') !== artist) continue
      const when = Date.parse(t.dateAdded || '') || 0
      if (when < sentAt) continue                            // owned before the send
      const key = `${title}|${artist}`
      if (coveredPairs.has(`${friend.toLowerCase()}|${key}`)) continue
      if (!best || when < best.when) best = { when, key, title: String(t.title).trim() }
    }
    if (!best) continue
    seen.add(recoId)
    out.push({ recoId, friend, key: best.key, label: `${best.title} — ${String(a.artist).trim()}` })
  }
  return out
}
