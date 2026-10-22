/**
 * Year in Review (2026-10-12, Jake: "build it"; format = BOTH): the story
 * slides for the December 17 reveal, and the whole year on one page to
 * browse. Opened from the Home card. Facts: the nightly homemini build,
 * mirrored here (src/main/yir-mirror.ts); cards: src/common/yir-story.ts.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirPageView.swift (YearInReviewPage) + YirStoryView.swift.
 */
import { useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
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
  const year = new Date().getFullYear()
  const { facts, loading } = useYirFacts(year)
  const concerts = useStoryConcerts(lib.tracks)
  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])
  const ctx = useMemo((): YirCtx => ({ tracks: lib.tracks, artworkMap: lib.artworkMap, artIndex, concerts }), [lib.tracks, lib.artworkMap, artIndex, concerts])
  const [mode, setMode] = useState<YirMode>(takeYirMode)
  const slides = useMemo(() => (facts ? buildStory(facts, { now: new Date(), concerts }) : []), [facts, concerts])

  if (loading) return <div className="yir-wait">Loading your year…</div>
  if (!facts) return <div className="yir-wait">Your Year in Review hasn't reached this Mac yet. homemini builds it every night at 4 AM.</div>
  if (mode === 'story') {
    return <YirStory slides={slides} ctx={ctx} onClose={() => dispatch({ type: 'SET_VIEW', view: 'home' })} onSeeAll={() => setMode('page')} />
  }
  return <YirPage y={facts} ctx={ctx} onStory={() => setMode('story')} />
}
