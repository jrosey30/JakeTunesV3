/**
 * The disc ↔ album page handoff (Island Albums jewel case, 2026-10-21): ONE
 * View Transition between the island Cover Flow's jewel-case disc (on Made
 * for You since V7, DISC_HANDOFF_PAGE; it was the Home's) and the album page's
 * cover. Open: the disc grows into the album page's cover while the page
 * fades up around it. Back: the cover shrinks into the disc, then the page's
 * case drops the disc onto its hub and snaps the lid shut
 * (components/JewelCase.tsx; numbers in common/jewel-case.ts).
 *
 * The phone's twin is the iOS zoom transition with the disc as its source
 * (JakeTunesMobile LaunchPageG.swift, `.zoomTransitionSource` on the disc).
 *
 * Who does what:
 *   TonightOnJakeTunes  opens the case; when the disc is up it ARMS the
 *                       handoff (armDiscOpen) and dispatches the album page.
 *   MainContent         (useDiscHandoffView) sees every navigation. Flow page →
 *                       the armed album, or that album page → straight back
 *                       to it, holds the OLD view on screen for the frame
 *                       the browser needs to capture it, then swaps views
 *                       inside document.startViewTransition. Any other
 *                       navigation forgets the case (no reverse unless the flow's page
 *                       is where you came from).
 *   CSS                 (styles/disc-handoff.css) names the disc and the
 *                       album page's cover `jt-disc` only while the
 *                       transition runs (:root.jt-disc-vt).
 *
 * No View Transitions (or Reduce Motion): plain navigation, no reverse.
 */
import { useLayoutEffect, useReducer, useRef } from 'react'
import { flushSync } from 'react-dom'
import {
  discHandoffKind, keepOpenedAfter, sameHandoffLoc, DISC_HANDOFF_TIMING, JEWEL_CASE_MOTION, DISC_HANDOFF_PAGE,
  type DiscHandoffKind, type HandoffLoc,
} from '../common/jewel-case'
import './styles/disc-handoff.css'

interface CaseRef { albumKey: string; flowKey: string }

/** The case is open with its disc up; the album page is about to come out of it. */
let armed: CaseRef | null = null
/** The album page on screen came out of this case. */
let opened: CaseRef | null = null
/** Back on the flow's page: this case is open with the disc up; `finished` = the page has shrunk into it. */
export interface ReturningCase { flowKey: string; finished: Promise<void> }
let returning: ReturningCase | null = null

const VT_CLASS = 'jt-disc-vt'
/** The latest run: a newer transition (Back mid-morph) skips the older one, whose cleanup must not undo the newer one's names. */
let runSeq = 0

// The one Reduce Motion question (motion.ts); re-exported for this module's callers.
import { prefersReducedMotion } from './motion'
import { pageSlideKind, pageSlideSupported, runPageSlide, slidesBetween } from './pageSlide'
import { peekHistoryDirection } from './navIntent'
export { prefersReducedMotion }

export function discHandoffSupported(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function' && !prefersReducedMotion()
}

export function armDiscOpen(albumKey: string, flowKey: string): void {
  armed = { albumKey, flowKey }
}

/** The flow's page mounting: is a case coming back open (the reverse)? A pure read. */
export function peekReturningCase(): ReturningCase | null {
  return returning
}

/** The lid is shut again (or the page gave up on it). */
export function endReturningCase(r: ReturningCase | null): void {
  if (r && returning === r) returning = null
}

/** A navigation that ISN'T a handoff: forget what it leaves behind. */
function note(next: HandoffLoc): void {
  armed = null
  if (!keepOpenedAfter(next, opened)) opened = null
  if (next.view !== DISC_HANDOFF_PAGE) returning = null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * The destination's image has loaded (so the new snapshot has it), or the cap
 * ran out. Only `load`, never img.decode(): inside the update callback the
 * page's rendering is suspended, and on Electron 30's Chromium (124) decode()
 * doesn't settle until a frame is produced — it burned the whole cap every
 * time (~200 ms with the disc frozen mid-air). A loaded image is drawn on the
 * first frame anyway (desktop raster decodes it synchronously).
 */
async function destinationReady(kind: DiscHandoffKind): Promise<void> {
  const sel = kind === 'open' ? '.album-page-cover img' : '.tn-case-disc img'
  const img = document.querySelector<HTMLImageElement>(sel)
  if (!img || (img.complete && img.naturalWidth > 0)) return
  await Promise.race([
    new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true })
      img.addEventListener('error', () => resolve(), { once: true })
    }),
    sleep(DISC_HANDOFF_TIMING.readyCapMs),
  ])
}

/**
 * Run the transition: `release` renders the destination synchronously (it is
 * called inside flushSync once the old view has been captured).
 */
function runDiscHandoff(kind: DiscHandoffKind, release: () => void): void {
  const root = document.documentElement
  const run = ++runSeq
  let resolveFinished: () => void = () => undefined
  const finished = new Promise<void>((r) => { resolveFinished = r })
  if (kind === 'open') {
    opened = armed
    armed = null
  } else {
    returning = opened ? { flowKey: opened.flowKey, finished } : null
    opened = null
  }
  root.style.setProperty('--jt-disc-morph', `${kind === 'open' ? DISC_HANDOFF_TIMING.morphMs : JEWEL_CASE_MOTION.returnMorphMs}ms`)
  root.classList.add(VT_CLASS)
  root.classList.toggle('jt-disc-vt--back', kind === 'close')
  let released = false
  const doRelease = (): void => {
    if (released) return
    released = true
    flushSync(release)
  }
  const done = (): void => {
    if (run === runSeq) {
      root.classList.remove(VT_CLASS, 'jt-disc-vt--back')
      root.style.removeProperty('--jt-disc-morph')
    }
    resolveFinished()
  }
  let vt: ViewTransition
  try {
    vt = document.startViewTransition(async () => {
      doRelease()
      // The case didn't come back (the island changed under it): no disc to
      // shrink into — straight to the page, the plain way.
      if (kind === 'close' && !document.querySelector('.tn-case-disc')) {
        returning = null
        vt.skipTransition()
        return
      }
      await destinationReady(kind)
    })
  } catch (err) {
    console.warn('[disc-handoff] View Transition refused; plain navigation', err)
    doRelease()
    done()
    return
  }
  vt.finished.then(done, done)
  // A skipped transition (the guard above) rejects `ready`; the swap stands.
  vt.ready.catch((err: unknown) => {
    if (!(err instanceof DOMException && err.name === 'AbortError')) console.warn('[disc-handoff] transition skipped', err)
  })
}

/**
 * MainContent: the view to RENDER for the current location. Usually the
 * current one; for a disc handoff, the previous one is held for the frame the
 * browser captures it, then swapped inside the View Transition.
 */
/** What the page slide needs to know about a location (MainContent). */
export interface SlideLoc extends HandoffLoc {
  /** the page's identity (keptView.viewTransitionKey) */
  pageKey: string
  /** the identity a page of this view would have under the CURRENT state */
  keyNow: (view: string) => string
}

/** A slide holds the old page with the new state: only when it still shows its own subject. */
function slides(from: SlideLoc, to: SlideLoc): boolean {
  return slidesBetween(from.view, to.view) && to.keyNow(from.view) === from.pageKey && pageSlideSupported()
}

export function useDiscHandoffView<L extends SlideLoc>(now: L): L {
  const shownRef = useRef<L>(now)
  const latestRef = useRef<L>(now)
  latestRef.current = now
  const busyRef = useRef(false)
  const [, bump] = useReducer((n: number) => n + 1, 0)

  const shown = shownRef.current
  const kind = !busyRef.current && !sameHandoffLoc(shown, now) && discHandoffSupported()
    ? discHandoffKind(shown, now, armed, opened)
    : null
  // A page slide holds the old page for one frame too (pageSlide.ts).
  const holding = busyRef.current || kind !== null || slides(shown, now)

  useLayoutEffect(() => {
    if (busyRef.current) return
    const from = shownRef.current
    const to = latestRef.current
    if (sameHandoffLoc(from, to)) return
    const k = discHandoffSupported() ? discHandoffKind(from, to, armed, opened) : null
    if (!k) {
      note(to)
      // V7 motion: any other page change slides like an iPod menu (pageSlide.ts).
      // `holding` already kept the old page on screen for this frame.
      if (slides(from, to)) {
        busyRef.current = true
        runPageSlide(pageSlideKind(peekHistoryDirection()), () => {
          busyRef.current = false
          const dest = latestRef.current
          if (!sameHandoffLoc(dest, to)) note(dest)
          shownRef.current = dest
          bump()
        })
        return
      }
      shownRef.current = to
      // The render held the old page expecting a slide that can't run now
      // (the window went hidden, Reduce Motion came on): show the new one.
      if (slidesBetween(from.view, to.view)) bump()  // cheap, and never strands a held page
      return
    }
    busyRef.current = true
    runDiscHandoff(k, () => {
      busyRef.current = false
      const dest = latestRef.current
      // Navigated on again while the old view was being captured.
      if (!sameHandoffLoc(dest, to)) note(dest)
      shownRef.current = dest
      bump()
    })
  }, [now.view, now.albumKey])

  return holding ? shown : now
}
