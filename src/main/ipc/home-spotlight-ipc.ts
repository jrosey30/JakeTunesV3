/**
 * Home spotlight IPC (launch page "G", 2026-10-18). The client and its cache
 * live in ../home-spotlight-client.ts; the document in
 * ../../common/home-spotlight-doc.ts; the rules in ../../common/home-spotlight.ts.
 *
 *   'home-spotlight:get'      → { ok, state }   cache or local, no network — instant
 *   'home-spotlight:refresh'  → { ok, state }   one GET (throttled), then what to draw
 *   push 'home-spotlight-updated' (state)       whenever what the Home draws changes
 *
 * Refresh cadence: shortly after boot, every 10 minutes, and when a JakeTunes
 * window gains focus (at most once a minute). The offline fallback reads this
 * Mac's play-events.jsonl ({id, ts} per play) and library.json — read-only.
 */
import { app, BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { quietWarn } from '../flight-recorder'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'
import { createHomeSpotlightClient } from '../home-spotlight-client.ts'
import { localSpotlightDoc, parsePlayEvents, spotTracksOf, type HomeSpotlightDoc } from '../../common/home-spotlight-doc.ts'

const EVERY_MS = 10 * 60_000
const FIRST_MS = 5_000
/** Focus / Home-mount refreshes closer together than this reuse the last answer. */
const MIN_GAP_MS = 60_000
/** The local computation scans the whole library per candidate artist
 *  (~120 ms on 11.7k tracks / 3.8k plays) — reuse it this long. */
const LOCAL_MEMO_MS = 5 * 60_000

export interface HomeSpotlightIpcHost {
  getPlayEventsPath: () => string
  libraryCache: { get: () => Promise<{ tracks?: unknown[] } | unknown> }
}

export function registerHomeSpotlightIpc(ipc: IpcRegistrar, host: HomeSpotlightIpcHost): void {
  let localMemo: { at: number; doc: HomeSpotlightDoc } | null = null
  const client = createHomeSpotlightClient({
    baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    dir: app.getPath('userData'),
    log: (m: string) => console.log(m),
    warn: (key: string, m: string) => quietWarn(`home-spotlight:${key}`, m),
    computeLocal: async () => {
      if (localMemo && Date.now() - localMemo.at < LOCAL_MEMO_MS) return localMemo.doc
      const [lib, events] = await Promise.all([
        host.libraryCache.get(),
        readFile(host.getPlayEventsPath(), 'utf-8').catch((err: NodeJS.ErrnoException) => {
          if (err?.code !== 'ENOENT') quietWarn('home-spotlight:play-events', '[home-spotlight] play-events read failed:', err?.message ?? err)
          return ''
        }),
      ])
      const tracks = Array.isArray((lib as { tracks?: unknown[] })?.tracks) ? (lib as { tracks: unknown[] }).tracks : []
      const doc = localSpotlightDoc(spotTracksOf(tracks), parsePlayEvents(events), Date.now())
      localMemo = { at: Date.now(), doc }
      return doc
    },
  })

  client.onChange((state) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('home-spotlight-updated', state)
    }
  })

  let lastAttempt = 0
  const refresh = (force: boolean) => {
    if (!force && Date.now() - lastAttempt < MIN_GAP_MS) return client.read()
    lastAttempt = Date.now()
    return client.refresh()
  }

  ipc.handle('home-spotlight:get', async () => ({ ok: true, state: await client.read() }), { refuse: REFUSED_SENDER })
  ipc.handle('home-spotlight:refresh', async () => ({ ok: true, state: await refresh(false) }), { refuse: REFUSED_SENDER })

  const tick = (force: boolean): void => {
    void refresh(force).catch((err: unknown) =>
      quietWarn('home-spotlight:tick', '[home-spotlight] refresh failed:', err instanceof Error ? err.message : err))
  }
  setTimeout(() => tick(true), FIRST_MS)
  setInterval(() => tick(true), EVERY_MS)
  app.on('browser-window-focus', () => tick(false))
}
