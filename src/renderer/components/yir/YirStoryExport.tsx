/**
 * Year in Review → Instagram Story frames, desktop side (2026-10-29, Jake: "this needs to work
 * on ig story too"; "everything in year in review"). Main opens this page in a hidden,
 * offscreen 1080×1920 window (src/main/yir-export.ts) and steps it frame by frame:
 * window.__yirSeek(card, ms) shows card `card` as it looks `ms` after it opened — every CSS
 * animation paused and set to that moment, every count-up read from the same clock — and main
 * captures the frame. Nothing but the background in Instagram's covered bands (top 250 px,
 * bottom 340 px), and a small JakeTunes mark inside the safe zone.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirStoryExport.swift (same frame, same bands).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buildStory, type Slide } from '../../../common/yir-story'
import { STORY_SAFE } from '../../../common/friend-share-card'
import { buildNormalizedArtworkIndex } from '../../utils/artworkLookup'
import { useStoryConcerts } from './yirData'
import { ensureLiveSetsLoaded } from '../../liveSets'
import { Backdrop, SlideBody, YirClock } from './YirStory'
import type { YirCtx } from './YirImg'
import type { Track } from '../../types'
import '../../styles/year-in-review.css'

declare global {
  interface Window {
    __yirReady?: boolean
    __yirCount?: number
    __yirSeek?: (card: number, ms: number) => Promise<boolean>
    /** "card:images:placeholders" at the last seek — main waits for it to stop changing. */
    __yirSettled?: string
  }
}

/** Instagram's covered bands (friend-share's STORY_SAFE), in the frame's CSS pixels (540×960 at 2×). */
export const YIR_STORY_BANDS = { top: STORY_SAFE.top / 2, bottom: STORY_SAFE.bottom / 2 }

/** Relative luminance (0–1) of a CSS rgb()/rgba() color; null when it isn't one. */
export function cssLuminance(color: string): number | null {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(color)
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null
  const lin = (v: number): number => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3])
}

export function YirStoryFrame({ slide, ctx, ms, card }: { slide: Slide; ctx: YirCtx; ms: number; card: number }): JSX.Element {
  // The mark takes the ink that reads on the card's ground: dark on light cards (the cream cover
  // hid a white mark — 2026-10-29), light everywhere else.
  const ref = useRef<HTMLDivElement>(null)
  const [darkMark, setDarkMark] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setDarkMark((cssLuminance(getComputedStyle(el).backgroundColor) ?? 0) > 0.5)
  }, [slide])
  return (
    <YirClock.Provider value={ms}>
      <div ref={ref} data-card={card} className={`yir-card yir-export yir-k-${slide.kind}${slide.kind === 'number' && slide.viz ? ` yir-v-${slide.viz.kind}` : ''}`}>
        <Backdrop slide={slide} ctx={ctx} />
        <div className="yir-body">
          <SlideBody slide={slide} ctx={ctx} playing={null} beat={null} onPlayRow={() => {}} />
        </div>
        {/* The one JakeTunes Story mark (JakeTunesMobile StoryShare.signed): the click-wheel dot and
            the JAKETUNES wordmark, bottom right, just inside Instagram's safe zone. */}
        <div className={`yir-export-mark${darkMark ? ' yir-export-mark--dark' : ''}`} aria-hidden="true"><i />JAKETUNES</div>
      </div>
    </YirClock.Provider>
  )
}

export default function YirStoryExportApp(): JSX.Element | null {
  const [tracks, setTracks] = useState<Track[]>([])
  const [artworkMap, setArtworkMap] = useState<Record<string, string>>({})
  const [facts, setFacts] = useState<Parameters<typeof buildStory>[0] | null>(null)
  const [at, setAt] = useState<{ card: number; ms: number }>({ card: 0, ms: 0 })
  const concerts = useStoryConcerts(tracks)
  const now = useMemo(() => {
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '').get('now')
    return q ? new Date(`${q}T12:00:00`) : new Date()
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    void ensureLiveSetsLoaded()
    void Promise.all([
      api.loadTracks().catch(() => ({ tracks: [] })),
      api.loadArtworkMap?.().catch(() => null),
      api.yirGet?.(now.getFullYear()).catch(() => null),
    ]).then(([t, a, f]) => {
      setTracks((t?.tracks ?? []) as Track[])
      const map = (a as { map?: Record<string, string> } | null)?.map
      if (map) setArtworkMap(map)
      setFacts(f ?? null)
    })
  }, [now])

  const ctx = useMemo((): YirCtx => ({ tracks, artworkMap, artIndex: buildNormalizedArtworkIndex(artworkMap), concerts }), [tracks, artworkMap, concerts])
  const slides = useMemo(() => (facts ? buildStory(facts, { now, concerts }) : []), [facts, now, concerts])

  useEffect(() => {
    window.__yirCount = slides.length
    window.__yirReady = slides.length > 0
    window.__yirSeek = (card, ms) => new Promise((resolve) => {
      setAt({ card, ms })
      // Two frames: React commits, then the animations are pinned to the same moment.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms }
        // Ready = this card is on the page and every picture it asked for has arrived (a picture
        // still being looked up shows as an empty placeholder with no <img> yet).
        const frame = document.querySelector(`.yir-export[data-card="${card}"]`)
        const imgs = [...document.images]
        const pending = frame ? frame.querySelectorAll('.yir-img-empty').length : 1
        resolve(!!frame && imgs.every((i) => i.complete) && imgs.length + pending > 0 && (window.__yirSettled = `${card}:${imgs.length}:${pending}`) !== undefined)
      }))
    })
  }, [slides])

  const slide = slides[at.card]
  if (!slide) return null
  return <div className="yir-export-stage"><YirStoryFrame key={at.card} card={at.card} slide={slide} ctx={ctx} ms={at.ms} /></div>
}
