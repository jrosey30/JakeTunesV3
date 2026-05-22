import { useEffect, useRef } from 'react'

// v4 Bandcamp Store: this view is just a layout placeholder for the
// embedded WebContentsView. The renderer draws nothing visible inside
// the container; the native view paints over the same rectangle on the
// main process side. We send the container's viewport-relative bounds
// over IPC so main can size the WebContentsView correctly, and re-send
// on any resize. Unmount detaches the view but does NOT destroy it, so
// session state (login, scroll position, current URL) survives sidebar
// navigation round-trips.

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

    void window.electronAPI.bandcampMount(bounds())

    // ResizeObserver catches container size changes (sidebar collapse,
    // panel resize). The window resize listener is a defensive backstop
    // for layout shifts that move the container without resizing it.
    const ro = new ResizeObserver(() => {
      void window.electronAPI.bandcampResize(bounds())
    })
    ro.observe(el)

    const onWindowResize = () => {
      void window.electronAPI.bandcampResize(bounds())
    }
    window.addEventListener('resize', onWindowResize)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
      void window.electronAPI.bandcampUnmount()
    }
  }, [])

  return <div ref={ref} style={{ width: '100%', height: '100%' }} aria-label="Bandcamp Store" />
}
