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

export interface RegisterHandleOptions {
  /**
   * Skip the main-window sender guard. Use only for intentionally
   * public / read-only channels.
   */
  public?: boolean
  /**
   * Value returned when a non-main-window sender is refused.
   * Required unless `public: true`.
   *
   * Deliberately NOT typed as the handler's Result: when it shared the
   * generic, TypeScript inferred Result from THIS literal and pinned all
   * 70+ call sites' handlers to the refusal shape (the 2026-08 "73
   * errors" wall). The refusal is a wire value the renderer's `{ ok:
   * false }` handling already absorbs — it never was the handler's type.
   */
  refuse?: unknown
}

export interface IpcRegistrar {
  handle: <Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
    options?: RegisterHandleOptions,
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
  options?: RegisterHandleOptions,
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

/**
 * Every invoke that went through a registrar, once it has answered: the usage
 * log (usage-log-start.ts) times them. `ok` is false when the handler threw
 * or answered `{ ok: false }`. Arguments and results never leave here.
 */
export interface IpcObservation { channel: string; ms: number; ok: boolean; error?: string; refused?: boolean }
export type IpcObserver = (o: IpcObservation) => void
let ipcObserver: IpcObserver | null = null
/** Channels with an invoke still running (a CD rip, an iPod sync): name → how many. */
const inFlight = new Map<string, number>()

export function observeIpc(fn: IpcObserver | null): void { ipcObserver = fn }
export function ipcInFlight(channel: string): boolean { return (inFlight.get(channel) ?? 0) > 0 }

function shortError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200)
}

/** Time one invoke for the observer. The observer can never change what the renderer gets. */
export async function observed<R>(channel: string, run: () => Promise<R> | R): Promise<R> {
  const began = performance.now()
  inFlight.set(channel, (inFlight.get(channel) ?? 0) + 1)
  const tell = (o: Omit<IpcObservation, 'channel' | 'ms'>): void => {
    const n = (inFlight.get(channel) ?? 1) - 1
    if (n > 0) inFlight.set(channel, n)
    else inFlight.delete(channel)
    if (!ipcObserver) return
    try { ipcObserver({ channel, ms: Math.round(performance.now() - began), ...o }) } catch { /* observation only */ }
  }
  try {
    const result = await run()
    const r = result as { ok?: unknown; error?: unknown } | null
    const failed = !!r && typeof r === 'object' && r.ok === false
    tell({ ok: !failed, ...(failed && r.error !== undefined ? { error: shortError(r.error) } : {}), ...(failed && r.error === 'refused-sender' ? { refused: true } : {}) })
    return result
  } catch (err) {
    tell({ ok: false, error: shortError(err) })
    throw err
  }
}

export function createIpcRegistrar(getMainWindow: MainWindowAccessor): IpcRegistrar {
  // Lazy so importing this module under node:test does not need Electron.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = require('electron') as typeof import('electron')

  function handle<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
    options?: RegisterHandleOptions,
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
      return observed(channel, () => listener(event, ...(args as Args)))
    })
  }

  return { handle }
}
