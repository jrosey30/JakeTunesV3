/**
 * Home — the desktop launch page (first view after splash).
 *
 * V7 (2026-11-24, Jake's approved design; it was ~16 rows):
 *
 *   1. Tonight on JakeTunes   one album, ▶ Play and Shuffle (components/HomeHero.tsx)
 *   2. three shelves          Listen more, On repeat, Recently added, each with
 *                             See All (components/HomeShelves.tsx)
 *   3. Shows                  upcoming shows, "Were you there?" (components/HomeShows.tsx)
 *
 * Year in Review joins in December only. Which sections may draw, and where
 * everything that left the Home lives now (Made for You, Record Shop › News),
 * is common/home-layout.ts — homeSections and MOVED_OFF_HOME. An empty library
 * gets the welcome instead.
 *
 * The phone's new Home is the same idea (hero, one For you rail, Tonight,
 * Listening Room): V7 and Mobile V3 stay aligned.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getCached, setCached } from '../homeCache'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import ScrollTopButton from '../components/ScrollTopButton'
import { buildNormalizedArtworkIndex } from '../utils/artworkLookup'
import YirHomeCard from '../components/yir/YirHomeCard'
import HomeHero from '../components/HomeHero'
import HomeShelves from '../components/HomeShelves'
import { useNavigation } from '../context/NavigationContext'
import { useBackLabel } from '../hooks/useBackLabel'
import BackButton from '../components/chrome/BackButton'
import { HomeItemMenusProvider, useHomeItemMenusHost } from '../components/HomeItemMenus'
import HomeShows from '../components/HomeShows'
import { asConcertsState, type ConcertsFeedState } from '../../common/concerts-feed'
import { homeSections } from '../../common/home-layout'
import '../styles/home.css'

export default function HomeView() {
  const { state: lib, dispatch } = useLibrary()

  // Home's rows use the REGULAR library: a declared concert's songs never
  // count here (2026-08-08). Same projection every other list wraps its source in.
  const regularTracks = useRegularLibraryTracks(lib.tracks)
  const { playTrack } = useAudio()
  // Right-click menus for the Home's songs and albums (components/HomeItemMenus.tsx).
  const homeMenus = useHomeItemMenusHost(playTrack)

  // Jake, 2026-10-30 ("make going back obvious on every page"): Home carries
  // its own back pill at the spot the shell's strip puts it on every other page
  // (16px, 6px; backPill.ts). Hidden when there is nowhere to go back to.
  const { canGoBack: canNavBack, goBack: navBack } = useNavigation()
  const navBackLabel = useBackLabel()

  // Scroll position survives leaving the view (4.4.13 hook).
  const rootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('home', rootRef)

  // Shows: homemini's ranked concerts feed, cached in main, with Bandsintown +
  // the venue calendars as main's fallback (ipc/concerts-ipc.ts). get = instant
  // from main's cache; refresh = one GET pair, throttled in main; the push keeps
  // an open Home current. The hero reads it too (its show line).
  const [concerts, setConcerts] = useState<ConcertsFeedState | null>(() => getCached('concerts') ?? null)
  useEffect(() => {
    let cancelled = false
    const take = (raw: unknown): void => {
      const s = asConcertsState(raw)
      if (cancelled || !s) return
      setCached('concerts', s)
      setConcerts(s)
    }
    void (async () => {
      try {
        take((await window.electronAPI.concertsGet?.())?.state)
        take((await window.electronAPI.concertsRefresh?.())?.state)
      } catch (err) {
        console.warn('[home] concerts lane failed:', err)
      }
    })()
    const off = window.electronAPI.onConcertsUpdated?.((state) => { take(state) })
    return () => { cancelled = true; off?.() }
  }, [])

  const openLink = useCallback((url: string) => {
    void window.electronAPI.openExternalUrl(url)
  }, [])
  const openImport = useCallback(() => {
    window.dispatchEvent(new Event('jaketunes-import-files'))
  }, [])

  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const heroShows = useMemo(() => (concerts ? [...concerts.items, ...concerts.discover] : []), [concerts])

  const sections = homeSections({
    now: new Date(),
    libraryEmpty: lib.tracks.length === 0,
    shows: concerts ? concerts.items.length + concerts.discover.length : 0,
  })

  return (
    // Right-click + drag on the Home's songs and albums (HomeItemMenus): the
    // menus and sheets render beside .home-view, outside its stacking context.
    <HomeItemMenusProvider value={homeMenus.api}>
    <div className="home-view" ref={rootRef}>
      {canNavBack && navBackLabel !== null && (
        // A zero-height row at the top of the scroll content (home.css); with
        // no art band under it, it takes the strip's 36px.
        <div className="home-back"><BackButton label={navBackLabel} onClick={navBack} /></div>
      )}

      {sections.includes('welcome') && (
        <section className="home-welcome-empty" aria-label="Start your library">
          <div className="home-welcome-empty-mark" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="20" cy="20" r="6" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="20" cy="20" r="2" fill="currentColor" />
            </svg>
          </div>
          <h2 className="home-welcome-empty-title">The Shelves Are Empty</h2>
          <p className="home-welcome-empty-body">
            Drop a folder of music onto this window, or import files to start a library.
            JakeTunes will take it from there.
          </p>
          <div className="home-welcome-empty-actions">
            <button type="button" className="home-featured-btn home-featured-btn--primary" onClick={openImport}>
              Import music…
            </button>
            <button type="button" className="home-featured-btn" onClick={() => dispatch({ type: 'SET_VIEW', view: 'discovery' })}>
              Browse the Record Shop
            </button>
          </div>
        </section>
      )}

      {sections.includes('hero') && (
        <HomeHero tracks={regularTracks} artworkMap={lib.artworkMap} artIndex={normalizedArtIndex} shows={heroShows} dispatch={dispatch} playTrack={playTrack} />
      )}

      {/* December only (common/home-layout.ts); all year on Made for You. */}
      {sections.includes('year-in-review') && <YirHomeCard />}

      {sections.includes('shelves') && (
        <HomeShelves tracks={lib.tracks} regularTracks={regularTracks} artworkMap={lib.artworkMap} artIndex={normalizedArtIndex} dispatch={dispatch} playTrack={playTrack} />
      )}

      {sections.includes('shows') && concerts !== null && (
        <section className="home-section home-section--shows">
          <div className="home-section-header">
            <h2 className="home-section-title">Shows</h2>
          </div>
          <HomeShows state={concerts} openLink={openLink} />
        </section>
      )}
    </div>
    {/* Fixed bottom-right; kept outside .home-view (an isolated stacking
        context, home.css) so it layers against the queue panel as in every
        other view. */}
    <ScrollTopButton targetRef={rootRef} />
    {homeMenus.overlays}
    </HomeItemMenusProvider>
  )
}
