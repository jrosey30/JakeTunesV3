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
 * Three things write here and they overlap in normal use: Headline… itself,
 * the flush before every list read, and the 5-minute retry. So (review of
 * PR 419, the same class as the tag queue's #415):
 *   - the waiting file is only ever changed under one lock, read and written
 *     in one turn, through writeJsonAtomic (a staging name no other write can
 *     share). Two lists saved at once used to tear it or wipe a waiting line;
 *   - one send at a time per list. A send that finishes clears the waiting
 *     line only if it is still the line that was sent; if Jake typed a newer
 *     one meanwhile, that one is sent next. A retry still on its way can no
 *     longer land after a newer headline and leave homemini on the old one.
 *
 * The Top 1000's story (2026-11-24, common/ipod-ad.ts) rides on the same
 * read: homemini's `story` from GET /api/top1000/name, kept with the headline
 * in top1000-headline-cache.json so the first paint has it. This Mac never
 * writes a story; homemini keeps it.
 *
 * Deps injected so node --test runs it without homemini.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { checkHeadline, cleanHeadline, cleanStory, homeminiCounts, type HomeminiCounts } from '../common/ipod-ad.ts'
import { writeJsonAtomic } from './atomic-write.ts'
import { withLocalLock } from './hub-local-state.ts'
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

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** The lock on the waiting file: every read-modify-write of it, in turn. */
const fileLock = (stateDir: string): string => `ipod-headlines-file:${stateDir}`
/** One send at a time for one list (or the Top 1000). */
const sendLock = (stateDir: string, key: string): string => `ipod-headlines-send:${stateDir}:${key}`

/** What became of the last value sent for each list, so a save whose line was sent by someone else's turn still knows. */
const settled = new Map<string, { headline: Headline; out: 'done' | 'drop' }>()

/** Change the waiting file in one locked turn. `edit` changes the map and returns its answer. */
function editPending<T>(stateDir: string, edit: (pending: Record<string, Headline>) => T): Promise<T> {
  return withLocalLock(fileLock(stateDir), async () => {
    const pending = await readPendingHeadlines(stateDir)
    const before = JSON.stringify(pending)
    const answer = edit(pending)
    if (JSON.stringify(pending) !== before) await writeJsonAtomic(join(stateDir, PENDING_FILE), pending)
    return answer
  })
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

/** How many newer lines one turn will send for one list before it leaves the rest for the next flush. */
const MAX_SENDS_PER_TURN = 10

/**
 * One list's turn: send its waiting line; when the send is answered, clear it
 * only if it is still the line that was sent, otherwise send the newer one.
 * 'none' = nothing was waiting when the turn began.
 */
function flushOne(stateDir: string, key: string, send: HeadlineSend, warn?: (msg: string) => void): Promise<'none' | 'sent' | 'still-waiting' | 'dropped'> {
  return withLocalLock(sendLock(stateDir, key), async () => {
    let result: 'none' | 'sent' | 'dropped' = 'none'
    for (let i = 0; i < MAX_SENDS_PER_TURN; i++) {
      const pending = await withLocalLock(fileLock(stateDir), () => readPendingHeadlines(stateDir))
      if (!has(pending, key)) return result
      const headline = pending[key]
      const out = await send(key, headline).catch((err) => {
        warn?.(`[ipod-headline] ${key}: ${(err as Error)?.message ?? err}`)
        return 'retry' as const
      })
      if (out === 'retry') return 'still-waiting'
      if (out === 'drop') warn?.(`[ipod-headline] homemini has no list for ${key}; its headline is dropped`)
      settled.set(`${stateDir}\0${key}`, { headline, out })
      result = out === 'drop' ? 'dropped' : 'sent'
      const cleared = await editPending(stateDir, (p) => {
        if (!has(p, key) || p[key] !== headline) return false
        delete p[key]
        return true
      })
      if (cleared) return result
      // Jake typed a newer line while this one was on its way: that one goes now.
    }
    return 'still-waiting'
  })
}

/**
 * Send what homemini hasn't heard (all, or one key's). 'drop' = homemini will
 * never take it (the list is gone): it stops waiting.
 */
export async function flushPendingHeadlines(
  stateDir: string,
  send: HeadlineSend,
  only?: string,
  warn?: (msg: string) => void,
): Promise<'none' | 'sent' | 'still-waiting' | 'dropped'> {
  const pending = await withLocalLock(fileLock(stateDir), () => readPendingHeadlines(stateDir))
  const keys = Object.keys(pending).filter((k) => only === undefined || k === only)
  if (!keys.length) return 'none'
  const outs = await Promise.all(keys.map((k) => flushOne(stateDir, k, send, warn)))
  if (outs.includes('still-waiting')) return 'still-waiting'
  if (only !== undefined && outs[0] === 'dropped') return 'dropped'
  return outs.every((o) => o === 'none') ? 'none' : 'sent'
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
  await editPending(deps.stateDir, (p) => { p[key] = check.headline })
  let flushed = await flushOne(deps.stateDir, key, deps.send, deps.warn)
  if (flushed === 'none') {
    // Another turn (a list read, the retry) sent it before this one got its go.
    const last = settled.get(`${deps.stateDir}\0${key}`)
    flushed = last && last.headline === check.headline ? (last.out === 'drop' ? 'dropped' : 'sent') : 'sent'
  }
  if (flushed === 'dropped') return { ok: false, error: 'homemini has no list for this iPod.' }
  if (flushed === 'sent' && key === TOP1000_HEADLINE_KEY) {
    // homemini's counts stay in the kept copy: a PUT answer never carries them.
    await withLocalLock(sendLock(deps.stateDir, key), async () => {
      const kept = await cachedTop1000(deps.stateDir)
      await writeJsonAtomic(join(deps.stateDir, TOP1000_CACHE_FILE), { headline: check.headline, counts: kept.counts, story: kept.story, savedAt: new Date().toISOString() })
    })
      .catch((err) => deps.warn?.(`[ipod-headline] cache write: ${(err as Error)?.message ?? err}`))
  }
  return { ok: true, headline: check.headline, homemini: flushed === 'sent' ? 'saved' : 'later' }
}

// ── The Top 1000's headline ──────────────────────────────────────────────

export interface Top1000HeadlineRemote {
  /** homemini's headline (null = none, or a homemini older than the field) and its two counts
   *  (null unless it sent both) and its story (null = none); undefined = no clean answer. */
  get: () => Promise<{ headline: Headline; counts: HomeminiCounts | null; story: string | null } | undefined>
  put: (headline: Headline) => Promise<'done' | 'retry' | 'drop'>
}

export interface Top1000HeadlineView {
  /** Jake's headline; null = none (the page shows the default line). */
  headline: Headline
  /** true while it waits for homemini. */
  pending: boolean
  /** homemini's song and artist counts for the copy line (its last answer); null = count here. */
  counts: HomeminiCounts | null
  /** Jake's story under the ad (homemini's last answer); null = none. */
  story: string | null
}

/** homemini's last answer kept on this Mac: its headline, its counts and its story. */
async function cachedTop1000(stateDir: string): Promise<{ headline: Headline; counts: HomeminiCounts | null; story: string | null }> {
  try {
    const raw = JSON.parse(await readFile(join(stateDir, TOP1000_CACHE_FILE), 'utf-8')) as { headline?: unknown; counts?: { songCount?: unknown; artistCount?: unknown }; story?: unknown } | null
    return { headline: cleanHeadline(raw?.headline), counts: homeminiCounts(raw?.counts), story: cleanStory(raw?.story) }
  } catch {
    // No copy kept yet: no headline, no counts, no story.
    return { headline: null, counts: null, story: null }
  }
}

/** The Top 1000's headline now: one waiting for homemini, else homemini's, else its last answer kept here. */
export function readTop1000Headline(deps: { stateDir: string; get: Top1000HeadlineRemote['get']; warn?: (msg: string) => void }): Promise<Top1000HeadlineView> {
  // In the Top 1000's send turn: an answer asked for while a new headline is on its
  // way can't be kept over the new one.
  return withLocalLock(sendLock(deps.stateDir, TOP1000_HEADLINE_KEY), async () => {
    const waiting = await withLocalLock(fileLock(deps.stateDir), () => readPendingHeadlines(deps.stateDir))
    const owed = has(waiting, TOP1000_HEADLINE_KEY)
    const before = await cachedTop1000(deps.stateDir)
    const fresh = await deps.get().catch(() => undefined)
    // homemini's counts are always its own. Its headline is kept only when none is owed:
    // an answer from before Jake's line reached it must not become the copy the next launch paints.
    const kept = fresh ? { headline: owed ? before.headline : fresh.headline, counts: fresh.counts, story: fresh.story } : before
    if (fresh) {
      await writeJsonAtomic(join(deps.stateDir, TOP1000_CACHE_FILE), { ...kept, savedAt: new Date().toISOString() })
        .catch((err) => deps.warn?.(`[ipod-headline] cache write: ${(err as Error)?.message ?? err}`))
    }
    if (owed) return { headline: waiting[TOP1000_HEADLINE_KEY], pending: true, counts: kept.counts, story: kept.story }
    return { headline: kept.headline, pending: false, counts: kept.counts, story: kept.story }
  })
}

/** The Top 1000's headline as this Mac has it on disk, without asking homemini (the first paint). */
export async function localTop1000Headline(stateDir: string): Promise<Top1000HeadlineView> {
  const kept = await cachedTop1000(stateDir)
  const waiting = await readPendingHeadlines(stateDir)
  if (has(waiting, TOP1000_HEADLINE_KEY)) return { headline: waiting[TOP1000_HEADLINE_KEY], pending: true, counts: kept.counts, story: kept.story }
  return { headline: kept.headline, pending: false, counts: kept.counts, story: kept.story }
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
        const body = await res.json().catch(() => null) as { name?: unknown; headline?: unknown; songCount?: unknown; artistCount?: unknown; story?: unknown } | null
        if (!body || typeof body !== 'object' || !('name' in body)) return undefined
        return { headline: cleanHeadline(body.headline), counts: homeminiCounts(body), story: cleanStory(body.story) }
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
