/**
 * Plays-elsewhere IPC (2026-10-20) — the phone's and workmini's plays, counted
 * on this Mac too. The client and its cache live in ../plays-elsewhere-client.ts;
 * the contract and the display-only rule in ../../common/plays-elsewhere.ts.
 *
 *   'plays-elsewhere:get'        → { ok, state }   cache or nothing, no network — instant
 *   push 'plays-elsewhere-updated' (state)        whenever what the views count changes
 *
 * windowed(cutoff) feeds get-windowed-play-counts (Top 25's week / month).
 *
 * Registered by registerMobileReadsIpc (its sibling for the phone's state), so
 * main/index.ts does not grow. Refresh cadence: shortly after boot, every 10
 * minutes, and when a JakeTunes window gains focus (at most once a minute).
 */
import { app, BrowserWindow } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { quietWarn } from '../flight-recorder'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'
import { createPlaysElsewhereClient } from '../plays-elsewhere-client.ts'
import { windowedElsewhere, type PlaysElsewhereState } from '../../common/plays-elsewhere.ts'

const EVERY_MS = 10 * 60_000
const FIRST_MS = 8_000
const MIN_GAP_MS = 60_000

export interface PlaysElsewhereIpcHost {
  /** true on a replica (workmini) — its own plays are in the feed. */
  isReplica: () => Promise<boolean>
}

export function registerPlaysElsewhereIpc(ipc: IpcRegistrar, host: PlaysElsewhereIpcHost): { windowed: (cutoff: number) => Promise<Record<string, number>> } {
  const client = createPlaysElsewhereClient({
    baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    dir: app.getPath('userData'),
    isReplica: host.isReplica,
    log: (m: string) => console.log(m),
    warn: (key: string, m: string) => quietWarn(`plays-elsewhere:${key}`, m),
  })

  let current: PlaysElsewhereState | null = null
  client.onChange((state) => {
    current = state
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('plays-elsewhere-updated', state)
    }
  })

  let lastAttempt = 0
  const tick = (force: boolean): void => {
    if (!force && Date.now() - lastAttempt < MIN_GAP_MS) return
    lastAttempt = Date.now()
    void client.refresh().catch((err: unknown) =>
      quietWarn('plays-elsewhere:tick', '[plays-elsewhere] refresh failed:', err instanceof Error ? err.message : err))
  }

  ipc.handle('plays-elsewhere:get', async () => ({ ok: true, state: await client.read() }), { refuse: REFUSED_SENDER })

  setTimeout(() => tick(true), FIRST_MS)
  setInterval(() => tick(true), EVERY_MS)
  app.on('browser-window-focus', () => tick(false))

  return {
    windowed: async (cutoff: number) => windowedElsewhere((current ?? await client.read()).doc, cutoff),
  }
}
