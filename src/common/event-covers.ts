/**
 * Event covers (2026-11-13). Jake: "I'd like current events to be the cover if
 * and only if something insanely memorable in the world happened that month."
 *
 * homemini keeps the proposals (JakeTunesMobile backend/src/util/eventCovers.ts):
 * the app may propose something world-historic and never anything political;
 * Jake may name any event; the facts always come from sources. A month wears
 * an event's cover only after Jake approves it here, and "Use the normal
 * cover" puts the month's own cover back.
 * ⚠️ CONTRACT: GET /api/event-covers, POST /api/event-covers/:ym/decide and /wish.
 */
export type EventCoverStatus = 'proposed' | 'approved' | 'skipped'
export type EventCoverDecision = 'approve' | 'skip' | 'restore'
export interface EventCoverSource { url: string; title: string; quote: string }
export interface EventCoverProposal {
  ym: string
  origin: 'ai' | 'jake'
  status: EventCoverStatus
  title: string
  line: string
  why: string
  sources: EventCoverSource[]
  hasPreview: boolean
}

const isYm = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** 'month-2026-06' → '2026-06'; null for every other playlist. */
export function eventCoverMonth(playlistId: unknown): string | null {
  const m = typeof playlistId === 'string' ? /^month-(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(playlistId) : null
  return m ? m[1] : null
}

/** One row of homemini's list; null when it is not a proposal this app can show. Links are https only. */
export function parseEventCoverProposal(raw: unknown): EventCoverProposal | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || !isYm(r.ym)) return null
  if (r.status !== 'proposed' && r.status !== 'approved' && r.status !== 'skipped') return null
  const ev = (r.event ?? {}) as Record<string, unknown>
  const title = text(ev.title, 80)
  if (!title) return null
  const sources = (Array.isArray(r.sources) ? r.sources : []).map((s) => {
    const o = s as Record<string, unknown> | null
    const url = text(o?.url, 500)
    return /^https:\/\/[^\s]+$/.test(url) ? { url, title: text(o?.title, 80) || new URL(url).hostname.replace(/^www\./, ''), quote: text(o?.quote, 400) } : null
  }).filter((s): s is EventCoverSource => s !== null)
  const line = [text(ev.number, 12), text(ev.unit, 60)].filter(Boolean).join(' ')
  const where = [text(ev.date, 40), text(ev.place, 60)].filter(Boolean).join(', ')
  return {
    ym: r.ym, origin: r.origin === 'ai' ? 'ai' : 'jake', status: r.status, title,
    line: [line, where].filter(Boolean).join(' · '), why: text(r.why, 400), sources, hasPreview: typeof r.preview === 'string' && r.preview.length > 0,
  }
}

export function parseEventCoverList(body: unknown): EventCoverProposal[] | null {
  const list = (body as { proposals?: unknown } | null)?.proposals
  return Array.isArray(list) ? list.map(parseEventCoverProposal).filter((p): p is EventCoverProposal => p !== null) : null
}

// The words the panel uses.
export const EVENT_COVER_HEADING = 'Cover to review'
export const eventCoverIntro = (p: Pick<EventCoverProposal, 'origin' | 'status'>): string =>
  p.status === 'approved' ? 'This month wears this cover. Its own cover is kept.'
    : p.origin === 'ai' ? 'JakeTunes thinks this month had something historic. The month keeps its own cover unless you approve.'
      : 'You named this. The month keeps its own cover unless you approve.'
export const EVENT_COVER_WISH_LABEL = 'This month’s cover is…'
export const EVENT_COVER_WISH_SENT = 'Noted. It’s checked against sources before anything is drawn.'
export const EVENT_COVER_AWAY = 'homemini is away. Try again when it’s back.'
