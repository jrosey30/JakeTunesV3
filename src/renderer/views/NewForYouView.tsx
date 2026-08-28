/**
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
import type { DiscoveryLearned } from '../types'
import PageGate from '../components/PageGate'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../previewPlayer'
import { useLibrary } from '../context/LibraryContext'
import { sessionArtistImages, hashColor, initials, prefetchArtistPortraits } from '../utils/artistPortrait'
import { useAudio } from '../hooks/useAudio'
import AlbumArtImage from '../components/AlbumArtImage'
import { PlayIcon, PauseIcon, CloseIcon } from '../components/TransportIcons'
import type { RediscoveryPick } from '../types'
import mmSmug from './RecordStore/art/musicman-smug.png'
import { binForGenre, applyBinQuotas } from '../../common/record-shop-bins'
import { useWjlrPicks } from '../hooks/useWjlrPicks'
import { lookupArtworkOneShot } from '../utils/artworkLookup'
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
}
interface Lane { id: string; title: string; cards: FeedCard[] }

let feedCache: Lane[] | null = null
let feedAtCache: number | null = null
let rediscCache: RediscoveryPick[] | null = null
// A background refresh that lands while Jake is LOOKING at the page must
// not reshuffle it (the "glitchy" feel — cards jumping mid-browse). The
// fresh feed parks here and is adopted on the NEXT visit; only per-card
// enrichment (art, preview, year, brain %) merges into the open page.
let pendingFeed: { lanes: Lane[]; generatedAt: number } | null = null

const cardId = (c: FeedCard) => `disc|${c.artist}|${c.title}`.toLowerCase()

export default function NewForYouView() {
  const [lanes, setLanes] = useState<Lane[]>(feedCache ?? [])
  const [loading, setLoading] = useState(feedCache === null)
  const [error, setError] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<number | null>(feedAtCache)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [owned, setOwned] = useState<RediscoveryPick[]>(rediscCache ?? [])
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
        pendingFeed = { lanes: p.lanes, generatedAt: p.generatedAt }
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
        feedCache = merged
        return merged
      })
    })
    return () => { off?.() }
  }, [])

  const notForMe = (c: FeedCard) => {
    void window.electronAPI.discoveryNotForMe?.(c.artist, cardId(c))
    window.setTimeout(loadLearned, 300)   // the number must visibly move
    void window.electronAPI.tasteLedgerAppend?.([{
      surface: 'discover', verdict: 'reject',
      key: { artist: c.artist, title: c.title },
      ctx: { lane: c.lane, type: c.type },
    }])
    const next = lanes.map((l) => ({ ...l, cards: l.cards.filter((x) => x.artist !== c.artist) })).filter((l) => l.cards.length > 0)
    feedCache = next
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
    await window.electronAPI.addRecommendation({
      song: c.type === 'song' ? c.title : undefined,
      album: c.type === 'album' ? c.title : undefined,
      artist: c.artist,
      source: 'radar',
    })
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

  // ── Genre sections (2026-08-23 store rebuild): the crate-flip diorama is
  // gone — cards group under clean genre shelves, scannable at a glance,
  // in the app's own iTunes-Store idiom. Bin organization survives.
  // Shelf quotas (Jake: 'some genre's shouldnt have 7 picks and others 2
  // and 1'): each shelf shows its best ~6; too-thin bins fold into a
  // single 'More Finds' shelf at the end.
  const binSections = applyBinQuotas(
    lanes.flatMap((l) => l.cards).map((c) => ({ ...c, bin: c.bin ?? binForGenre(c.genre) })),
  )

  const SHOP_NAMES: Record<string, string> = {
    'brand-new': 'New', 'scene': 'Scene', 'missing': 'Gap', 'time-machine': 'Used', 'songs': 'Single',
  }
  const laneReason = (c: FeedCard): string | null => {
    switch (c.lane) {
      case 'brand-new': return c.year ? `New in ${c.year}` : 'Out now'
      case 'time-machine': return c.year ? `From ${c.year} — an era you play` : 'From an era you play'
      case 'scene': return 'From the scene around your library'
      case 'missing': return 'A gap in a genre you play'
      case 'songs': return 'One song to try'
      default: return null
    }
  }

  // ── Staff picks wall — the WJLR personas, moved in from the sidebar.
  const shelves = useWjlrPicks(useMemo(
    () => lib.tracks.map((t) => ({ id: t.id, title: t.title || '', artist: t.artist || '', album: t.album || '', genre: t.genre || '', year: t.year ?? '' })),
    [lib.tracks],
  ))
  const trackById = useMemo(() => new Map(lib.tracks.map((t) => [t.id, t])), [lib.tracks])

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
          <button type="button" className="store-btn store-btn--primary" onClick={() => dispatch({ type: 'SET_VIEW', view: 'recordstore' })}>
            <img className="df-step-inside-mm" src={mmSmug} alt="" aria-hidden="true" />
            Step Inside
          </button>
        </div>
      </div>

      {learned && (
        <section className={`df-learned df-learned--${learned.confidence}`}>
          <div className="df-learned-head">
            <span className="df-learned-eyebrow">What I've learned</span>
            <span className="df-learned-headline">{learned.headline}</span>
          </div>
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
          {learned.lanes.length > 0 && (
            <div className="df-learned-lanes">
              {learned.lanes.map((l: DiscoveryLearned['lanes'][number]) => (
                <span key={l.lane} className="df-learned-lane">
                  {SHOP_NAMES[l.lane] ?? l.lane}
                  <b className="df-learned-yes">+{l.accepts}</b>
                  {l.rejects > 0 && <b className="df-learned-no">−{l.rejects}</b>}
                </span>
              ))}
            </div>
          )}
          {learned.stoppedShowing.length > 0 && (
            <div className="df-learned-stopped">
              Stopped showing you: {learned.stoppedShowing.slice(0, 6).map((s2: DiscoveryLearned['stoppedShowing'][number]) => s2.artist).join(', ')}
              {learned.stoppedShowing.length > 6 ? ` +${learned.stoppedShowing.length - 6} more` : ''}
            </div>
          )}
        </section>
      )}

      {loading && lanes.length === 0 && (
        <PageGate note="Reading your taste…" layout="grid" />
      )}
      {error && !loading && lanes.length === 0 && <div className="df-error">{error}</div>}

      {shelves && shelves.length > 0 && shelves.map((sh) => {
        const picks = sh.trackIds.map((tid) => trackById.get(tid)).filter((t): t is NonNullable<typeof t> => !!t).slice(0, 12)
        if (!picks.length) return null
        return (
          <section key={sh.id} className="store-shelf" data-lane={`staff-${sh.accent}`}>
            <div className="store-shelf-head">
              <span className={`staff-dot staff-dot--${sh.accent}`} aria-hidden="true" />
              <span className="store-shelf-title">{sh.label} Picks</span>
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
        )
      })}

      {binSections.map(({ bin, cards }) => (
        <section key={bin} className="store-shelf" data-lane={`bin-${bin}`}>
          <div className="store-shelf-head">
            <span className="store-shelf-title">{bin}</span>
            <span className="store-shelf-count">{cards.length} pick{cards.length === 1 ? '' : 's'}</span>
          </div>
          <div className="store-row">
            {cards.map((c) => {
              const id = cardId(c)
              const isPlaying = preview.playingId === id
              const isAdded = added.has(id)
              const sampleUrl = c.type === 'album' ? c.hookPreviewUrl : c.previewUrl
              return (
                <div key={id} className="store-card store-card--reco">
                  <div className="store-art">
                    <div className="df-art-ph" aria-hidden="true">♪</div>
                    {c.artUrl && <img className="store-art-img" src={c.artUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
                    {c.brainPct != null && <span className="store-pct" title="Brain match vs your taste">{c.brainPct}%</span>}
                    <button type="button" className="store-nope" title={`Never show ${c.artist} again`} aria-label="Not for me" onClick={() => notForMe(c)}><CloseIcon /></button>
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
                    <span className="store-lane">{SHOP_NAMES[c.lane] ?? ''}</span>
                  </div>
                  <div className="store-name" title={c.title}>{c.type === 'artist' ? c.artist : c.title}</div>
                  {c.type !== 'artist' && <div className="store-artist" title={c.artist}>{c.artist}</div>}
                  {c.because
                    ? <div className="store-because">Because you play <b>{c.because}</b></div>
                    : laneReason(c) ? <div className="store-because store-because--lane">{laneReason(c)}</div> : null}
                  {c.why && <div className="store-pitch">{c.why}</div>}
                  <button type="button" className={`store-add${isAdded ? ' store-add--done' : ''}`} disabled={isAdded} onClick={() => void addToList(c)}>
                    {isAdded ? 'On your list ✓' : '+ List'}
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {owned.length > 0 && (
        <section className="df-lane" data-lane="behind-counter">
          <div className="df-lane-head">Behind the Counter</div>
          <div className="df-row">
            {owned.map((pk) => {
              return (
                // ARTIST cards (Jake: "those are supposed to be ARTISTS") —
                // circles, artist name front and centered, album demoted to
                // the tooltip alongside Music Man's pitch.
                <div key={`${pk.artist}|${pk.album}`} className="df-card df-card--artist">
                  <button type="button" className="df-art df-art--btn" title={pk.reason || `Play ${pk.artist}`} onClick={() => playOwned(pk)}>
                    {/* An ARTIST card shows the ARTIST. Album art in a circle
                        claims to be a photo of a person and isn't — that is
                        what read as sloppy. Portrait when we have one, honest
                        initials disc when we don't. Never a cover. */}
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
              )
            })}
          </div>
        </section>
      )}

    </div>
  )
}
