/**
 * Home shelves IPC (2026-10-20) — the three rows under launch page "G". The
 * client and its cache live in ../home-shelves-client.ts; the document in
 * ../../common/home-shelves-doc.ts; the rules in ../../common/home-shelves.ts.
 *
 *   'home-shelves:get'          → { ok, state }   cache or nothing, no network — instant
 *   'home-shelves:refresh'      → { ok, state }   one GET (throttled), then what to draw
 *   'home-shelves:local-plays'  → { ok, plays }   this Mac's play history ({id, ts}) for
 *                                                 the renderer's offline rows — read-only
 *   push 'home-shelves-updated' (state)          whenever what the Home draws changes
 *   'listen-more-weekly:get' / ':refresh'        → { ok, state }  homemini's weekly playlist
 *                                                 (../listen-more-weekly-client.ts) — the row's
 *                                                 "See all" and the sidebar's Listen More Weekly
 *   push 'listen-more-weekly-updated' (state)    when that week's list changes
 *
 * Registered by registerHomeSpotlightIpc (its sibling on the same Home), so
 * main/index.ts does not grow. Refresh cadence: shortly after boot, every 10
 * minutes, and when a JakeTunes window gains focus (at most once a minute).
 */
import { app, BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { quietWarn } from '../flight-recorder'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'
import { createHomeShelvesClient } from '../home-shelves-client.ts'
import { createListenMoreWeeklyClient } from '../listen-more-weekly-client.ts'
import { createOverlookedClient } from '../overlooked-client.ts'
import { createTop1000Client } from '../top1000-client.ts'
import { parsePlayEvents } from '../../common/home-spotlight-doc.ts'

const EVERY_MS = 10 * 60_000
const FIRST_MS = 6_000
/** Focus / Home-mount refreshes closer together than this reuse the last answer. */
const MIN_GAP_MS = 60_000

export interface HomeShelvesIpcHost {
  getPlayEventsPath: () => string
}

export function registerHomeShelvesIpc(ipc: IpcRegistrar, host: HomeShelvesIpcHost): void {
  const client = createHomeShelvesClient({
    baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    dir: app.getPath('userData'),
    log: (m: string) => console.log(m),
    warn: (key: string, m: string) => quietWarn(`home-shelves:${key}`, m),
  })

  client.onChange((state) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('home-shelves-updated', state)
    }
  })

  let lastAttempt = 0
  const refresh = (force: boolean) => {
    if (!force && Date.now() - lastAttempt < MIN_GAP_MS) return client.read()
    lastAttempt = Date.now()
    return client.refresh()
  }

  // The Overlooked page (2026-10-22): homemini's brain-ranked song lanes.
  const overlooked = createOverlookedClient({
    baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    warn: (m: string) => quietWarn('overlooked', m),
  })
  ipc.handle('overlooked:get', async (_e: unknown, force?: unknown) => ({ ok: true, state: await overlooked.get(force === true) }), { refuse: REFUSED_SENDER })

  // The Top 1000 Quiz (2026-10-23): homemini asks, ranks and keeps the answers.
  const top1000 = createTop1000Client({
    baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    warn: (m: string) => quietWarn('top1000', m),
  })
  ipc.handle('top1000:next', async () => top1000.next(), { refuse: REFUSED_SENDER })
  ipc.handle('top1000:answer', async (_e: unknown, input: unknown) => {
    const i = (input ?? {}) as { kind?: unknown; ids?: unknown; choice?: unknown; reasons?: unknown }
    if (typeof i.kind !== 'string' || !Array.isArray(i.ids) || typeof i.choice !== 'string') {
      return { ok: false, error: 'That answer was incomplete.' }
    }
    return top1000.answer({
      kind: i.kind as 'pick',
      ids: i.ids.map(String),
      choice: i.choice,
      reasons: Array.isArray(i.reasons) ? (i.reasons.map(String) as never[]) : undefined,
    })
  }, { refuse: REFUSED_SENDER })
  ipc.handle('top1000:list', async () => top1000.list(), { refuse: REFUSED_SENDER })

  ipc.handle('home-shelves:get', async () => ({ ok: true, state: await client.read() }), { refuse: REFUSED_SENDER })
  ipc.handle('home-shelves:refresh', async () => ({ ok: true, state: await refresh(false) }), { refuse: REFUSED_SENDER })
  ipc.handle('home-shelves:local-plays', async () => {
    const text = await readFile(host.getPlayEventsPath(), 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== 'ENOENT') quietWarn('home-shelves:play-events', '[home-shelves] play-events read failed:', err?.message ?? err)
      return ''
    })
    return { ok: true, plays: parsePlayEvents(text) }
  }, { refuse: REFUSED_SENDER })

  // Listen More Weekly — homemini's weekly playlist, refreshed on the same
  // ticks as the rows (it turns over on Mondays; the cache bridges absences).
  const weekly = createListenMoreWeeklyClient({
    baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    dir: app.getPath('userData'),
    warn: (key: string, m: string) => quietWarn(`listen-more-weekly:${key}`, m),
  })
  weekly.onChange((state) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('listen-more-weekly-updated', state)
    }
  })
  ipc.handle('listen-more-weekly:get', async () => ({ ok: true, state: await weekly.read() }), { refuse: REFUSED_SENDER })
  ipc.handle('listen-more-weekly:refresh', async () => ({ ok: true, state: await weekly.refresh() }), { refuse: REFUSED_SENDER })

  const tick = (force: boolean): void => {
    void refresh(force).catch((err: unknown) =>
      quietWarn('home-shelves:tick', '[home-shelves] refresh failed:', err instanceof Error ? err.message : err))
    if (force) {
      void weekly.refresh().catch((err: unknown) =>
        quietWarn('listen-more-weekly:tick', '[listen-more-weekly] refresh failed:', err instanceof Error ? err.message : err))
    }
  }
  setTimeout(() => tick(true), FIRST_MS)
  setInterval(() => tick(true), EVERY_MS)
  app.on('browser-window-focus', () => tick(false))
}
