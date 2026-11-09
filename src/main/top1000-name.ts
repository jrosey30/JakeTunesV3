/**
 * The Top 1000's display name (2026-11-09, Jake: "allow me to rename the ipod
 * playlists too!! if i want"). homemini keeps it (GET/PUT /api/top1000/name,
 * JakeTunesMobile backend/src/util/top1000Name.ts), so the phone and every Mac
 * show the same name. This Mac keeps:
 *   - top1000-name-cache.json: homemini's last answer, for when it can't answer;
 *   - top1000-name-pending.json: a rename homemini hasn't heard yet. It is on
 *     disk before homemini is asked, it is what this Mac shows until homemini
 *     has it, and it goes on the next read or the 5-minute retry
 *     (main/ipc/ipod-lists-ipc.ts). Same pattern as main/ipod-colors.ts.
 *
 * Deps injected so node --test runs it without homemini.
 */
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { checkListName, TOP_1000_DEFAULT_NAME } from '../common/ipod-list-name.ts'
import { withCompanionInit } from './hub-companion.ts'
import type { FetchLike } from './top1000-client.ts'

export const CACHE_FILE = 'top1000-name-cache.json'
export const PENDING_FILE = 'top1000-name-pending.json'

/** null = the default name. */
type Custom = string | null

export interface Top1000NameRemote {
  /** homemini's custom name (null = the default); undefined = no clean answer. */
  get: () => Promise<{ custom: Custom } | undefined>
  /** PUT the name. 'drop' = homemini will never take it (400, 409). */
  put: (custom: Custom) => Promise<'done' | 'retry' | 'drop'>
}

export interface Top1000NameDeps extends Top1000NameRemote {
  stateDir: string
  warn?: (msg: string) => void
}

export interface Top1000NameView {
  /** What every screen shows. */
  name: string
  custom: Custom
  /** true while a rename waits for homemini. */
  pending: boolean
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  await rename(tmp, path)
}

/** A stored { name } as a custom name; undefined = no usable file. */
async function readCustom(path: string): Promise<Custom | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as { name?: unknown } | null
    if (!raw || typeof raw !== 'object' || !('name' in raw)) return undefined
    if (raw.name === null) return null
    return typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined
  } catch {
    return undefined
  }
}

const view = (custom: Custom, pending: boolean): Top1000NameView => ({ name: custom ?? TOP_1000_DEFAULT_NAME, custom, pending })

/** Send a waiting rename. A rename made again while one was in flight stays waiting. */
export async function flushTop1000Name(deps: Top1000NameDeps): Promise<'none' | 'sent' | 'still-waiting'> {
  const path = join(deps.stateDir, PENDING_FILE)
  const waiting = await readCustom(path)
  if (waiting === undefined) return 'none'
  const out = await deps.put(waiting).catch(() => 'retry' as const)
  if (out === 'retry') return 'still-waiting'
  if (out === 'drop') deps.warn?.(`[top1000-name] homemini won't take "${waiting ?? TOP_1000_DEFAULT_NAME}"; dropped`)
  else await writeJson(join(deps.stateDir, CACHE_FILE), { name: waiting, savedAt: new Date().toISOString() }).catch(() => undefined)
  if ((await readCustom(path)) === waiting) await writeJson(path, {}).catch(() => undefined)
  return 'sent'
}

/** The name now: a rename homemini hasn't heard yet, else homemini's, else its last answer, else "Top 1000". */
export async function readTop1000Name(deps: Top1000NameDeps): Promise<Top1000NameView> {
  await flushTop1000Name(deps).catch((err) => deps.warn?.(`[top1000-name] flush: ${(err as Error)?.message ?? err}`))
  const waiting = await readCustom(join(deps.stateDir, PENDING_FILE))
  if (waiting !== undefined) return view(waiting, true)
  const fresh = await deps.get().catch(() => undefined)
  if (fresh) {
    await writeJson(join(deps.stateDir, CACHE_FILE), { name: fresh.custom, savedAt: new Date().toISOString() })
      .catch((err) => deps.warn?.(`[top1000-name] cache write: ${(err as Error)?.message ?? err}`))
    return view(fresh.custom, false)
  }
  const kept = await readCustom(join(deps.stateDir, CACHE_FILE))
  return view(kept ?? null, false)
}

/** The name this Mac shows, without asking homemini: a waiting rename, else homemini's last answer, else "Top 1000". */
export async function localTop1000Name(stateDir: string): Promise<string> {
  const waiting = await readCustom(join(stateDir, PENDING_FILE))
  const custom = waiting !== undefined ? waiting : await readCustom(join(stateDir, CACHE_FILE))
  return custom ?? TOP_1000_DEFAULT_NAME
}

export type SetTop1000NameResult =
  | { ok: true; name: string; custom: Custom; homemini: 'saved' | 'later' }
  | { ok: false; error: string }

/**
 * Rename the Top 1000. `raw` empty or "Top 1000" puts the default back. `others` = every
 * iPod list's name now: the Top 1000 never takes one of them.
 */
export async function setTop1000Name(deps: Top1000NameDeps, raw: unknown, others: readonly string[]): Promise<SetTop1000NameResult> {
  let custom: Custom
  if (raw === null || (typeof raw === 'string' && !raw.trim())) custom = null
  else {
    const check = checkListName(raw, others)
    if (!check.ok) return check
    custom = check.name === TOP_1000_DEFAULT_NAME ? null : check.name
  }
  // On disk before homemini is asked: a crash mid-send can't lose it.
  await writeJson(join(deps.stateDir, PENDING_FILE), { name: custom, at: new Date().toISOString() })
  const sent = await flushTop1000Name(deps)
  const still = await readCustom(join(deps.stateDir, PENDING_FILE))
  return { ok: true, name: custom ?? TOP_1000_DEFAULT_NAME, custom, homemini: sent === 'sent' && still === undefined ? 'saved' : 'later' }
}

/** homemini's half: GET/PUT /api/top1000/name with the companion header. */
export function createTop1000NameRemote(opts: { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number; warn?: (msg: string) => void }): Top1000NameRemote {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const timeoutMs = opts.timeoutMs ?? 8_000
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/top1000/name`
  return {
    async get() {
      try {
        const res = await fetchImpl(url, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
        if (res.status !== 200) return undefined
        const body = await res.json().catch(() => null) as { custom?: unknown } | null
        if (!body || !('custom' in body)) return undefined
        if (body.custom === null) return { custom: null }
        return typeof body.custom === 'string' && body.custom.trim() ? { custom: body.custom.trim() } : undefined
      } catch (err) {
        warn(`[top1000-name] read failed: ${(err as Error)?.message ?? err}`)
        return undefined
      }
    },
    async put(custom) {
      try {
        const res = await fetchImpl(url, withCompanionInit({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: custom }),
          signal: AbortSignal.timeout(timeoutMs),
        }) as Record<string, unknown>)
        if (res.status === 200) return 'done'
        warn(`[top1000-name] homemini answered ${res.status}`)
        // 404 = a homemini older than the route: the name waits until it updates.
        return res.status === 400 || res.status === 409 ? 'drop' : 'retry'
      } catch (err) {
        warn(`[top1000-name] save failed: ${(err as Error)?.message ?? err}`)
        return 'retry'
      }
    },
  }
}
