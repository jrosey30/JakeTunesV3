/**
 * A song Jake saves from an iPod's shelf in the Record Shop joins that iPod's
 * list (Brief 259, 2026-11-20). Jake saved 22 songs from the Y2K shelf and
 * asked why they weren't on the Y2K iPod: the save downloaded them, homemini's
 * nightly wanted check dropped them as "now in your library", and nothing put
 * them on the list. Choosing a song from that iPod's shelf is his yes.
 *
 * How (the shelf → the job → the import → homemini):
 *   - The shelf's Save puts the list's id on the download job
 *     (QueueOrigin.forIpodList, renderer NewForYouView), and the job sends it
 *     to main (`streamrip:download-by-query` opts.forIpodList).
 *   - When that job's import lands, main has the exact track ids it imported
 *     (streamrip-store importStaged) and calls `queueShelfSave(list, ids)`:
 *     they are on THIS Mac's disk (ipod-shelf-joins.json) before homemini is
 *     asked, so a quit or no signal can't lose them.
 *   - homemini is told with POST /api/ipod-lists/:id/add
 *     { ids, by: 'claude', why, from: 'shelf' }. Its rules decide: the cap,
 *     the skit rule, curation.excludeIds ('excluded'), and a shelf add never
 *     starts a list or goes on the Original (JakeTunesMobile
 *     backend/src/util/ipodLists.ts applyAdd). ⚠️ CONTRACT with that route.
 *   - homemini hears about a new song only when this Mac publishes the
 *     library, a few seconds to minutes after the import, so its first answer
 *     is usually 'not-in-library'. Those ids wait and are asked again (a
 *     minute after the import, then every 5 minutes), for up to 3 days; after
 *     that the song is taken to be gone. Every other answer is final.
 *   - Only the ids this job imported. A song the library already had (a dupe)
 *     never joins: the shelf never shows an owned song, so a dupe was not
 *     chosen for this iPod.
 *
 * Deps injected so node --test runs it against a fake homemini.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { writeJsonAtomic } from './atomic-write.ts'
import { withLocalLock } from './hub-local-state.ts'
import { withCompanionInit } from './hub-companion.ts'
import type { FetchLike } from './top1000-client.ts'

export const SHELF_JOINS_FILE = 'ipod-shelf-joins.json'
/** How often what homemini hasn't heard (or doesn't have in its library yet) is asked again. */
export const SHELF_JOIN_RETRY_MS = 5 * 60_000
/** The first ask after an import waits this long: the library publish to homemini goes first. */
export const SHELF_JOIN_FIRST_ASK_MS = 60_000
/** A song homemini still doesn't have after this long is taken to be gone. */
export const SHELF_JOIN_GIVE_UP_MS = 3 * 24 * 3600_000
/** The `why` on the list's add record (homemini keeps it, at most 200 characters). */
export const SHELF_WHY = 'Jake saved it from this iPod’s shelf in the Record Shop'

const LIST_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const MAX_IDS = 2000

/** A list id a shelf save may name: one homemini would take, never the Original ('top1000'). */
export function isShelfListId(v: unknown): v is string {
  return typeof v === 'string' && LIST_ID.test(v) && v !== 'top1000'
}

const cleanIds = (raw: unknown): number[] => [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, MAX_IDS)

export interface PendingShelfJoin { opId: string; listId: string; ids: number[]; at: string }
export interface ShelfJoinsDoc { version: 1; joins: PendingShelfJoin[] }

export function parseShelfJoins(raw: unknown): ShelfJoinsDoc {
  const out: ShelfJoinsDoc = { version: 1, joins: [] }
  const doc = raw as Partial<ShelfJoinsDoc> | null
  if (!doc || doc.version !== 1 || !Array.isArray(doc.joins)) return out
  for (const j of doc.joins) {
    const ids = cleanIds(j?.ids)
    if (!j || typeof j.opId !== 'string' || !isShelfListId(j.listId) || !ids.length || !Number.isFinite(Date.parse(String(j.at)))) continue
    out.joins.push({ opId: j.opId, listId: j.listId, ids, at: String(j.at) })
  }
  return out
}

// ── homemini ───────────────────────────────────────────────────────────

export type ShelfJoinAnswer =
  | { kind: 'done'; skipped: Array<{ id: number; reason: string }> }
  | { kind: 'refused'; error: string }
  | { kind: 'retry' }

export interface ShelfJoinsRemote { add: (listId: string, ids: number[]) => Promise<ShelfJoinAnswer> }

export function createShelfJoinsRemote(opts: { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number; warn?: (m: string) => void }): ShelfJoinsRemote {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const base = opts.baseUrl.replace(/\/+$/, '')
  return {
    async add(listId, ids) {
      try {
        const res = await fetchImpl(`${base}/api/ipod-lists/${encodeURIComponent(listId)}/add`, withCompanionInit({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, by: 'claude', why: SHELF_WHY, from: 'shelf' }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
        }) as Record<string, unknown>)
        const body = await res.json().catch(() => null) as Record<string, unknown> | null
        if (res.status === 200 && body && typeof body === 'object') {
          const skipped = Array.isArray(body.skipped)
            ? (body.skipped as Array<{ id?: unknown; reason?: unknown }>).filter((s) => Number.isSafeInteger(Number(s?.id))).map((s) => ({ id: Number(s.id), reason: String(s.reason ?? '') }))
            : []
          return { kind: 'done', skipped }
        }
        // Only homemini's own refusal is final: a proxy's page or a restart is "not now".
        if ((res.status === 400 || res.status === 404) && body && typeof body.error === 'string') return { kind: 'refused', error: body.error }
        warn(`[ipod-shelf] add to ${listId}: homemini answered ${res.status}; it waits`)
        return { kind: 'retry' }
      } catch (err) {
        warn(`[ipod-shelf] add to ${listId} not sent (${(err as Error)?.message ?? err}); it waits`)
        return { kind: 'retry' }
      }
    },
  }
}

// ── the queue ──────────────────────────────────────────────────────────

export interface ShelfJoinsDeps {
  stateDir: string
  remote: ShelfJoinsRemote
  now?: () => Date
  newId?: () => string
  warn?: (msg: string) => void
  /** Ask homemini later (default: a timer). Tests pass a no-op and call flush themselves. */
  later?: (fn: () => void, ms: number) => void
}

export function createShelfJoins(deps: ShelfJoinsDeps) {
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => randomUUID())
  const later = deps.later ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.() })
  const path = join(deps.stateDir, SHELF_JOINS_FILE)
  const fileLock = `ipod-shelf-joins-file:${deps.stateDir}`
  const sendLock = `ipod-shelf-joins-send:${deps.stateDir}`

  async function read(): Promise<ShelfJoinsDoc> {
    try {
      return parseShelfJoins(JSON.parse(await readFile(path, 'utf-8')))
    } catch {
      // No file yet: nothing is waiting.
      return { version: 1, joins: [] }
    }
  }
  /** Change the waiting file in one locked turn. */
  function edit<T>(fn: (doc: ShelfJoinsDoc) => T): Promise<T> {
    return withLocalLock(fileLock, async () => {
      const doc = await read()
      const before = JSON.stringify(doc)
      const answer = fn(doc)
      if (JSON.stringify(doc) !== before) await writeJsonAtomic(path, doc)
      return answer
    })
  }

  /** Songs this job imported from a list's shelf: on disk first, homemini asked a minute later. */
  async function queue(listId: unknown, rawIds: unknown): Promise<boolean> {
    const ids = cleanIds(rawIds)
    if (!isShelfListId(listId) || !ids.length) return false
    await edit((doc) => { doc.joins.push({ opId: newId(), listId, ids, at: now().toISOString() }) })
    later(() => { void flush().catch((err) => warn(`[ipod-shelf] ${(err as Error)?.message ?? err}`)) }, SHELF_JOIN_FIRST_ASK_MS)
    return true
  }

  /** Ask homemini about everything waiting, oldest first. Answers what is still waiting. */
  function flush(): Promise<number> {
    return withLocalLock(sendLock, async () => {
      const { joins } = await edit((doc) => doc)
      for (const j of joins) {
        const a = await deps.remote.add(j.listId, j.ids)
        if (a.kind === 'retry') break   // homemini is away: the rest wait too, in order
        let keep: number[] = []
        if (a.kind === 'refused') {
          warn(`[ipod-shelf] homemini refused ${j.listId}: ${a.error}`)
        } else {
          const notYet = a.skipped.filter((s) => s.reason === 'not-in-library').map((s) => s.id)
          const old = now().getTime() - Date.parse(j.at) > SHELF_JOIN_GIVE_UP_MS
          if (notYet.length && !old) keep = notYet
          else if (notYet.length) warn(`[ipod-shelf] ${j.listId}: homemini still doesn't have ${notYet.join(', ')} after 3 days; given up`)
          const other = a.skipped.filter((s) => s.reason !== 'not-in-library' && s.reason !== 'already')
          if (other.length) warn(`[ipod-shelf] ${j.listId} didn't take ${other.map((s) => `${s.id} (${s.reason})`).join(', ')}`)
        }
        await edit((doc) => {
          const cur = doc.joins.find((x) => x.opId === j.opId)
          if (!cur) return
          if (keep.length) cur.ids = keep
          else doc.joins = doc.joins.filter((x) => x.opId !== j.opId)
        })
      }
      return (await edit((doc) => doc)).joins.length
    })
  }

  return { queue, flush, read }
}

export type ShelfJoins = ReturnType<typeof createShelfJoins>

// ── the app's one queue ────────────────────────────────────────────────

let installed: ShelfJoins | null = null

/** Wired once by ipc/ipod-lists-ipc.ts (with the iPod lists): the queue, and its 5-minute retry. */
export function installShelfJoins(host: { stateDir: string; baseUrl: string; fetchImpl?: FetchLike; warn?: (m: string) => void }): ShelfJoins {
  const joins = createShelfJoins({ stateDir: host.stateDir, remote: createShelfJoinsRemote(host), warn: host.warn })
  installed = joins
  const tick = (): void => { void joins.flush().catch((err) => host.warn?.(`[ipod-shelf] ${(err as Error)?.message ?? err}`)) }
  setTimeout(tick, SHELF_JOIN_FIRST_ASK_MS).unref?.()
  setInterval(tick, SHELF_JOIN_RETRY_MS).unref?.()
  return joins
}

/** streamrip-store's import hook: songs a shelf save imported. */
export async function queueShelfSave(listId: string, ids: number[]): Promise<void> {
  if (!installed) { console.warn(`[ipod-shelf] no queue yet: ${ids.length} song(s) for ${listId} not kept`); return }
  await installed.queue(listId, ids)
}
