/**
 * IPC registration helper that *defaults* to `refuseIfNotMainWindow`.
 *
 * New (and migrated) handlers should register through this helper so a
 * forgotten sender check is the exception (`public: true`), not the
 * default. Opt out only for intentionally public / read-only channels
 * that guest frames or other windows may legitimately invoke.
 *
 * Refusing with a value (rather than throwing) matches `ipc-guard` —
 * renderers already handle `{ ok: false }` shapes.
 *
 * Electron's `ipcMain` is required lazily inside `createIpcRegistrar` so
 * unit tests can import `assertIpcRegisterOptions` / `REFUSED_SENDER`
 * under Node without hitting Electron's CJS named-export quirk.
 */
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { refuseIfNotMainWindow } from './ipc-guard.ts'

export type MainWindowAccessor = () => BrowserWindow | null

export interface RegisterHandleOptions<Result> {
  /**
   * Skip the main-window sender guard. Use only for intentionally
   * public / read-only channels.
   */
  public?: boolean
  /**
   * Value returned when a non-main-window sender is refused.
   * Required unless `public: true`.
   */
  refuse?: Result
}

export interface IpcRegistrar {
  handle: <Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
    options?: RegisterHandleOptions<Result>,
  ) => void
}

const REFUSED = { ok: false, error: 'refused-sender' } as const

/** Common refusal shape used by most mutating handlers. */
export const REFUSED_SENDER = REFUSED

/**
 * Validate registration options. Exported so unit tests can cover the
 * default-deny rule without spinning up Electron's ipcMain.
 */
export function assertIpcRegisterOptions(
  channel: string,
  options?: RegisterHandleOptions<unknown>,
): { public: boolean } {
  const isPublic = options?.public === true
  // Allow `{ refuse: undefined }` for void-returning handlers — the key
  // must be present; only a missing refuse opts-in is rejected.
  if (!isPublic && !(options && Object.prototype.hasOwnProperty.call(options, 'refuse'))) {
    throw new Error(
      `ipc-register: channel "${channel}" must pass { refuse } or { public: true }`,
    )
  }
  return { public: isPublic }
}

export function createIpcRegistrar(getMainWindow: MainWindowAccessor): IpcRegistrar {
  // Lazy so importing this module under node:test does not need Electron.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = require('electron') as typeof import('electron')

  function handle<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
    options?: RegisterHandleOptions<Result>,
  ): void {
    const { public: isPublic } = assertIpcRegisterOptions(channel, options)

    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isPublic) {
        const refused = refuseIfNotMainWindow(
          event,
          getMainWindow(),
          channel,
          options!.refuse as Result,
        )
        if (refused !== null) return refused
      }
      return listener(event, ...(args as Args))
    })
  }

  return { handle }
}
