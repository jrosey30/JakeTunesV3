import { useEffect, useRef, useState } from 'react'
import '../BandcampStore/store-header.css'

// lucida.to embedded view (replaces the dead squid.wtf store). The renderer
// paints the header chrome (back/forward arrows) above the native
// WebContentsView the main process draws over the rest of the viewport.
// Unmount detaches the view but doesn't destroy it, so session state
// (Cloudflare clearance cookie, scroll position, current URL) survives
// sidebar navigation round-trips.
//
// Nav state is polled every 500 ms — lucida.to uses client-side routing
// that doesn't fire reliable did-navigate events, so without polling the
// back arrow would only update on re-mount.

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

    void window.electronAPI.lucidaMount(bounds())

    const ro = new ResizeObserver(() => {
      void window.electronAPI.lucidaResize(bounds())
    })
    ro.observe(el)

    const onWindowResize = () => {
      void window.electronAPI.lucidaResize(bounds())
    }
    window.addEventListener('resize', onWindowResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
      void window.electronAPI.lucidaUnmount()
    }
  }, [])

  // Poll nav state. 500 ms cadence is cheap — one IPC every 0.5 s,
  // round-trip ~1 ms; cost is invisible. Without polling, the back
  // arrow would dim/light only when the user re-mounted the view.
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      window.electronAPI.lucidaNavState?.().then(r => {
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
            onClick={() => window.electronAPI.lucidaGoBack?.()}
            disabled={!navState.canGoBack}
            title="Back"
            aria-label="Back"
          >‹</button>
          <button
            className="store-library-header__navbtn"
            onClick={() => window.electronAPI.lucidaGoForward?.()}
            disabled={!navState.canGoForward}
            title="Forward"
            aria-label="Forward"
          >›</button>
        </div>
      </div>
      <div ref={ref} className="store-view-embed" aria-label="lucida.to" />
    </div>
  )
}
