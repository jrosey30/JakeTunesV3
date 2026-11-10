/**
 * Is homemini's playable copy of an ALAC song ready? (2026-11-10)
 *
 * Jake: "transistor by 311 wont play. it never ends!!" This Mac dropped its
 * own files of an album five minutes after the import (the sha check passed),
 * and every first play then waited on homemini: 7 to 31 s a song. Chromium
 * can't decode ALAC, so a streamed ALAC song is played from a FLAC copy.
 * homemini keeps those copies and can say whether one is ready:
 *
 *   GET  /api/flac-variant?ids=1,2,3    (companion header)
 *   POST /api/flac-variant/want {ids}   the same answer, and it builds the missing ones
 *   → { ok: true, variants: { "<id>": { state } } }
 *
 * `ready`: `/audio/:id?fmt=flac` answers at once. `not-needed`: the original
 * plays as it is. Everything else (building, absent, missing, waiting,
 * no-room, failed, an older backend, no answer) is NOT playable now, and this
 * Mac keeps its own file.
 *
 * ⚠️ TWIN (contract): JakeTunesMobile backend/src/util/flacVariant.ts
 * (`VariantAnswer`, `MAX_VARIANT_IDS`) and routes/flacVariant.ts.
 */

export type VariantState = 'ready' | 'building' | 'absent' | 'not-needed' | 'missing' | 'waiting' | 'no-room' | 'failed'

const STATES: ReadonlySet<string> = new Set(['ready', 'building', 'absent', 'not-needed', 'missing', 'waiting', 'no-room', 'failed'])

export type VariantReply =
  | { kind: 'answers'; byId: Map<string, VariantState | null> }
  /** 404: a backend from before the route. Nothing is known to be ready. */
  | { kind: 'unsupported' }
  | { kind: 'unreachable' }

/** Ids in one request. ⚠️ TWIN: under the backend's MAX_VARIANT_IDS (500). */
export const VARIANT_CHUNK = 100
export const VARIANT_TIMEOUT_MS = 20_000

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** A song this Mac may stop holding: its copy is on homemini's disk, or it needs none. */
export function playableNow(state: VariantState | null | undefined): boolean {
  return state === 'ready' || state === 'not-needed'
}

/** Every asked id gets an entry; anything that isn't a known state is null. */
export function parseVariantBody(body: unknown, asked: ReadonlyArray<string>): Map<string, VariantState | null> {
  const holder = (body as { variants?: unknown } | null)?.variants
  const out = new Map<string, VariantState | null>()
  for (const id of asked) {
    const state = holder && typeof holder === 'object' ? (holder as Record<string, { state?: unknown } | null>)[id]?.state : undefined
    out.set(id, typeof state === 'string' && STATES.has(state) ? (state as VariantState) : null)
  }
  return out
}

export async function askFlacVariants(opts: {
  baseUrl: string
  ids: ReadonlyArray<string | number>
  /** true: homemini also builds the copies it doesn't have. */
  want: boolean
  fetchImpl?: FetchLike
  withInit?: (init: RequestInit) => RequestInit | undefined
  chunk?: number
  timeoutMs?: number
}): Promise<VariantReply> {
  const byId = new Map<string, VariantState | null>()
  const ids = [...new Set(opts.ids.map(String).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)))]
  if (!ids.length) return { kind: 'answers', byId }
  const fetchImpl = opts.fetchImpl ?? fetch
  const wrap = opts.withInit ?? ((i: RequestInit) => i)
  const chunk = Math.max(1, opts.chunk ?? VARIANT_CHUNK)
  const root = opts.baseUrl.replace(/\/+$/, '')
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk)
    const signal = AbortSignal.timeout(opts.timeoutMs ?? VARIANT_TIMEOUT_MS)
    let res: Response
    try {
      res = opts.want
        ? await fetchImpl(`${root}/api/flac-variant/want`, wrap({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: part }), signal }))
        : await fetchImpl(`${root}/api/flac-variant?ids=${part.join(',')}`, wrap({ signal }))
    } catch {
      return { kind: 'unreachable' }
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return { kind: res.status === 404 ? 'unsupported' : 'unreachable' }
    }
    let body: unknown
    try { body = await res.json() } catch { return { kind: 'unreachable' } }
    for (const [id, state] of parseVariantBody(body, part)) byId.set(id, state)
  }
  return { kind: 'answers', byId }
}

/** The asked ids whose copy is playable now; null when homemini gave no answer. */
export function playableIds(reply: VariantReply): Set<string> | null {
  if (reply.kind !== 'answers') return null
  const out = new Set<string>()
  for (const [id, state] of reply.byId) if (playableNow(state)) out.add(id)
  return out
}

/**
 * What the offload queue needs to know per id (stream-convert-pass.ts
 * `PlayableVerdict`): `ready`; `never` when homemini said it won't have a copy
 * for now (no room, the conversion failed, no file); `soon` for everything
 * else. null when homemini gave no answer.
 */
export function playableVerdicts(reply: VariantReply): Map<string, 'ready' | 'soon' | 'never'> | null {
  if (reply.kind !== 'answers') return null
  const out = new Map<string, 'ready' | 'soon' | 'never'>()
  for (const [id, state] of reply.byId) {
    out.set(id, playableNow(state) ? 'ready' : state === 'no-room' || state === 'failed' || state === 'missing' ? 'never' : 'soon')
  }
  return out
}

export const PLAYABLE_WAIT_MS = 1500
/** How many more times a request ("Remove download") asks while homemini builds the copy. */
export const USER_PLAYABLE_RETRIES = 6

/**
 * The last check before a file is dropped: is the copy on homemini's disk NOW?
 * It asks with `want`, so a missing copy starts building. `retries` 0 is the
 * background: not ready is the answer, and the next pass asks again.
 */
export async function confirmPlayableOnHomemini(opts: {
  id: string | number
  ask: (id: string | number) => Promise<VariantReply>
  retries?: number
  waitMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<{ ok: true } | { ok: false; state: VariantState | 'unsupported' | 'unreachable' | 'unknown' }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  let last: VariantState | 'unsupported' | 'unreachable' | 'unknown' = 'unknown'
  for (let i = 0; i <= (opts.retries ?? 0); i++) {
    if (i > 0) await sleep(opts.waitMs ?? PLAYABLE_WAIT_MS)
    let reply: VariantReply
    try { reply = await opts.ask(opts.id) } catch { reply = { kind: 'unreachable' } }
    if (reply.kind !== 'answers') { last = reply.kind; continue }
    const state = reply.byId.get(String(opts.id)) ?? null
    if (playableNow(state)) return { ok: true }
    last = state ?? 'unknown'
    // Only a copy being built is worth waiting for.
    if (state !== 'building' && state !== 'absent') break
  }
  return { ok: false, state: last }
}

/** What to tell Jake when a file was kept because homemini's playable copy isn't there. */
export function notPlayableMessage(state: VariantState | 'unsupported' | 'unreachable' | 'unknown'): string {
  if (state === 'no-room') return 'homemini has no room for a playable copy of this song — kept local'
  if (state === 'unreachable' || state === 'unsupported' || state === 'unknown') return 'homemini did not say its playable copy of this song is ready — kept local'
  return 'homemini is still getting its playable copy of this song ready — kept local for now'
}
