/**
 * The Record Shop's For You page (2026-11-09 reorganization: one band per
 * question, new-to-buy first and owned last, every card once; the bands and
 * their order are common/record-shop-page.ts). Built on:
 *
 * Discover — typed, multi-lane feed (2026-07-14 ground-up rebuild).
 *
 * Jake killed the old radar view: "wordy and sloppy… it doesn't know what
 * it is recommending at all. songs, artists, albums, new old in between."
 * The rebuilt feed fixes exactly that:
 *
 *   - Four lanes: Brand New · You're Missing · Time Machine · Songs to Try
 *   - Every card carries a TYPE badge (SONG / ALBUM / ARTIST) + its era
 *   - The % is the brain's cosine vs Jake's taste exemplars
 *   - The why is ≤ 8 words. Phrases, not paragraphs.
 *   - ▶ previews songs · + jots it onto the list · ✕ = never again
 *
 * Grounding: LLM-lane cards were verified against iTunes in main before
 * they got here; "You're Missing" comes straight from MusicBrainz
 * discographies minus what the library owns.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } from 'react'
import type { DiscoveryLearned, Recommendation } from '../types'
import PageGate from '../components/PageGate'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../previewPlayer'
import { useLibrary } from '../context/LibraryContext'
import { sessionArtistImages, hashColor, initials, prefetchArtistPortraits } from '../utils/artistPortrait'
import { useAudio } from '../hooks/useAudio'
import AlbumArtImage from '../components/AlbumArtImage'
import { useImpressions } from '../hooks/useImpressions'
import { PlayIcon, PauseIcon, CloseIcon } from '../components/TransportIcons'
import type { RediscoveryPick } from '../types'
import { CRITIC_LANE } from '../../common/critic-picks'
import {
  buildShopPage, laneChip, moreLabel, sectionLabel, shopCountLine, LANE_NAMES, SHOP_PAGE_SECTIONS, SHOP_SECTION_TITLES,
  type CrateEntry, type ShopPageSection,
} from '../../common/record-shop-page'
import { useWjlrPicks } from '../hooks/useWjlrPicks'
import { lookupArtworkOneShot } from '../utils/artworkLookup'
import {
  getLtlDownloadSnapshot, subscribeLtlDownload, queueRecoDownload, prefillDownloadView, openBrowse,
} from '../listen-to-the-list/ltlDownload'
import '../styles/discover-feed.css'

interface FeedCard {
  lane: string
  type: 'song' | 'album' | 'artist'
  artist: string
  title: string
  year?: string
  why: string
  /** Artist already in the library this pick bridges from. */
  because?: string
  artUrl?: string
  previewUrl?: string
  brainPct?: number
  genre?: string
  bin?: string
  hookPreviewUrl?: string
  hookTitle?: string
  desc?: string
}
interface Lane { id: string; title: string; cards: FeedCard[] }
// "For your iPods" (2026-11-09; main/ipod-wanted-shelf.ts on
// feat/shop-for-your-ipods): what each iPod list is missing. Kept between
// visits like the feed; refreshed quietly on arrival. Until main registers
// 'ipod-lists:wanted-shelf' the call fails and the band simply isn't drawn.
interface WantedShelf { listId: string; listName: string; title: string; cards: FeedCard[] }
let wantedCache: WantedShelf[] | null = null

let feedCache: Lane[] | null = null
let feedAtCache: number | null = null
let rediscCache: RediscoveryPick[] | null = null
// A background refresh that lands while Jake is LOOKING at the page must
// not reshuffle it (the "glitchy" feel — cards jumping mid-browse). The
// fresh feed parks here and is adopted on the NEXT visit; only per-card
// enrichment (art, preview, year, brain %) merges into the open page.
let pendingFeed: { lanes: Lane[]; generatedAt: number } | null = null

const cardId = (c: FeedCard) => `disc|${c.artist}|${c.title}`.toLowerCase()

// Picks put on the Listen List this session. Main leaves listed cards out of
// every feed it serves (dropListed); the copies kept between visits drop them
// too, so an added card can't flash back with "+ List" on the next arrival.
// The open page keeps it, marked "On your list ✓".
const listedIds = new Set<string>()
const withoutListedIds = (ls: Lane[]): Lane[] =>
  ls.map((l) => ({ ...l, cards: l.cards.filter((c) => !listedIds.has(cardId(c))) })).filter((l) => l.cards.length > 0)

export default function NewForYouView() {
  const [lanes, setLanes] = useState<Lane[]>(feedCache ?? [])
  const [loading, setLoading] = useState(feedCache === null)
  const [error, setError] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<number | null>(feedAtCache)
  const [added, setAdded] = useState<Set<string>>(new Set())
  // The list entry each "+ List" made (by cardId) — once it's back, the
  // same button becomes "↓ Get" and downloads it the way the Listen List does.
  const [addedRecs, setAddedRecs] = useState<Map<string, Recommendation>>(new Map())
  const dlMap = useSyncExternalStore(subscribeLtlDownload, getLtlDownloadSnapshot)
  const [owned, setOwned] = useState<RediscoveryPick[]>(rediscCache ?? [])
  const [wantedShelves, setWantedShelves] = useState<WantedShelf[]>(wantedCache ?? [])
  // Folded cards ("+2 more by NOFX") opened on this visit, by the lead's id.
  const [openFolds, setOpenFolds] = useState<Set<string>>(new Set())
  // Real artist photos for the Overlooked lane. Jake, twice: "that's an
  // album picture not an artist". Keyed by artist name; null = looked up,
  // none available (fall back to initials, never to a cover in a circle).
  const [portraits, setPortraits] = useState<Map<string, string | null>>(() => new Map(sessionArtistImages))
  // Page memory (2026-08-07, Jake: "many pages like home, discovery dont
  // remember where i was when i leave page").
  const pageRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('discover-page', pageRef)

  // Backfill portraits for whoever the Overlooked lane is showing. Bounded and
  // batched inside the helper so the photo IPC isn't hammered; already-known
  // names are skipped, so revisiting Discover costs nothing.
  useEffect(() => {
    if (owned.length === 0) return
    let cancelled = false
    void (async () => {
      const pairs = await prefetchArtistPortraits(
        owned.map((p) => p.artist),
        portraits,
        { cancelled: () => cancelled },
      )
      if (cancelled || pairs.length === 0) return
      setPortraits((prev) => {
        const next = new Map(prev)
        for (const [name, slug] of pairs) next.set(name, slug)
        return next
      })
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owned])
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const { state: lib, dispatch } = useLibrary()
  const { playTrack } = useAudio()
  // "In Your Library" — music Jake OWNS but overlooks (the rediscovery
  // engine). One click PLAYS it: no list, no download — it's sitting
  // right there.
  useEffect(() => {
    if (rediscCache !== null) return
    void window.electronAPI.getRediscovery?.().then((r) => {
      if (r?.ok && r.picks) { rediscCache = r.picks; setOwned(r.picks) }
    })
  }, [])

  // Jake (2026-11-09): "the songs i dont have for y2k, 80's and indie
  // sleaze....thats the type of stuff that should go in the record shop."
  useEffect(() => {
    void window.electronAPI.ipodWantedShelf?.().then((r) => {
      if (r?.ok && r.shelves) { wantedCache = r.shelves; setWantedShelves(r.shelves) }
    }).catch(() => { /* the band simply isn't there */ })
  }, [])

  const playOwned = (pick: RediscoveryPick) => {
    const nrm = (x: string) => (x || '').trim().toLowerCase()
    const tracks = lib.tracks.filter((t) => nrm(t.albumArtist || t.artist) === nrm(pick.artist))
    if (tracks.length) playTrack(tracks[0], tracks, 0, undefined, true)
  }

  const load = async (force = false, quiet = false) => {
    if (!quiet) setLoading(true)
    setError(null)
    try {
      const r = await window.electronAPI.getDiscoverFeed?.(force)
      if (r?.ok && r.lanes) {
        feedCache = r.lanes; feedAtCache = r.generatedAt ?? Date.now()
        setLanes(r.lanes); setGeneratedAt(feedAtCache)
      } else {
        setError(r?.error || 'Discover is unavailable right now.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Discover failed.')
    } finally { setLoading(false) }
  }

  useEffect(() => {
    // A refresh that landed while the page was closed is adopted now —
    // fresh content appears BETWEEN visits, never under Jake's cursor.
    if (pendingFeed) {
      feedCache = pendingFeed.lanes; feedAtCache = pendingFeed.generatedAt
      setLanes(pendingFeed.lanes); setGeneratedAt(pendingFeed.generatedAt)
      pendingFeed = null
      return
    }
    // ALWAYS refetch on arrival (2026-08-28): the module cache used to be
    // trusted forever, so a regen that finished while another view was open
    // was never heard (the updated-push only subscribes while mounted) and
    // the shop stayed stale until relaunch — "yeah no i dont see it...."
    // Arrival IS "between visits", so adopting the newest feed here never
    // reshuffles anything under the cursor; quiet keeps the seeded page
    // from flashing a spinner.
    void load(false, feedCache !== null)
  }, [])

  // A stale feed serves instantly; when the background refresh lands, only
  // per-card enrichment (art, preview, year, brain %) merges into the open
  // page — cards never appear, vanish, or reorder mid-browse. The full
  // fresh feed waits for the next visit (pendingFeed above).
  useEffect(() => {
    const off = window.electronAPI.onDiscoverFeedUpdated?.((p) => {
      setLanes((cur) => {
        if (cur.length === 0) {
          feedCache = p.lanes; feedAtCache = p.generatedAt
          setGeneratedAt(p.generatedAt)
          return p.lanes
        }
        pendingFeed = { lanes: withoutListedIds(p.lanes), generatedAt: p.generatedAt }
        const key = (c: FeedCard) => `${c.artist}|${c.title}`.toLowerCase()
        const fresh = new Map<string, FeedCard>()
        for (const l of p.lanes) for (const c of l.cards) fresh.set(key(c), c)
        const merged = cur.map((l) => ({
          ...l,
          cards: l.cards.map((c) => {
            const f = fresh.get(key(c))
            if (!f) return c
            return {
              ...c,
              artUrl: c.artUrl || f.artUrl,
              previewUrl: c.previewUrl || f.previewUrl,
              year: c.year || f.year,
              brainPct: f.brainPct ?? c.brainPct,
            }
          }),
        }))
        feedCache = withoutListedIds(merged)
        return merged
      })
    })
    return () => { off?.() }
  }, [])

  // Impressions: a card counts as shown only once it was really on screen
  // (hooks/useImpressions.ts) — the denominator Discovery acceptance lacked.
  const seenRef = useImpressions<FeedCard>((batch) => {
    void window.electronAPI.tasteLedgerAppend?.(batch.map(({ meta: c }) => ({
      surface: 'discover', verdict: 'shown',
      key: { artist: c.artist, title: c.title },
      ctx: { lane: c.lane, type: c.type },
    })))
  })

  const notForMe = (c: FeedCard) => {
    void window.electronAPI.discoveryNotForMe?.(c.artist, cardId(c))
    window.setTimeout(loadLearned, 300)   // the number must visibly move
    void window.electronAPI.tasteLedgerAppend?.([{
      surface: 'discover', verdict: 'reject',
      key: { artist: c.artist, title: c.title },
      ctx: { lane: c.lane, type: c.type },
    }])
    const next = lanes.map((l) => ({ ...l, cards: l.cards.filter((x) => x.artist !== c.artist) })).filter((l) => l.cards.length > 0)
    feedCache = withoutListedIds(next)
    setLanes(next)
  }

  const addToList = async (c: FeedCard) => {
    const id = cardId(c)
    setAdded((s) => new Set(s).add(id))
    void window.electronAPI.tasteLedgerAppend?.([{
      surface: 'discover', verdict: 'accept',
      key: { artist: c.artist, title: c.title },
      ctx: { lane: c.lane, type: c.type },
    }])
    const res = await window.electronAPI.addRecommendation({
      song: c.type === 'song' ? c.title : undefined,
      album: c.type === 'album' ? c.title : undefined,
      artist: c.artist,
      source: 'radar',
    })
    // Only once it's really on the list: a failed add must still show next visit.
    if (res?.ok) {
      listedIds.add(id)
      if (feedCache) feedCache = withoutListedIds(feedCache)
      if (pendingFeed) pendingFeed = { ...pendingFeed, lanes: withoutListedIds(pendingFeed.lanes) }
      const rec = res.recommendation
      if (rec) setAddedRecs((m) => new Map(m).set(id, rec))
    }
  }

  // The Listen List's own door (ListenToTheListView getReco): a song queues
  // on the one scheduler; an album has its EDITION picked in Browse first;
  // an artist-only pick is browsed, never downloaded blind.
  const getReco = (rec: Recommendation) => {
    const d = queueRecoDownload(rec)
    if (d.kind === 'select-edition') { prefillDownloadView(rec, 'album'); openBrowse(dispatch) }
    else if (d.kind === 'browse-only') { prefillDownloadView(rec, 'song'); openBrowse(dispatch) }
  }

  // ── What I've learned ────────────────────────────────────────────────
  // Jake: "hard to know if you are actually learning my tastes or not based
  // on what is recommended." So the page says so, out loud, using the ledger
  // it already keeps. Refetched whenever a verdict is given, because the
  // whole point is that an action visibly moves the number.
  const [learned, setLearned] = useState<DiscoveryLearned | null>(null)
  const loadLearned = useCallback(() => {
    window.electronAPI.discoveryLearned?.()
      .then((r) => { if (r?.ok && r.summary) setLearned(r.summary) })
      .catch(() => { /* the panel simply doesn't render */ })
  }, [])
  useEffect(() => { loadLearned() }, [loadLearned])

  // ── The page (2026-11-09 reorganization) ────────────────────────────
  // The old page opened with three rows of music Jake already owns, then
  // "Today's 25 New Records" (mostly catalog), then one genre crate called
  // "Misc" and a catch-all "More Finds" that a 6-card cap quietly trimmed.
  // Now: For Your iPods → Out This Year → The Crates (Jake's own filing,
  // fixed order, albums first, one card per artist, nothing capped) → the
  // hosts' picks and Behind the Counter, both already in the library →
  // What I've learned. buildShopPage decides; this only draws.
  const year = String(new Date().getFullYear())
  const page = useMemo(() => buildShopPage({ lanes, wanted: wantedShelves, year }), [lanes, wantedShelves, year])

  const laneReason = (c: FeedCard): string | null => {
    switch (c.lane) {
      case 'brand-new': return c.year ? `Out in ${c.year}` : 'Out recently'
      case 'time-machine': return c.year ? `From ${c.year} — an era you play` : 'From an era you play'
      case 'scene': return 'From the scene around your library'
      case 'missing': return "You're missing this one"
      case 'songs': return 'One song to try'
      case 'fresh-albums': return 'Not in your library'
      case 'fresh-songs': return 'Not in your library'
      case CRITIC_LANE: return "A critic's pick"
      case 'ipod-wanted': return c.why
      default: return null
    }
  }

  const shopCard = (c: FeedCard, section?: string) => {
    const id = cardId(c)
    const isPlaying = preview.playingId === id
    const isAdded = added.has(id)
    const sampleUrl = c.type === 'album' ? c.hookPreviewUrl : c.previewUrl
    return (
      <div key={id} ref={seenRef(id, c)} className="store-card store-card--reco">
        <div className="store-art">
          <div className="df-art-ph" aria-hidden="true">♪</div>
          {c.artUrl && <img className="store-art-img" src={c.artUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
          {c.brainPct != null && <span className="store-pct" title="Brain match vs your taste">{c.brainPct}%</span>}
          {c.lane !== 'ipod-wanted' && <button type="button" className="store-nope" title={`Never show ${c.artist} again`} aria-label="Not for me" onClick={() => notForMe(c)}><CloseIcon /></button>}
          {sampleUrl && (
            <button type="button" className={`store-play store-play--btn${isPlaying ? ' store-play--on' : ''}`}
              onClick={() => togglePreview(id, sampleUrl, c.type === 'album' && c.hookTitle ? `${c.title} · ${c.hookTitle}` : c.title, c.artist)}
              title={isPlaying ? 'Stop' : (c.type === 'album' && c.hookTitle ? `Sample: ${c.hookTitle}` : 'Preview')}>
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
          )}
        </div>
        <div className="store-meta-line">
          <span className={`df-type df-type--${c.type}`}>{c.type}</span>
          {c.year && <span className="store-year">{c.year}</span>}
          <span className="store-lane">{section ?? laneChip(c, year)}</span>
        </div>
        <div className="store-name" title={c.title}>{c.type === 'artist' ? c.artist : c.title}</div>
        {c.type !== 'artist' && <div className="store-artist" title={c.artist}>{c.artist}</div>}
        {c.because
          ? <div className="store-because">Because you play <b>{c.because}</b></div>
          : laneReason(c) ? <div className="store-because store-because--lane">{laneReason(c)}</div> : null}
        {c.why && c.lane !== 'ipod-wanted' && !/^Neighbors with /.test(c.why) && <div className="store-pitch">{c.why}</div>}
        {(() => {
          if (!isAdded) {
            return <button type="button" className="store-add" onClick={() => void addToList(c)}>+ List</button>
          }
          const rec = addedRecs.get(id)
          const dl = rec ? dlMap.get(rec.id)?.state ?? 'idle' : null
          if (!rec || dl === 'queued' || dl === 'downloading' || dl === 'done') {
            const label = !rec ? 'On your list ✓' : dl === 'queued' ? 'Queued…' : dl === 'downloading' ? 'Getting…' : 'In your library ✓'
            return <button type="button" className="store-add store-add--done" disabled>{label}</button>
          }
          const failed = dl === 'error'
          return (
            <button type="button" className="store-add" onClick={() => getReco(rec)}
              title={failed ? (dlMap.get(rec.id)?.error || 'Download failed — try again') : c.type === 'song' ? 'Download to your library' : c.type === 'album' ? 'Pick the edition in Browse' : 'Browse their records'}>
              {failed ? 'Retry ↓' : '↓ Get'}
            </button>
          )
        })()}
      </div>
    )
  }

  // One artist, one card; the rest fold behind it and open in place.
  const entryCards = (e: CrateEntry<FeedCard>) => {
    const leadId = cardId(e.lead)
    const open = openFolds.has(leadId)
    const section = e.section ? sectionLabel(e.section) : undefined
    return [
      shopCard(e.lead, section),
      ...(e.more.length ? [
        <button key={`${leadId}|fold`} type="button" className={`store-fold${open ? ' store-fold--open' : ''}`}
          aria-expanded={open}
          onClick={() => setOpenFolds((cur) => { const n = new Set(cur); if (n.has(leadId)) n.delete(leadId); else n.add(leadId); return n })}>
          {open ? `Fold ${e.lead.artist} back` : moreLabel(e)}
        </button>,
      ] : []),
      ...(open ? e.more.map((m) => shopCard(m, section)) : []),
    ]
  }

  const sectionHead = (id: ShopPageSection, note?: string) => (
    <div className="store-section-head">
      <h2 className="store-section-title">{SHOP_SECTION_TITLES[id].title}</h2>
      {SHOP_SECTION_TITLES[id].sub && <span className="store-section-sub">{SHOP_SECTION_TITLES[id].sub}</span>}
      {note && <span className="store-section-note">{note}</span>}
    </div>
  )

  // ── The hosts' picks — the WJLR personas' weekly rows. Music Jake already
  // owns: moved down beside Behind the Counter and labeled so (2026-11-09).
  const shelves = useWjlrPicks(useMemo(
    () => lib.tracks.map((t) => ({ id: t.id, title: t.title || '', artist: t.artist || '', album: t.album || '', genre: t.genre || '', year: t.year ?? '' })),
    [lib.tracks],
  ))
  const trackById = useMemo(() => new Map(lib.tracks.map((t) => [t.id, t])), [lib.tracks])

  const hostRows = (shelves ?? []).map((sh) => ({ sh, picks: sh.trackIds.map((tid) => trackById.get(tid)).filter((t): t is NonNullable<typeof t> => !!t).slice(0, 12) }))
    .filter((r) => r.picks.length > 0)

  // Every band, drawn in SHOP_PAGE_SECTIONS order (the order is data, tested).
  const bands: Record<ShopPageSection, JSX.Element | null> = {
    'for-your-ipods': page.ipods.length === 0 ? null : (
      <section key="for-your-ipods" className="store-section" data-section="for-your-ipods">
        {sectionHead('for-your-ipods')}
        {page.ipods.map((sh) => (
          <section key={sh.listId} className="store-shelf" data-lane={`ipod-wanted-${sh.listId}`}>
            <div className="store-shelf-head">
              <span className="store-shelf-title">{sh.title}</span>
              <span className="store-shelf-count">{sh.entries.length} pick{sh.entries.length === 1 ? '' : 's'}</span>
            </div>
            <div className="store-row">{sh.entries.flatMap(entryCards)}</div>
          </section>
        ))}
      </section>
    ),
    'out-this-year': page.outThisYear.length === 0 ? null : (
      <section key="out-this-year" className="store-section" data-section="out-this-year">
        {sectionHead('out-this-year', `${page.counts.outThisYear} from ${year}`)}
        <div className="store-row store-row--wrap">{page.outThisYear.flatMap(entryCards)}</div>
      </section>
    ),
    crates: page.crates.length === 0 ? null : (
      <section key="crates" className="store-section" data-section="crates">
        {sectionHead('crates', shopCountLine(page.counts))}
        {page.crates.map((cr) => (
          <section key={cr.id} className="store-shelf" data-lane={`crate-${cr.id}`}>
            <div className="store-shelf-head">
              <span className="store-shelf-title">{cr.label}</span>
              <span className="store-shelf-count">{cr.count} pick{cr.count === 1 ? '' : 's'}</span>
            </div>
            <div className="store-row">{cr.entries.flatMap(entryCards)}</div>
          </section>
        ))}
      </section>
    ),
    'hosts-picks': hostRows.length === 0 ? null : (
      <section key="hosts-picks" className="store-section store-section--owned" data-section="hosts-picks">
        {sectionHead('hosts-picks')}
        {hostRows.map(({ sh, picks }) => (
          <section key={sh.id} className="store-shelf" data-lane={`staff-${sh.accent}`}>
            <div className="store-shelf-head">
              <span className={`staff-dot staff-dot--${sh.accent}`} aria-hidden="true" />
              <span className="store-shelf-title">{sh.label} Picks</span>
              <span className="store-shelf-owned">already in your library</span>
              {sh.commentary && <span className="store-shelf-note" title={sh.commentary}>“{sh.commentary.length > 110 ? sh.commentary.slice(0, 107).replace(/\s+\S*$/, '') + '…' : sh.commentary}”</span>}
              <button type="button" className="store-seeall" onClick={() => dispatch({ type: 'VIEW_SMART_PLAYLIST', id: sh.id })}>See All ›</button>
            </div>
            <div className="store-row">
              {picks.map((t, ti) => (
                <div key={t.id} className="store-card" onClick={() => playTrack(t, picks, ti, undefined, true, true)} title={`Play ${t.title}`}>
                  <div className="store-art">
                    <div className="df-art-ph" aria-hidden="true">♪</div>
                    {(() => { const h = lookupArtworkOneShot(lib.artworkMap, t.artist, t.album); return h ? <AlbumArtImage hash={h} alt="" className="store-art-img" size={320} /> : null })()}
                    <span className="store-play" aria-hidden="true"><PlayIcon size={16} /></span>
                  </div>
                  <div className="store-name" title={t.title}>{t.title}</div>
                  <div className="store-artist" title={t.artist}>{t.artist}</div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </section>
    ),
    'behind-the-counter': owned.length === 0 ? null : (
      <section key="behind-the-counter" className="store-section store-section--owned df-lane" data-section="behind-the-counter" data-lane="behind-counter">
        {sectionHead('behind-the-counter')}
        <div className="df-row">
          {owned.map((pk) => (
            // ARTIST cards (Jake: "those are supposed to be ARTISTS") —
            // circles, artist name front and centered, album demoted to
            // the tooltip alongside Music Man's pitch.
            <div key={`${pk.artist}|${pk.album}`} className="df-card df-card--artist">
              <button type="button" className="df-art df-art--btn" title={pk.reason || `Play ${pk.artist}`} onClick={() => playOwned(pk)}>
                {/* An ARTIST card shows the ARTIST. Portrait when we have
                    one, honest initials disc when we don't. Never a cover. */}
                {portraits.get(pk.artist)
                  ? <img className="df-portrait" src={`artist-image://${portraits.get(pk.artist)}.jpg`} alt="" draggable={false} />
                  : <div className="df-initials" style={{ background: hashColor(pk.artist) }}>{initials(pk.artist)}</div>}
                <span className="df-play df-play--owned" aria-hidden="true"><PlayIcon size={15} /></span>
              </button>
              <div className="df-badge-row df-badge-row--center">
                <span className="df-type df-type--owned">Artist</span>
                <span className="df-year">{pk.plays} play{pk.plays === 1 ? '' : 's'}</span>
              </div>
              <div className="df-name df-name--center" title={`${pk.artist}${pk.album ? ` — ${pk.album}` : ''}`}>{pk.artist}</div>
            </div>
          ))}
        </div>
      </section>
    ),
    // A report about the shop, not part of it: a quiet strip at the bottom,
    // with the way to Rock DNA (out of the shop's tabs since 2026-11-09).
    'what-ive-learned': (
      <section key="what-ive-learned" className={`df-learned df-learned--quiet df-learned--${learned?.confidence ?? 'low'}`} data-section="what-ive-learned">
        <div className="df-learned-head">
          <span className="df-learned-eyebrow">{SHOP_SECTION_TITLES['what-ive-learned'].title}</span>
          {learned && <span className="df-learned-headline">{learned.headline}</span>}
          <button type="button" className="store-seeall" onClick={() => dispatch({ type: 'SET_VIEW', view: 'rock-dna' })}>Tune my taste: Rock DNA ›</button>
        </div>
        {learned && (
          <div className="df-learned-stats">
            <span><b>{learned.accepts}</b> kept</span>
            <span><b>{learned.rejects}</b> turned down</span>
            {learned.stripSignals > 0 && (
              <span className="df-learned-dim">{learned.stripSignals.toLocaleString()} more from your playlists</span>
            )}
            {learned.learnedAt && (
              <span className="df-learned-dim">last studied {new Date(learned.learnedAt).toLocaleDateString()}</span>
            )}
          </div>
        )}
        {learned && learned.lanes.length > 0 && (
          <div className="df-learned-lanes">
            {learned.lanes.map((l: DiscoveryLearned['lanes'][number]) => (
              <span key={l.lane} className="df-learned-lane">
                {LANE_NAMES[l.lane] ?? l.lane}
                <b className="df-learned-yes">+{l.accepts}</b>
                {l.rejects > 0 && <b className="df-learned-no">−{l.rejects}</b>}
              </span>
            ))}
          </div>
        )}
        {learned && learned.stoppedShowing.length > 0 && (
          <div className="df-learned-stopped">
            Stopped showing you: {learned.stoppedShowing.slice(0, 6).map((s2: DiscoveryLearned['stoppedShowing'][number]) => s2.artist).join(', ')}
            {learned.stoppedShowing.length > 6 ? ` +${learned.stoppedShowing.length - 6} more` : ''}
          </div>
        )}
      </section>
    ),
  }

  return (
    <div className="df-view" ref={pageRef}>
      <div className="store-head">
        <div>
          <h1 className="store-title">The Record Shop</h1>
          <span className="store-sub">WJLR Records · Greenpoint{generatedAt ? ` · restocked ${new Date(generatedAt).toLocaleDateString()}` : ''}</span>
        </div>
        <div className="store-head-right">
          <button type="button" className="store-btn" onClick={() => void load(true)} disabled={loading}>
            {loading ? 'Restocking…' : '↻ Restock'}
          </button>
        </div>
      </div>

      {loading && lanes.length === 0 && (
        <PageGate note="Reading your taste…" layout="grid" />
      )}
      {error && !loading && lanes.length === 0 && <div className="df-error">{error}</div>}

      {SHOP_PAGE_SECTIONS.map((id) => bands[id])}
    </div>
  )
}
