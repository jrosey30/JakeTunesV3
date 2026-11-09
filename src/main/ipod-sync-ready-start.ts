/**
 * The Electron half of "ready for an updated sync" (ipod-sync-ready.ts): the
 * real sources and the macOS notification. Kept out of index.ts, which is
 * ratcheted. Clicking the notification brings the window up on the Device page
 * (menu-action 'view-device', App.tsx).
 */
import { Notification, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { activityTrackCanBoard, pickReplacementTracks } from './activity-fill.ts'
import { ipodStateDirFor, loadIpodRegistry } from './ipod-identity.ts'
import { createIpodListClient } from './ipod-list-client.ts'
import { createIpodSyncReady, readManifestIds, type IpodSyncReadyRunner, type SyncBoarding } from './ipod-sync-ready.ts'
import { pushNtfy } from './ntfy-push.ts'
import { createTop1000Client } from './top1000-client.ts'

export interface IpodSyncReadyHost {
  stateDir: string
  /** homemini's base URL (no /audio). */
  baseUrl: string
  /** true on a replica (workmini, homemini's own app); a throw reads as replica. */
  isReplica: () => Promise<boolean>
  libraryTracks: () => Promise<unknown[] | undefined>
  ineligible: () => Promise<Set<number>>
  window: () => BrowserWindow | null
  send: (channel: string, ...args: unknown[]) => void
  log: (msg: string) => void
  /** homemini-down noise from the clients (rate-limited by the caller). */
  warn: (msg: string) => void
}

// A notification the code no longer references can be collected before it is clicked.
const live = new Set<Notification>()

export function startIpodSyncReady(host: IpodSyncReadyHost): IpodSyncReadyRunner {
  const top1000 = createTop1000Client({ baseUrl: host.baseUrl, warn: host.warn })
  const lists = createIpodListClient({ baseUrl: host.baseUrl, warn: host.warn })
  return createIpodSyncReady({
    stateDir: host.stateDir,
    isHub: async () => !(await host.isReplica()),
    devices: async () => (await loadIpodRegistry(host.stateDir)).devices,
    onIpod: (device) => readManifestIds(join(ipodStateDirFor(host.stateDir, device), 'last-sync-manifest.json')),
    top1000: async () => {
      const r = await top1000.list()
      return r.ok ? [...r.value.list].sort((a, b) => a.rank - b.rank).map((e) => e.id) : null
    },
    list: async (device) => {
      const r = await lists.get(device.id)
      return r.kind === 'ok' ? { ids: r.list.ids, everyDays: r.list.brain.everyDays } : null
    },
    boarding: async (): Promise<SyncBoarding | null> => {
      const tracks = ((await host.libraryTracks()) ?? []) as Array<Record<string, unknown>>
      if (tracks.length === 0) return null
      const ineligible = await host.ineligible().catch(() => new Set<number>())
      const byId = new Map<number, Record<string, unknown>>()
      for (const t of tracks) { const id = Number(t?.id); if (Number.isInteger(id)) byId.set(id, t) }
      return {
        canBoard: (id) => { const t = byId.get(id); return !!t && !ineligible.has(id) && activityTrackCanBoard(t) },
        fill: (taken, needed) => pickReplacementTracks(tracks, taken, needed, ineligible).map((t) => Number(t.id)),
      }
    },
    notify: ({ title, body }) => {
      if (!Notification.isSupported()) return
      const n = new Notification({ title, body })
      live.add(n)
      n.on('click', () => {
        live.delete(n)
        const w = host.window()
        if (w && !w.isDestroyed()) {
          if (w.isMinimized()) w.restore()
          w.show()
          w.focus()
        }
        host.send('menu-action', 'view-device')
      })
      n.on('close', () => { live.delete(n) })
      n.show()
    },
    push: (msg) => pushNtfy(msg, { log: host.log }),
    log: host.log,
  })
}
