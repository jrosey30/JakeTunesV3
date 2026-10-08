// Hub catalog poll (2026-10-08) — replicas (any machine with
// library.streamRoot set: workmini today) adopt the library from homemini
// the way the phone does: poll /api/library-version, fetch
// /api/tracks/delta?since=<adopted>, hand the upserts/removals to the
// renderer, and remember the adopted version only after the renderer acks.
//
// This replaced ~/bin/jaketunes-workmini-index-sync.sh (laptop → workmini
// file swap under the running app), retired the same day. See
// src/common/hub-catalog-merge.ts for the merge rules.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { HubCatalogPayload } from '../common/hub-catalog-merge'

export interface HubCatalogDeps {
  /** app.getPath('userData') — holds hub-catalog-state.json */
  stateDir: string
  /** Hub origin (e.g. http://homemini:3000) or null when this machine is canonical. */
  hubBase: () => Promise<string | null>
  /** Deliver to the renderer; return false when no window can receive it. */
  send: (channel: string, payload: HubCatalogPayload) => boolean
  /** Non-null while library saves are locked (iPod sync etc.) — skip the tick. */
  isLocked: () => string | null
  log?: (msg: string) => void
  fetchImpl?: typeof fetch
  intervalMs?: number
  requestTimeoutMs?: number
}

interface HubState { version: string; adoptedAt?: string }

const STATE_FILE = 'hub-catalog-state.json'
const ACK_GRACE_MS = 60_000

export interface HubCatalogHandle {
  stop: () => void
  /** Renderer ack: the save that contains `version` succeeded. Calling this
   *  before that save lands (or after a refused save) retires the cursor
   *  and the delta is never retried. */
  adopted: (version: string) => Promise<void>
  /** For tests / diagnostics. */
  tick: () => Promise<void>
}

export function startHubCatalogPoll(deps: HubCatalogDeps): HubCatalogHandle {
  const log = deps.log ?? ((m: string) => console.log(m))
  const fetchImpl = deps.fetchImpl ?? fetch
  const intervalMs = deps.intervalMs ?? 15_000
  const timeoutMs = deps.requestTimeoutMs ?? 20_000
  const statePath = join(deps.stateDir, STATE_FILE)

  let inFlight = false
  let lastKey: string | null = null
  let pending: { version: string; sentAt: number } | null = null
  let stopped = false

  async function readState(): Promise<HubState> {
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as HubState
      return typeof raw?.version === 'string' ? raw : { version: '' }
    } catch { return { version: '' } }
  }
  async function writeState(s: HubState): Promise<void> {
    await mkdir(deps.stateDir, { recursive: true })
    const tmp = `${statePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(s), 'utf-8')
    await rename(tmp, statePath)
  }
  async function getJson<T>(url: string): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as T
    } finally { clearTimeout(timer) }
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const base = await deps.hubBase()
      if (!base) return                                   // canonical machine: inert
      const lock = deps.isLocked()
      if (lock) return                                    // iPod sync etc. — not now
      // A payload we sent but never got acked (window not ready, renderer
      // busy) is re-sent after a grace period rather than lost forever.
      if (pending && Date.now() - pending.sentAt < ACK_GRACE_MS) return
      if (pending) { pending = null; lastKey = null }

      const ver = await getJson<Record<string, unknown>>(`${base}/api/library-version`)
      const key = ['library', 'tracks', 'stars', 'plays'].map((k) => String(ver[k] ?? '')).join('|')
      if (key === lastKey) return
      const state = await readState()
      const since = encodeURIComponent(state.version)
      const d = await getJson<Record<string, unknown>>(`${base}/api/tracks/delta?since=${since}`)
      const version = typeof d.version === 'string' ? d.version : ''
      if (!version) throw new Error('delta reply had no version')
      if (d.unchanged === true) {
        lastKey = key
        if (state.version !== version) await writeState({ version, adoptedAt: new Date().toISOString() })
        return
      }
      const full = d.full === true
      const upserts = (full ? d.items : d.upserts) as HubCatalogPayload['upserts'] | undefined
      const removedIds = (Array.isArray(d.removedIds) ? d.removedIds : []) as Array<string | number>
      const payload: HubCatalogPayload = { full, version, upserts: Array.isArray(upserts) ? upserts : [], removedIds }
      if (!deps.send('hub-catalog-updated', payload)) {
        log('[hub-catalog] no window to receive the catalog — will retry')
        return
      }
      pending = { version, sentAt: Date.now() }
      lastKey = key
      log(`[hub-catalog] sent ${full ? 'FULL' : 'delta'} ${version}: ${payload.upserts.length} upsert(s), ${removedIds.length} removal(s)`)
    } catch (err) {
      log(`[hub-catalog] tick failed (will retry): ${(err as Error)?.message ?? err}`)
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  return {
    stop: () => { stopped = true; clearInterval(timer) },
    adopted: async (version: string) => {
      if (pending && pending.version === version) pending = null
      await writeState({ version, adoptedAt: new Date().toISOString() })
      log(`[hub-catalog] adopted ${version}`)
    },
    tick,
  }
}
