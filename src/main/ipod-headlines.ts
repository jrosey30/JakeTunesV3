/**
 * "Headline…" (2026-11-14, common/ipod-ad.ts): the one line at the top of an
 * iPod list's page, and of the Top 1000's. homemini keeps it so every Mac and
 * the phone show the same words:
 *   - an iPod list:  PATCH /api/ipod-lists/:id { headline }   (null clears it)
 *   - the Top 1000:  PUT /api/top1000/name { headline }       (null = the default)
 *
 * The same rules as a rename (main/ipod-list-rename.ts, main/ipod-colors.ts):
 * what Jake typed is on this Mac's disk BEFORE homemini is asked
 * (ipod-headlines-pending.json, newest wins), it is what this Mac shows until
 * homemini has it (main/ipod-lists-gather.ts lays it over homemini's), and it
 * goes on the next read or the 5-minute retry (main/ipc/ipod-lists-ipc.ts).
 * A homemini that doesn't know the field yet answers 400: the headline waits.
 *
 * Deps injected so node --test runs it without homemini.
 */
import { readFile, writeFile, rename, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { checkHeadline, cleanHeadline } from '../common/ipod-ad.ts'
import { withCompanionInit } from './hub-companion.ts'
import type { FetchLike } from './top1000-client.ts'

export const PENDING_FILE = 'ipod-headlines-pending.json'
export const TOP1000_CACHE_FILE = 'top1000-headline-cache.json'
/** The Top 1000's key in the waiting file; every other key is an iPod's id. */
export const TOP1000_HEADLINE_KEY = 'top1000'

const KEY = /^[a-z0-9-]{6,64}$/

/** null = "no headline" (cleared). */
type Headline = string | null
export type HeadlineSend = (key: string, headline: Headline) => Promise<'done' | 'retry' | 'drop'>

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  await rename(tmp, path)
}

/** Headlines homemini hasn't heard yet, by key. A value that breaks the rules is not there. */
export async function readPendingHeadlines(stateDir: string): Promise<Record<string, Headline>> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(stateDir, PENDING_FILE), 'utf-8'))
  } catch {
    // No file yet (or an unreadable one): nothing is waiting.
    return {}
  }
  const out: Record<string, Headline> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY.test(k)) continue
    if (v === null) out[k] = null
    else if (cleanHeadline(v)) out[k] = cleanHeadline(v)
  }
  return out
}

/**
 * Send what homemini hasn't heard (all, or one key's). 'drop' = homemini will
 * never take it (the list is gone): it stops waiting. A headline changed again
 * while one was in flight stays waiting for the next flush.
 */
export async function flushPendingHeadlines(
  stateDir: string,
  send: HeadlineSend,
  only?: string,
  warn?: (msg: string) => void,
): Promise<'none' | 'sent' | 'still-waiting' | 'dropped'> {
  const pending = await readPendingHeadlines(stateDir)
  const keys = Object.keys(pending).filter((k) => only === undefined || k === only)
  if (!keys.length) return 'none'
  let waiting = false
  let dropped = false
  for (const key of keys) {
    const headline = pending[key]
    const out = await send(key, headline).catch((err) => {
      warn?.(`[ipod-headline] ${key}: ${(err as Error)?.message ?? err}`)
      return 'retry' as const
    })
    if (out === 'retry') { waiting = true; continue }
    if (out === 'drop') { dropped = true; warn?.(`[ipod-headline] homemini has no list for ${key}; its headline is dropped`) }
    const now = await readPendingHeadlines(stateDir)
    if (Object.prototype.hasOwnProperty.call(now, key) && now[key] === headline) {
      delete now[key]
      await writeJson(join(stateDir, PENDING_FILE), now)
    }
  }
  if (waiting) return 'still-waiting'
  return dropped && only !== undefined ? 'dropped' : 'sent'
}

export interface SetHeadlineDeps {
  stateDir: string
  send: HeadlineSend
  warn?: (msg: string) => void
}

export type SetHeadlineResult =
  | { ok: true; headline: Headline; homemini: 'saved' | 'later' }
  | { ok: false; error: string }

/** Jake's new headline for `key` (an iPod's id, or 'top1000'). Empty or null clears it. */
export async function setHeadline(deps: SetHeadlineDeps, key: unknown, raw: unknown): Promise<SetHeadlineResult> {
  if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, error: 'No list.' }
  const check = checkHeadline(raw)
  if (!check.ok) return check
  // On disk before homemini is asked: a crash mid-send can't lose it.
  const pending = await readPendingHeadlines(deps.stateDir)
  pending[key] = check.headline
  await writeJson(join(deps.stateDir, PENDING_FILE), pending)
  const flushed = await flushPendingHeadlines(deps.stateDir, deps.send, key, deps.warn)
  if (flushed === 'dropped') return { ok: false, error: 'homemini has no list for this iPod.' }
  if (flushed === 'sent' && key === TOP1000_HEADLINE_KEY) {
    await writeJson(join(deps.stateDir, TOP1000_CACHE_FILE), { headline: check.headline, savedAt: new Date().toISOString() })
      .catch((err) => deps.warn?.(`[ipod-headline] cache write: ${(err as Error)?.message ?? err}`))
  }
  return { ok: true, headline: check.headline, homemini: flushed === 'sent' ? 'saved' : 'later' }
}

// ── The Top 1000's headline ──────────────────────────────────────────────

export interface Top1000HeadlineRemote {
  /** homemini's headline (null = none, or a homemini older than the field); undefined = no clean answer. */
  get: () => Promise<{ headline: Headline } | undefined>
  put: (headline: Headline) => Promise<'done' | 'retry' | 'drop'>
}

export interface Top1000HeadlineView {
  /** Jake's headline; null = none (the page shows the default line). */
  headline: Headline
  /** true while it waits for homemini. */
  pending: boolean
}

async function cachedTop1000Headline(stateDir: string): Promise<Headline> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, TOP1000_CACHE_FILE), 'utf-8')) as { headline?: unknown } | null
    return cleanHeadline(raw?.headline)
  } catch {
    // No copy kept yet: no headline.
    return null
  }
}

/** The Top 1000's headline now: one waiting for homemini, else homemini's, else its last answer kept here. */
export async function readTop1000Headline(deps: { stateDir: string; get: Top1000HeadlineRemote['get']; warn?: (msg: string) => void }): Promise<Top1000HeadlineView> {
  const waiting = await readPendingHeadlines(deps.stateDir)
  if (Object.prototype.hasOwnProperty.call(waiting, TOP1000_HEADLINE_KEY)) return { headline: waiting[TOP1000_HEADLINE_KEY], pending: true }
  const fresh = await deps.get().catch(() => undefined)
  if (fresh) {
    await writeJson(join(deps.stateDir, TOP1000_CACHE_FILE), { headline: fresh.headline, savedAt: new Date().toISOString() })
      .catch((err) => deps.warn?.(`[ipod-headline] cache write: ${(err as Error)?.message ?? err}`))
    return { headline: fresh.headline, pending: false }
  }
  return { headline: await cachedTop1000Headline(deps.stateDir), pending: false }
}

/** The Top 1000's headline as this Mac has it on disk, without asking homemini (the first paint). */
export async function localTop1000Headline(stateDir: string): Promise<Top1000HeadlineView> {
  const waiting = await readPendingHeadlines(stateDir)
  if (Object.prototype.hasOwnProperty.call(waiting, TOP1000_HEADLINE_KEY)) return { headline: waiting[TOP1000_HEADLINE_KEY], pending: true }
  return { headline: await cachedTop1000Headline(stateDir), pending: false }
}

/** homemini's half: GET/PUT /api/top1000/name with the companion header. A PUT of { headline } alone never touches the name. */
export function createTop1000HeadlineRemote(opts: { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number; warn?: (msg: string) => void }): Top1000HeadlineRemote {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const timeoutMs = opts.timeoutMs ?? 8_000
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/top1000/name`
  return {
    async get() {
      try {
        const res = await fetchImpl(url, withCompanionInit({ method: 'GET', signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
        if (res.status !== 200) return undefined
        const body = await res.json().catch(() => null) as { name?: unknown; headline?: unknown } | null
        if (!body || typeof body !== 'object' || !('name' in body)) return undefined
        return { headline: cleanHeadline(body.headline) }
      } catch (err) {
        warn(`[ipod-headline] Top 1000 read failed: ${(err as Error)?.message ?? err}`)
        return undefined
      }
    },
    async put(headline) {
      try {
        const res = await fetchImpl(url, withCompanionInit({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headline }),
          signal: AbortSignal.timeout(timeoutMs),
        }) as Record<string, unknown>)
        if (res.status === 200) return 'done'
        // 400 = a homemini older than the field ("only name can be set"): the headline waits for it.
        warn(`[ipod-headline] Top 1000: homemini answered ${res.status}`)
        return 'retry'
      } catch (err) {
        warn(`[ipod-headline] Top 1000 save failed: ${(err as Error)?.message ?? err}`)
        return 'retry'
      }
    },
  }
}
