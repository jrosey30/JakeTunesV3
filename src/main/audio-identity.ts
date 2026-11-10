/**
 * What homemini holds for a song, asked instead of downloaded (2026-11-09).
 *
 * Two background jobs on the MacBook used to download a whole file from
 * homemini just to hash it: 722 GB in a week, most of it away from home
 * (~/concert-repair/refused-copies-diagnosis.md). homemini can hash its own
 * disk, so now it is asked:
 *
 *   GET /api/audio-identity?ids=1,2,3   (companion header, at most 200 ids)
 *   → { ok: true, files: { "<id>": { size, sha1, etag }
 *                                 | { pending: true, size?, etag? }
 *                                 | { missing: true } } }
 *
 * for the raw file GET /audio/:id would serve. `sha1` is the whole file's, 40
 * hex. `etag` is /audio's own (size and modified time), so it tells one copy on
 * homemini from the next and a refusal is asked about again only when it moves.
 * `pending`: homemini hasn't hashed that file yet (it hashes in the background,
 * one at a time, only what was asked about); the next ask has it.
 *
 * Three answers, kept apart on purpose:
 *   answers      the route answered; an id it has no file for is null, one it
 *                hasn't hashed yet is `pending`
 *   unsupported  404: a backend from before the route. The caller falls back
 *                to the old check, and only then.
 *   unreachable  anything else. It proves nothing, so nothing is decided.
 *
 * ⚠️ TWIN (contract): JakeTunesMobile backend/src/routes/audioIdentity.ts and
 * util/audioIdentity.ts (`IdentityAnswer`, `MAX_IDS_PER_REQUEST`).
 */

export interface HomeminiIdentity {
  size: number
  sha1: string
  etag: string
}

/** homemini has the file and hasn't hashed it yet. */
export interface PendingIdentity {
  pending: true
  size?: number
  etag?: string
}

/** One id: the identity, not hashed yet, or null (homemini has no file for it). */
export type IdentityEntry = HomeminiIdentity | PendingIdentity | null

export function isPending(e: IdentityEntry | undefined): e is PendingIdentity {
  return !!e && (e as PendingIdentity).pending === true
}

export type IdentityAnswer =
  | { kind: 'answers'; byId: Map<string, IdentityEntry> }
  | { kind: 'unsupported' }
  | { kind: 'unreachable' }

/** One id's answer for a caller that asked for one: the entry, or why there is none. */
export type OneIdentity = IdentityEntry | 'unsupported' | 'unreachable'

/** Ids in one request. ⚠️ TWIN: under the backend's MAX_IDS_PER_REQUEST (200), which answers 400 past it. */
export const IDENTITY_CHUNK = 40
export const IDENTITY_TIMEOUT_MS = 120_000

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * A whole, well-formed identity; `pending` only when homemini says so; else
 * null. A half answer is never an identity.
 */
export function parseIdentityEntry(v: unknown): IdentityEntry {
  if (!v || typeof v !== 'object') return null
  const o = v as { size?: unknown; sha1?: unknown; etag?: unknown; pending?: unknown; missing?: unknown }
  if (o.missing === true) return null
  const n = Number(o.size)
  const size = typeof o.size === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
  const etag = typeof o.etag === 'string' && o.etag ? o.etag : null
  if (o.pending === true) return { pending: true, ...(size !== null ? { size } : {}), ...(etag ? { etag } : {}) }
  const sha1 = typeof o.sha1 === 'string' ? o.sha1.toLowerCase() : ''
  if (size === null || !etag || !/^[0-9a-f]{40}$/.test(sha1)) return null
  return { size, sha1, etag }
}

const CONTAINERS = ['files', 'identities', 'ids', 'items', 'results', 'tracks'] as const

/**
 * Every asked id gets an entry: the identity, or null. The body is an object
 * keyed by id (bare, or under one wrapper key), or a list of rows with `id`.
 */
export function parseIdentityBody(body: unknown, asked: ReadonlyArray<string | number>): Map<string, IdentityEntry> {
  let holder: unknown = body
  if (holder && typeof holder === 'object' && !Array.isArray(holder)) {
    const o = holder as Record<string, unknown>
    for (const k of CONTAINERS) {
      if (o[k] && typeof o[k] === 'object') { holder = o[k]; break }
    }
  }
  const found = new Map<string, unknown>()
  if (Array.isArray(holder)) {
    for (const row of holder) {
      const id = (row as { id?: unknown } | null)?.id
      if (id != null && id !== '') found.set(String(id), row)
    }
  } else if (holder && typeof holder === 'object') {
    for (const [id, row] of Object.entries(holder as Record<string, unknown>)) found.set(id, row)
  }
  const out = new Map<string, IdentityEntry>()
  for (const id of asked) out.set(String(id), parseIdentityEntry(found.get(String(id))))
  return out
}

/** What a refusal remembers about homemini's side. It moves when homemini's copy does. */
export function identityKey(a: HomeminiIdentity): string {
  return `${a.etag}|${a.sha1}|${a.size}`
}

/** homemini's base URL from its /audio base. */
export function hubBaseFromAudioBase(audioBase: string): string {
  return audioBase.replace(/\/+$/, '').replace(/\/audio$/, '')
}

export async function askAudioIdentity(opts: {
  baseUrl: string
  ids: ReadonlyArray<string | number>
  fetchImpl?: FetchLike
  withInit?: (init: RequestInit) => RequestInit | undefined
  chunk?: number
  timeoutMs?: number
}): Promise<IdentityAnswer> {
  const byId = new Map<string, IdentityEntry>()
  const ids = [...new Set(opts.ids.map(String).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)))]
  if (!ids.length) return { kind: 'answers', byId }
  const fetchImpl = opts.fetchImpl ?? fetch
  const wrap = opts.withInit ?? ((i: RequestInit) => i)
  const chunk = Math.max(1, opts.chunk ?? IDENTITY_CHUNK)
  const root = opts.baseUrl.replace(/\/+$/, '')
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk)
    let res: Response
    try {
      res = await fetchImpl(`${root}/api/audio-identity?ids=${part.join(',')}`, wrap({ signal: AbortSignal.timeout(opts.timeoutMs ?? IDENTITY_TIMEOUT_MS) }))
    } catch {
      return { kind: 'unreachable' }
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined)
      return { kind: 'unsupported' }
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return { kind: 'unreachable' }
    }
    let body: unknown
    try { body = await res.json() } catch { return { kind: 'unreachable' } }
    for (const [id, a] of parseIdentityBody(body, part)) byId.set(id, a)
  }
  return { kind: 'answers', byId }
}

export function oneIdentity(answer: IdentityAnswer, id: string | number): OneIdentity {
  if (answer.kind !== 'answers') return answer.kind
  return answer.byId.get(String(id)) ?? null
}
