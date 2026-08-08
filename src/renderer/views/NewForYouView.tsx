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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import PageGate from '../components/PageGate'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../previewPlayer'
import { useLibrary } from '../context/LibraryContext'
import { sessionArtistImages, hashColor, initials, prefetchArtistPortraits } from '../utils/artistPortrait'
import { useAudio } from '../hooks/useAudio'
import AlbumArtImage from '../components/AlbumArtImage'
import { PlayIcon, PauseIcon, CloseIcon } from '../components/TransportIcons'
import type { RediscoveryPick } from '../types'
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

  const load = async (force = false) => {
    setLoading(true); setError(null)
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
    if (feedCache === null) void load()
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
    void window.electronAPI.discoveryNotForMe?.(c.artist)
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

  // The Record Shop (2026-08-07 rebrand): display-only lane renames +
  // shop-flow order. Feed lane ids are a wire contract — never renamed.
  const SHOP_NAMES: Record<string, string> = {
    'brand-new': 'New Arrivals',
    'scene': 'The Scene Rack',
    'missing': 'House Picks',
    'time-machine': 'The Used Bins',
    'songs': 'The Listening Booth',
  }
  const SHOP_ORDER = ['brand-new', 'scene', 'songs', 'missing', 'time-machine']
  const shopLanes = [...lanes].sort((a, b) => {
    const ai = SHOP_ORDER.indexOf(a.id); const bi = SHOP_ORDER.indexOf(b.id)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  return (
    <div className="df-view" ref={pageRef}>
      <div className="df-head">
        <h1 className="df-title df-title--sign">The Record Shop</h1>
        {generatedAt && <span className="df-updated">{new Date(generatedAt).toLocaleDateString()}</span>}
        <button type="button" className="df-refresh" onClick={() => void load(true)} disabled={loading} title="Restock the racks">
          {loading ? '…' : '↻'}
        </button>
        <button type="button" className="df-step-inside" onClick={() => dispatch({ type: 'SET_VIEW', view: 'recordstore' })}
          title="Walk into the shop">Step Inside</button>
      </div>

      {loading && lanes.length === 0 && (
        <PageGate note="Reading your taste…" layout="grid" />
      )}
      {error && !loading && lanes.length === 0 && <div className="df-error">{error}</div>}

      {shopLanes.map((lane) => (
        <section key={lane.id} className="df-lane">
          <div className="df-lane-head">{SHOP_NAMES[lane.id] ?? lane.title}</div>
          <div className="df-row">
            {lane.cards.map((c) => {
              const id = cardId(c)
              const isPlaying = preview.playingId === id
              const isAdded = added.has(id)
              return (
                <div key={id} className={`df-card${c.type === 'artist' ? ' df-card--artist' : ''}`}>
                  <div className="df-art">
                    {/* Placeholder always renders UNDER the image: a cover
                        that 404s hides itself and the ♪ shows — never a
                        blank hole (inconsistency Jake flagged). */}
                    <div className="df-art-ph" aria-hidden="true">♪</div>
                    {c.artUrl && <img src={c.artUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
                    {c.brainPct != null && <div className="df-pct" title="Brain match vs your taste">{c.brainPct}%</div>}
                    <button type="button" className="df-nope" title={`Never show ${c.artist} again`} aria-label="Not for me"
                      onClick={() => notForMe(c)}><CloseIcon /></button>
                    {c.previewUrl && (
                      <button type="button" className={`df-play${isPlaying ? ' df-play--on' : ''}`}
                        onClick={() => togglePreview(id, c.previewUrl!, c.title, c.artist)}
                        title={isPlaying ? 'Stop' : 'Preview'}>{isPlaying ? <PauseIcon /> : <PlayIcon />}</button>
                    )}
                  </div>
                  <div className="df-badge-row">
                    <span className={`df-type df-type--${c.type}`}>{c.type}</span>
                    {c.year && <span className="df-year">{c.year}</span>}
                  </div>
                  <div className="df-name" title={c.title}>{c.type === 'artist' ? c.artist : c.title}</div>
                  {c.type !== 'artist' && <div className="df-artist" title={c.artist}>{c.artist}</div>}
                  {c.because
                    ? <div className="df-because">Because you play <b>{c.because}</b></div>
                    : null}
                  {c.why && <div className="df-why">{c.why}</div>}
                  <button type="button" className={`df-add${isAdded ? ' df-add--done' : ''}`}
                    disabled={isAdded} onClick={() => void addToList(c)}>
                    {isAdded ? 'On your list ✓' : '+ List'}
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {owned.length > 0 && (
        <section className="df-lane">
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
