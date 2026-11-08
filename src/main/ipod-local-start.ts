/**
 * The Electron half of "iPod songs stay on this Mac" (2026-11-08): the keep set
 * (ipod-keep-local.ts), the background download (ipod-prefetch.ts), and the
 * Device page's ready check (common/ipod-ready-on-mac.ts). Kept out of index.ts,
 * which is ratcheted.
 *
 *   'ipod-local:check' (planIds) → ReadyOnMac for the plugged-in iPod's plan
 *   'ipod-local:kick'            → re-read the lists and run a download pass now
 *
 * When it runs: 3 minutes after launch, then every 30 minutes; each run re-reads
 * the Top 1000 and every iPod list from homemini first, so a list that changed
 * is picked up on the next run (and at once from the Device page's Wait).
 * Only on the Mac Jake syncs from (not a replica): elsewhere it does nothing.
 */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IpcRegistrar } from './ipc-register.ts'
import { REFUSED_SENDER } from './ipc-register.ts'
import { withCompanionInit } from './hub-companion.ts'
import { createTop1000Client } from './top1000-client.ts'
import { createIpodListClient } from './ipod-list-client.ts'
import { loadIpodRegistry, resolveIpodState } from './ipod-identity.ts'
import { classifyLocalLibraryFile } from './activity-boardable.ts'
import { activityTrackCanBoard, pickReplacementTracks } from './activity-fill.ts'
import { onCardByRecord, readCardState } from './ipod-activity-engine.ts'
import { LAST_SYNC_MANIFEST_FILE, TSA_SEAL_FILE } from './ipod-swap-sync.ts'
import { offloadReplacementsPath, parseReplacementLog, rawAudioUrl } from './offload-audio.ts'
import { createIpodKeepLocal, keepsRel, type KeepGate } from './ipod-keep-local.ts'
import {
  discardPart, fetchResumable, planPrefetch, prefetchLogLine, runPrefetchPass, verifyFetched,
  type LocalKind, type PrefetchPassResult,
} from './ipod-prefetch.ts'
import type { MaterializeFetchResult } from './ipod-sync-materialize.ts'
import type { ReadyOnMac } from '../common/ipod-ready-on-mac.ts'

export interface IpodLocalHost {
  ipc: IpcRegistrar
  userDataDir: string
  stateDir: string
  /** homemini's base URL (no /audio). */
  baseUrl: string
  /** homemini's /audio base. */
  audioBase: string
  /** true on a replica (workmini, homemini's own app); a throw reads as replica. */
  isReplica: () => Promise<boolean>
  libraryTracks: () => Promise<ReadonlyArray<Record<string, unknown>>>
  /** The library root (the parent of iPod_Control). */
  localMount: () => string
  pathSep: string
  isPlaying: () => boolean
  syncInFlight: () => boolean
  freeBytes: () => Promise<number>
  /** Why this Mac may not hold a library file of its own here, or null (offload-audio.ts localAudioDropRefused). */
  libraryRefused: () => Promise<string | null>
  /** The existing restore path (materializeTrackFromHomemini), handed the verified bytes. */
  materialize: (colon: string, id: number, fetchAudio: (url: string) => Promise<MaterializeFetchResult>) => Promise<{ ok: boolean; error?: string }>
  mount: () => string | null
  ineligible: () => Promise<Set<number>>
  log: (msg: string) => void
  warn: (msg: string) => void
}

export interface IpodLocal {
  /** What the eviction routes ask (ipod-keep-local.ts). */
  gate(): Promise<KeepGate>
  /** For sweepOnce: true = keep this F##/file. */
  sweepKeep(): Promise<(rel: string) => boolean>
}

const FIRST_RUN_MS = 3 * 60 * 1000
const EVERY_MS = 30 * 60 * 1000

export function startIpodLocal(host: IpodLocalHost): IpodLocal {
  const top1000 = createTop1000Client({ baseUrl: host.baseUrl, warn: host.warn })
  const lists = createIpodListClient({ baseUrl: host.baseUrl, warn: host.warn })
  const applies = async (): Promise<boolean> => !(await host.isReplica().catch(() => true))
  const keep = createIpodKeepLocal({
    userDataDir: host.userDataDir,
    applies,
    top1000: async () => {
      const r = await top1000.list()
      return r.ok ? [...r.value.list].sort((a, b) => a.rank - b.rank).map((e) => e.id) : null
    },
    lists: async () => (await lists.all())?.map((l) => ({ id: l.id, name: l.name, ids: l.ids })) ?? null,
    registered: async () => new Set((await loadIpodRegistry(host.stateDir)).devices.map((d) => d.id)),
    libraryTracks: host.libraryTracks,
    log: host.log,
  })

  const kindOf = async (colon: string): Promise<LocalKind> => {
    const k = await classifyLocalLibraryFile(colon, { localMount: host.localMount(), pathSep: host.pathSep, lstat })
    return k === 'ok' ? 'local' : k === 'streamed' ? 'streamed' : 'missing'
  }

  let running = false
  let lastPass: PrefetchPassResult | null = null
  let lastSkip: string | null = null

  const reachable = async (): Promise<boolean> => {
    try {
      const res = await fetch(`${host.baseUrl.replace(/\/+$/, '')}/healthz`, withCompanionInit({ signal: AbortSignal.timeout(5000) }))
      return res.ok
    } catch {
      return false
    }
  }

  const fullSha1ByPath = async (): Promise<Map<string, string>> => {
    const out = new Map<string, string>()
    try {
      for (const r of parseReplacementLog(await readFile(offloadReplacementsPath(host.userDataDir), 'utf-8'))) {
        if (r.fullSha1 && /^[0-9a-f]{40}$/i.test(r.fullSha1)) out.set(r.path, r.fullSha1)
      }
    } catch { /* no offload log: fingerprints and sizes carry the check */ }
    return out
  }

  async function cycle(): Promise<void> {
    if (running) return
    running = true
    try {
      if (!(await applies())) return
      const { doc } = await keep.refresh()
      if (!doc) { skip('homemini hasn’t answered with the iPod lists yet'); return }
      const refused = await host.libraryRefused()
      if (refused) { skip(`this Mac keeps no library files of its own here (${refused})`); return }
      if (host.syncInFlight()) { skip('an iPod sync is running'); return }
      const tracks = await host.libraryTracks()
      const plan = await planPrefetch(doc.ids, tracks, kindOf, await fullSha1ByPath())
      lastSkip = null
      const partDir = join(host.userDataDir, 'ipod-prefetch')
      const pass = await runPrefetchPass({
        items: plan.items,
        reachable,
        isPlaying: () => host.isPlaying() || host.syncInFlight(),
        freeBytes: host.freeBytes,
        fetchOne: async (item, shouldStop) => {
          const part = join(partDir, `${item.id}.part`)
          const got = await fetchResumable({
            url: rawAudioUrl(host.audioBase, item.id), partPath: part, fetchImpl: fetch, shouldStop,
            withInit: (init) => withCompanionInit(init) ?? init,
          })
          if (!got.ok) return got
          const bad = await verifyFetched(part, item)
          if (bad) { await discardPart(part); return { ok: false, error: bad } }
          const bytes = await readFile(part)
          const r = await host.materialize(item.colon, item.id, async () => ({ ok: true, status: 200, buffer: bytes }))
          await discardPart(part)
          return r.ok ? { ok: true, bytes: bytes.length } : { ok: false, error: r.error || 'restore failed' }
        },
      })
      lastPass = pass
      host.log(prefetchLogLine(plan, pass))
    } catch (err) {
      host.warn(`[ipod-local] pass failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      running = false
    }
  }
  function skip(why: string): void {
    if (why !== lastSkip) host.log(`[ipod-local] not fetching iPod songs: ${why}`)
    lastSkip = why
  }

  const first = setTimeout(() => { void cycle() }, FIRST_RUN_MS)
  first.unref?.()
  const every = setInterval(() => { void cycle() }, EVERY_MS)
  every.unref?.()

  host.ipc.handle('ipod-local:kick', async () => {
    void cycle()
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  host.ipc.handle('ipod-local:check', async (_e, planIds: unknown): Promise<{ ok: true; ready: ReadyOnMac } | { ok: false; error: string }> => {
    try {
      const ids = Array.isArray(planIds) ? planIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
      const tracks = await host.libraryTracks()
      const byId = new Map(tracks.map((t) => [Number(t.id), t]))
      const notLocal: number[] = []
      for (const id of ids) {
        const colon = String(byId.get(id)?.path || '')
        if ((await kindOf(colon)) !== 'local') notLocal.push(id)
      }
      let onCard = new Map<number, unknown>()
      let primary = false
      const mount = host.mount()
      if (mount) {
        const st = await resolveIpodState(mount, host.stateDir)
        primary = !!st.device?.primary
        if (!st.refusal && notLocal.length > 0) {
          const readJson = async (name: string): Promise<unknown> => {
            try { return JSON.parse(await readFile(join(st.stateDir, name), 'utf-8')) } catch { return null }
          }
          onCard = onCardByRecord(notLocal, tracks as Array<Record<string, unknown>>, await readJson(LAST_SYNC_MANIFEST_FILE), await readJson(TSA_SEAL_FILE), await readCardState(mount))
        }
      }
      const missing = notLocal.filter((id) => !onCard.has(id))
      let fill: number[] = []
      if (primary && missing.length > 0) {
        const ineligible = await host.ineligible().catch(() => new Set<number>())
        const candidates = pickReplacementTracks([...tracks] as Array<Record<string, unknown>>, new Set(ids), missing.length + 200, ineligible)
        for (const t of candidates) {
          if (fill.length >= missing.length) break
          if (!activityTrackCanBoard(t)) continue
          if ((await kindOf(String(t.path || ''))) === 'local') fill.push(Number(t.id))
        }
      }
      const stoppedBecause = running ? null : (lastSkip ?? lastPass?.stoppedBecause ?? null)
      return { ok: true, ready: { total: ids.length, missing, onCard: onCard.size, fill, downloading: running || (!stoppedBecause && missing.length > 0), stoppedBecause } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, { refuse: REFUSED_SENDER })

  return {
    gate: () => keep.gate(),
    async sweepKeep() {
      const g = await keep.gate()
      return (rel: string) => keepsRel(g, rel)
    },
  }
}
