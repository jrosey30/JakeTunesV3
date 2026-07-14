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
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../previewPlayer'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import AlbumArtImage from '../components/AlbumArtImage'
import type { RediscoveryPick } from '../types'
import '../styles/discover-feed.css'

interface FeedCard {
  lane: string
  type: 'song' | 'album' | 'artist'
  artist: string
  title: string
  year?: string
  why: string
  artUrl?: string
  previewUrl?: string
  brainPct?: number
}
interface Lane { id: string; title: string; cards: FeedCard[] }

let feedCache: Lane[] | null = null
let feedAtCache: number | null = null
let rediscCache: RediscoveryPick[] | null = null

const cardId = (c: FeedCard) => `disc|${c.artist}|${c.title}`.toLowerCase()

export default function NewForYouView() {
  const [lanes, setLanes] = useState<Lane[]>(feedCache ?? [])
  const [loading, setLoading] = useState(feedCache === null)
  const [error, setError] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<number | null>(feedAtCache)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [owned, setOwned] = useState<RediscoveryPick[]>(rediscCache ?? [])
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const { state: lib } = useLibrary()
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

  useEffect(() => { if (feedCache === null) void load() }, [])

  const notForMe = (c: FeedCard) => {
    void window.electronAPI.discoveryNotForMe?.(c.artist)
    const next = lanes.map((l) => ({ ...l, cards: l.cards.filter((x) => x.artist !== c.artist) })).filter((l) => l.cards.length > 0)
    feedCache = next
    setLanes(next)
  }

  const addToList = async (c: FeedCard) => {
    const id = cardId(c)
    setAdded((s) => new Set(s).add(id))
    await window.electronAPI.addRecommendation({
      song: c.type === 'song' ? c.title : undefined,
      album: c.type === 'album' ? c.title : undefined,
      artist: c.artist,
      source: 'radar',
    })
  }

  return (
    <div className="df-view">
      <div className="df-head">
        <h1 className="df-title">Discover</h1>
        {generatedAt && <span className="df-updated">{new Date(generatedAt).toLocaleDateString()}</span>}
        <button type="button" className="df-refresh" onClick={() => void load(true)} disabled={loading} title="Refresh picks">
          {loading ? '…' : '↻'}
        </button>
      </div>

      {loading && lanes.length === 0 && (
        <div className="df-loading">Reading your taste…</div>
      )}
      {error && !loading && lanes.length === 0 && <div className="df-error">{error}</div>}

      {owned.length > 0 && (
        <section className="df-lane">
          <div className="df-lane-head">In Your Library — Overlooked</div>
          <div className="df-row">
            {owned.map((pk) => {
              const hash = lib.artworkMap[`${pk.artist}|||${pk.album}`]
              return (
                <div key={`${pk.artist}|${pk.album}`} className="df-card">
                  <button type="button" className="df-art df-art--btn" title={`Play ${pk.artist}`} onClick={() => playOwned(pk)}>
                    {hash
                      ? <AlbumArtImage hash={hash} alt={pk.album} size={320} />
                      : <div className="df-art-ph" aria-hidden="true">♪</div>}
                    <span className="df-play df-play--owned" aria-hidden="true">▶</span>
                  </button>
                  <div className="df-badge-row">
                    <span className="df-type df-type--owned">Owned</span>
                    <span className="df-year">{pk.plays} play{pk.plays === 1 ? '' : 's'}</span>
                  </div>
                  <div className="df-name" title={pk.artist}>{pk.artist}</div>
                  {pk.album && <div className="df-artist" title={pk.album}>{pk.album}</div>}
                  {pk.reason && <div className="df-why">{pk.reason.split(/\s+/).slice(0, 10).join(' ')}</div>}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {lanes.map((lane) => (
        <section key={lane.id} className="df-lane">
          <div className="df-lane-head">{lane.title}</div>
          <div className="df-row">
            {lane.cards.map((c) => {
              const id = cardId(c)
              const isPlaying = preview.playingId === id
              const isAdded = added.has(id)
              return (
                <div key={id} className={`df-card${c.type === 'artist' ? ' df-card--artist' : ''}`}>
                  <div className="df-art">
                    {c.artUrl
                      ? <img src={c.artUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />
                      : <div className="df-art-ph" aria-hidden="true">♪</div>}
                    {c.brainPct != null && <div className="df-pct" title="Brain match vs your taste">{c.brainPct}%</div>}
                    <button type="button" className="df-nope" title={`Never show ${c.artist} again`} aria-label="Not for me"
                      onClick={() => notForMe(c)}>✕</button>
                    {c.previewUrl && (
                      <button type="button" className={`df-play${isPlaying ? ' df-play--on' : ''}`}
                        onClick={() => togglePreview(id, c.previewUrl!, c.title, c.artist)}
                        title={isPlaying ? 'Stop' : 'Preview'}>{isPlaying ? '❚❚' : '▶'}</button>
                    )}
                  </div>
                  <div className="df-badge-row">
                    <span className={`df-type df-type--${c.type}`}>{c.type}</span>
                    {c.year && <span className="df-year">{c.year}</span>}
                  </div>
                  <div className="df-name" title={c.title}>{c.type === 'artist' ? c.artist : c.title}</div>
                  {c.type !== 'artist' && <div className="df-artist" title={c.artist}>{c.artist}</div>}
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
    </div>
  )
}
