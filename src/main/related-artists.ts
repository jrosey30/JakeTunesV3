/**
 * Related artists on the artist page (2026-10-22, Jake: "the desktop reads the
 * SAME homemini route the phone uses, so both devices show the identical
 * list" and "never list the artist on their own page").
 *
 * homemini names the band(s), the band's notable members, their side projects
 * and a few similar artists (GET /api/artist/:name/related — Claude Haiku,
 * the question below, cached a day on homemini). This Mac asks homemini first,
 * with the companion header like its other homemini reads, and only asks
 * Claude itself — the same question, the same parse — when homemini is
 * unreachable or errors, so the section never goes blank.
 *
 * Cache: the one this handler always had (a day, per artist, in main), now
 * holding only homemini's answers. A local fallback answer is not kept, so
 * the next look asks homemini again and the two devices converge as soon as
 * it is back. (homemini caches a day itself; no second cache is added here.)
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/relatedArtists.ts (the prompt, the
 * parse, the self filter, the 16 cap — change them in both or neither) and
 * backend/src/routes/relatedArtists.ts (the route). Phone chips:
 * ios/JakeTunesMobile/RelatedArtists.swift.
 *
 * Electron-free: the Claude call and fetch are injected; node --test loads it.
 */
import { parseRelatedArtists, type RelatedArtist } from './artist-groups-core.ts'
import { nameKey } from '../common/fold-text.ts'
import { withCompanionInit } from './hub-companion.ts'
import type { ProfileFetchLike } from './artist-profile-client.ts'

/** Cached a day per artist (band lineups don't change). */
export const RELATED_TTL_MS = 24 * 60 * 60 * 1000
/** The first 16. */
export const RELATED_MAX = 16
export const RELATED_MAX_TOKENS = 800
/** A first lookup on homemini asks Claude (a few seconds); longer than this and the Mac asks for itself. */
const HOMEMINI_TIMEOUT_MS = 15_000

export const RELATED_SYSTEM = 'You are a precise music encyclopedia listing artists a fan should explore. Return only real, well-established MUSICAL artists related to the subject — bands, their NOTABLE members (ones with real recording careers of their own), those members\' own bands/side projects, and a few genuinely similar or closely-allied recording artists. NEVER include producers, engineers, managers, songwriters-for-hire, or minor/early former members who left before the act\'s success or had no recording career of their own (e.g. for the Beatles: exclude George Martin, Pete Best, Stuart Sutcliffe). Never invent a relationship.'

export function relatedUserPrompt(name: string): string {
  return `List the recording artists most directly related to "${name}" — for a fan who likes them and wants similar or adjacent artists to explore. Include: the band(s) they are/were in, that band's NOTABLE members (the ones with real careers of their own), those members' side projects/aliases/other bands, and a few genuinely similar artists. EXCLUDE producers, engineers, managers, and minor/early members. Return ONLY JSON — an array of {"name","relation"} where relation is one of "band","member","sideProject","similar" (use "similar" for similar/adjacent artists). 6–12 entries, most relevant first. No prose, no code fence.`
}

// ── Never the artist itself ─────────────────────────────────────────────────

/** An artist's name as the list compares it: the shared name fold (accents,
 *  case, punctuation — "Beyoncé" is "Beyonce"), minus a leading "the"
 *  ("The Beatles" is "Beatles"). */
export function selfKey(name: string): string {
  return nameKey(name).replace(/^the /, '')
}

/** The list without the artist whose page it is: the model sometimes names the
 *  act itself ("Red Hot Chili Peppers · band" on its own page). Order kept; a
 *  name that folds to nothing is never treated as self.
 *  ⚠️ TWIN: JakeTunesMobile backend/src/util/relatedArtists.ts dropSelf and
 *  ios RelatedArtists.swift withoutSelf. */
export function dropSelf(related: RelatedArtist[], artist: string): RelatedArtist[] {
  const me = selfKey(artist)
  if (!me) return related
  return related.filter((r) => selfKey(r.name) !== me)
}

// ── The client ──────────────────────────────────────────────────────────────

/** Where the list came from: homemini (the one both devices share) or this Mac's own ask. */
export type RelatedSource = 'homemini' | 'local'
export type RelatedReply =
  | { ok: true; related: RelatedArtist[]; source: RelatedSource }
  | { ok: false; error: string }

export interface RelatedArtistsOptions {
  /** homemini backend origin, e.g. http://homemini:3000 (no trailing slash needed). */
  baseUrl: string
  /** This Mac's own ask (the fallback): (system, user) → the reply's text. Throws on failure. */
  askLocal: (system: string, user: string) => Promise<string>
  fetchImpl?: ProfileFetchLike
  now?: () => number
  timeoutMs?: number
  warn?: (key: string, msg: string) => void
  /** How a thrown error reads in the reply (main passes safeIpcError). */
  errorText?: (err: unknown) => string
}

export interface RelatedArtistsClient {
  get(artist: string): Promise<RelatedReply>
}

export function createRelatedArtistsClient(opts: RelatedArtistsOptions): RelatedArtistsClient {
  const fetchImpl: ProfileFetchLike = opts.fetchImpl ?? (fetch as unknown as ProfileFetchLike)
  const now = opts.now ?? Date.now
  const warn = opts.warn ?? ((_k: string, m: string) => console.warn(m))
  const timeoutMs = opts.timeoutMs ?? HOMEMINI_TIMEOUT_MS
  const errorText = opts.errorText ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)))
  const base = opts.baseUrl.replace(/\/+$/, '')
  const cache = new Map<string, { related: RelatedArtist[]; at: number }>()

  /** homemini's list, or null for any reason it could not give one. */
  async function fromHomemini(name: string): Promise<RelatedArtist[] | null> {
    let res
    try {
      res = await fetchImpl(`${base}/api/artist/${encodeURIComponent(name)}/related`, withCompanionInit({ signal: AbortSignal.timeout(timeoutMs) }) as Record<string, unknown>)
    } catch (err) {
      warn('related:away', `[related] homemini unreachable for ${name}: ${err instanceof Error ? err.message : String(err)} — asking locally`)
      return null
    }
    if (!res.ok) {
      warn('related:http', `[related] homemini answered ${res.status} for ${name} — asking locally`)
      return null
    }
    const body = await res.json().catch(() => null) as { ok?: unknown; related?: unknown } | null
    if (!body || body.ok === false || !Array.isArray(body.related)) {
      warn('related:junk', `[related] homemini's answer for ${name} was not a list — asking locally`)
      return null
    }
    // Through the same parse and whitelist as a local answer: one set of rules.
    return parseRelatedArtists(JSON.stringify(body.related))
  }

  return {
    async get(artist: string): Promise<RelatedReply> {
      const name = String(artist || '').trim()
      if (!name) return { ok: true, related: [], source: 'local' }
      const key = name.toLowerCase()
      const hit = cache.get(key)
      if (hit && now() - hit.at < RELATED_TTL_MS) return { ok: true, related: hit.related, source: 'homemini' }

      const hub = await fromHomemini(name)
      if (hub) {
        const related = dropSelf(hub, name).slice(0, RELATED_MAX)
        cache.set(key, { related, at: now() })
        return { ok: true, related, source: 'homemini' }
      }
      try {
        const text = await opts.askLocal(RELATED_SYSTEM, relatedUserPrompt(name))
        return { ok: true, related: dropSelf(parseRelatedArtists(text), name).slice(0, RELATED_MAX), source: 'local' }
      } catch (err) {
        return { ok: false, error: errorText(err) }
      }
    },
  }
}
