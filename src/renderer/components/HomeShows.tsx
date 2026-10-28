/**
 * Home › Shows — the concerts rows (2026-10-19, Jake: "need to be better at
 * concerts!!!"). Two rows above On the Horizon, both from homemini's show
 * collector (src/common/concerts-feed.ts):
 *
 *   Live Near You    his artists in New York City, soonest first
 *   You'd Like This  related artists he doesn't own yet, "Because you play Geese"
 *
 * Both rows are in DATE order (Jake, 2026-10-28: "concert suggestions are
 * never in date order"): taste picks the shows and writes the reason line,
 * the date orders them — main hands over listConcerts() output, so nothing
 * here re-sorts. Each row is a rail of the first cards with "See All N",
 * which opens the whole list in place as a wrapped grid. Cards keep the ticket-
 * stub look of the old Live Near You cards; names wrap, never clip. Clicking a
 * card opens its ticket link, as before.
 */
import { useCallback, useRef, useState } from 'react'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import {
  cardBill, cardReason, concertBadges, formatOnSale, formatShowTime, longDate, nyDate,
  runNightsLine, runStamp, ticketUrl, whereLine,
  type ConcertItem, type ConcertsFeedState,
} from '../../common/concerts-feed'

/** How much of each list the rail shows before "See All". */
const RANKED_RAIL = 24
const DISCOVER_RAIL = 20
/** A saved copy older than this says when it's from. */
const SAY_AGE_AFTER_MS = 12 * 60 * 60 * 1000

function activateOnKey(action: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action() }
  }
}

function sourceLabel(state: ConcertsFeedState, nowMs: number): string {
  if (state.source === 'fallback') return 'via Bandsintown + venue calendars'
  if (state.source === 'cache' && state.fetchedAt && nowMs - state.fetchedAt > SAY_AGE_AFTER_MS) {
    return `Picked by your taste · as of ${new Date(state.fetchedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }
  return 'Picked by your taste'
}

interface CardProps {
  item: ConcertItem
  kind: 'ranked' | 'discover'
  nowMs: number
  today: string
  openLink: (url: string) => void
}

function ConcertCard({ item, kind, nowMs, today, openLink }: CardProps) {
  const stamp = runStamp(item, today)
  const badges = concertBadges(item, nowMs)
  const bill = cardBill(item)
  const reason = cardReason(item, kind)
  const where = whereLine(item)
  const url = ticketUrl(item)
  const open = () => { if (url) openLink(url) }
  const time = formatShowTime(item.time)
  const others = item.artists.filter((a) => a !== bill.artist)
  const title = [
    others.length ? `${bill.artist} with ${others.slice(0, 4).join(', ')}` : bill.artist,
    [item.venue, item.room, where].filter(Boolean).join(' · '),
    runNightsLine(item) ?? [longDate(item.date), time].filter(Boolean).join(' · '),
    reason,
    url ? 'Open tickets' : '',
  ].filter(Boolean).join('\n')
  return (
    <div
      className={`home-tour-card home-concert-card${badges.soldOut === 'all' ? ' home-concert-card--soldout' : ''}`}
      role="listitem"
      tabIndex={0}
      onClick={open}
      onKeyDown={activateOnKey(open)}
      title={title}
    >
      <div className="home-tour-date">
        <div className="home-tour-date-month">{stamp.month}</div>
        <div className={`home-tour-date-day${stamp.nights > 1 ? ' home-tour-date-day--range' : ''}`}>{stamp.day}</div>
        {stamp.nights > 1 && <div className="home-tour-date-nights">{stamp.nights} nights</div>}
        {stamp.year !== null && <div className="home-concert-year">{stamp.year}</div>}
      </div>
      <div className="home-tour-info home-concert-info">
        {(badges.justAnnounced || badges.soldOut) && (
          <div className="home-concert-badges">
            {badges.justAnnounced && <span className="home-concert-badge home-concert-badge--new">Just announced</span>}
            {badges.soldOut && (
              <span className="home-concert-badge home-concert-badge--soldout">
                {badges.soldOut === 'all' ? 'Sold out' : 'Some nights sold out'}
              </span>
            )}
          </div>
        )}
        <div className="home-concert-artist">{bill.artist}</div>
        {bill.openingFor && <div className="home-concert-opening">opening for {bill.openingFor}</div>}
        <div className="home-concert-venue">{item.venue}</div>
        {where && <div className="home-concert-where">{where}</div>}
        {reason && <div className="home-concert-reason">{reason}</div>}
        {badges.onSaleAt && <div className="home-concert-onsale">{formatOnSale(badges.onSaleAt)}</div>}
      </div>
    </div>
  )
}

interface RailProps {
  title: string
  source: string
  items: ConcertItem[]
  kind: 'ranked' | 'discover'
  cap: number
  scrollKey: string
  nowMs: number
  today: string
  openLink: (url: string) => void
}

function ConcertRail({ title, source, items, kind, cap, scrollKey, nowMs, today, openLink }: RailProps) {
  const [all, setAll] = useState(false)
  const groupRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  useScrollPersistence(scrollKey, rowRef)
  const more = items.length > cap
  const shown = all ? items : items.slice(0, cap)
  const toggle = useCallback(() => {
    // Folding a long grid back up: keep the row's heading in view.
    if (all) requestAnimationFrame(() => groupRef.current?.scrollIntoView({ block: 'nearest' }))
    setAll(!all)
  }, [all])
  return (
    <div className="home-shows-group" ref={groupRef}>
      <div className="home-section-subhead">
        <h3 className="home-section-subtitle">{title}</h3>
        <div className="home-concert-subhead-end">
          <span className="home-section-source">{source}</span>
          {more && (
            <button type="button" className="home-section-more" onClick={toggle} aria-expanded={all}>
              {all ? `Show First ${cap}` : `See All ${items.length}`}
            </button>
          )}
        </div>
      </div>
      <div className={`home-card-row${all ? ' home-card-row--concert-grid' : ''}`} role="list" ref={rowRef}>
        {shown.map((item) => (
          <ConcertCard key={`${item.id}|${item.rank}`} item={item} kind={kind} nowMs={nowMs} today={today} openLink={openLink} />
        ))}
      </div>
    </div>
  )
}

export default function HomeShows({ state, openLink }: { state: ConcertsFeedState; openLink: (url: string) => void }) {
  const nowMs = Date.now()
  const today = nyDate(nowMs)
  return (
    <>
      {state.items.length > 0 && (
        <ConcertRail
          title="Live Near You" source={sourceLabel(state, nowMs)} items={state.items} kind="ranked"
          cap={RANKED_RAIL} scrollKey="home-row-concerts" nowMs={nowMs} today={today} openLink={openLink}
        />
      )}
      {state.discover.length > 0 && (
        <ConcertRail
          title="You'd Like This" source="Not in your library yet" items={state.discover} kind="discover"
          cap={DISCOVER_RAIL} scrollKey="home-row-concerts-discover" nowMs={nowMs} today={today} openLink={openLink}
        />
      )}
    </>
  )
}
