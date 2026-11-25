/**
 * Year in Review (2026-10-12, Jake: "build it"; format = BOTH): the story
 * slides for the December 17 reveal, and the whole year on one page to
 * browse. Opened from its card (Made for You all year; the Home in December). Facts: the nightly homemini build,
 * mirrored here (src/main/yir-mirror.ts); cards: src/common/yir-story.ts.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirPageView.swift (YearInReviewPage) + YirStoryView.swift.
 */
import { useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useNavigation } from '../context/NavigationContext'
import { yearInReviewHomeView } from '../../common/home-layout'
import { buildNormalizedArtworkIndex } from '../utils/artworkLookup'
import { buildStory } from '../../common/yir-story'
import { useYirFacts, useStoryConcerts } from '../components/yir/yirData'
import { takeYirMode, type YirMode } from '../components/yir/yirNav'
import YirStory from '../components/yir/YirStory'
import YirPage from '../components/yir/YirPage'
import type { YirCtx } from '../components/yir/YirImg'
import '../styles/year-in-review.css'

export default function YearInReviewView(): JSX.Element {
  const { state: lib, dispatch } = useLibrary()
  const { canGoBack, goBack } = useNavigation()
  const year = new Date().getFullYear()
  const { facts, loading } = useYirFacts(year)
  const concerts = useStoryConcerts(lib.tracks)
  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const ctx = useMemo((): YirCtx => ({ tracks: lib.tracks, artworkMap: lib.artworkMap, artIndex, concerts }), [lib.tracks, lib.artworkMap, artIndex, concerts])
  const [mode, setMode] = useState<YirMode>(takeYirMode)
  const slides = useMemo(() => (facts ? buildStory(facts, { now: new Date(), concerts }) : []), [facts, concerts])

  if (loading) return <div className="yir-wait">Loading your year…</div>
  if (!facts) return <div className="yir-wait">Your Year in Review hasn't reached this Mac yet.</div>
  if (mode === 'story') {
    // Closing goes back where you came from; with nowhere to go back to, to the
    // page its card is on: the Home in December, Made for You otherwise (V7).
    const close = (): void => { if (canGoBack) goBack(); else dispatch({ type: 'SET_VIEW', view: yearInReviewHomeView(new Date()) }) }
    return <YirStory slides={slides} ctx={ctx} onClose={close} onSeeAll={() => setMode('page')} />
  }
  return <YirPage y={facts} ctx={ctx} onStory={() => setMode('story')} />
}
