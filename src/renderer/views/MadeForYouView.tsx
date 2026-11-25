/**
 * Made for You — the page for what left the Home in V7 (2026-11-24, Jake's
 * approved plan: the Home is the hero, three shelves, Shows;
 * common/home-layout.ts). Sidebar: LIBRARY › Made for You. In this order:
 *
 *   Island Albums + Now Digging   launch page G's Cover Flow with its jewel
 *                                 case, and the new bands you can't stop
 *                                 playing (components/TonightOnJakeTunes.tsx)
 *   Today's tapes / Your mixes    homemini's daily tapes and mixes, Make me a
 *                                 vibe (components/MadeForYou.tsx)
 *   Year in Review                the card, all year (the Home shows it in
 *                                 December only)
 *
 * Today's pick, Rediscover and the Music Man's listening quote were cut by
 * the plan (CUT_FROM_HOME), not moved here.
 *
 * The page wears the Home's styles (home.css, home-tonight.css) and its one
 * menu host (HomeItemMenus), so every card right-clicks and drags as it did on
 * the Home.
 */
import { useMemo, useRef } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import ScrollTopButton from '../components/ScrollTopButton'
import { buildNormalizedArtworkIndex } from '../utils/artworkLookup'
import MadeForYou from '../components/MadeForYou'
import YirHomeCard from '../components/yir/YirHomeCard'
import TonightOnJakeTunes from '../components/TonightOnJakeTunes'
import { HomeItemMenusProvider, useHomeItemMenusHost } from '../components/HomeItemMenus'
import '../styles/home.css'

export default function MadeForYouView() {
  const { state: lib, dispatch } = useLibrary()
  const regularTracks = useRegularLibraryTracks(lib.tracks)
  const { playTrack } = useAudio()
  const menus = useHomeItemMenusHost(playTrack)

  const rootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('made-for-you', rootRef)

  const normalizedArtIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])

  return (
    <HomeItemMenusProvider value={menus.api}>
    <div className="home-view mfy-view" ref={rootRef}>
      <TonightOnJakeTunes tracks={regularTracks} artworkMap={lib.artworkMap} artIndex={normalizedArtIndex} dispatch={dispatch} />
      <MadeForYou />
      <YirHomeCard />
    </div>
    {/* Fixed bottom-right; outside .home-view (an isolated stacking context). */}
    <ScrollTopButton targetRef={rootRef} />
    {menus.overlays}
    </HomeItemMenusProvider>
  )
}
