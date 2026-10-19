/**
 * Synced picks IPC (2026-10-18) — TOP 10 ISLAND ALBUMS + 5 FAVORITE ARTISTS,
 * shared with the phone through homemini (the only writer). The client and
 * its cache/outbox live in ../synced-picks-client.ts; the contract in
 * ../../common/synced-picks.ts.
 *
 *   'synced-picks:get'     (kind)          → { ok, state }   disk only, instant
 *   'synced-picks:refresh' (kind)          → { ok, state }   GET + replay a queued edit
 *   'synced-picks:save'    (kind, values)  → { ok, state } | { ok:false, error, state }
 *   push 'synced-picks-updated' (state)    whenever what the renderer draws changes
 *
 * The renderer refreshes on window focus and every 30 s while visible (only
 * while a shelf is on screen). Main adds one quiet timer: when an edit is
 * queued, retry it every 60 s — so an offline edit lands even if Jake never
 * reopens the Albums or Artists page. No edit queued = no traffic.
 */
import { app, BrowserWindow } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { quietWarn } from '../flight-recorder'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'
import { createSyncedPicksClient, type SyncedPicksClient } from '../synced-picks-client.ts'
import {
  ISLAND_ALBUMS_SPEC, FAVORITE_ARTISTS_SPEC, isPicksKind,
  type IslandSlot, type FavoriteSlot, type PicksKind,
} from '../../common/synced-picks.ts'

const REPLAY_EVERY_MS = 60_000
const FIRST_REPLAY_MS = 12_000

export function registerSyncedPicksIpc(ipc: IpcRegistrar): void {
  const dir = app.getPath('userData')
  const baseUrl = MOBILE_BACKEND_URL.replace(/\/audio$/, '')
  const common = {
    baseUrl,
    dir,
    log: (m: string) => console.log(m),
    warn: (key: string, m: string) => quietWarn(`synced-picks:${key}`, m),
  }
  const clients: { 'island-albums': SyncedPicksClient<IslandSlot>; 'favorite-artists': SyncedPicksClient<FavoriteSlot> } = {
    'island-albums': createSyncedPicksClient({ ...common, spec: ISLAND_ALBUMS_SPEC }),
    'favorite-artists': createSyncedPicksClient({ ...common, spec: FAVORITE_ARTISTS_SPEC }),
  }
  const clientFor = (kind: PicksKind): SyncedPicksClient<IslandSlot> | SyncedPicksClient<FavoriteSlot> => clients[kind]

  for (const c of Object.values(clients)) {
    c.onChange((state) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('synced-picks-updated', state)
      }
    })
  }

  const badKind = { ok: false, error: 'unknown picks kind' } as const

  ipc.handle('synced-picks:get', async (_e, kind: unknown) => {
    if (!isPicksKind(kind)) return badKind
    return { ok: true, state: await clientFor(kind).read() }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('synced-picks:refresh', async (_e, kind: unknown) => {
    if (!isPicksKind(kind)) return badKind
    return { ok: true, state: await clientFor(kind).sync() }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('synced-picks:save', async (_e, kind: unknown, values: unknown) => {
    if (!isPicksKind(kind)) return badKind
    return clientFor(kind).save(values)
  }, { refuse: REFUSED_SENDER })

  // Outbox replay for edits made while homemini was away.
  const replayQueued = (): void => {
    for (const c of [clients['island-albums'], clients['favorite-artists']] as Array<SyncedPicksClient<unknown>>) {
      void c.hasPending().then(async (p) => { if (p) await c.sync() }).catch((err: unknown) =>
        quietWarn(`synced-picks:${c.spec.kind}:replay`, `[${c.spec.kind}] queued-edit replay failed:`, err instanceof Error ? err.message : err))
    }
  }
  setTimeout(replayQueued, FIRST_REPLAY_MS)
  setInterval(replayQueued, REPLAY_EVERY_MS)
}
