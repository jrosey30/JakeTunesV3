/**
 * V7 motion — the one motion module (with styles/motion.css, its CSS twin).
 *
 * The motion follows the look: the iPod and Mac OS X 2002. Three speeds on
 * one easing curve, and nothing else:
 *   instant — a press, a hover, a state change
 *   normal  — pages, dialogs, drawers (about a fifth of a second)
 *   slow    — only Cover Flow and the Home hero
 * Loops are allowed only when they mean something (MEANINGFUL_LOOPS); their
 * periods are tokens too. With Reduce Motion on, everything just appears.
 *
 * ⚠️ TWIN: styles/motion.css `:root` holds the same numbers as CSS variables.
 * src/main/__tests__/motion-rules.test.ts fails if the two disagree, if a
 * stylesheet or inline style names a raw duration or curve, or if a new
 * animation loops forever without an entry below.
 *
 * Pure apart from the three DOM helpers at the bottom, which guard `window`.
 */

export type MotionSpeed = 'instant' | 'normal' | 'slow'

/** The three speeds, in milliseconds. */
export const MOTION_MS: Readonly<Record<MotionSpeed, number>> = {
  instant: 100,
  normal: 200,
  slow: 560,
}

/** The one curve: a quick start and a long, soft settle (an ease-out). */
export const MOTION_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** The step between items that arrive one after another. */
export const MOTION_STAGGER_MS = 30

/**
 * Timed displays: how long something stays on screen to be read (shown, held,
 * gone). Not a move, so not one of the three speeds. Under Reduce Motion each
 * is shown still for its whole time instead of fading (motion.css).
 */
export const TIMED_DISPLAYS_MS = {
  /** the GOING stamp on a concert card (HomeShows.tsx removes it at the same time) */
  stamp: 1300,
  /** the booth's hit verdict (PERFECT / GREAT …) */
  verdict: 420,
  /** the visualiser's keyboard hint */
  hint: 4500,
} as const

/** Periods for the loops that mean something. A loop is not a speed. */
export const MOTION_PERIOD_MS = {
  /** a spinner: something is loading */
  spin: 800,
  /** a caret, a recording light */
  blink: 1000,
  /** a glow that breathes: something is live, busy or waiting on you */
  pulse: 1200,
} as const

/**
 * Every keyframe allowed to run with `infinite`, and what it means. A loop
 * that means nothing does not get an entry: it gets cut. Keep the reason
 * honest — the reviewer reads this list, not the CSS.
 */
export const MEANINGFUL_LOOPS: Readonly<Record<string, string>> = {
  // loading
  'iq-spin': 'import queue: a file is importing',
  'cd-spin': 'CD import: the disc is being read',
  'mm-refresh-spin': 'Music Man suggestions: refreshing',
  'ltl-spin': 'the Listening List: a download is running',
  'dl-spin': 'Record Shop: a download is running',
  'dj-ring-spin': 'DJ: the set is being built',
  'dl-pulse': 'a song row: its download is starting',
  'page-gate-slide': 'a page is loading',
  'pg-eq': 'a page is loading',
  'pg-shimmer': 'a page is loading',
  'pg4-travel': 'a page is loading',
  'activity-bar-pulse': 'the activity bar: work is in progress',
  // the launch screen, which runs only while the app is starting
  'splash-glow-drift': 'launch screen: the app is still starting',
  'splash-halo-breathe': 'launch screen: the app is still starting',
  'splash-shine-sweep': 'launch screen: the app is still starting',
  'splash-shadow-breathe': 'launch screen: the app is still starting',
  'splash-note-rise': 'launch screen: the app is still starting',
  'splash-eq-dance': 'launch screen: the app is still starting',
  'splash-progress-sheen': 'launch screen: the progress bar is moving',
  'splash-device-breathe': 'launch screen: the app is still starting',
  // waiting on someone
  'np-thinking-bounce': 'Now Playing: the Music Man is thinking',
  'cynthia-typing': 'Cynthia is typing',
  'dj-dots': 'DJ: Stephen is thinking',
  // a caret or a recording light
  'np-caret-blink': 'a text caret',
  'search-caret-blink': 'the search caret',
  'mic-blink': 'a tape is recording or winding',
  'rec-dot-blink': 'recording',
  'rec-pulse': 'recording',
  // live: on air, playing, speaking
  'dj-pulse': 'DJ Mode is on (the smoke test checks this glow)',
  'radio-on-air-pulse': 'the radio is on air',
  'radio-wave-pulse': 'the radio is on air',
  'np-radio-dot-blink': 'the radio is on air',
  'np-radio-hero-pulse': 'the radio is on air',
  'np-radio-eq': 'the radio is playing',
  'home-concert-eq': 'this act is playing right now',
  'home-concert-glow': 'a concert card: the show is TONIGHT',
  'spool-rotate': 'the tape is rolling',
  'scotus-pulse': 'this voice is speaking',
  'recently-added-pulse': 'a song that just arrived (the class comes off after 10 s)',
  // Year in Review, a show that plays to the music
  'yir-spin': 'Year in Review: the record is playing',
  'yir-beat': 'Year in Review: on the beat of the song playing',
  'yir-pulse': 'Year in Review: the seats still being decided',
}

/**
 * Files whose `infinite` WAAPI loops (`iterations: Infinity`) are allowed,
 * and why. CSS loops are keyed by keyframe name above.
 */
export const MEANINGFUL_SCRIPT_LOOPS: Readonly<Record<string, string>> = {
  'src/renderer/components/playback/lcdTicker.ts': 'Now Playing: a long title scrolls on one line',
}

/**
 * Motion with its own clock, outside the three speeds, and why. Reduce Motion
 * still applies to all of it. Paths are from the repo root.
 */
export const MOTION_EXEMPT_FILES: Readonly<Record<string, string>> = {
  'src/renderer/styles/motion.css': 'the tokens themselves and the Reduce Motion switch',
  'src/renderer/styles/coverflow.css': 'Cover Flow stays as it is',
  'src/renderer/views/CoverFlowView.tsx': 'Cover Flow stays as it is',
  'src/renderer/styles/disc-handoff.css': 'the Home hero: the disc grows into the album page, timed by common/jewel-case.ts',
  'src/renderer/styles/year-in-review.css': 'Year in Review: a show timed to the music, not a UI move',
  'src/renderer/components/SplashScreen.tsx': 'the launch screen: a show while the app starts',
}

/** Rules whose selector matches this are the launch screen's show (app.css). */
export const MOTION_EXEMPT_SELECTOR = /\.(app-)?splash(?![a-z])/

/**
 * Animations V7 cut. The check fails if one comes back under the same name.
 */
export const MOTION_CUT: Readonly<Record<string, string>> = {
  tnDrift: 'the endless backdrop drift behind the Home hero',
  'ad-drift': "the endless drift on an artist page's header photo",
  'ad-drift-whole': "the endless drift on an artist page's header photo",
  'tn-poster-drift': 'the drifting posters on Home',
  'tn-rank-in': 'the bouncing rank pop',
  tnPulse: "the Music Man dot on Home that blinked for ever",
}

/** `var(--motion-normal)` etc. — for inline styles written in TSX. */
export function motionVar(speed: MotionSpeed): string {
  return `var(--motion-${speed})`
}

/** One inline `transition` value on the tokens: `opacity var(--motion-normal) var(--motion-ease)`. */
export function motionTransition(props: string | string[], speed: MotionSpeed = 'normal'): string {
  const list = Array.isArray(props) ? props : [props]
  return list.map((p) => `${p} ${motionVar(speed)} var(--motion-ease)`).join(', ')
}

/** Is Reduce Motion on (the OS setting, or the test switch on <html>)? */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof document !== 'undefined' && document.documentElement?.dataset?.motion === 'reduce') return true
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** A speed in ms for script-driven motion: 0 under Reduce Motion, so it just appears. */
export function motionMs(speed: MotionSpeed): number {
  return prefersReducedMotion() ? 0 : MOTION_MS[speed]
}

/**
 * Follow the OS: keep `<html data-motion>` at "reduce" or "full" as the
 * macOS Reduce Motion setting changes (Electron passes it through as
 * prefers-reduced-motion). motion.css honours both the media query and the
 * attribute, so first paint is right before this runs.
 */
export function initMotion(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  const root = document.documentElement
  const apply = (): void => {
    // A forced value (the frame test sets data-motion-lock) is left alone.
    if (root.dataset.motionLock) return
    root.dataset.motion = mq.matches ? 'reduce' : 'full'
  }
  apply()
  mq.addEventListener('change', apply)
  return () => mq.removeEventListener('change', apply)
}
