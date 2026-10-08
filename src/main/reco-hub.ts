/**
 * The hub transport for recommendations — the ONE place main talks to the
 * homemini backend about the list. Two implementations:
 *
 *   live     — HTTP to MOBILE_BACKEND_URL (normal fulfilment, unchanged)
 *   fixture  — an in-memory hub seeded from a local JSON file, selected only
 *              by JT_RECO_FIXTURE in a dev (unpackaged) build. Reads AND
 *              mutations stay inside it: a fixture jot that completes, is
 *              released by the Listen List or is deleted never reaches the
 *              real hub (2026-09-06: a fixture record's release tombstoned
 *              Little Creatures Deluxe on homemini — twice removed by hand).
 *
 * Pure: no electron, no fs — the caller loads the seed and passes fetch.
 */
/** The hub's rows — main's RecommendationRecord passes through untyped. */
export interface HubRecord { id: string }
export interface HubReply { ok: boolean; status: number; json: unknown }

export interface RecoHub {
  readonly mode: 'live' | 'fixture'
  /** The NAS read-only fallback is a second door to shared state; closed in fixture mode. */
  readonly nasFallback: boolean
  /** GET the list; null = unreachable. */
  list(): Promise<HubRecord[] | null>
  /** POST one add (origin 'user' etc. already in the body). */
  add(body: Record<string, unknown>): Promise<HubReply>
  /** DELETE by id, carrying the identity keys so the hub tombstones the song even if the id is unknown. */
  remove(id: string, identities: string[]): Promise<HubReply>
  /** GET the tombstone keys; null = unreachable. */
  deletedKeys(): Promise<string[] | null>
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const identityQuery = (identities: string[]): string =>
  identities.slice(0, 8).map((k) => `identity=${encodeURIComponent(k)}`).join('&')

export function liveRecoHub(baseUrl: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): RecoHub {
  const reply = async (res: { ok: boolean; status: number; json(): Promise<unknown> }): Promise<HubReply> =>
    ({ ok: res.ok, status: res.status, json: await res.json().catch(() => null) })
  return {
    mode: 'live',
    nasFallback: true,
    async list() {
      const res = await fetchImpl(`${baseUrl}/api/recommendations`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return null
      const parsed = await res.json() as unknown
      if (Array.isArray(parsed)) return parsed as HubRecord[]
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) return (parsed as { items: HubRecord[] }).items
      return []
    },
    async add(body) {
      return reply(await fetchImpl(`${baseUrl}/api/recommendations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      }))
    },
    async remove(id, identities) {
      const q = identityQuery(identities)
      return reply(await fetchImpl(`${baseUrl}/api/recommendations/${encodeURIComponent(id)}${q ? `?${q}` : ''}`, {
        method: 'DELETE', signal: AbortSignal.timeout(8000),
      }))
    },
    async deletedKeys() {
      const res = await fetchImpl(`${baseUrl}/api/recommendations/deleted`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return null
      const parsed = await res.json() as { keys?: unknown }
      return Array.isArray(parsed?.keys) ? parsed.keys.map(String) : []
    },
  }
}

export interface FixtureRecoHub extends RecoHub {
  records(): HubRecord[]
  tombstones(): string[]
  /** Every call, in order — the acceptance harness's proof of isolation. */
  readonly calls: string[]
}

export function fixtureRecoHub(seed: HubRecord[]): FixtureRecoHub {
  let records = seed.map((r) => ({ ...r }))
  const tombstones: string[] = []
  const calls: string[] = []
  let minted = 0
  return {
    mode: 'fixture',
    nasFallback: false,
    calls,
    records: () => records.map((r) => ({ ...r })),
    tombstones: () => [...tombstones],
    async list() { calls.push('list'); return records.map((r) => ({ ...r })) },
    async add(body) {
      calls.push('add')
      const rec = { ...body, id: String(body.id ?? `fixture-${++minted}`), createdAt: String(body.createdAt ?? new Date().toISOString()) } as HubRecord
      records = [rec, ...records]
      return { ok: true, status: 201, json: rec }
    },
    async remove(id, identities) {
      calls.push(`remove:${id}`)
      const existed = records.some((r) => String(r.id) === id)
      records = records.filter((r) => String(r.id) !== id)
      for (const k of [id, ...identities.map((i) => `identity:${i}`)]) if (!tombstones.includes(k)) tombstones.push(k)
      return { ok: true, status: 200, json: { ok: true, existed } }
    },
    async deletedKeys() { calls.push('deleted'); return [...tombstones] },
  }
}

/** Fixture mode needs BOTH the env var and an unpackaged build; a packaged
 *  app with a stray env var still talks to the real hub. */
export function selectRecoHub(opts: {
  fixturePath: string | undefined
  packaged: boolean
  loadSeed: (path: string) => HubRecord[]
  baseUrl: string
  fetchImpl?: FetchLike
}): RecoHub {
  if (opts.fixturePath && !opts.packaged) return fixtureRecoHub(opts.loadSeed(opts.fixturePath))
  return liveRecoHub(opts.baseUrl, opts.fetchImpl)
}
