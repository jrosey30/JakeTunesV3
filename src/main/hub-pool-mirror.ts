/**
 * Read-only mirror of the hub's iPod Pool for replicas (workmini).
 * 2026-10-22 ("mobile has it and so should workmini").
 *
 * The phone shows the MacBook's pool as a built-in playlist served by
 * homemini; a replica reads that same playlist over HTTP. One-way and
 * display-only: this module only ever GETs, and only ever writes its OWN
 * file (activity-pool-hub.json, a last-known-good copy for offline starts).
 * It never touches activity-pool.json, so a stale mirror can't push older
 * state back at the MacBook's pool (the hub rule, A02/A10).
 *
 * Electron-free: deps injected, node --test loads it.
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { HUB_POOL_PLAYLIST_ID, parseHubPoolBody } from '../common/hub-pool.ts'
import { withCompanionInit } from './hub-companion.ts'

export const HUB_POOL_FILE = 'activity-pool-hub.json'

export interface HubPoolMirrorDeps {
  stateDir: string
  /** Hub origin, or null when this machine is the hub (not a replica). */
  hubBase: () => Promise<string | null>
  fetchImpl?: typeof fetch
  ttlMs?: number
  requestTimeoutMs?: number
  now?: () => number
}

export interface HubPoolMirror {
  /** null = this machine is not a replica. Otherwise the pool ids in the
   *  hub's order (last-known-good when the hub can't be reached). */
  get(): Promise<number[] | null>
}

export function createHubPoolMirror(deps: HubPoolMirrorDeps): HubPoolMirror {
  const fetchImpl = deps.fetchImpl ?? fetch
  const ttl = deps.ttlMs ?? 60_000
  const now = deps.now ?? Date.now
  const file = join(deps.stateDir, HUB_POOL_FILE)
  let cached: number[] | null = null
  let at = -Infinity
  let inflight: Promise<number[]> | null = null

  async function loadFile(): Promise<number[]> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf-8')) as { ids?: unknown }
      return Array.isArray(parsed.ids) ? parsed.ids.map(Number).filter((n) => Number.isFinite(n)) : []
    } catch { return [] }
  }

  async function saveFile(ids: number[]): Promise<void> {
    try {
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ ids, updatedAt: new Date(now()).toISOString() }))
      await rename(tmp, file)
    } catch { /* the mirror file is only an offline convenience */ }
  }

  async function refresh(base: string): Promise<number[]> {
    if (cached === null) cached = await loadFile()
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), deps.requestTimeoutMs ?? 8_000)
      let res: Response
      try {
        res = await fetchImpl(`${base}/api/playlists/${HUB_POOL_PLAYLIST_ID}`, withCompanionInit({ signal: ctl.signal }))
      } finally { clearTimeout(timer) }
      if (res.status === 404) {
        // The hub serves no pool playlist: the MacBook's pool is empty (or
        // has no file). That IS the hub's answer; mirror it.
        cached = []
        await saveFile(cached)
      } else if (res.ok) {
        const ids = parseHubPoolBody(await res.json())
        if (ids) { cached = ids; await saveFile(ids) }
      }
      // Any other status or an unreadable body: keep the last good list.
    } catch { /* hub unreachable: keep the last good list */ }
    at = now()
    return cached
  }

  return {
    async get() {
      const base = await deps.hubBase()
      if (!base) return null
      if (cached !== null && now() - at < ttl) return cached
      if (!inflight) inflight = refresh(base).finally(() => { inflight = null })
      return inflight
    },
  }
}
