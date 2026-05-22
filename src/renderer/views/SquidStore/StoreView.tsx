import { useEffect, useRef } from 'react'

// squid.wtf embedded view — mirror of the BandcampStore host. The
// renderer draws nothing visible; the native WebContentsView paints
// over the same viewport rectangle from the main process side. Unmount
// detaches the view but doesn't destroy it, so session state (login,
// scroll position, current URL) survives sidebar navigation
// round-trips.

export default function StoreView() {
  const ref = useRef<HTMLDivElement>(null)

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

  return <div ref={ref} style={{ width: '100%', height: '100%' }} aria-label="squid.wtf" />
}
