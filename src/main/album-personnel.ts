/**
 * Album personnel from MusicBrainz (Jake, 2026-10-30: "mention the album
 * personnel somewhere" — the album page's Personnel section).
 *
 * Who played and who produced what on an album: instrument, vocal and
 * production credits read from MusicBrainz relationships, never from an LLM
 * ("Ground AI facts, never guess"). A wrong release is worse than none, so a
 * release group is accepted only when its title AND one credited name fold to
 * the album Jake asked about (the release-kinds acceptance rule, reused), and
 * anything less answers with nobody.
 *
 * Request sequence (MusicBrainz WS2, JSON, ≥ 1.1 s between requests):
 *   1. release-group search   releasegroup:"<album>" AND artist:"<artist>"
 *      → the accepted group whose type the library title implies
 *        ("… - Single" → Single, "… - EP" → EP, else Album), earliest first
 *   2. the group's releases   GET /ws/2/release?release-group=<id>&limit=100
 *      → Official first, then the earliest date (a bare year counts as the
 *        END of that year, so 2002-08-17 beats "2002"), plain editions before
 *        variants (empty disambiguation first), then id — deterministic
 *   3. the release            GET /ws/2/release/<id>?inc=artist-rels+recordings+recording-level-rels
 *      → relations on the release itself and on every track's recording
 *
 * Measured cold (2026-10-30, Songs for the Deaf): three requests, ~4.3 s wall
 * with the two throttle waits. MusicBrainz answers 503 "server busy" / rate
 * limited fairly often, so a request is retried once after a pause.
 *
 * Answers persist in <userData>/album-personnel.json (Jake: "once the AI
 * comes up with something, it should stay there"): a found list stays put; a
 * looked-up-but-empty answer is kept too (no hammering MusicBrainz) and asked
 * again after 30 days. Failures — network, 5xx, rate limit — are never cached,
 * so the next visit to the page retries.
 *
 * Everything that touches the world is injected (fetch, clock, directory,
 * throttle), so the tests run on recorded fixtures with no network.
 */
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { nameKey } from '../common/fold-text.ts'
import { acceptedReleaseGroups, releaseGroupSearchUrl, type MbReleaseGroup } from './release-kinds.ts'
import { writeJsonAtomic } from './atomic-write.ts'

/** ⚠️ TWIN: src/renderer/types.ts (AlbumPerson, AlbumPersonnel). These cross
 *  the IPC boundary ('get-album-personnel'), so a field added on one side
 *  only is silently dropped, never caught — change both together. */
export interface AlbumPerson {
  /** As credited on this release when MusicBrainz records that ("Natasha
   *  Shneider"), else the MusicBrainz artist name (which may be in another
   *  script — "Наташа Шнайдер"). */
  name: string
  /** Lowercase, deduped. Performer roles ("guitar", "lead vocals") come before
   *  production roles ("producer", "mixing"); within each, the most frequent first. */
  roles: string[]
  /** Recordings on the release this person is credited on. 0 = credited on
   *  the release as a whole only (mastering, say). */
  tracks: number
}
export interface AlbumPersonnel {
  ok: boolean
  people: AlbumPerson[]
  /** The MusicBrainz release the credits were read from. */
  releaseMbid?: string
  /** Stable renderer-safe code ('api-failed', 'rate-limited', 'invalid-input'). */
  error?: string
}

export const PERSONNEL_CACHE_FILE = 'album-personnel.json'
/** A looked-up-but-empty answer is asked again after this long. */
export const PERSONNEL_EMPTY_RECHECK_MS = 30 * 24 * 3600 * 1000
/** MusicBrainz asks for about one request a second; the app spaces them 1.1 s. */
export const MB_MIN_GAP_MS = 1100
export const MAX_PEOPLE = 40
const RETRY_DELAY_MS = 2000
const TIMEOUT_MS = 10_000

// ── MusicBrainz wire shapes (only the fields read here) ────────────────────

export interface MbRelation {
  type?: string
  direction?: string
  'target-type'?: string
  /** Instrument / voice names and credit qualifiers ("guitar", "lead vocals", "assistant"). */
  attributes?: string[]
  artist?: { id?: string; name?: string }
  /** The name as printed on this release, when it differs from the artist's MusicBrainz name. */
  'target-credit'?: string
}
export interface MbRecording { id?: string; title?: string; relations?: MbRelation[] }
export interface MbReleaseDetail {
  id?: string
  title?: string
  status?: string
  date?: string
  relations?: MbRelation[]
  media?: Array<{ position?: number; tracks?: Array<{ position?: number; title?: string; recording?: MbRecording }> }>
}
/** A release as the browse endpoint lists it. */
export interface MbReleaseSummary { id?: string; title?: string; status?: string; date?: string; disambiguation?: string }
/** A release group as the search lists it (release-kinds' shape plus the group's first date). */
export interface MbSearchGroup extends MbReleaseGroup { 'first-release-date'?: string }

// ── Roles ──────────────────────────────────────────────────────────────────

/** Relationship types that mean "performed" — labelled by what they played. */
const PERFORMER_TYPE_LABEL = new Map<string, string>([
  ['performer', 'performer'],
  ['performing orchestra', 'orchestra'],
  ['conductor', 'conductor'],
])
/** Relationship types that mean "made the record" — one plain word each. */
const PRODUCTION_TYPE_LABEL = new Map<string, string>([
  ['producer', 'producer'],
  ['engineer', 'engineer'],
  ['mix', 'mixing'],
  ['mastering', 'mastering'],
  ['recording', 'recording'],
  ['programming', 'programming'],
  ['arranger', 'arranger'],
  ['remixer', 'remixer'],
])
/** Attributes that qualify a credit ("additional", "assistant") rather than
 *  name an instrument or a voice. Dropped from the label. */
const MODIFIER_ATTRIBUTES = new Set(['additional', 'guest', 'solo', 'minor', 'assistant', 'associate', 'co', 'executive', 'original'])

/** "drums (drum set)" → "drums"; case and spacing normalized. */
export function instrumentLabel(attr: string): string {
  return String(attr ?? '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** The role labels one relationship credits, or null when the type is not a
 *  credit this feature shows (composer, design, copyright, …). */
export function relationRoles(rel: MbRelation): { performer: boolean; labels: string[] } | null {
  const type = String(rel.type ?? '').trim().toLowerCase()
  if (type === 'instrument' || type === 'vocal') {
    const named = [...new Set((rel.attributes ?? []).map(instrumentLabel).filter((a) => a && !MODIFIER_ATTRIBUTES.has(a)))]
    return { performer: true, labels: named.length ? named : [type === 'vocal' ? 'vocals' : 'instruments'] }
  }
  const performer = PERFORMER_TYPE_LABEL.get(type)
  if (performer) return { performer: true, labels: [performer] }
  const production = PRODUCTION_TYPE_LABEL.get(type)
  if (production) return { performer: false, labels: [production] }
  return null
}

interface PersonAcc {
  /** The MusicBrainz artist name — the fallback when no credit names them. */
  name: string
  /** as-credited name → how many relations print it */
  credits: Map<string, number>
  /** label → how many credits carry it (the sort key within a bucket) */
  performer: Map<string, number>
  production: Map<string, number>
  firstSeen: Map<string, number>
  recordings: Set<string>
}

/** The name the release prints most often; the MusicBrainz name when it prints none. */
function displayName(p: PersonAcc): string {
  let best = ''
  let most = 0
  for (const [credit, count] of p.credits) {
    if (count > most) { best = credit; most = count }   // ties keep the first seen (Map order)
  }
  return best || p.name
}

/**
 * Everyone credited on the release (release-level relations) or on any of
 * its recordings, deduped by MusicBrainz artist id. Performers first, by the
 * number of recordings they appear on, then name; production-only people
 * after, the same way. Capped at MAX_PEOPLE.
 */
export function peopleFromRelease(release: MbReleaseDetail): AlbumPerson[] {
  const acc = new Map<string, PersonAcc>()
  let seq = 0
  const credit = (rel: MbRelation, recordingKey: string | null): void => {
    const roles = relationRoles(rel)
    const name = String(rel.artist?.name ?? '').trim()
    if (!roles || !name) return
    const key = rel.artist?.id || nameKey(name)
    let p = acc.get(key)
    if (!p) {
      p = { name, credits: new Map(), performer: new Map(), production: new Map(), firstSeen: new Map(), recordings: new Set() }
      acc.set(key, p)
    }
    const credited = String(rel['target-credit'] ?? '').trim()
    if (credited) p.credits.set(credited, (p.credits.get(credited) ?? 0) + 1)
    const bucket = roles.performer ? p.performer : p.production
    for (const label of roles.labels) {
      bucket.set(label, (bucket.get(label) ?? 0) + 1)
      if (!p.firstSeen.has(label)) p.firstSeen.set(label, seq++)
    }
    if (recordingKey) p.recordings.add(recordingKey)
  }
  for (const rel of release.relations ?? []) credit(rel, null)
  ;(release.media ?? []).forEach((m, mi) => {
    ;(m.tracks ?? []).forEach((t, ti) => {
      const rec = t.recording
      if (!rec) return
      const recordingKey = rec.id || `media-${m.position ?? mi}-track-${t.position ?? ti}`
      for (const rel of rec.relations ?? []) credit(rel, recordingKey)
    })
  })
  const ordered = (p: PersonAcc, bucket: Map<string, number>): string[] =>
    [...bucket.entries()]
      .sort((a, b) => b[1] - a[1] || (p.firstSeen.get(a[0]) ?? 0) - (p.firstSeen.get(b[0]) ?? 0))
      .map(([label]) => label)
  const people = [...acc.values()].map((p) => ({
    name: displayName(p),
    roles: [...ordered(p, p.performer), ...ordered(p, p.production)],
    tracks: p.recordings.size,
    isPerformer: p.performer.size > 0,
  }))
  people.sort((a, b) => Number(b.isPerformer) - Number(a.isPerformer) || b.tracks - a.tracks || a.name.localeCompare(b.name, 'en'))
  return people.slice(0, MAX_PEOPLE).map(({ name, roles, tracks }) => ({ name, roles, tracks }))
}

// ── Choosing the group and the release ─────────────────────────────────────

/** "2002" → "2002-12-31", "2002-08" → "2002-08-31", unknown → "9999-12-31":
 *  a bare year is not earlier than a dated release of that year. */
export function dateKey(d: string | null | undefined): string {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(d ?? '').trim())
  return m ? `${m[1]}-${m[2] ?? '12'}-${m[3] ?? '31'}` : '9999-12-31'
}

/** The kind of release the library title implies: iTunes-style "… - Single"
 *  and "… - EP" suffixes; anything else is asked about as an album. */
export function impliedPrimaryType(album: string): 'Album' | 'EP' | 'Single' {
  if (/\s[-–—]\s*single\s*$/i.test(album)) return 'Single'
  if (/\s[-–—]\s*ep\s*$/i.test(album)) return 'EP'
  return 'Album'
}

/** Among the groups that ARE this album by this artist (exact folded title +
 *  credited name): the one whose type the title implies, earliest first, then id.
 *  undefined when none qualifies — a namesake or a near title is refused. */
export function pickReleaseGroup(groups: readonly MbSearchGroup[], album: string, artist: string): MbSearchGroup | undefined {
  const want = impliedPrimaryType(album)
  const rank = (g: MbSearchGroup): number => ((g['primary-type'] ?? '') === want ? 0 : 1)
  return (acceptedReleaseGroups(groups, album, artist) as MbSearchGroup[])
    .filter((g) => g.id)
    .sort((a, b) => rank(a) - rank(b)
      || dateKey(a['first-release-date']).localeCompare(dateKey(b['first-release-date']))
      || String(a.id).localeCompare(String(b.id)))[0]
}

const STATUS_RANK = new Map<string, number>([['official', 0], ['promotion', 1], ['', 2], ['pseudo-release', 3], ['bootleg', 4], ['withdrawn', 5], ['cancelled', 6]])

/** The release to read credits from: Official first, earliest date (dateKey),
 *  plain editions before variants, then id. */
export function pickRelease(releases: readonly MbReleaseSummary[]): MbReleaseSummary | undefined {
  const statusRank = (r: MbReleaseSummary): number => STATUS_RANK.get(String(r.status ?? '').trim().toLowerCase()) ?? 2
  const variant = (r: MbReleaseSummary): number => (String(r.disambiguation ?? '').trim() ? 1 : 0)
  return releases
    .filter((r) => r.id)
    .sort((a, b) => statusRank(a) - statusRank(b)
      || dateKey(a.date).localeCompare(dateKey(b.date))
      || variant(a) - variant(b)
      || String(a.id).localeCompare(String(b.id)))[0]
}

// ── MusicBrainz requests ───────────────────────────────────────────────────

export const mbReleasesUrl = (groupId: string): string =>
  `https://musicbrainz.org/ws/2/release?release-group=${encodeURIComponent(groupId)}&fmt=json&limit=100`
export const mbReleaseUrl = (releaseId: string): string =>
  `https://musicbrainz.org/ws/2/release/${encodeURIComponent(releaseId)}?inc=artist-rels+recordings+recording-level-rels&fmt=json`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A MusicBrainz throttle: callers take turns, each granted ≥ minGapMs after
 * the previous grant (same design as index.ts mbThrottle — a promise chain,
 * one slot at a time, a rejected caller never poisons the next). index.ts
 * owns the app-wide one; this is the fallback when it is not handed over.
 */
export function createMbThrottle(minGapMs = MB_MIN_GAP_MS, now: () => number = Date.now, wait: (ms: number) => Promise<void> = sleep): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  let lastAt = -Infinity
  return () => {
    const my = chain.then(async () => {
      const due = minGapMs - (now() - lastAt)
      if (due > 0) await wait(due)
      lastAt = now()
    })
    chain = my.catch(() => undefined)
    return my
  }
}

const defaultThrottle = createMbThrottle()

export interface LookupDeps {
  /** The app's descriptive User-Agent (MusicBrainz requires one). */
  userAgent: string
  fetchFn?: typeof fetch
  /** The app's shared MusicBrainz throttle (index.ts mbThrottle); this module's own 1.1 s chain when absent. */
  throttle?: () => Promise<void>
  timeoutMs?: number
  /** Pause before the one retry of a busy / failed request (tests pass 0). */
  retryDelayMs?: number
  log?: (m: string) => void
}

type MbGet = (url: string) => Promise<{ ok: true; body: unknown } | { ok: false; error: string }>

/** One throttled GET with one retry: MusicBrainz answers 503 "busy" and 429
 *  routinely, and a dropped socket is worth a second try. 4xx is final. */
function mbGetter(deps: LookupDeps): MbGet {
  const fetchFn = deps.fetchFn ?? fetch
  const throttle = deps.throttle ?? defaultThrottle
  const retryDelay = deps.retryDelayMs ?? RETRY_DELAY_MS
  return async (url) => {
    let error = 'api-failed'
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && retryDelay > 0) await sleep(retryDelay)
      await throttle()
      try {
        const res = await fetchFn(url, {
          headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
        })
        if (res.ok) return { ok: true, body: await res.json() }
        error = res.status === 503 || res.status === 429 ? 'rate-limited' : 'api-failed'
        if (res.status < 500 && res.status !== 429) break
      } catch {
        error = 'api-failed'   // network, timeout, or a body that is not JSON
      }
    }
    return { ok: false, error }
  }
}

export type LookupResult = { ok: true; people: AlbumPerson[]; releaseMbid?: string } | { ok: false; error: string }

/**
 * The three-request lookup. `{ ok: true, people: [] }` is a real answer
 * (no release group is this album by this artist, or the release carries no
 * credits); `{ ok: false }` means MusicBrainz did not answer and nothing
 * should be remembered.
 */
export async function lookupAlbumPersonnel(artist: string, album: string, deps: LookupDeps): Promise<LookupResult> {
  const get = mbGetter(deps)
  const search = await get(releaseGroupSearchUrl(album, artist))
  if (!search.ok) return search
  const groups = (search.body as { 'release-groups'?: unknown } | null)?.['release-groups']
  const group = pickReleaseGroup(Array.isArray(groups) ? (groups as MbSearchGroup[]) : [], album, artist)
  if (!group?.id) return { ok: true, people: [] }
  const browse = await get(mbReleasesUrl(group.id))
  if (!browse.ok) return browse
  const releases = (browse.body as { releases?: unknown } | null)?.releases
  const release = pickRelease(Array.isArray(releases) ? (releases as MbReleaseSummary[]) : [])
  if (!release?.id) return { ok: true, people: [] }
  const detail = await get(mbReleaseUrl(release.id))
  if (!detail.ok) return detail
  const body = detail.body && typeof detail.body === 'object' ? (detail.body as MbReleaseDetail) : {}
  return { ok: true, people: peopleFromRelease(body), releaseMbid: release.id }
}

// ── The disk cache + service ───────────────────────────────────────────────

export interface PersonnelCacheEntry { people: AlbumPerson[]; releaseMbid?: string; at: number }
export interface PersonnelCacheFile { v: 1; entries: Record<string, PersonnelCacheEntry> }

export const personnelCachePath = (dir: string): string => join(dir, PERSONNEL_CACHE_FILE)
export const personnelCacheKey = (artist: string, album: string): string =>
  `${String(artist ?? '').toLowerCase().trim()}|${String(album ?? '').toLowerCase().trim()}`

export const emptyPersonnelCache = (): PersonnelCacheFile => ({ v: 1, entries: {} })

function isPerson(v: unknown): v is AlbumPerson {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return typeof p.name === 'string' && Array.isArray(p.roles) && p.roles.every((r) => typeof r === 'string') && typeof p.tracks === 'number'
}

/** Keep only well-formed entries; anything else in the file is ignored, not trusted. */
export function normalizePersonnelCache(raw: unknown): PersonnelCacheFile {
  const out = emptyPersonnelCache()
  if (!raw || typeof raw !== 'object') return out
  const entries = (raw as { entries?: unknown }).entries
  if (!entries || typeof entries !== 'object') return out
  for (const [k, v] of Object.entries(entries as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const e = v as { people?: unknown; releaseMbid?: unknown; at?: unknown }
    if (!Array.isArray(e.people) || !e.people.every(isPerson) || typeof e.at !== 'number' || !Number.isFinite(e.at)) continue
    const entry: PersonnelCacheEntry = { people: e.people.map(({ name, roles, tracks }) => ({ name, roles, tracks })), at: e.at }
    if (typeof e.releaseMbid === 'string' && e.releaseMbid) entry.releaseMbid = e.releaseMbid
    out.entries[k] = entry
  }
  return out
}

/** A found list stays until the file is deleted; an empty one is asked again after 30 days. */
export function isPersonnelStale(entry: PersonnelCacheEntry, now: number): boolean {
  return entry.people.length === 0 && now - entry.at > PERSONNEL_EMPTY_RECHECK_MS
}

/**
 * Load the cache file. Missing → empty. Unparseable → moved aside (kept, never
 * deleted; it is a derived cache, so starting fresh costs only a re-lookup).
 */
export async function readPersonnelCache(file: string, log: (m: string) => void): Promise<PersonnelCacheFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log(`[album-personnel] could not read ${PERSONNEL_CACHE_FILE} (${(err as NodeJS.ErrnoException)?.code ?? 'error'}) — starting empty`)
    return emptyPersonnelCache()
  }
  try {
    return normalizePersonnelCache(JSON.parse(text))
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`
    try {
      await rename(file, aside)
      log(`[album-personnel] ${PERSONNEL_CACHE_FILE} did not parse — kept as ${aside}, starting a fresh file`)
    } catch (err) {
      log(`[album-personnel] ${PERSONNEL_CACHE_FILE} did not parse and could not be moved aside: ${err instanceof Error ? err.message : String(err)}`)
    }
    return emptyPersonnelCache()
  }
}

export interface AlbumPersonnelServiceDeps extends LookupDeps {
  /** Directory holding album-personnel.json — the app's userData. */
  dir: string
  now?: () => number
}

export interface AlbumPersonnelService {
  /** Cached when known; otherwise the three-request lookup, remembered on disk. */
  get(artist: string, album: string): Promise<AlbumPersonnel>
  /** Wait for queued cache writes (tests, quit path). */
  flush(): Promise<void>
}

export function createAlbumPersonnelService(deps: AlbumPersonnelServiceDeps): AlbumPersonnelService {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((m: string) => console.log(m))
  const file = personnelCachePath(deps.dir)

  let state: PersonnelCacheFile | null = null
  let loading: Promise<PersonnelCacheFile> | null = null
  const load = (): Promise<PersonnelCacheFile> => {
    if (state) return Promise.resolve(state)
    if (!loading) loading = readPersonnelCache(file, log).then((s) => { state = s; return s })
    return loading
  }

  // One serialized, coalescing writer: the write serializes `state` as it is
  // when it RUNS, so answers landing while a write is queued ride along.
  let writeChain: Promise<void> = Promise.resolve()
  let writeQueued = false
  const scheduleWrite = (): void => {
    if (writeQueued) return
    writeQueued = true
    writeChain = writeChain.then(async () => {
      writeQueued = false
      if (!state) return
      try {
        await writeJsonAtomic(file, state)
      } catch (err) {
        log(`[album-personnel] could not write ${PERSONNEL_CACHE_FILE}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  const answer = (e: PersonnelCacheEntry): AlbumPersonnel =>
    e.releaseMbid ? { ok: true, people: e.people, releaseMbid: e.releaseMbid } : { ok: true, people: e.people }

  // Two album-page mounts asking at once share one lookup.
  const inflight = new Map<string, Promise<AlbumPersonnel>>()

  async function get(artist: string, album: string): Promise<AlbumPersonnel> {
    if (typeof artist !== 'string' || typeof album !== 'string') return { ok: false, people: [], error: 'invalid-input' }
    if (!artist.trim() || !album.trim()) return { ok: true, people: [] }
    const key = personnelCacheKey(artist, album)
    const cache = await load()
    const hit = cache.entries[key]
    if (hit && !isPersonnelStale(hit, now())) return answer(hit)
    let pending = inflight.get(key)
    if (!pending) {
      pending = (async (): Promise<AlbumPersonnel> => {
        const r = await lookupAlbumPersonnel(artist, album, deps)
        if (!r.ok) {
          log(`[album-personnel] ${artist} — ${album}: MusicBrainz did not answer (${r.error}); will retry next time`)
          return { ok: false, people: [], error: r.error }
        }
        const entry: PersonnelCacheEntry = r.releaseMbid ? { people: r.people, releaseMbid: r.releaseMbid, at: now() } : { people: r.people, at: now() }
        cache.entries[key] = entry
        scheduleWrite()
        log(`[album-personnel] ${artist} — ${album}: ${r.people.length} people${r.releaseMbid ? ` (release ${r.releaseMbid})` : ' (no release group is this album by this artist)'}`)
        return answer(entry)
      })().finally(() => { inflight.delete(key) })
      inflight.set(key, pending)
    }
    return pending
  }

  return { get, flush: () => writeChain }
}
