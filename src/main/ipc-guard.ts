/**
 * Who is allowed to invoke a privileged IPC handler.
 *
 * `ipcMain.handle` answers ANY frame in the app — including a `<webview>`
 * showing a remote page. The Bandcamp store loads real bandcamp.com in this
 * session, so "the renderer" is not one trusted thing; handlers that write the
 * library or drive the iPod need to check WHICH window is asking.
 *
 * Deliberately minimal: compare the sender to the main window's webContents.
 * No allow-list of frame URLs, no origin parsing — those drift and give a false
 * sense of coverage. Either the call came from the app's own top-level window
 * or it is refused.
 */
import type { IpcMainInvokeEvent, BrowserWindow } from 'electron'

/** True when `event` came from `mainWindow`'s own top-level frame. */
export function isFromMainWindow(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  mainWindow: BrowserWindow | null,
): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const sender = event?.sender
  if (!sender) return false
  // A webview's webContents is a DIFFERENT object from the host window's, so
  // identity comparison is exactly the boundary we want.
  return sender === mainWindow.webContents
}

/**
 * Guard a privileged handler. Returns null when the caller is trusted, or the
 * refusal value to return to the caller when it is not.
 *
 * Refusing with a value (rather than throwing) keeps the renderer's existing
 * `{ ok: false }` error handling intact — a guard that crashes callers would
 * get reverted the first time it misfired.
 */
export function refuseIfNotMainWindow<T>(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  mainWindow: BrowserWindow | null,
  channel: string,
  refusal: T,
): T | null {
  if (isFromMainWindow(event, mainWindow)) return null
  console.warn(`[ipc-guard] refused ${channel} from a non-main-window sender`)
  return refusal
}
