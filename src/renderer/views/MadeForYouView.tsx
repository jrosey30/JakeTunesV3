/**
 * Made for You — the page for what left the Home in V7 (2026-11-24, Jake's
 * approved Home: hero, three shelves, Shows; common/home-layout.ts). Nothing
 * was deleted; it moved here, in this order (sidebar: LIBRARY › Made for You):
 *
 *   Island albums + Now digging   launch page G's Cover Flow with its jewel
 *                                 case, and the new bands you can't stop
 *                                 playing (components/TonightOnJakeTunes.tsx)
 *   Today's tapes / Your mixes    homemini's daily tapes and mixes, Make me a
 *                                 vibe (components/MadeForYou.tsx)
 *   the Music Man's line          Listening Memory's quote (homemini's, over
 *                                 both devices' plays)
 *   Rediscover                    owned artists you've overlooked, in his voice
 *   Year in Review                the card, all year (the Home shows it in
 *                                 December only)
 *
 * The page wears the Home's styles (home.css, home-tonight.css) and its one
 * menu host (HomeItemMenus), so every card right-clicks and drags as it did on
 * the Home.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getCached, setCached } from '../homeCache'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { requestDrillIn } from '../utils/drillIn'
import ScrollTopButton from '../components/ScrollTopButton'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../utils/artworkLookup'
import AlbumArtImage from '../components/AlbumArtImage'
import MadeForYou from '../components/MadeForYou'
import YirHomeCard from '../components/yir/YirHomeCard'
import TonightOnJakeTunes from '../components/TonightOnJakeTunes'
import { HomeItemMenusProvider, useHomeItemMenusHost } from '../components/HomeItemMenus'
import { setAlbumDragPayload } from '../utils/trackDrag'
import { tracksForArtist } from '../utils/artistTracks'
import type { ListeningMemoryData, RediscoveryPick } from '../types'
import '../styles/home.css'

/** Enter/Space on role=button cards — mouse click already works. */
function activateOnKey(action: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      action()
    }
  }
}

export default function MadeForYouView() {
  const { state: lib, dispatch } = useLibrary()
  const regularTracks = useRegularLibraryTracks(lib.tracks)
  const { playTrack } = useAudio()
  const menus = useHomeItemMenusHost(playTrack)

  const rootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('made-for-you', rootRef)
  const rediscoverRowRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('home-row-rediscover', rediscoverRowRef)

  // Listening Memory — the Music Man's one line (the phone's quote, no stat
  // cards: Jake, 2026-06-09). Main computes it from homemini, this Mac's log
  // when homemini is away. Null → nothing drawn.
  const [memory, setMemory] = useState<ListeningMemoryData | null>(() => getCached('memory') ?? null)
  useEffect(() => {
    let cancelled = false
    window.electronAPI.getListeningMemory?.().then((r) => {
      if (!cancelled) { const v = (r?.ok && r.insights) ? (r as ListeningMemoryData) : null; setCached('memory', v); if (v) setMemory(v) }
    }).catch(() => { /* the line just doesn't render */ })
    return () => { cancelled = true }
  }, [])

  // Rediscover: owned-but-overlooked artists with the Music Man's pitch.
  const [rediscovery, setRediscovery] = useState<RediscoveryPick[] | null>(() => getCached('rediscovery') ?? null)
  useEffect(() => {
    let cancelled = false
    window.electronAPI.getRediscovery?.().then((r) => {
      if (!cancelled) { const v = (r?.ok && r.picks) ? r.picks : null; setCached('rediscovery', v); if (v) setRediscovery(v) }
    }).catch(() => { /* the row just doesn't render */ })
    return () => { cancelled = true }
  }, [])

  const playRediscovery = useCallback((pick: RediscoveryPick) => {
    const norm = (s: string) => (s || '').trim().toLowerCase()
    const tracks = lib.tracks.filter((t) => norm(t.albumArtist || t.artist) === norm(pick.artist))
    if (tracks.length) playTrack(tracks[0], tracks, 0, undefined, true)
  }, [lib.tracks, playTrack])

  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const artHashForKey = useCallback((key: string | null): string | undefined => {
    if (!key) return undefined
    if (lib.artworkMap[key]) return lib.artworkMap[key]
    const [artist, album] = key.split('|||')
    return lookupArtwork(lib.artworkMap, normalizedArtIndex, artist || '', album || '')
  }, [lib.artworkMap, normalizedArtIndex])

  return (
    <HomeItemMenusProvider value={menus.api}>
    <div className="home-view mfy-view" ref={rootRef}>
      <TonightOnJakeTunes tracks={regularTracks} artworkMap={lib.artworkMap} artIndex={normalizedArtIndex} dispatch={dispatch} />

      <MadeForYou />

      {memory?.quote && (
        <section className="home-section home-memory">
          <blockquote className="home-memory-obs">
            <span className="home-memory-quote">{'“'}{memory.quote}{'”'}</span>
            <cite>— the Music Man</cite>
          </blockquote>
        </section>
      )}

      {rediscovery && rediscovery.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">Rediscover</h2>
            <span className="home-section-source">The Music Man</span>
          </div>
          <div className="home-card-row" role="list" ref={rediscoverRowRef}>
            {rediscovery.map((pick) => {
              const hash = artHashForKey(`${pick.artist}|||${pick.album}`)
              return (
                <div
                  key={`${pick.artist}|||${pick.album}`}
                  className="home-rediscover-card"
                  role="listitem"
                  // An artist pick: drags as the artist's songs, like an Artists tile.
                  draggable
                  onDragStart={(e) => {
                    const ids = tracksForArtist(regularTracks, pick.artist).map((t) => t.id)
                    if (ids.length) setAlbumDragPayload(e, ids)
                    else e.preventDefault()
                  }}
                  title={`${pick.artist}${pick.album ? ` — ${pick.album}` : ''}\nYou own ${pick.ownedTracks}, played ${pick.plays}× here`}
                >
                  <div className="home-rediscover-art" onClick={() => playRediscovery(pick)} onKeyDown={activateOnKey(() => playRediscovery(pick))} role="button" tabIndex={0} title="Play" aria-label={`Play ${pick.artist}`}>
                    {hash ? (
                      <AlbumArtImage hash={hash} alt={pick.artist} size={320} onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')} />
                    ) : (
                      <div className="home-album-art-placeholder home-rediscover-art-ph">{pick.artist.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('')}</div>
                    )}
                    <div className="home-rediscover-play" aria-hidden="true">▶</div>
                  </div>
                  <button
                    type="button"
                    className="home-rediscover-artist"
                    onClick={() => { requestDrillIn('artist', pick.artist); dispatch({ type: 'SET_VIEW', view: 'artists' }) }}
                  >{pick.artist}</button>
                  <div className="home-rediscover-pitch">“{pick.reason}”</div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <YirHomeCard />
    </div>
    {/* Fixed bottom-right; outside .home-view (an isolated stacking context). */}
    <ScrollTopButton targetRef={rootRef} />
    {menus.overlays}
    </HomeItemMenusProvider>
  )
}
