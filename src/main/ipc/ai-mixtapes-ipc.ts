/**
 * Daily AI tapes IPC (2026-10-22, parity gap #9) — the phone's daily tapes
 * rail, Keep, and the kept tapes on the shelf. The client and its cache live
 * in ../ai-mixtapes-client.ts; the rules in ../../common/ai-mixtapes.ts.
 *
 *   'ai-mixtapes:get'            → { ok, state }  cache or nothing, no network — instant
 *   'ai-mixtapes:refresh'        → { ok, state }  one GET (throttled unless forced), then what to draw
 *   'ai-mixtapes:keep' (id, kept) → { ok, error? } POST the Keep flag to homemini
 *   push 'ai-mixtapes-updated' (state)           whenever what the rail / shelf draws changes
 *
 * Registered by registerMobileReadsIpc (its sibling for the phone's daily
 * mixes), so main/index.ts does not grow. Refresh cadence: shortly after
 * boot, every 10 minutes, when a JakeTunes window gains focus (at most once a
 * minute), and right after Home's /api/mixes call has minted today's batch.
 */
import { app, BrowserWindow } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { quietWarn } from '../flight-recorder'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'
import { createAiMixtapesClient } from '../ai-mixtapes-client.ts'

const EVERY_MS = 10 * 60_000
const FIRST_MS = 7_000
const MIN_GAP_MS = 60_000

export function registerAiMixtapesIpc(ipc: IpcRegistrar): void {
  const client = createAiMixtapesClient({
    baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    dir: app.getPath('userData'),
    log: (m: string) => console.log(m),
    warn: (key: string, m: string) => quietWarn(`ai-mixtapes:${key}`, m),
  })

  client.onChange((state) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('ai-mixtapes-updated', state)
    }
  })

  let lastAttempt = 0
  const refresh = (force: boolean) => {
    if (!force && Date.now() - lastAttempt < MIN_GAP_MS) return client.read()
    lastAttempt = Date.now()
    return client.refresh()
  }

  ipc.handle('ai-mixtapes:get', async () => ({ ok: true, state: await client.read() }), { refuse: REFUSED_SENDER })
  // force: Home asks right after /api/mixes minted today's batch — the phone
  // reads the tapes straight after that call too (MixesSection.load()).
  ipc.handle('ai-mixtapes:refresh', async (_e, force?: boolean) => ({ ok: true, state: await refresh(force === true) }), { refuse: REFUSED_SENDER })
  ipc.handle('ai-mixtapes:keep', async (_e, id: unknown, kept: unknown) => {
    // Identity only: the tape's own id, exactly as homemini minted it.
    if (typeof id !== 'string' || !id || id.length > 200) return { ok: false, error: 'bad id' }
    return client.keep(id, kept === true)
  }, { refuse: REFUSED_SENDER })

  const tick = (force: boolean): void => {
    void refresh(force).catch((err: unknown) =>
      quietWarn('ai-mixtapes:tick', '[ai-mixtapes] refresh failed:', err instanceof Error ? err.message : err))
  }
  setTimeout(() => tick(true), FIRST_MS)
  setInterval(() => tick(true), EVERY_MS)
  app.on('browser-window-focus', () => tick(false))
}
