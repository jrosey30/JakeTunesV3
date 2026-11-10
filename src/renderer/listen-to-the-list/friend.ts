/**
 * Who sent a Listen List row, and the link they sent.
 *
 * homemini keeps both in fields (`from`, `link`; its Brief 132) for every row
 * that names an artist, and for every row added on the phone with "who sent
 * it". This app read only the old packed note ("… · from Ben · https://…"),
 * so those rows showed no sender and their Got / Tossed never reached the
 * friend's ledger (found 2026-11-10, with Avery's artist page and playlist).
 * The fields win; the note is the fallback for a row still waiting on this
 * Mac. Pure, so it is tested.
 * ⚠️ TWIN: main/friend-imports-core.ts friendOfReco — same regex, same order.
 */
export interface SentRow { from?: string; link?: string; note?: string; kind?: string }

export function friendOf(rec: SentRow): string | null {
  const from = (rec.from || '').trim()
  if (from) return from
  const m = String(rec.note || '').match(/(?:^|· )from ([^·]+?)(?: ·|$)/)
  return m ? m[1].trim() : null
}

/** The http(s) link the row carries, if any. */
export function linkOf(rec: SentRow): string | null {
  const link = (rec.link || '').trim() || String(rec.note || '').match(/https?:\/\/\S+/)?.[0] || ''
  return /^https?:\/\/\S+$/i.test(link) ? link : null
}

/** A row that is opened, not downloaded: an artist or a playlist a friend sent
 *  (named by homemini), or a page listed under its link (a podcast, a TikTok
 *  nobody could name — note === link, homemini's saved-link shape).
 *  ⚠️ TWIN: main/reco-kind-core.ts isHubNamedLink. */
export function isLinkKind(rec: SentRow): boolean {
  return rec.kind === 'artist' || rec.kind === 'playlist' || (!!rec.link && rec.note === rec.link)
}
