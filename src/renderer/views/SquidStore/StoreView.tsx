import { useEffect, useRef, useState } from 'react'
import '../BandcampStore/store-header.css'

// squid.wtf embedded view. The renderer paints the header chrome
// (back/forward arrows) above the native WebContentsView which the
// main process draws over the rest of the viewport. Unmount detaches
// the view but doesn't destroy it, so session state (login, scroll
// position, current URL) survives sidebar navigation round-trips.
//
// 4.5.0-76 — back/forward arrows added (mirror of BandcampStore). The
// embedded squid.wtf view has its own browser history; without these
// the user got trapped on whatever page a link landed them on. Nav
// state is polled every 500 ms — squid.wtf uses client-side routing
// that doesn't fire reliable did-navigate events.

export default function StoreView() {
  const ref = useRef<HTMLDivElement>(null)
  const [navState, setNavState] = useState<{ canGoBack: boolean; canGoForward: boolean }>(
    { canGoBack: false, canGoForward: false },
  )

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const bounds = () => {
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
    }

    void window.electronAPI.squidMount(bounds())

    const ro = new ResizeObserver(() => {
      void window.electronAPI.squidResize(bounds())
    })
    ro.observe(el)

    const onWindowResize = () => {
      void window.electronAPI.squidResize(bounds())
    }
    window.addEventListener('resize', onWindowResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
      void window.electronAPI.squidUnmount()
    }
  }, [])

  // Poll nav state. 500 ms cadence is cheap — one IPC every 0.5 s,
  // round-trip ~1 ms; cost is invisible. Without polling, the back
  // arrow would dim/light only when the user re-mounted the view.
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      window.electronAPI.squidNavState?.().then(r => {
        if (!cancelled && r) setNavState({ canGoBack: !!r.canGoBack, canGoForward: !!r.canGoForward })
      }).catch(() => { /* ignore */ })
    }
    refresh()
    const id = window.setInterval(refresh, 500)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  return (
    <div className="store-view-root">
      <div className="store-library-header">
        <div className="store-library-header__nav">
          <button
            className="store-library-header__navbtn"
            onClick={() => window.electronAPI.squidGoBack?.()}
            disabled={!navState.canGoBack}
            title="Back"
            aria-label="Back"
          >‹</button>
          <button
            className="store-library-header__navbtn"
            onClick={() => window.electronAPI.squidGoForward?.()}
            disabled={!navState.canGoForward}
            title="Forward"
            aria-label="Forward"
          >›</button>
        </div>
      </div>
      <div ref={ref} className="store-view-embed" aria-label="squid.wtf" />
    </div>
  )
}
