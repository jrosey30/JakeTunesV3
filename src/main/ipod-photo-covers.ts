/**
 * Photo covers on this Mac (2026-11-09; the rules: common/ipod-photo-covers.ts).
 * Jake: "for top 1000 ipod. use this photo".
 *
 *   • "Use a photo…": the picked file is checked (JPEG or PNG by its own bytes,
 *     25 MB), kept here and marked waiting BEFORE homemini is asked, so a pick
 *     made with homemini away shows at once and goes when it answers. homemini
 *     makes the cover (the middle square, the right way up, 900 across) and this
 *     Mac swaps its copy for homemini's, so both show the same crop.
 *   • "Use the drawing": the copy goes, and homemini is told (now or later).
 *   • homemini's list (GET /api/photo-covers) is read on each iPod list read and
 *     on the 5-minute retry: a photo set from another Mac arrives, one removed
 *     goes. A waiting pick always wins over the list.
 *
 * Kept in <stateDir>/ipod-photo-covers/: <key>.jpg|png and state.json
 * ({ indexSeen, versions, pending }). Deps injected so node --test runs it.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  isPhotoKey, parsePhotoIndex, photoKind, photoProblem, photoShown, type PhotoIndexEntry, type PhotoShown,
} from '../common/ipod-photo-covers.ts'

export const PHOTO_DIR = 'ipod-photo-covers'
const STATE_FILE = 'state.json'

export type PutAnswer =
  | { kind: 'ok'; version: string }
  /** homemini said no for good (not a JPEG/PNG, too small, no such list): never sent again. */
  | { kind: 'refused'; status: number; error: string }
  /** No answer, or one that may change (5xx, an older homemini without the route). */
  | { kind: 'later' }

export interface PhotoCoverClient {
  index(): Promise<PhotoIndexEntry[] | null>
  get(key: string): Promise<{ bytes: Buffer; version: string | null } | null>
  put(key: string, bytes: Buffer): Promise<PutAnswer>
  /** true = homemini has no photo for the key now. */
  remove(key: string): Promise<boolean>
}

interface PhotoState {
  /** homemini's list has been read at least once on this Mac. */
  indexSeen: boolean
  /** homemini's version of each photo this Mac keeps (absent = a pick not sent yet). */
  versions: Record<string, string>
  /** Picks homemini hasn't heard yet. */
  pending: Record<string, 'set' | 'remove'>
}

export type ChoosePhotoResult =
  | { ok: true; homemini: 'saved' | 'later' }
  | { ok: false; error: string }

export interface PhotoCoverView { shown: PhotoShown; url: string | null }

export interface PhotoCovers {
  choose(key: unknown, bytes: Uint8Array): Promise<ChoosePhotoResult>
  useDrawing(key: unknown): Promise<ChoosePhotoResult>
  /** Send what waits, then follow homemini's list. */
  sync(): Promise<void>
  view(key: unknown): Promise<PhotoCoverView>
}

export function createPhotoCovers(deps: { stateDir: string; client: PhotoCoverClient; log?: (line: string) => void }): PhotoCovers {
  const dir = join(deps.stateDir, PHOTO_DIR)
  const log = deps.log ?? ((line: string) => console.warn(line))
  // One change at a time: a pick, a flush and a sync never interleave.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  async function readState(): Promise<PhotoState> {
    try {
      const raw = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf-8')) as Partial<PhotoState>
      const versions: Record<string, string> = {}
      for (const [k, v] of Object.entries(raw.versions ?? {})) if (isPhotoKey(k) && typeof v === 'string') versions[k] = v
      const pending: Record<string, 'set' | 'remove'> = {}
      for (const [k, v] of Object.entries(raw.pending ?? {})) if (isPhotoKey(k) && (v === 'set' || v === 'remove')) pending[k] = v
      return { indexSeen: raw.indexSeen === true, versions, pending }
    } catch {
      return { indexSeen: false, versions: {}, pending: {} }
    }
  }

  async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
    await mkdir(dir, { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, data)
    await rename(tmp, path)
  }

  const writeState = (s: PhotoState) => writeAtomic(join(dir, STATE_FILE), JSON.stringify(s, null, 2))

  const keptPath = (key: string): string | null => {
    for (const ext of ['jpg', 'png']) {
      const p = join(dir, `${key}.${ext}`)
      if (existsSync(p)) return p
    }
    return null
  }

  async function keep(key: string, bytes: Uint8Array): Promise<void> {
    const ext = photoKind(bytes) === 'png' ? 'png' : 'jpg'
    await writeAtomic(join(dir, `${key}.${ext}`), bytes)
    await rm(join(dir, `${key}.${ext === 'png' ? 'jpg' : 'png'}`), { force: true })
  }

  async function drop(key: string): Promise<void> {
    await rm(join(dir, `${key}.jpg`), { force: true })
    await rm(join(dir, `${key}.png`), { force: true })
  }

  /** Send one waiting pick. 'refused' carries homemini's reason. */
  async function flushOne(key: string): Promise<'none' | 'sent' | 'later' | { refused: string }> {
    const state = await readState()
    const op = state.pending[key]
    if (!op) return 'none'
    if (op === 'remove') {
      if (!(await deps.client.remove(key).catch(() => false))) return 'later'
      delete state.pending[key]
      delete state.versions[key]
      await writeState(state)
      return 'sent'
    }
    const path = keptPath(key)
    if (!path) {
      delete state.pending[key]
      await writeState(state)
      return 'none'
    }
    const answer = await deps.client.put(key, await readFile(path)).catch((): PutAnswer => ({ kind: 'later' }))
    if (answer.kind === 'later') return 'later'
    delete state.pending[key]
    if (answer.kind === 'refused') {
      delete state.versions[key]
      await writeState(state)
      await drop(key)
      log(`[photo-covers] homemini refused ${key}: ${answer.error}`)
      return { refused: answer.error }
    }
    state.versions[key] = answer.version
    await writeState(state)
    // homemini's own cover (the square it made) replaces the picked file.
    const made = await deps.client.get(key).catch(() => null)
    if (made && photoKind(made.bytes)) await keep(key, made.bytes)
    return 'sent'
  }

  async function flushAll(): Promise<void> {
    const state = await readState()
    for (const key of Object.keys(state.pending)) await flushOne(key)
  }

  async function follow(): Promise<void> {
    const index = await deps.client.index().catch(() => null)
    if (!index) return
    const state = await readState()
    const listed = new Map(index.map((e) => [e.key, e.version]))
    let changed = !state.indexSeen
    state.indexSeen = true
    for (const [key, version] of listed) {
      if (state.pending[key]) continue
      if (state.versions[key] === version && keptPath(key)) continue
      const got = await deps.client.get(key).catch(() => null)
      if (!got || !photoKind(got.bytes)) continue
      await keep(key, got.bytes)
      state.versions[key] = got.version ?? version
      changed = true
    }
    const keptKeys = new Set(Object.keys(state.versions))
    for (const key of keptKeys) {
      if (listed.has(key) || state.pending[key]) continue
      await drop(key)
      delete state.versions[key]
      changed = true
    }
    if (changed) await writeState(state)
  }

  return {
    choose(key, bytes) {
      return serial(async () => {
        if (!isPhotoKey(key)) return { ok: false as const, error: 'No iPod.' }
        const problem = photoProblem(bytes)
        if (problem) return { ok: false as const, error: problem }
        // Kept and waiting on disk before homemini is asked: a crash mid-send can't lose it.
        await keep(key, bytes)
        const state = await readState()
        state.pending[key] = 'set'
        delete state.versions[key]
        await writeState(state)
        const r = await flushOne(key)
        if (typeof r === 'object') return { ok: false as const, error: `homemini couldn’t use that photo: ${r.refused}` }
        return { ok: true as const, homemini: r === 'later' ? 'later' as const : 'saved' as const }
      })
    },
    useDrawing(key) {
      return serial(async () => {
        if (!isPhotoKey(key)) return { ok: false as const, error: 'No iPod.' }
        await drop(key)
        const state = await readState()
        state.pending[key] = 'remove'
        delete state.versions[key]
        await writeState(state)
        const r = await flushOne(key)
        return { ok: true as const, homemini: r === 'later' ? 'later' as const : 'saved' as const }
      })
    },
    sync() {
      return serial(async () => {
        await flushAll()
        await follow()
      })
    },
    async view(key) {
      if (!isPhotoKey(key)) return { shown: 'drawing', url: null }
      const state = await readState()
      const path = keptPath(key)
      const shown = photoShown({ key, pending: state.pending[key] ?? null, kept: path !== null, indexSeen: state.indexSeen })
      if (shown !== 'kept' || !path) return { shown, url: null }
      const bytes = await readFile(path).catch(() => null)
      if (!bytes) return { shown: 'drawing', url: null }
      const mime = path.endsWith('.png') ? 'image/png' : 'image/jpeg'
      return { shown, url: `data:${mime};base64,${bytes.toString('base64')}` }
    },
  }
}

/** homemini's /api/photo-covers, over the companion header (fetch injected for tests). */
export function createPhotoCoverClient(opts: {
  baseUrl: string
  fetchImpl?: (url: string, init?: Record<string, unknown>) => Promise<{ status: number; json(): Promise<unknown>; arrayBuffer?: () => Promise<ArrayBuffer>; headers?: { get?: (k: string) => string | null } }>
  withAuth?: (init: Record<string, unknown>) => Record<string, unknown>
  timeoutMs?: number
  warn?: (msg: string) => void
}): PhotoCoverClient {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as NonNullable<typeof opts.fetchImpl>)
  const auth = opts.withAuth ?? ((i: Record<string, unknown>) => i)
  const timeoutMs = opts.timeoutMs ?? 20_000
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/photo-covers`
  const call = (path: string, init: Record<string, unknown>) =>
    fetchImpl(`${base}${path}`, auth({ ...init, signal: AbortSignal.timeout(timeoutMs) }))

  return {
    async index() {
      try {
        const res = await call('', { method: 'GET' })
        if (res.status !== 200) return null
        return parsePhotoIndex(await res.json())
      } catch (err) {
        warn(`[photo-covers] list failed: ${(err as Error)?.message ?? err}`)
        return null
      }
    },
    async get(key) {
      try {
        const res = await call(`/${encodeURIComponent(key)}`, { method: 'GET' })
        if (res.status !== 200 || !res.arrayBuffer) return null
        return { bytes: Buffer.from(await res.arrayBuffer()), version: res.headers?.get?.('x-photo-cover-version') ?? null }
      } catch (err) {
        warn(`[photo-covers] ${key} failed: ${(err as Error)?.message ?? err}`)
        return null
      }
    },
    async put(key, bytes) {
      try {
        const res = await call(`/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        })
        const body = await res.json().catch(() => null) as { version?: unknown; error?: unknown } | null
        if (res.status === 200 && typeof body?.version === 'string') return { kind: 'ok', version: body.version }
        // 400/404/413/415/422 are homemini's verdict on this photo or list. Anything else
        // (5xx; a homemini older than this route answers 404 for an unknown path too, but
        // with Express's HTML, not our JSON) may change, so it waits.
        if ([400, 404, 413, 415, 422].includes(res.status) && typeof body?.error === 'string') {
          return { kind: 'refused', status: res.status, error: body.error }
        }
        warn(`[photo-covers] ${key}: homemini answered ${res.status}`)
        return { kind: 'later' }
      } catch (err) {
        warn(`[photo-covers] ${key} upload failed: ${(err as Error)?.message ?? err}`)
        return { kind: 'later' }
      }
    },
    async remove(key) {
      try {
        const res = await call(`/${encodeURIComponent(key)}`, { method: 'DELETE' })
        const body = await res.json().catch(() => null) as { removed?: unknown } | null
        return res.status === 200 && typeof body?.removed === 'boolean'
      } catch (err) {
        warn(`[photo-covers] ${key} remove failed: ${(err as Error)?.message ?? err}`)
        return false
      }
    },
  }
}
