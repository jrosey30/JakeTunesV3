/**
 * IPC sender authorization for mutating / filesystem handlers.
 * Only the main JakeTunes BrowserWindow top-frame may invoke them.
 */

import type { BrowserWindow, IpcMainInvokeEvent, IpcMainEvent } from 'electron'

export type TrustedSenderResult = { ok: true } | { ok: false; error: string }

/**
 * Returns ok when `event.sender` is the main window's webContents.
 * Bandcamp/Squid WebContentsViews and stray BrowserWindows are rejected.
 */
export function assertTrustedMainSender(
  event: IpcMainInvokeEvent | IpcMainEvent,
  mainWindow: BrowserWindow | null,
): TrustedSenderResult {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: 'no-main-window' }
  }
  const expected = mainWindow.webContents
  if (!expected || expected.isDestroyed()) {
    return { ok: false, error: 'no-main-webcontents' }
  }
  if (event.sender !== expected) {
    return { ok: false, error: 'untrusted-sender' }
  }
  // Prefer top-frame only when Electron exposes senderFrame.
  const frame = (event as IpcMainInvokeEvent).senderFrame
  if (frame && typeof frame !== 'undefined') {
    try {
      // top frame has no parent; nested frames (if any) are rejected
      const parent = (frame as { parent?: unknown }).parent
      if (parent) return { ok: false, error: 'untrusted-frame' }
    } catch {
      /* older Electron — sender match is enough */
    }
  }
  return { ok: true }
}
