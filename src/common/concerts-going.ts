/**
 * Going / I went + "What they've been playing" (Jake, 2026-10-29) — the
 * desktop's half. The answers live in ONE place on homemini (rsvps.json,
 * JakeTunesMobile backend util/rsvps.ts) so the phone and both Macs agree;
 * the LATEST tap wins (each write carries when it was tapped).
 *
 *   GET  /api/rsvps                         every entry; `ask` = ask "Were you there?" now
 *   PUT  /api/rsvps/:id        {status, at}  going / not / clear
 *   PUT  /api/rsvps/:id/attended {answer, at} yes / no / clear
 *   GET  /api/concerts/lately?artist=        "What they've been playing" (setlist.fm);
 *                                            { enabled: false } without a key → draw nothing
 *
 * Named apart from the album page's live-recording list ("Songs in this
 * show", once "Set List" — Jake 2026-10-28: "what the hell is the Setlist???").
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/ConcertGoing.swift (+ the
 * RsvpStore in Concerts.swift). Pure — no electron, no fetch.
 */

export type RsvpStatus = 'going' | 'not'
export type AttendedAnswer = 'yes' | 'no'

export interface RsvpShow {
  artist: string
  headliners?: string[]
  support?: string[]
  venue: string
  neighbourhood?: string | null
  borough?: string | null
  date: string
  time?: string | null
  url?: string | null
}

export interface PlayedSetlist {
  id: string
  url: string | null
  venue: string
  city: string | null
  songs: Array<{ name: string; encore: boolean; cover: string | null }>
}

export interface RsvpEntry {
  eventId: string
  status: RsvpStatus
  at: string
  show?: RsvpShow
  attended?: AttendedAnswer
  attendedAt?: string
  setlist?: PlayedSetlist
  ask?: boolean
}

export interface LatelySong {
  name: string
  count: number
  position: number
  cover: string | null
  trackId: string | null
  title: string | null
}

export interface Lately {
  shows: number
  from: string
  to: string
  url: string | null
  songs: LatelySong[]
  ownedInSetOrder: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** GET /api/rsvps → entries (malformed rows dropped). */
export function parseRsvps(body: unknown): RsvpEntry[] {
  const items = isObj(body) && Array.isArray(body.items) ? body.items : []
  const out: RsvpEntry[] = []
  for (const r of items) {
    if (!isObj(r)) continue
    const eventId = str(r.eventId)
    const status = r.status === 'going' || r.status === 'not' ? r.status : null
    if (!eventId || !status) continue
    const e: RsvpEntry = { eventId, status, at: str(r.at) ?? '' }
    if (isObj(r.show) && str(r.show.artist) && str(r.show.venue) && str(r.show.date)) e.show = r.show as unknown as RsvpShow
    if (r.attended === 'yes' || r.attended === 'no') e.attended = r.attended
    if (str(r.attendedAt)) e.attendedAt = r.attendedAt as string
    if (isObj(r.setlist)) e.setlist = r.setlist as unknown as PlayedSetlist
    if (typeof r.ask === 'boolean') e.ask = r.ask
    out.push(e)
  }
  return out
}

/** GET /api/concerts/lately → the body to draw, or null (off, nothing recent). */
export function parseLately(body: unknown): Lately | null {
  if (!isObj(body) || body.enabled !== true || !isObj(body.lately)) return null
  const l = body.lately
  const songs = Array.isArray(l.songs) ? l.songs.filter((s): s is LatelySong => isObj(s) && typeof s.name === 'string' && typeof s.count === 'number') : []
  if (!songs.length || typeof l.shows !== 'number') return null
  return {
    shows: l.shows,
    from: str(l.from) ?? '',
    to: str(l.to) ?? '',
    url: str(l.url),
    songs: songs.map((s) => ({ ...s, cover: s.cover ?? null, trackId: s.trackId ?? null, title: s.title ?? null })),
    ownedInSetOrder: Array.isArray(l.ownedInSetOrder) ? l.ownedInSetOrder.filter((x): x is string => typeof x === 'string') : [],
  }
}

/** The question to ask now: the oldest unanswered past show he was going to
 *  (homemini decides `ask`, so every app asks the same one). */
export function nextAsk(entries: readonly RsvpEntry[]): RsvpEntry | null {
  return [...entries]
    .filter((e) => e.ask === true && !e.attended && e.status === 'going' && e.show)
    .sort((a, b) => a.show!.date.localeCompare(b.show!.date) || a.eventId.localeCompare(b.eventId))[0] ?? null
}

/** A tap on Going: going ↔ clear. */
export function goingAfterTap(current: RsvpStatus | null | undefined): RsvpStatus | null {
  return current === 'going' ? null : 'going'
}

/** "Every show" / "3 of 4 shows" · "Ramones cover" · in your library or not. */
export function latelyDetail(s: LatelySong, shows: number): string {
  const parts = [s.count === shows ? 'Every show' : `${s.count} of ${shows} shows`]
  if (s.cover) parts.push(`${s.cover} cover`)
  parts.push(s.trackId ? 'In your library' : 'Not in your library')
  return parts.join(' · ')
}

/** "Play the 5 you own, in set order". */
export function latelyPlayLabel(owned: number): string {
  return owned === 1 ? 'Play the 1 you own' : `Play the ${owned} you own, in set order`
}
