/**
 * Jake's taste choices, shared by both Macs (2026-10-20, "fix ALL of them").
 *
 * Each Mac keeps writing ONLY its own files — discovery-feedback.json (Record
 * Shop "Not for me"), taste-ledger.jsonl (strip ✕ / refresh / add, Discovery
 * verdicts) and rock-dna.json (the quiz, Dislikes). The sync script carries
 * each Mac's copies to homemini and pulls the OTHER Mac's copies back into
 * userData/taste-elsewhere/<source>/ (hub → "hub", a replica → its name).
 * This module merges those read-only copies with the local file, in memory:
 *
 *   - a union, never an overwrite — one Mac's file never replaces the other's,
 *     and a pulled copy is never written into the local file (so nothing
 *     echoes back and nothing is counted twice);
 *   - the newest verdict wins, by its own timestamp: "Not for me" vs "Allow
 *     again" per artist, each quiz answer by its `at`;
 *   - the strip's rules are unchanged (src/common/strip-memory.ts): ✕ hides
 *     for good, two refreshes inside 90 days hide for 90 days — now counted
 *     across both Macs.
 *
 * Pure: no fs, no electron. main/taste-elsewhere.ts reads the copies.
 * ⚠️ TWIN: Dr. Claude/scripts/jaketunes-homemini-sync.sh pull_taste_elsewhere
 * (what lands in taste-elsewhere/ and where).
 */
import { normalizeDnaState, type DnaState, type DnaAnswer } from './rock-dna.ts'

/** userData/<this>/<source>/<file> — the other Macs' copies, pulled read-only. */
export const TASTE_ELSEWHERE_DIR = 'taste-elsewhere'

// ── Record Shop "Not for me" ───────────────────────────────────────────────

export interface ArtistVerdict { artist: string; at: number }
export interface ServedEntry { first: number; last: number; views: number }
export interface DiscoveryFeedback {
  /** normalized artist key → "never surface this artist again". */
  notForMe: Record<string, ArtistVerdict>
  /** normalized artist key → "Allow again" (the undo). Kept, not just a
   *  delete, so the undo travels: across Macs the newer of the two wins. */
  allowed?: Record<string, ArtistVerdict>
  /** card key → rotation bookkeeping. views ≥ CARD_REST_VIEWS is a hard
   *  "Not for me" rest on one card (an artist Jake owns). */
  served: Record<string, ServedEntry>
}

/** Same value as discover-feed.ts CARD_REST_VIEWS (a common module can't
 *  import main). */
export const NOT_FOR_ME_REST_VIEWS = 99

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const entries = (o: unknown): Array<[string, Record<string, unknown>]> =>
  o && typeof o === 'object' ? Object.entries(o as Record<string, unknown>).filter((e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === 'object') : []

/** Every artist that is "Not for me" on ANY Mac, unless an "Allow again"
 *  newer than the newest "Not for me" undid it. A tie keeps it hidden. */
export function effectiveNotForMe(docs: Array<Partial<DiscoveryFeedback> | null | undefined>): Record<string, ArtistVerdict> {
  const rejected = new Map<string, ArtistVerdict>()
  const allowedAt = new Map<string, number>()
  for (const d of docs) {
    if (!d) continue
    for (const [k, v] of entries(d.notForMe)) {
      const at = num(v.at)
      const cur = rejected.get(k)
      if (!cur || at > cur.at) rejected.set(k, { artist: typeof v.artist === 'string' && v.artist ? v.artist : (cur?.artist ?? k), at })
    }
    for (const [k, v] of entries(d.allowed)) allowedAt.set(k, Math.max(allowedAt.get(k) ?? 0, num(v.at)))
  }
  const out: Record<string, ArtistVerdict> = {}
  for (const [k, r] of rejected) if (!((allowedAt.get(k) ?? -1) > r.at)) out[k] = r
  return out
}

/**
 * What the Record Shop reads: the local file's own rotation, plus every
 * verdict made on the other Macs — their "Not for me" artists and their
 * hard card rests. Their ordinary view counts stay theirs (rotation is per
 * screen, not a taste choice). Returns fresh objects: the caller must never
 * write this back (the local cache keeps the local file).
 */
export function sharedFeedbackView(local: DiscoveryFeedback, elsewhere: Array<Partial<DiscoveryFeedback> | null | undefined>): DiscoveryFeedback {
  const served: Record<string, ServedEntry> = { ...(local.served ?? {}) }
  for (const d of elsewhere) {
    for (const [k, v] of entries(d?.served)) {
      const views = num(v.views)
      if (views < NOT_FOR_ME_REST_VIEWS) continue
      const rest = { first: num(v.first), last: num(v.last), views }
      const cur = served[k]
      if (!cur || cur.views < NOT_FOR_ME_REST_VIEWS || rest.last > cur.last) served[k] = rest
    }
  }
  return { notForMe: effectiveNotForMe([local, ...elsewhere]), allowed: local.allowed ?? {}, served }
}

/** The local "Not for me" write (discovery-not-for-me). `restKeys` set =
 *  an artist Jake owns: rest those cards; otherwise the artist-level no. */
export function applyNotForMe(cur: DiscoveryFeedback, v: { key: string; artist: string; restKeys: string[] | null }, now: number): DiscoveryFeedback {
  if (v.restKeys) {
    for (const k of v.restKeys) cur.served[k] = { first: now, last: now, views: NOT_FOR_ME_REST_VIEWS }
  } else {
    cur.notForMe[v.key] = { artist: v.artist, at: now }
  }
  return cur
}

/** The local "Allow again" write (discovery-allow-again): drop this Mac's
 *  verdict and stamp the undo, so a "Not for me" made on the other Mac
 *  before now is undone there too. */
export function applyAllowAgain(cur: DiscoveryFeedback, key: string, artist: string, now: number): DiscoveryFeedback {
  delete cur.notForMe[key]
  cur.allowed = { ...(cur.allowed ?? {}), [key]: { artist, at: now } }
  return cur
}

// ── The taste ledger (strip + Discovery verdicts) ──────────────────────────

export interface SharedLedgerRow {
  ts?: string
  surface?: string
  verdict?: string
  key?: object
  ctx?: object
  /** Set on rows read from another Mac's copy: its source folder name. */
  elsewhere?: string
}

/** A verdict's identity: the same row twice (a copy of a copy) counts once. */
export function rowIdentity(r: SharedLedgerRow): string {
  return `${r.ts ?? ''}\u0001${r.surface ?? ''}\u0001${r.verdict ?? ''}\u0001${JSON.stringify(r.key ?? {})}`
}

/**
 * This Mac's rows plus the other Macs' rows, each verdict once. With nothing
 * from elsewhere the local rows come back untouched (same array, same order);
 * otherwise the union is ordered by time, so "latest verdict wins" readers
 * (discoverVerdicts) see both Macs in the order Jake gave them.
 */
export function unionLedgerRows<T extends SharedLedgerRow>(local: T[], elsewhere: T[][]): T[] {
  const extra = elsewhere.flat()
  if (extra.length === 0) return local
  const seen = new Set(local.map(rowIdentity))
  const out = [...local]
  for (const r of extra) {
    const id = rowIdentity(r)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(r)
  }
  const t = (r: T): number => { const n = Date.parse(r.ts ?? ''); return Number.isFinite(n) ? n : 0 }
  return out.map((r, i) => ({ r, i, t: t(r) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.r)
}

// ── Rock DNA ────────────────────────────────────────────────────────────────

const iso = (s: string | undefined): number => { const n = Date.parse(s ?? ''); return Number.isFinite(n) ? n : 0 }
const hasContent = (s: DnaState): boolean =>
  !!s.startedAt || Object.keys(s.answers).length > 0 || Object.keys(s.ratings).length > 0 || Object.keys(s.traitEdits).length > 0

/**
 * One quiz from both Macs' copies — he can answer on either.
 *   - A RETAKE (it keeps the last run as `previous`) supersedes every run
 *     that began before it; anything started at or after it is the same run.
 *   - Within a run: each screen's answer is the one he gave last (its `at`),
 *     so answers given on both Macs before a sync are all kept; a rating
 *     (Love … Dislike) keeps the newest copy's value, and ratings only one
 *     Mac has are kept (the quiz never un-rates). Trait corrections come
 *     whole from the newest copy — "auto" deletes one, and a union would
 *     bring it back.
 */
export function mergeDnaStates(states: Array<DnaState | null | undefined>): DnaState {
  const list = states.filter((s): s is DnaState => !!s && hasContent(s))
  if (list.length === 0) return normalizeDnaState(null)
  if (list.length === 1) return list[0]
  const retakes = list.filter((s) => s.previous).sort((a, b) => iso(b.startedAt) - iso(a.startedAt))
  const runStart = retakes.length ? iso(retakes[0].startedAt) : -Infinity
  const run = list.filter((s) => iso(s.startedAt) >= runStart)
  const byUpdate = [...run].sort((a, b) => iso(a.updatedAt) - iso(b.updatedAt))
  const newest = byUpdate[byUpdate.length - 1]
  if (run.length === 1) return newest

  const answers: Record<string, DnaAnswer> = {}
  const answeredAt: Record<string, number> = {}
  const ratings: DnaState['ratings'] = {}
  for (const s of byUpdate) {
    for (const [id, a] of Object.entries(s.answers)) {
      const at = iso(a.at) || iso(s.updatedAt)
      if (!(id in answers) || at >= answeredAt[id]) { answers[id] = a; answeredAt[id] = at }
    }
    Object.assign(ratings, s.ratings)
  }
  const started = run.filter((s) => s.startedAt).sort((a, b) => iso(a.startedAt) - iso(b.startedAt))[0]?.startedAt
  const completedAt = newest.completedAt ?? [...byUpdate].reverse().find((s) => s.completedAt)?.completedAt
  const previous = newest.previous ?? [...byUpdate].reverse().find((s) => s.previous)?.previous
  const merged: DnaState = {
    version: 1,
    person: newest.person,
    startedAt: started,
    updatedAt: newest.updatedAt,
    completedAt,
    position: newest.position,
    answers,
    ratings,
    traitEdits: { ...newest.traitEdits },
  }
  return previous ? { ...merged, previous } : merged
}
