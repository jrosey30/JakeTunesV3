/**
 * Wheel → cover steps on a Cover Flow stage (common/cover-flow-wheel.ts holds
 * the rules; this is the DOM end).
 *
 * A NATIVE, non-passive listener: React's onWheel is attached passive in
 * Chromium, so preventDefault there is ignored and a sideways swipe would
 * also scroll the page (or read as back/forward). Only gestures the flow owns
 * are prevented; a vertical scroll over the Home row reaches the page
 * untouched.
 *
 * Steps go straight to `onSteps`, which sets the new index: the covers'
 * CSS transform transitions retarget from wherever they are, so a step during
 * a running transition never queues behind it. One timer, for a lone notch
 * waiting `notchMs` to see whether it was alone; cleared on every event and
 * on unmount.
 *
 * The timer runs notchMs from when the event was HANDLED and settles on the
 * EVENT clock (settleAt), never on performance.now(): when the page is busy,
 * events are handled late, and comparing their timestamps with the wall
 * clock read every event of a trackpad swipe as a lone notch (the renderer
 * harness: an 80 px swipe ran from No. 1 to No. 10). The next event, if
 * there is one, is already queued and is handled before the timer.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { createCoverWheel, type CoverWheelOptions } from '../../common/cover-flow-wheel'

export function useCoverFlowWheel(
  ref: RefObject<HTMLElement>,
  onSteps: (steps: number) => void,
  options: CoverWheelOptions | undefined,
  /** Re-attach when the stage element mounts (e.g. the row appears). */
  mounted: boolean,
): void {
  const onStepsRef = useRef(onSteps)
  onStepsRef.current = onSteps
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    const el = ref.current
    if (!el || !mounted) return
    const wheel = createCoverWheel(optionsRef.current)
    let timer: number | null = null
    const arm = (at: number | null, eventTime: number): void => {
      if (timer !== null) { window.clearTimeout(timer); timer = null }
      if (at === null) return
      timer = window.setTimeout(() => {
        timer = null
        const r = wheel.settle(at)
        if (r.steps !== 0) onStepsRef.current(r.steps)
      }, Math.max(0, at - eventTime))
    }
    const onWheel = (e: WheelEvent): void => {
      const r = wheel.push({
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        timeStamp: e.timeStamp,
      })
      if (r.consume && e.cancelable) e.preventDefault()
      if (r.steps !== 0) onStepsRef.current(r.steps)
      arm(r.settleAt, e.timeStamp)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (timer !== null) window.clearTimeout(timer)
      timer = null
    }
  }, [ref, mounted])
}
