/**
 * The LCD ticker: names never clip in the toolbar pill (Jake's rule).
 *
 * The pill's song / artist / album lines (.now-playing-line-*) used to end in
 * "…" when a name outran the pill. The phone's Now Playing ticks long names
 * past like an iPod mini (TickerText.swift); this gives the desktop's LCD the
 * same behaviour, with the same numbers (common/lcd-ticker.ts):
 * fits → as before; a little long → shrinks to fit; long → scrolls.
 *
 * Why a behaviour attached from outside, not markup inside NowPlaying.tsx:
 * NowPlaying is on CLAUDE.md's Do-Not-Touch list. This hook only READS its
 * lines — it watches the pill for line/text changes, measures, and decorates
 * the line's child span (an em font-size for a shrink, a Web Animation for a
 * scroll). It never adds, removes or reorders nodes React owns, and it
 * observes text/children only (never attributes), so its own decoration
 * can't retrigger it. The class names it reads are locked by
 * src/main/__tests__/lcd-ticker.test.ts.
 */
import { useEffect, type RefObject } from 'react'
import { planLcdFit } from '../../../common/lcd-ticker'

export const LCD_LINE_SELECTOR = '.now-playing-line-primary, .now-playing-line-secondary, .now-playing-line-tertiary'

interface LineState { text: string; width: number; anims: Animation[] }

function lineOf(node: Node | null): Element | null {
  const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement)
  return el ? el.closest(LCD_LINE_SELECTOR) : null
}

export function useLcdTicker(rootRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    const states = new WeakMap<HTMLElement, LineState>()
    const watched = new Set<HTMLElement>()

    const reset = (line: HTMLElement, s?: LineState): void => {
      for (const a of s?.anims ?? []) a.cancel()
      line.removeAttribute('data-lcd')
      for (const child of Array.from(line.children) as HTMLElement[]) child.style.fontSize = ''
    }

    const fit = (line: HTMLElement, force = false): void => {
      const text = line.textContent || ''
      const prev = states.get(line)
      // Measure at rest: undo our own shrink / scroll first.
      if (prev && !force && prev.text === text && prev.width === line.clientWidth) return
      reset(line, prev)
      const width = line.clientWidth
      const plan = planLcdFit(line.scrollWidth, width)
      const next: LineState = { text, width, anims: [] }
      states.set(line, next)
      if (plan.kind === 'shrink') {
        line.setAttribute('data-lcd', 'shrink')
        for (const child of Array.from(line.children) as HTMLElement[]) child.style.fontSize = `${plan.scale}em`
      } else if (plan.kind === 'ticker') {
        line.setAttribute('data-lcd', 'ticker')
        const frames = plan.keyframes.map((k) => ({ offset: k.offset, transform: `translateX(${k.x}px)` }))
        for (const child of Array.from(line.children) as HTMLElement[]) {
          if (typeof child.animate !== 'function') continue
          next.anims.push(child.animate(frames, { duration: plan.durationMs, iterations: Infinity, easing: 'linear' }))
        }
      }
    }

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) fit(e.target as HTMLElement)
    })
    const scan = (force = false): void => {
      for (const line of Array.from(root.querySelectorAll<HTMLElement>(LCD_LINE_SELECTOR))) {
        if (!watched.has(line)) { watched.add(line); ro.observe(line) }
        fit(line, force)
      }
      for (const line of Array.from(watched)) {
        if (!line.isConnected) { ro.unobserve(line); reset(line, states.get(line)); watched.delete(line) }
      }
    }
    // The pill re-renders its clock ~10×/s; only a change inside a name line
    // (or a line coming or going) is worth a look.
    const mo = new MutationObserver((records) => {
      const touched = records.some((r) =>
        lineOf(r.target) != null ||
        (r.type === 'childList' && [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].some((n) =>
          n.nodeType === 1 && ((n as Element).matches(LCD_LINE_SELECTOR) || (n as Element).querySelector(LCD_LINE_SELECTOR) != null))))
      if (touched) scan()
    })
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    scan()
    // A name measured in the fallback face is the wrong width once the real
    // font lands.
    let alive = true
    void document.fonts?.ready.then(() => { if (alive) scan(true) })
    return () => {
      alive = false
      mo.disconnect()
      ro.disconnect()
      for (const line of watched) reset(line, states.get(line))
      watched.clear()
    }
  }, [rootRef])
}
