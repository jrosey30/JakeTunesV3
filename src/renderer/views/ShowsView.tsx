/**
 * Shows — every show on one page (V7, 2026-11-24). Home's two concert rails
 * (Live Near You, You'd Like This) used to grow in place on "See All"; now See
 * All always opens a page, and this is that page: the same cards, the same
 * filter, Going / Interested and "Pick a night", every show in a wrapped grid.
 *
 * The feed is main's cache (ipc/concerts-ipc.ts), the copy Home painted from;
 * the page paints from Home's cache at once and asks main for a fresh one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import HomeShows from '../components/HomeShows'
import BackButton from '../components/chrome/BackButton'
import { useNavigation } from '../context/NavigationContext'
import { useBackLabel } from '../hooks/useBackLabel'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getCached, setCached } from '../homeCache'
import { asConcertsState, type ConcertsFeedState } from '../../common/concerts-feed'
import '../styles/home.css'

export default function ShowsView(): JSX.Element {
  const [state, setState] = useState<ConcertsFeedState | null>(() => getCached('concerts') ?? null)
  const { canGoBack, goBack } = useNavigation()
  const backLabel = useBackLabel()
  const pageRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('shows-page', pageRef)

  useEffect(() => {
    let cancelled = false
    const take = (raw: unknown): void => {
      const s = asConcertsState(raw)
      if (!s || cancelled) return
      setCached('concerts', s)
      setState(s)
    }
    void (async () => {
      try {
        take((await window.electronAPI.concertsGet?.())?.state)
        take((await window.electronAPI.concertsRefresh?.())?.state)
      } catch (err) {
        console.warn('[shows] feed failed:', err)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const openLink = useCallback((url: string) => { void window.electronAPI.openExternalUrl(url) }, [])

  return (
    <div className="home-view shows-view" ref={pageRef}>
      {canGoBack && backLabel !== null && <div className="home-back"><BackButton label={backLabel} onClick={goBack} /></div>}
      <section className="home-section home-section--shows">
        <div className="home-section-header">
          <h2 className="home-section-title">Shows</h2>
        </div>
        {state && (state.items.length > 0 || state.discover.length > 0)
          ? <HomeShows state={state} openLink={openLink} page />
          : <p className="home-concert-empty">{state ? 'No shows right now.' : 'Looking for shows…'}</p>}
      </section>
    </div>
  )
}
