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
 *
 * Going / I went (2026-10-29, twin of the phone's ConcertGoing.swift): a
 * "Going" pill on each card marks the show (one click, again to undo); the day
 * after a show he was going to, "Were you there?" sits above Live Near You
 * (Yes / No). Both answers live on homemini, so the phone and both Macs agree
 * and the latest click wins. A Going card offers "What they've been playing"
 * (setlist.fm): the band's most played songs lately, the owned ones marked,
 * one click plays those in the band's order. Nothing about setlist.fm draws
 * when homemini has no key.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import {
  goingAfterTap, latelyDetail, latelyPlayLabel, nextAsk, snippetTrack, stubLabel,
  type Lately, type RsvpEntry, type RsvpShow, type RsvpStatus,
} from '../../common/concerts-going'
import { nameKey } from '../../common/fold-text'
import { useArtistProfile } from '../artistProfile'
import { initials } from '../utils/artistPortrait'
import { snippetPlaying, stopSnippet, subscribeSnippet, toggleSnippet } from '../concertSnippet'
import { usePlayback } from '../context/PlaybackContext'
import type { Track } from '../types'
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

interface Going {
  status: (item: ConcertItem) => RsvpStatus | null
  toggle: (item: ConcertItem) => void
  lately: (item: ConcertItem) => Lately | null
  openLately: (item: ConcertItem) => void
}

interface CardProps {
  item: ConcertItem
  kind: 'ranked' | 'discover'
  nowMs: number
  today: string
  openLink: (url: string) => void
  going: Going
}

// ── "More fun" (2026-10-29; twin of the phone's ConcertFun.swift) ─────────
// The photo is the hero (the artist page's header photo, else the app's
// photo when its short side is 500+ px, else initials); a ticket stub on it
// ("TONIGHT" glows); a click plays 15 s of his most-played song by the act
// (equalizer; stops when the card leaves the screen); Going lands a "GOING"
// stamp; the photo drifts with the rail (CSS scroll timeline). Reduce Motion
// (prefers-reduced-motion) stills all of it (home.css).

const appPhotoSlugs = new Map<string, string | null>()
const PHOTO_MIN_SIDE = 500

function ConcertPhoto({ name }: { name: string }) {
  const { state: profile } = useArtistProfile(name)
  const hero = profile.profile?.hero ? profile.photos[profile.profile.hero.url] ?? null : null
  const [app, setApp] = useState<string | null>(appPhotoSlugs.get(name) ?? null)
  const [big, setBig] = useState<boolean | null>(null)
  useEffect(() => {
    if (hero || appPhotoSlugs.has(name)) return
    let live = true
    window.electronAPI.getArtistImage(name).then((r) => (r.ok ? r.slug : null)).catch(() => null).then((s) => {
      appPhotoSlugs.set(name, s)
      if (live) setApp(s)
    })
    return () => { live = false }
  }, [name, hero])
  const slug = hero ?? app
  if (slug && (hero || big !== false)) {
    return (
      <img
        className={`home-concert-photo-img${hero || big ? '' : ' home-concert-photo-img--checking'}`}
        src={`artist-image://${slug}.jpg`}
        alt=""
        draggable={false}
        decoding="async"
        onLoad={(e) => {
          if (hero) return
          const i = e.currentTarget
          setBig(Math.min(i.naturalWidth, i.naturalHeight) >= PHOTO_MIN_SIDE)
        }}
        onError={() => setBig(false)}
      />
    )
  }
  return <span className="home-concert-photo-initials" aria-hidden="true">{initials(name)}</span>
}

function Equalizer() {
  return (
    <span className="home-concert-eq" aria-label="Playing a snippet">
      <i /><i /><i />
    </span>
  )
}

/** 12×12 in the 22px-tall pill: a check (going) or a plus (not yet). */
function GoingIcon({ on }: { on: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      {on
        ? <path d="M2.5 6.2 5 8.6l4.6-5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M6 2.5v7M2.5 6h7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  )
}

/** "Show me the list" lines, 12×12 in its 18px row. */
function ListIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 3h8M2 6h8M2 9h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ShowConcertCard({ item, kind, nowMs, today, openLink, going, snippet }: CardProps & { snippet: Snippet }) {
  const on = going.status(item) === 'going'
  const lately = on ? going.lately(item) : null
  const url = ticketUrl(item)
  const [stamped, setStamped] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  const playing = snippet.playing === item.id
  // Photos load once a card comes near the screen; a playing snippet stops
  // once its card has left it.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        if (e.isIntersecting) setSeen(true)
        else stopSnippet(item.id)
      }
    }, { rootMargin: '0px 300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [item.id])
  useEffect(() => () => stopSnippet(item.id), [item.id])
  useEffect(() => {
    if (!stamped) return
    const t = window.setTimeout(() => setStamped(0), 1300)
    return () => window.clearTimeout(t)
  }, [stamped])
  return (
    <div className="home-concert-wrap" role="listitem" ref={wrapRef}>
      <ConcertCard
        item={item} kind={kind} nowMs={nowMs} today={today}
        photo={seen ? <ConcertPhoto name={cardBill(item).artist} /> : null}
        playing={playing}
        stamped={stamped}
        onPlay={() => snippet.toggle(item)}
      />
      <div className="home-concert-actions">
        <button
          type="button"
          className={`home-concert-going${on ? ' home-concert-going--on' : ''}`}
          aria-pressed={on}
          title={on ? 'You\u2019re going (click to undo)' : 'Mark as going'}
          onClick={() => { if (!on) setStamped(Date.now()); going.toggle(item) }}
        >
          <GoingIcon on={on} />
          <span>Going</span>
        </button>
        {url && (
          <button type="button" className="home-concert-tickets" onClick={() => openLink(url)}>Tickets</button>
        )}
        {lately && (
          <button type="button" className="home-concert-lately-link" onClick={() => going.openLately(item)}>
            <ListIcon />
            <span>What they've been playing</span>
          </button>
        )}
      </div>
    </div>
  )
}

interface Snippet {
  playing: string | null
  toggle: (item: ConcertItem) => void
}

function ConcertCard({ item, kind, nowMs, today, photo, playing, stamped, onPlay }: Omit<CardProps, 'going' | 'openLink'> & {
  photo: JSX.Element | null
  playing: boolean
  stamped: number
  onPlay: () => void
}) {
  const stamp = runStamp(item, today)
  const badges = concertBadges(item, nowMs)
  const bill = cardBill(item)
  const reason = cardReason(item, kind)
  const where = whereLine(item)
  const open = onPlay
  const time = formatShowTime(item.time)
  const stub = stubLabel(item.date, today)
  const others = item.artists.filter((a) => a !== bill.artist)
  const title = [
    others.length ? `${bill.artist} with ${others.slice(0, 4).join(', ')}` : bill.artist,
    [item.venue, item.room, where].filter(Boolean).join(' · '),
    runNightsLine(item) ?? [longDate(item.date), time].filter(Boolean).join(' · '),
    reason,
    playing ? 'Click to stop the snippet' : 'Click to hear their song you play most',
  ].filter(Boolean).join('\n')
  return (
    <div
      className={`home-tour-card home-concert-card${badges.soldOut === 'all' ? ' home-concert-card--soldout' : ''}${playing ? ' home-concert-card--playing' : ''}`}
      tabIndex={0}
      onClick={open}
      onKeyDown={activateOnKey(open)}
      title={title}
    >
      <div className="home-concert-photo">
        {photo}
        {stub && <span className={`home-concert-stub${stub === 'TONIGHT' ? ' home-concert-stub--tonight' : ''}`}>{stub}</span>}
        {playing && <Equalizer />}
        {stamped > 0 && <span key={stamped} className="home-concert-stamp" aria-hidden="true">GOING</span>}
      </div>
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
  going: Going
  snippet: Snippet
}

function ConcertRail({ title, source, items, kind, cap, scrollKey, nowMs, today, openLink, going, snippet }: RailProps) {
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
          <ShowConcertCard key={`${item.id}|${item.rank}`} item={item} kind={kind} nowMs={nowMs} today={today} openLink={openLink} going={going} snippet={snippet} />
        ))}
      </div>
    </div>
  )
}

/** The show for an RSVP, from the card (homemini keeps its own snapshot
 *  when its table still has the show; this is the fallback). */
function showOf(item: ConcertItem): RsvpShow {
  return {
    artist: cardBill(item).artist, headliners: item.headliners, support: item.support,
    venue: item.venue, neighbourhood: item.neighbourhood, borough: item.borough,
    date: item.date, time: item.time, url: item.url,
  }
}

/** "Were you there?" — the oldest unanswered past show he was going to. */
function WereYouThere({ entry, answer }: { entry: RsvpEntry; answer: (a: 'yes' | 'no') => void }) {
  const show = entry.show!
  return (
    <div className="home-concert-ask" role="group" aria-label="Were you there?">
      <div className="home-concert-ask-text">
        <div className="home-concert-ask-q">Were you there?</div>
        <div className="home-concert-ask-show">
          <span className="home-concert-artist">{show.artist}</span>
          <span className="home-concert-ask-where">{show.venue} · {longDate(show.date)}</span>
        </div>
      </div>
      <div className="home-concert-ask-buttons">
        <button type="button" className="home-concert-ask-yes" onClick={() => answer('yes')}>Yes, I went</button>
        <button type="button" className="home-concert-ask-no" onClick={() => answer('no')}>No</button>
      </div>
    </div>
  )
}

/** "What they've been playing" — opened from a Going card, under its row. */
function LatelyPanel({ artist, lately, close, openLink }: { artist: string; lately: Lately; close: () => void; openLink: (url: string) => void }) {
  const { state: lib } = useLibrary()
  const { playTrack } = useAudio()
  const byId = useMemo(() => new Map(lib.tracks.map((t) => [String(t.id), t])), [lib.tracks])
  const owned = lately.ownedInSetOrder.map((id) => byId.get(id)).filter((t): t is Track => !!t)
  return (
    <div className="home-concert-lately" role="region" aria-label={`What ${artist} have been playing`}>
      <div className="home-concert-lately-head">
        <div>
          <div className="home-concert-lately-eyebrow">What they've been playing</div>
          <div className="home-concert-lately-artist">{artist}</div>
          <div className="home-concert-lately-from">{lately.shows === 1 ? 'From their last show' : `From their last ${lately.shows} shows`}</div>
        </div>
        <div className="home-concert-lately-actions">
          {owned.length > 0 && (
            <button
              type="button"
              className="home-concert-lately-play"
              // The band's running order IS the point: preserveOrder, like a mix.
              onClick={() => playTrack(owned[0], owned, 0, undefined, true, true)}
            >
              {latelyPlayLabel(owned.length)}
            </button>
          )}
          <button type="button" className="home-section-more" onClick={close}>Close</button>
        </div>
      </div>
      <ol className="home-concert-lately-list">
        {lately.songs.map((s) => (
          <li key={s.name} className={s.trackId ? 'home-concert-lately-song--owned' : undefined}>
            <span className="home-concert-lately-mark" aria-hidden="true">{s.trackId ? <GoingIcon on /> : null}</span>
            <span className="home-concert-lately-name">{s.name}</span>
            <span className="home-concert-lately-detail">{latelyDetail(s, lately.shows)}</span>
          </li>
        ))}
      </ol>
      <div className="home-concert-lately-credit">
        Setlists via {lately.url
          ? <a href={lately.url} onClick={(e) => { e.preventDefault(); openLink(lately.url!) }}>setlist.fm</a>
          : 'setlist.fm'}
      </div>
    </div>
  )
}

export default function HomeShows({ state, openLink }: { state: ConcertsFeedState; openLink: (url: string) => void }) {
  const nowMs = Date.now()
  const today = nyDate(nowMs)
  const [entries, setEntries] = useState<RsvpEntry[] | null>(null)
  const [mine, setMine] = useState<Record<string, RsvpStatus | null>>({})
  const [latelyBy, setLatelyBy] = useState<Record<string, Lately | null>>({})
  const [openFor, setOpenFor] = useState<string | null>(null)
  const asked = useRef(new Set<string>())

  const reload = useCallback(async () => {
    const r = await window.electronAPI.concertsRsvps?.().catch(() => null)
    if (r?.ok) { setEntries([...r.items]); setMine({}) }
  }, [])
  // Re-read on mount and whenever the feed changes (a Mac or the phone may
  // have answered since).
  useEffect(() => { void reload() }, [reload, state])

  const byId = useMemo(() => new Map((entries ?? []).map((e) => [e.eventId, e])), [entries])
  const status = useCallback((item: ConcertItem): RsvpStatus | null => {
    if (item.id in mine) return mine[item.id] ?? null
    return byId.get(item.id)?.status ?? item.rsvp ?? null
  }, [mine, byId])

  const toggle = useCallback((item: ConcertItem) => {
    const next = goingAfterTap(status(item))
    setMine((m) => ({ ...m, [item.id]: next }))
    void window.electronAPI.concertsSetGoing?.(item.id, next === 'going', showOf(item))
      .then((r) => (r?.ok ? reload() : setMine((m) => { const c = { ...m }; delete c[item.id]; return c })))
      .catch(() => setMine((m) => { const c = { ...m }; delete c[item.id]; return c }))
  }, [status, reload])

  // "What they've been playing" for the Going acts (homemini refuses others).
  const goingActs = useMemo(() => {
    const acts = new Set<string>()
    for (const item of [...state.items, ...state.discover]) if (status(item) === 'going') acts.add(cardBill(item).artist)
    return [...acts]
  }, [state, status])
  useEffect(() => {
    for (const act of goingActs) {
      if (asked.current.has(act)) continue
      asked.current.add(act)
      void window.electronAPI.concertsLately?.(act)
        .then((r) => setLatelyBy((m) => ({ ...m, [act]: r?.lately ?? null })))
        .catch(() => undefined)
    }
  }, [goingActs])

  const going: Going = {
    status,
    toggle,
    lately: (item) => latelyBy[cardBill(item).artist] ?? null,
    openLately: (item) => setOpenFor(cardBill(item).artist),
  }

  // Snippets: the act's most-played song he owns; the user's music pauses first.
  const { state: libState } = useLibrary()
  const { state: pb } = usePlayback()
  const { togglePlayPause } = useAudio()
  const playingSnippet = useSyncExternalStore(subscribeSnippet, snippetPlaying)
  const fold = useCallback((s: string) => nameKey(s, ''), [])
  const snippet: Snippet = {
    playing: playingSnippet,
    toggle: (item) => {
      const t = snippetTrack(cardBill(item).artist, libState.tracks, fold)
      void toggleSnippet(item.id, t, () => { if (pb.isPlaying) togglePlayPause() })
    },
  }
  useEffect(() => () => stopSnippet(), [])

  const ask = entries ? nextAsk(entries) : null
  const answer = (a: 'yes' | 'no') => {
    if (!ask) return
    setEntries((es) => (es ?? []).map((e) => (e.eventId === ask.eventId ? { ...e, attended: a, ask: false } : e)))
    void window.electronAPI.concertsSetAttended?.(ask.eventId, a).then(() => reload()).catch(() => reload())
  }

  const panel = openFor && latelyBy[openFor]
    ? <LatelyPanel artist={openFor} lately={latelyBy[openFor]!} close={() => setOpenFor(null)} openLink={openLink} />
    : null
  return (
    <>
      {ask && <WereYouThere entry={ask} answer={answer} />}
      {state.items.length > 0 && (
        <ConcertRail
          title="Live Near You" source={sourceLabel(state, nowMs)} items={state.items} kind="ranked"
          cap={RANKED_RAIL} scrollKey="home-row-concerts" nowMs={nowMs} today={today} openLink={openLink} going={going} snippet={snippet}
        />
      )}
      {panel}
      {state.discover.length > 0 && (
        <ConcertRail
          title="You'd Like This" source="Not in your library yet" items={state.discover} kind="discover"
          cap={DISCOVER_RAIL} scrollKey="home-row-concerts-discover" nowMs={nowMs} today={today} openLink={openLink} going={going} snippet={snippet}
        />
      )}
    </>
  )
}
