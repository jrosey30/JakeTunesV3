/**
 * User-edit journal wiring (2026-10-20) — the rules are src/common/user-edits.ts.
 *
 * Three roles, decided per call:
 *   hub      the MacBook (not a replica, and it runs the homemini sync). Its
 *            journal times its own edits; every 5 minutes it fetches
 *            GET /api/user-edits and absorbs what the replicas' journals hold
 *            into its overrides — through the app's own override writer, the
 *            star sidecar at the edit's own time, and the open window — then
 *            asks the sync to publish.
 *   replica  workmini. Its journal is the only thing that carries Jake's
 *            edits upstream (the sync pushes it to replicas/<name>/). At load
 *            its overrides file and the phone overlay lose every field the hub
 *            catalog carries (replicaOverlay); its journal, checked against
 *            the hub's (fetched here, cached for boots while homemini is
 *            away), puts back the edits that still stand — and pinPending
 *            keeps them on the hub catalog's rows until the hub absorbs them.
 *   off      anything else — homemini's own JakeTunes, whose app folder IS
 *            where the MacBook's state lands. It keeps no journal, absorbs
 *            nothing and changes nothing at load.
 *
 * The journal file is written only by record() (the save-metadata-override
 * handler) and by the hub's absorb. A journal that exists but does not parse
 * stops both and is never overwritten.
 *
 * Electron-free: every dependency is injected (__tests__/user-edits-sync.test.ts).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import { HUB_CATALOG_FIELDS, HUB_DETAIL_FIELDS, type HubCatalogPayload } from '../common/hub-catalog-merge.ts'
import {
  USER_EDITS_FILE, USER_EDITS_HUB_CACHE_FILE, USER_EDITS_PATH,
  emptyUserEdits, isUserEditField, parseUserEdits, pinPendingEdits, planHubAbsorb, recordUserEdit,
  replicaLiveUpdates, replicaOverlay, rowFingerprint, seedStarsFromOverrides,
  type RowLike, type StarEventsLike, type UserEditsDoc,
} from '../common/user-edits.ts'

export type UserEditsRole = 'hub' | 'replica' | 'off'

/** No homemini sync script = not a Mac whose edits go anywhere (homemini itself). */
export function userEditsRole(o: { isReplica: boolean; syncScriptPresent: boolean }): UserEditsRole {
  if (!o.syncScriptPresent) return 'off'
  return o.isReplica ? 'replica' : 'hub'
}

/** Fields a replica takes from the hub catalog, never from its own overrides file. */
export const HUB_OWNED_FIELDS: ReadonlySet<string> = new Set<string>(HUB_CATALOG_FIELDS)
/** Details the catalog carries when the hub knows them (its blank never erases a replica's). */
export const HUB_DETAIL_OWNED: ReadonlySet<string> = new Set<string>(HUB_DETAIL_FIELDS)
/** Everything the hub catalog merge takes from the hub. */
export const HUB_CARRIED_FIELDS: ReadonlySet<string> = new Set<string>([...HUB_CATALOG_FIELDS, ...HUB_DETAIL_FIELDS])

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

export interface UserEditsHost {
  /** STATE_DIR — where user-edits.json lives */
  dir: string
  /** homemini backend origin, e.g. http://homemini:3000 */
  baseUrl: string
  role: () => Promise<UserEditsRole>
  /** library rows by id (library.json as saved on this Mac) */
  rows: () => Promise<ReadonlyMap<string, RowLike>>
  /** this Mac's metadata-overrides.json (the live cache object) */
  overrides: () => Promise<Record<string, unknown>>
  /** this Mac's star sidecar */
  stars: () => Promise<StarEventsLike>
  /** non-null while saves are locked (iPod sync) — the hub absorbs nothing then */
  isLocked: () => string | null
  /** hub: write one field through the app's override writer */
  writeOverride: (id: number, field: string, value: string, fingerprint: string | undefined) => Promise<void>
  /** hub: the star sidecar takes an absorbed star / un-star at the edit's time */
  starAt: (id: number, starred: boolean, at: number) => Promise<void>
  /** the open window applies these field values */
  applied: (updates: Array<{ id: number; field: string; value: string }>) => void
  /** hub: publish after absorbing */
  publish: () => void
  fetchImpl?: FetchLike
  now?: () => number
  log?: (msg: string) => void
  warn?: (key: string, msg: string) => void
  timeoutMs?: number
}

export interface UserEditsSync {
  /** A person's edit, at `at` (epoch ms). No-op for non-user fields and role 'off'. */
  record(trackId: number, field: string, value: string, at: number): Promise<void>
  /** A replica's overrides at load; unchanged on the hub and 'off'. */
  overlay(merged: Record<string, unknown>): Promise<Record<string, unknown>>
  /** hub: absorb the replicas' journals; replica: refresh the hub's journal. */
  tick(): Promise<void>
  /**
   * Replica: the hub catalog's payload with this replica's standing edits
   * pinned onto its rows (sync; uses the journals loaded at boot — before
   * that, the payload is unchanged).
   */
  pinPending<P extends Pick<HubCatalogPayload, 'upserts'>>(payload: P): P
  /** Wait for queued journal writes (tests, quit). */
  flush(): Promise<void>
}

/** The fingerprint an absorbed field is written with — never one that would wipe an entry. */
export function absorbFingerprint(overrides: Record<string, unknown>, id: string, row: RowLike): string | undefined {
  const cur = overrides[id] as { fp?: unknown; fields?: unknown } | undefined
  if (cur && typeof cur === 'object' && cur.fields && typeof cur.fields === 'object') {
    return typeof cur.fp === 'string' && cur.fp ? cur.fp : undefined   // merge, keep the entry's own fp
  }
  return rowFingerprint(row)
}

interface Reply { hub: UserEditsDoc | null; replicas: Array<{ name: string; doc: UserEditsDoc }> }

export function parseUserEditsReply(raw: unknown): Reply | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1 || !Array.isArray(o.replicas)) return null
  const hubRaw = o.hub as { doc?: unknown } | null | undefined
  const hub = hubRaw && typeof hubRaw === 'object' ? parseUserEdits(hubRaw.doc) : null
  const replicas: Reply['replicas'] = []
  for (const r of o.replicas as unknown[]) {
    const rr = r as { name?: unknown; doc?: unknown } | null
    const doc = rr ? parseUserEdits(rr.doc) : null
    if (doc && typeof rr!.name === 'string' && /^[a-z0-9-]+$/.test(rr!.name)) replicas.push({ name: rr!.name, doc })
  }
  return { hub, replicas }
}

export function createUserEditsSync(host: UserEditsHost): UserEditsSync {
  const fetchImpl: FetchLike = host.fetchImpl ?? (fetch as unknown as FetchLike)
  const now = host.now ?? Date.now
  const log = host.log ?? ((m: string) => console.log(m))
  const warn = host.warn ?? ((_k: string, m: string) => console.warn(m))
  const file = join(host.dir, USER_EDITS_FILE)
  const hubCacheFile = join(host.dir, USER_EDITS_HUB_CACHE_FILE)
  const url = `${host.baseUrl.replace(/\/+$/, '')}${USER_EDITS_PATH}`

  let mine: UserEditsDoc | null = null
  let state: 'unloaded' | 'ok' | 'corrupt' = 'unloaded'
  let loading: Promise<UserEditsDoc | null> | null = null
  let writeChain: Promise<void> = Promise.resolve()
  let hubDoc: UserEditsDoc | null | undefined   // replica: undefined = not read yet
  let etag: string | null = null
  // hub: the replicas' journals from the last 200. A 304 re-plans against
  // them — a song held because it was not on the hub yet lands once it is.
  let lastReplicas: Reply['replicas'] = []
  let overlaidRole = false   // replica: the boot overlay ran, so `mine` and `hubDoc` are this replica's

  function persist(): void {
    const snapshot = mine
    if (!snapshot) return
    writeChain = writeChain.then(() => writeJsonAtomic(file, snapshot, false)).catch((err) => {
      warn('user-edits-write', `[user-edits] could not save ${USER_EDITS_FILE}: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async function loadMine(role: UserEditsRole): Promise<UserEditsDoc | null> {
    if (role === 'off') return null
    if (state === 'ok') return mine
    if (state === 'corrupt') return null
    loading ??= (async () => {
      let text: string | null = null
      try { text = await readFile(file, 'utf-8') } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          state = 'corrupt'
          warn('user-edits-read', `[user-edits] ${USER_EDITS_FILE} unreadable — journal off, file left alone: ${err instanceof Error ? err.message : String(err)}`)
          return null
        }
      }
      if (text !== null) {
        let parsed: UserEditsDoc | null = null
        try { parsed = parseUserEdits(JSON.parse(text)) } catch { parsed = null }
        if (!parsed) {
          state = 'corrupt'
          warn('user-edits-read', `[user-edits] ${USER_EDITS_FILE} is not a journal — journal off, file left alone`)
          return null
        }
        mine = parsed
        state = 'ok'
        return mine
      }
      // First journal on this Mac. A replica backfills the stars it set
      // before journals existed (the only timed evidence its file holds).
      let doc = emptyUserEdits(now())
      if (role === 'replica') {
        const [overrides, rows] = await Promise.all([host.overrides(), host.rows()])
        const seeded = seedStarsFromOverrides(doc, overrides, rows, now())
        doc = seeded.doc
        log(`[user-edits] started this replica's journal — ${seeded.seeded} earlier star(s) carried in from starredAt`)
      } else {
        log('[user-edits] started the hub journal')
      }
      mine = doc
      state = 'ok'
      persist()
      return mine
    })().finally(() => { loading = null })
    return loading
  }

  async function fetchReply(): Promise<Reply | null | 'unchanged'> {
    let res: FetchReply
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (etag) headers['If-None-Match'] = etag
      res = await fetchImpl(url, withCompanionInit({ headers, signal: AbortSignal.timeout(host.timeoutMs ?? 10_000) }) as Record<string, unknown>)
    } catch (err) {
      warn('user-edits-unreachable', `[user-edits] homemini unreachable (${err instanceof Error ? err.message : String(err)}) — next tick retries`)
      return null
    }
    if (res.status === 304) return 'unchanged'
    if (!res.ok) {
      warn('user-edits-http', `[user-edits] GET ${USER_EDITS_PATH} → ${res.status} — next tick retries`)
      return null
    }
    const reply = parseUserEditsReply(await res.json().catch(() => null))
    if (!reply) { warn('user-edits-shape', `[user-edits] GET ${USER_EDITS_PATH} returned no journal document`); return null }
    etag = res.headers?.get('etag') ?? null
    return reply
  }

  async function readHubCache(): Promise<UserEditsDoc | null> {
    try {
      const raw = JSON.parse(await readFile(hubCacheFile, 'utf-8')) as { doc?: unknown }
      return parseUserEdits(raw?.doc)
    } catch { return null }
  }

  async function hubTick(): Promise<void> {
    const doc = await loadMine('hub')
    if (!doc) return
    const locked = host.isLocked()
    if (locked) return
    const reply = await fetchReply()
    if (!reply) return
    if (reply !== 'unchanged') lastReplicas = reply.replicas
    if (lastReplicas.length === 0) return
    const [overrides, rows, stars] = await Promise.all([host.overrides(), host.rows(), host.stars()])
    const plan = planHubAbsorb({ replicas: lastReplicas, hub: mine!, overrides, rows, stars })
    for (const w of plan.writes) {
      const row = rows.get(w.id)
      if (!row) continue
      await host.writeOverride(Number(w.id), w.field, w.value, absorbFingerprint(overrides, w.id, row))
      if (w.field === 'rating') await host.starAt(Number(w.id), Number(w.value) > 0, w.at)
    }
    if (plan.hub !== mine) { mine = plan.hub; persist() }
    if (plan.writes.length > 0) {
      host.applied(plan.writes.map((w) => ({ id: Number(w.id), field: w.field, value: w.value })))
      host.publish()
    }
    const summary = Object.entries(plan.counts).map(([k, n]) => `${k} ${n}`).join(', ')
    if (summary && (plan.writes.length > 0 || plan.hub !== doc)) {
      log(`[user-edits] replica edits: ${summary} — ${plan.writes.length} field(s) written: ${plan.writes.slice(0, 8).map((w) => `${w.id}.${w.field}`).join(' ')}`)
    }
  }

  async function replicaTick(): Promise<void> {
    const reply = await fetchReply()
    if (!reply || reply === 'unchanged') return
    const prev = hubDoc === undefined ? await readHubCache() : hubDoc
    const next = reply.hub
    hubDoc = next
    if (JSON.stringify(prev) === JSON.stringify(next)) return
    await writeJsonAtomic(hubCacheFile, { doc: next, fetchedAt: now() }, false).catch((err) => {
      warn('user-edits-cache', `[user-edits] could not cache the hub journal: ${err instanceof Error ? err.message : String(err)}`)
    })
    const updates = replicaLiveUpdates(prev, next, await loadMine('replica'), HUB_CARRIED_FIELDS)
    if (updates.length > 0) {
      host.applied(updates.map((u) => ({ id: Number(u.id), field: u.field, value: u.value })))
      log(`[user-edits] hub journal changed — ${updates.length} field(s) updated here`)
    }
  }

  return {
    async record(trackId, field, value, at) {
      if (!isUserEditField(field)) return
      try {
        const role = await host.role()
        const doc = await loadMine(role)
        if (!doc) return
        const row = (await host.rows()).get(String(trackId))
        const dur = Number(row?.duration) || 0
        const next = recordUserEdit(mine!, trackId, field, value, at, dur > 0 ? { dur } : {})
        if (next !== mine) { mine = next; persist() }
      } catch (err) {
        warn('record', `[user-edits] could not journal ${field} on ${trackId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    async overlay(merged) {
      if ((await host.role()) !== 'replica') return merged
      const doc = await loadMine('replica')
      if (hubDoc === undefined) hubDoc = await readHubCache()
      const rows = await host.rows()
      const r = replicaOverlay(merged, { hubFields: HUB_OWNED_FIELDS, hubDetailFields: HUB_DETAIL_OWNED, rows, mine: doc, hub: hubDoc })
      overlaidRole = true
      log(`[user-edits] replica overlay: ${r.droppedFields} hub-owned field(s) from local overrides left to the hub, ${r.journalFields} journal field(s) applied`)
      return r.overrides
    },
    async tick() {
      const role = await host.role()
      if (role === 'hub') await hubTick()
      else if (role === 'replica') await replicaTick()
    },
    async flush() { await writeChain },
    pinPending(payload) {
      if (!overlaidRole || !mine || !Array.isArray(payload.upserts)) return payload
      const r = pinPendingEdits(payload.upserts, mine, hubDoc ?? null, HUB_CARRIED_FIELDS)
      if (r.pinned === 0) return payload
      log(`[user-edits] kept ${r.pinned} field(s) Jake edited here over the hub catalog (not absorbed yet)`)
      return { ...payload, upserts: r.upserts }
    },
  }
}
