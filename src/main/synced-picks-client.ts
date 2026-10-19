/**
 * Synced picks client (2026-10-18) — the desktop half of Jake's TOP 10 ISLAND
 * ALBUMS and 5 FAVORITE ARTISTS, shared with the phone through homemini.
 *
 * The backend is the ONLY writer (src/common/synced-picks.ts has the wire
 * contract). This client, one per document:
 *
 *   cache   userData/<kind>.desktop-cache.json   the last good document homemini
 *                                                served + its ETag (so the shelf
 *                                                draws offline, and the 30 s poll
 *                                                is an If-None-Match → 304)
 *   outbox  userData/<kind>.desktop-outbox.json  the ONE queued desktop edit — a
 *                                                whole document, so a newer edit
 *                                                replaces an older one instead of
 *                                                queueing behind it
 *
 * The names are deliberately NOT island-albums.json / favorite-artists.json:
 * those are the backend's own files (local + NAS state dir, newest wins on its
 * boot), and the desktop must never copy or push a file by those names —
 * SYNCED_PICKS_BACKEND_FILES + assertNoSyncedPicksPush lock that.
 *
 * What the renderer draws = the queued edit if there is one, else the cache.
 * No cache yet (never synced) = read-only: an edit from ten "unknown" slots
 * would wipe the phone's picks on its way in.
 *
 * Replay (the recommendations outbox idiom, Brief 125, applied to a whole-doc
 * last-write-wins document):
 *   - a fresh edit PUTs straight away (`direct`): it IS the last write;
 *   - an edit that sat queued while homemini was away is replayed only after a
 *     GET shows nobody wrote since it was made — if the phone saved later
 *     (remote.updatedAt > queuedAt), the phone's write is the last write and
 *     the stale desktop edit is dropped instead of clobbering it;
 *   - 400 { error: "<sentence>" } = the backend refused the document → dropped
 *     (it would never land) and the sentence goes to Jake; any other failure
 *     (offline, timeout, 5xx, 404 while the endpoint isn't deployed yet) keeps
 *     it queued for the next pass;
 *   - an edit identical to the stored document is not sent at all (first run
 *     against an empty server never PUTs an empty list).
 *
 * Pure of electron — fetch, the directory and the clock are injected, so the
 * whole thing runs under node:test (src/main/__tests__/synced-picks-client.test.ts).
 */
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { withCompanionInit } from './hub-companion.ts'
import {
  emptyPicksDoc, parsePicksDoc, normalizeValues, sameValues, toWireDoc,
  type PicksDoc, type PicksSpec, type PicksState,
} from '../common/synced-picks.ts'

export interface FetchReply { ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<FetchReply>

/** The backend's own documents (JakeTunesMobile backend/src/util/curatedSlots.ts,
 *  mobileWritable in @jaketunes/contracts). The backend is their ONLY writer:
 *  no desktop push / reconcile / backup list may carry these names. */
export const SYNCED_PICKS_BACKEND_FILES = ['island-albums.json', 'favorite-artists.json'] as const

/** Boot-time fence, next to assertNoDesktopBluntPush: a desktop push list that
 *  names a synced-picks document is a boot error, not a silent clobber. */
export function assertNoSyncedPicksPush(files: readonly string[], label: string): void {
  const hits = files.filter((f) => (SYNCED_PICKS_BACKEND_FILES as readonly string[]).includes(f))
  if (hits.length > 0) {
    throw new Error(`[synced-picks] ${label} must not push ${hits.join(', ')} — the homemini backend is their single writer`)
  }
}

export interface SyncedPicksClientOptions<V> {
  spec: PicksSpec<V>
  /** homemini backend origin, e.g. http://homemini:3000 (no trailing slash). */
  baseUrl: string
  /** Where the cache + outbox files live (userData in the app). */
  dir: string
  fetchImpl?: FetchLike
  now?: () => number
  log?: (msg: string) => void
  warn?: (key: string, msg: string) => void
  getTimeoutMs?: number
  putTimeoutMs?: number
}

export interface QueuedEdit<V> {
  id: string
  values: V[]
  queuedAt: string
}

interface CacheFile { doc: Record<string, unknown>; syncedAt: number; etag?: string | null }

export type SaveResult<V> = { ok: true; state: PicksState<V> } | { ok: false; error: string; state: PicksState<V> }

export interface SyncedPicksClient<V> {
  readonly spec: PicksSpec<V>
  /** Current state from disk only — no network. */
  read(): Promise<PicksState<V>>
  /** One network pass: GET, then replay (or drop) the queued edit. Coalesced. */
  sync(opts?: { direct?: boolean }): Promise<PicksState<V>>
  /** Validate, queue, render-ready immediately, then PUT. */
  save(values: unknown): Promise<SaveResult<V>>
  hasPending(): Promise<boolean>
  /** Called whenever the drawable state changes (after a save or a sync). */
  onChange(cb: (state: PicksState<V>) => void): () => void
}

export function createSyncedPicksClient<V>(opts: SyncedPicksClientOptions<V>): SyncedPicksClient<V> {
  const { spec } = opts
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((m: string) => console.log(m))
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const getTimeoutMs = opts.getTimeoutMs ?? 6000
  const putTimeoutMs = opts.putTimeoutMs ?? 8000
  const url = `${opts.baseUrl.replace(/\/+$/, '')}${spec.path}`
  const cachePath = join(opts.dir, `${spec.kind}.desktop-cache.json`)
  const outboxPath = join(opts.dir, `${spec.kind}.desktop-outbox.json`)
  const tag = `[${spec.kind}]`

  let reachable: boolean | null = null
  let rejected: string | undefined
  /** ms of the last good reply this session (the cache file keeps the one
   *  from before a restart) — in memory so an unchanged 30 s poll writes nothing. */
  let lastGoodAt = 0
  let wasUnreachable = false
  const listeners = new Set<(s: PicksState<V>) => void>()
  let lastEmitted = ''

  // ── files ──────────────────────────────────────────────────────────────
  async function readJson(path: string): Promise<unknown> {
    try { return JSON.parse(await readFile(path, 'utf-8')) as unknown } catch { return null /* missing or torn — treated as absent */ }
  }

  async function readCache(): Promise<{ doc: PicksDoc<V>; syncedAt: number; etag: string | null } | null> {
    const raw = await readJson(cachePath) as Partial<CacheFile> | null
    const doc = raw && typeof raw === 'object' ? parsePicksDoc(spec, raw.doc) : null
    if (!doc) return null
    return { doc, syncedAt: typeof raw?.syncedAt === 'number' ? raw.syncedAt : 0, etag: typeof raw?.etag === 'string' ? raw.etag : null }
  }

  /** Store a good document (+ the ETag it was served with). Skips the write
   *  when nothing but the clock moved. */
  async function writeCache(doc: PicksDoc<V>, etag: string | null): Promise<void> {
    lastGoodAt = now()
    const wire = toWireDoc(spec, doc)
    const cur = await readJson(cachePath) as Partial<CacheFile> | null
    if (cur && JSON.stringify(cur.doc) === JSON.stringify(wire) && (cur.etag ?? null) === etag) return
    const file: CacheFile = { doc: wire, syncedAt: lastGoodAt, etag }
    await writeJsonAtomic(cachePath, file)
  }

  async function readOutbox(): Promise<QueuedEdit<V> | null> {
    const raw = await readJson(outboxPath) as Partial<QueuedEdit<V>> | null
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !Array.isArray(raw.values)) return null
    return {
      id: raw.id,
      values: normalizeValues(spec, raw.values),
      queuedAt: typeof raw.queuedAt === 'string' ? raw.queuedAt : new Date(0).toISOString(),
    }
  }

  // Every outbox read-modify-write runs through one chain, so a save landing
  // mid-replay can never be erased by the replay's "clear what I sent".
  let ioChain: Promise<unknown> = Promise.resolve()
  function withIo<T>(fn: () => Promise<T>): Promise<T> {
    const run = ioChain.then(fn)
    ioChain = run.catch(() => undefined)   // the caller sees the error; the chain keeps going
    return run
  }

  /** Remove the queued edit only if it is still the one we just sent. */
  function settleOutbox(id: string): Promise<void> {
    return withIo(async () => {
      const cur = await readOutbox()
      if (cur && cur.id !== id) return            // a newer edit arrived meanwhile — it stays queued
      try { await unlink(outboxPath) } catch { /* already gone */ }
    })
  }

  // ── state ──────────────────────────────────────────────────────────────
  async function read(): Promise<PicksState<V>> {
    const [cache, pending] = await Promise.all([readCache(), readOutbox()])
    const doc = cache?.doc ?? emptyPicksDoc(spec)
    return {
      kind: spec.kind,
      values: pending ? pending.values : doc.values,
      updatedAt: pending ? pending.queuedAt : doc.updatedAt,
      updatedBy: pending ? 'desktop' : doc.updatedBy,
      pending: !!pending,
      reachable,
      syncedAt: lastGoodAt || (cache && cache.syncedAt > 0 ? cache.syncedAt : null),
      ...(rejected ? { rejected } : {}),
    }
  }

  async function emitIfChanged(): Promise<PicksState<V>> {
    const state = await read()
    // syncedAt moves on every good poll; only a change worth redrawing pushes.
    const json = JSON.stringify({ ...state, syncedAt: null })
    if (json !== lastEmitted) {
      lastEmitted = json
      for (const cb of listeners) {
        try { cb(state) } catch (err) { warn(`${spec.kind}:listener`, `${tag} change listener threw: ${err instanceof Error ? err.message : String(err)}`) }
      }
    }
    return state
  }

  function noteReachable(ok: boolean, why?: string): void {
    reachable = ok
    if (ok && wasUnreachable) { wasUnreachable = false; log(`${tag} homemini reachable again`) }
    if (!ok && !wasUnreachable) { wasUnreachable = true; warn(`${spec.kind}:unreachable`, `${tag} homemini unreachable (${why ?? 'no answer'}) — drawing the cache; edits stay queued`) }
  }

  // ── network ────────────────────────────────────────────────────────────
  const etagOf = (res: FetchReply): string | null => res.headers?.get('etag') ?? null

  /** GET with If-None-Match when we hold a cached doc + its ETag: 304 = the
   *  cache IS homemini's document (the cheap 30 s poll). Caches what it gets. */
  async function getRemote(): Promise<PicksDoc<V> | null> {
    try {
      const cache = await readCache()
      const conditional = cache?.etag ? { headers: { 'If-None-Match': cache.etag } } : {}
      const res = await fetchImpl(url, withCompanionInit({ ...conditional, signal: AbortSignal.timeout(getTimeoutMs) }) as Record<string, unknown>)
      if (res.status === 304 && cache) {
        noteReachable(true)
        lastGoodAt = now()
        return cache.doc
      }
      if (!res.ok) { noteReachable(false, `GET ${res.status}`); return null }
      const doc = parsePicksDoc(spec, await res.json().catch(() => null))
      if (!doc) { noteReachable(false, 'GET returned no document'); return null }
      noteReachable(true)
      await writeCache(doc, etagOf(res))
      return doc
    } catch (err) {
      noteReachable(false, err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /** landed = homemini stored it; rejected = 400, dropped; queued = try again later. */
  async function putEdit(edit: QueuedEdit<V>): Promise<'landed' | 'rejected' | 'queued'> {
    let res: FetchReply
    try {
      res = await fetchImpl(url, withCompanionInit({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [spec.field]: edit.values, updatedBy: 'desktop' }),
        signal: AbortSignal.timeout(putTimeoutMs),
      }) as Record<string, unknown>)
    } catch (err) {
      noteReachable(false, err instanceof Error ? err.message : String(err))
      return 'queued'                              // offline / timeout — stays queued
    }
    const body = await res.json().catch(() => null)
    if (res.ok) {
      noteReachable(true)
      rejected = undefined
      // The stored doc is the truth (it carries homemini's updatedAt). A 2xx
      // with no readable doc still landed — cache what we sent; the next GET
      // corrects the timestamps.
      const stored = parsePicksDoc(spec, body)
      await writeCache(stored ?? { version: 1 as const, values: edit.values, updatedAt: null, updatedBy: 'desktop' as const }, stored ? etagOf(res) : null)
      await settleOutbox(edit.id)
      return 'landed'
    }
    if (res.status === 400) {
      noteReachable(true)
      // The backend answers 400 { error: "<plain sentence>" } — Jake reads it.
      const b = body && typeof body === 'object' ? body as { error?: unknown; message?: unknown } : {}
      const msg = typeof b.error === 'string' && b.error ? b.error
        : typeof b.message === 'string' && b.message ? b.message
          : 'homemini refused the change.'
      rejected = msg
      warn(`${spec.kind}:rejected`, `${tag} homemini refused the edit (400: ${msg}) — dropped; showing the stored document`)
      await settleOutbox(edit.id)
      await getRemote()                            // redraw from what homemini actually holds
      return 'rejected'
    }
    // 404 (endpoint not deployed yet), 401, 5xx — keep it for the next pass.
    noteReachable(false, `PUT ${res.status}`)
    return 'queued'
  }

  async function runSync(direct: boolean): Promise<PicksState<V>> {
    const pending = await readOutbox()
    if (pending && direct) {
      await putEdit(pending)
      return emitIfChanged()
    }
    const remote = await getRemote()                // caches it (or 304: the cache already is it)
    if (remote) {
      if (pending) {
        const remoteAt = remote.updatedAt ? Date.parse(remote.updatedAt) : NaN
        const queuedAt = Date.parse(pending.queuedAt)
        if (Number.isFinite(remoteAt) && Number.isFinite(queuedAt) && remoteAt > queuedAt) {
          log(`${tag} queued desktop edit (${pending.queuedAt}) is older than homemini's (${remote.updatedAt}, ${remote.updatedBy ?? 'unknown'}) — the later write wins; dropped`)
          await settleOutbox(pending.id)
        } else if ((await putEdit(pending)) === 'landed') {
          log(`${tag} replayed the queued desktop edit from ${pending.queuedAt}`)
        }
      }
    }
    return emitIfChanged()
  }

  // Coalesced: at most one pass running + one waiting. The waiting pass reads
  // the outbox when it STARTS, so it always carries the newest edit.
  let chain: Promise<unknown> = Promise.resolve()
  let waiting: Promise<PicksState<V>> | null = null
  let waitingDirect = false
  function sync(o?: { direct?: boolean }): Promise<PicksState<V>> {
    if (o?.direct) waitingDirect = true
    if (waiting) return waiting
    const run = chain.then(() => {
      waiting = null
      const direct = waitingDirect
      waitingDirect = false
      return runSync(direct)
    })
    waiting = run
    chain = run.catch((err) => warn(`${spec.kind}:sync`, `${tag} sync pass failed: ${err instanceof Error ? err.message : String(err)}`))
    return run
  }

  async function save(values: unknown): Promise<SaveResult<V>> {
    const v = spec.validate(values)
    if (!v.ok) return { ok: false, error: v.error, state: await read() }
    // Never edit blind. Until homemini's document has been seen once (a cache
    // file, or an edit already queued on top of one), the desktop's ten empty
    // slots are "don't know", not "empty" — a pick PUT from there would wipe
    // every pick the phone has. First run on a new Mac, or the endpoint not
    // deployed yet: read-only until the first good GET.
    const [cache, pending] = await Promise.all([readCache(), readOutbox()])
    if (!cache && !pending) {
      return { ok: false, error: 'Not synced with homemini yet — editing unlocks after the first sync.', state: await read() }
    }
    // Nothing to say: the edit IS what homemini already holds (and nothing is
    // queued on top of it) — e.g. an empty list against an empty server.
    if (!pending && cache && sameValues(v.values as Array<V | null>, cache.doc.values as Array<V | null>, spec.keyOf as (x: V) => string)) {
      return { ok: true, state: await read() }
    }
    const edit: QueuedEdit<V> = { id: randomUUID(), values: v.values, queuedAt: new Date(now()).toISOString() }
    await withIo(() => writeJsonAtomic(outboxPath, edit))
    rejected = undefined
    await emitIfChanged()                          // the edit draws now, before the network
    const state = await sync({ direct: true })
    // Refused by homemini (400): the sentence is the answer to this save.
    if (state.rejected && !state.pending) return { ok: false, error: state.rejected, state }
    return { ok: true, state }
  }

  return {
    spec,
    read,
    sync,
    save,
    hasPending: async () => (await readOutbox()) !== null,
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}
