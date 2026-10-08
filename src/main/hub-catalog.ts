// Hub catalog poll (2026-10-08) — replicas (any machine with
// library.streamRoot set: workmini today) adopt the library from homemini
// the way the phone does: poll /api/library-version, fetch
// /api/tracks/delta?since=<adopted>, hand the upserts/removals to the
// renderer, and remember the adopted version only after the renderer acks.
//
// This replaced ~/bin/jaketunes-workmini-index-sync.sh (laptop → workmini
// file swap under the running app), retired the same day. See
// src/common/hub-catalog-merge.ts for the merge rules.
//
// /api/library-version only moves on library, tracks, stars, and plays.
// Phone song edits, phone imports, and live sets live on other routes, so
// those stamps are folded into the same key (same interval, no new publish):
//   • phone edits  — mtimeMs (or ETag / Last-Modified) of
//     GET /api/phone-sidecars/mobile-metadata-overrides.json
//   • phone imports — the same for mobile-imports.json
//   • live sets — ETag or Last-Modified on HEAD /api/live-sets when the
//     hub sends one (that GET never runs); otherwise mtimeMs on
//     GET /api/live-sets; otherwise the SHA-256 of that body
//
// Once a response carries an ETag or Last-Modified, the next poll sends
// it back (If-None-Match, else If-Modified-Since). Express answers 304
// with no body when the JSON is unchanged. 304 keeps the old stamp. A
// 200 recomputes it. No validator at all still falls through to mtimeMs
// or the hash, which means the body is read.
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { adoptHubCatalogState, type HubCatalogPayload } from '../common/hub-catalog-merge.ts'
import { withCompanionInit } from './hub-companion.ts'

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

/** Renderer ack is either a version string (older callers) or `{ version, protectedIds }`. */
export function parseHubAdoptAck(raw: unknown): { version: string; protectedIds?: string[] } | null {
  if (typeof raw === 'string') return raw ? { version: raw } : null
  if (!raw || typeof raw !== 'object') return null
  const version = (raw as { version?: unknown }).version
  if (typeof version !== 'string' || !version) return null
  const p = (raw as { protectedIds?: unknown }).protectedIds
  if (p === undefined) return { version }
  if (!Array.isArray(p)) return { version }
  const protectedIds: string[] = []
  for (const id of p) {
    if (typeof id === 'string' || typeof id === 'number') protectedIds.push(String(id))
  }
  return { version, protectedIds }
}

interface HubState {
  version: string
  adoptedAt?: string
  seenIds?: string[]
  protectedIds?: string[]
}

const STATE_FILE = 'hub-catalog-state.json'
const ACK_GRACE_MS = 60_000

/** Phone Get Info edits. Served by the existing phone-sidecar route. */
export const PHONE_EDIT_SIDECAR = 'mobile-metadata-overrides.json'
/** Phone downloads waiting to be absorbed. Same route. */
export const PHONE_IMPORT_SIDECAR = 'mobile-imports.json'

export interface StampHeaders { get(name: string): string | null }

/** Validator remembered from the last 200, sent back on the next poll. */
export interface StampValidator { etag: string | null; lastModified: string | null }

export function emptyStampValidator(): StampValidator {
  return { etag: null, lastModified: null }
}

/**
 * Conditional headers for a repeat poll. ETag wins; Last-Modified is the
 * fallback. Neither → no conditional header, and the body has to come down.
 */
export function conditionalStampHeaders(validator: StampValidator): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (validator.etag) headers['If-None-Match'] = validator.etag
  else if (validator.lastModified) headers['If-Modified-Since'] = validator.lastModified
  return headers
}

function rememberValidator(validator: StampValidator, header: StampHeaders): void {
  validator.etag = header.get('etag')
  validator.lastModified = header.get('last-modified')
}

/**
 * Change stamp for a phone sidecar. 304 and 5xx → null (keep the
 * previous stamp). Missing file → '' so it stays quiet until the file
 * appears. Prefer a validator header; the hub's JSON puts the stamp in
 * `mtimeMs` and usually sends neither header.
 */
export function phoneSidecarStamp(status: number, header: StampHeaders, body: string): string | null {
  if (status === 304) return null
  if (status >= 500 || status <= 0) return null
  if (status < 200 || status >= 300) return ''
  const etag = header.get('etag')
  if (etag) return `etag:${etag}`
  const lm = header.get('last-modified')
  if (lm) return `lm:${lm}`
  try {
    const parsed = JSON.parse(body) as { mtimeMs?: unknown }
    if (typeof parsed.mtimeMs === 'number' && Number.isFinite(parsed.mtimeMs)) return `mtime:${parsed.mtimeMs}`
  } catch { /* not JSON — no stamp in the body */ }
  return ''
}

/**
 * Change stamp for GET/HEAD /api/live-sets. Same failure rule as the
 * phone sidecars. Validators first, then `mtimeMs`, then a hash of the
 * body so a list with no clock still moves the key.
 */
export function liveSetStamp(status: number, header: StampHeaders, body: string): string | null {
  if (status === 304) return null
  if (status >= 500 || status <= 0) return null
  if (status < 200 || status >= 300) return `http:${status}`
  const etag = header.get('etag')
  if (etag) return `etag:${etag}`
  const lm = header.get('last-modified')
  if (lm) return `lm:${lm}`
  try {
    const parsed = JSON.parse(body) as { mtimeMs?: unknown }
    if (typeof parsed.mtimeMs === 'number' && Number.isFinite(parsed.mtimeMs)) return `mtime:${parsed.mtimeMs}`
  } catch { /* hash the bytes */ }
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}

/** The poll's change key. Any one field moving means "fetch the delta". */
export function hubCatalogChangeKey(
  version: Record<string, unknown>,
  stamps: { phoneEdits: string; phoneImports: string; liveSets: string },
): string {
  const core = ['library', 'tracks', 'stars', 'plays'].map((k) => String(version[k] ?? '')).join('|')
  return `${core}|phone-edits:${stamps.phoneEdits}|phone-imports:${stamps.phoneImports}|live-sets:${stamps.liveSets}`
}

export interface HubCatalogHandle {
  stop: () => void
  /** Renderer ack: the save that contains `version` succeeded. Calling this
   *  before that save lands (or after a refused save) retires the cursor
   *  and the delta is never retried. */
  adopted: (version: string, protectedIds?: string[]) => Promise<void>
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
  let pending: { version: string; sentAt: number; hubIds: string[] } | null = null
  let stopped = false
  // Last good sidecar / live-set stamps. A failed probe keeps these so a
  // blip does not look like a change and does not wipe a real one.
  let phoneEdits = ''
  let phoneImports = ''
  let liveSets = ''
  const editValidator = emptyStampValidator()
  const importValidator = emptyStampValidator()
  const liveValidator = emptyStampValidator()

  function idList(v: unknown): string[] {
    if (!Array.isArray(v)) return []
    const out: string[] = []
    for (const id of v) if (typeof id === 'string' || typeof id === 'number') out.push(String(id))
    return out
  }
  async function readState(): Promise<HubState> {
    try {
      const raw = JSON.parse(await readFile(statePath, 'utf-8')) as HubState
      if (typeof raw?.version !== 'string') return { version: '' }
      return {
        version: raw.version,
        adoptedAt: typeof raw.adoptedAt === 'string' ? raw.adoptedAt : undefined,
        seenIds: idList(raw.seenIds),
        protectedIds: idList(raw.protectedIds),
      }
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
      const r = await fetchImpl(url, withCompanionInit({ signal: ctrl.signal, headers: { accept: 'application/json' } }))
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as T
    } finally { clearTimeout(timer) }
  }

  async function probe(
    url: string,
    method: 'GET' | 'HEAD',
    validator: StampValidator,
  ): Promise<{ status: number; headers: Headers; text: string } | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetchImpl(url, withCompanionInit({
        method,
        signal: ctrl.signal,
        headers: conditionalStampHeaders(validator),
      }))
      // 304 is "unchanged" — Express sends no body. Don't read one.
      const text = method === 'HEAD' || r.status === 304 ? '' : await r.text()
      return { status: r.status, headers: r.headers, text }
    } catch {
      return null
    } finally { clearTimeout(timer) }
  }

  async function readSidecarStamp(
    url: string,
    stamp: (status: number, headers: StampHeaders, body: string) => string | null,
    validator: StampValidator,
  ): Promise<string | null> {
    const head = await probe(url, 'HEAD', validator)
    if (head?.status === 304) return null
    const headOk = !!head && head.status >= 200 && head.status < 300
    if (headOk && (head.headers.get('etag') || head.headers.get('last-modified'))) {
      rememberValidator(validator, head.headers)
      return stamp(head.status, head.headers, '')
    }
    const got = await probe(url, 'GET', validator)
    if (!got || got.status === 304) return null
    if (got.status >= 200 && got.status < 300) rememberValidator(validator, got.headers)
    return stamp(got.status, got.headers, got.text)
  }

  async function readLiveSetStamp(url: string): Promise<string | null> {
    return readSidecarStamp(url, liveSetStamp, liveValidator)
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

      const origin = base.replace(/\/$/, '')
      const [ver, editStamp, importStamp, liveStamp] = await Promise.all([
        getJson<Record<string, unknown>>(`${origin}/api/library-version`),
        readSidecarStamp(`${origin}/api/phone-sidecars/${encodeURIComponent(PHONE_EDIT_SIDECAR)}`, phoneSidecarStamp, editValidator),
        readSidecarStamp(`${origin}/api/phone-sidecars/${encodeURIComponent(PHONE_IMPORT_SIDECAR)}`, phoneSidecarStamp, importValidator),
        readLiveSetStamp(`${origin}/api/live-sets`),
      ])
      if (editStamp !== null) phoneEdits = editStamp
      if (importStamp !== null) phoneImports = importStamp
      if (liveStamp !== null) liveSets = liveStamp
      const key = hubCatalogChangeKey(ver, { phoneEdits, phoneImports, liveSets })
      if (key === lastKey) return
      const state = await readState()
      const since = encodeURIComponent(state.version)
      const d = await getJson<Record<string, unknown>>(`${origin}/api/tracks/delta?since=${since}`)
      const version = typeof d.version === 'string' ? d.version : ''
      if (!version) throw new Error('delta reply had no version')
      if (d.unchanged === true) {
        lastKey = key
        if (state.version !== version) {
          await writeState({
            version,
            adoptedAt: new Date().toISOString(),
            seenIds: state.seenIds ?? [],
            protectedIds: state.protectedIds ?? [],
          })
        }
        return
      }
      const full = d.full === true
      const upserts = (full ? d.items : d.upserts) as HubCatalogPayload['upserts'] | undefined
      const removedIds = (Array.isArray(d.removedIds) ? d.removedIds : []) as Array<string | number>
      const payload: HubCatalogPayload = {
        full, version, upserts: Array.isArray(upserts) ? upserts : [], removedIds,
        seenIds: state.seenIds ?? [],
        protectedIds: state.protectedIds ?? [],
        adoptedAt: state.adoptedAt ?? null,
      }
      if (!deps.send('hub-catalog-updated', payload)) {
        log('[hub-catalog] no window to receive the catalog — will retry')
        return
      }
      pending = { version, sentAt: Date.now(), hubIds: payload.upserts.map((u) => String(u.id)) }
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
    adopted: async (version: string, protectedIds?: string[]) => {
      const state = await readState()
      const hubIds = pending && pending.version === version ? pending.hubIds : []
      if (pending && pending.version === version) pending = null
      const next = adoptHubCatalogState(state, {
        version,
        hubIds,
        protectedIds,
        now: new Date().toISOString(),
      })
      await writeState(next)
      log(`[hub-catalog] adopted ${version}`)
    },
    tick,
  }
}
