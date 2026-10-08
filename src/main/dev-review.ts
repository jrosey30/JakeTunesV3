/**
 * Dev-review launches (Jake, 2026-09-07): a review instance of the app must
 * never make a sound on its own — while a dev window was open for a fixture
 * check it played music and he heard it as his app. The launch configuration
 * sets JT_DEV_REVIEW=1; this mutes the window's audio output at creation and
 * titles it so it can be told apart. Normal startup (no variable) is untouched.
 */
import type { BrowserWindow } from 'electron'

export function devReviewRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JT_DEV_REVIEW === '1'
}

/** Review windows get Chromium's autoplay gate: audio may start only from a
 *  real user gesture — a boot restore, a reload, or a scripted click cannot
 *  start playback. Normal windows keep Electron's default. */
export function devReviewWebPreferences(env: NodeJS.ProcessEnv = process.env): { autoplayPolicy: 'user-gesture-required' } | Record<string, never> {
  return devReviewRequested(env) ? { autoplayPolicy: 'user-gesture-required' } : {}
}

/** In review mode, listening activity is never written: play/skip/rating
 *  records, taste-ledger events and play-count overrides are acknowledged
 *  and dropped, so a fixture session leaves no trace in Jake's history. */
export function suppressListeningWrites(env: NodeJS.ProcessEnv = process.env): boolean {
  return devReviewRequested(env)
}

export function applyDevReview(win: BrowserWindow, env: NodeJS.ProcessEnv = process.env): void {
  if (!devReviewRequested(env)) return
  win.webContents.setAudioMuted(true)
  win.setTitle('JakeTunes V3 — dev review (muted)')
  // Re-assert on every load: the renderer's own title writes would otherwise hide the tag.
  win.webContents.on('did-finish-load', () => { win.webContents.setAudioMuted(true); win.setTitle('JakeTunes V3 — dev review (muted)') })
  console.warn('[dev-review] audio muted for this instance (JT_DEV_REVIEW=1)')
}
