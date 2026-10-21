/**
 * Window-level back / forward inputs that never reach the page as DOM events
 * (2026-10-21, parity with the phone's swipe-back):
 *  - macOS `swipe` — the older page-swipe style, delivered when System
 *    Settings › Trackpad › More Gestures › "Swipe between pages" is set to
 *    "two or three fingers" / "three fingers". (The default two-finger
 *    *scroll* style arrives as wheel events; the renderer handles that one.)
 *  - Windows / Linux `app-command` browser-backward / browser-forward (mouse
 *    X1/X2, keyboard browser keys). macOS mouse side buttons arrive in the
 *    page as DOM buttons 3 / 4 instead.
 * Relayed as menu actions, so they run the renderer's own history — the same
 * path as ‹ › and ⌘[ ⌘].
 */
import type { BrowserWindow } from 'electron'

/** Fingers moving right = back (Safari's convention); left = forward. */
export function swipeDirectionToAction(direction: string): 'history-back' | 'history-forward' | null {
  return direction === 'right' ? 'history-back' : direction === 'left' ? 'history-forward' : null
}

export function appCommandToAction(command: string): 'history-back' | 'history-forward' | null {
  return command === 'browser-backward' ? 'history-back' : command === 'browser-forward' ? 'history-forward' : null
}

export function wireHistoryGestures(win: BrowserWindow, send: (channel: string, action: string) => void): void {
  win.on('swipe', (_e, direction) => {
    const action = swipeDirectionToAction(direction)
    if (action) send('menu-action', action)
  })
  win.on('app-command', (_e, command) => {
    const action = appCommandToAction(command)
    if (action) send('menu-action', action)
  })
}
