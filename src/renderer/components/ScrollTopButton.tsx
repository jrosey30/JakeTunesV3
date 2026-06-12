import { useEffect, useState, type RefObject } from 'react'

/**
 * 4.5: floating "back to top" — appears after the container scrolls past
 * `threshold`, fixed bottom-right, smooth-scrolls home. Mounted inside each
 * scrollable library view so it unmounts on view switch.
 */
export default function ScrollTopButton({ targetRef, threshold = 600 }: { targetRef: RefObject<HTMLElement>; threshold?: number }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = targetRef.current
    if (!el) return
    const onScroll = () => setVisible(el.scrollTop > threshold)
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [targetRef, threshold])

  if (!visible) return null
  return (
    <button
      type="button"
      className="scroll-top-btn"
      onClick={() => targetRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
      title="Back to top"
      aria-label="Back to top"
    >↑</button>
  )
}
