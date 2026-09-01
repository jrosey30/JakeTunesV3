/**
 * recommendations — the jot-it-down list: local file + NAS mirror + Mini
 * backend converge, outbox replay, iTunes/MusicBrainz verification,
 * Music Man suggestions, iMessage capture intake.
 *
 * Extracted from main/index.ts (6.0 Phase 1, the "reco braid" cut) —
 * bodies verbatim. The friends/credits sweep, taste ledger, hub-sync
 * inits, and album-info lookups that were interleaved with this code
 * deliberately stay behind.
 */
import { BrowserWindow, app } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync } from 'fs'
import { open, readFile, rename, unlink, writeFile } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { NAS_STATE_DIR_PATH, STATE_DIR, nasAvailable } from '../state-dir'
import { quietWarn } from '../flight-recorder'
import { foldAccents } from '../../common/fold-text.ts'
import { noteAttribution } from '../friend-credit-sweep.ts'
import { startImessageCapture } from '../imessage-capture'
import { MUSIC_MAN_CORE } from '../personas.ts'
import {
  evaluateMusicManVerification, pickBetterReco, recoArtistMatches, recoDedupeKey,
  recoNorm, recoTitleMatches, recordIdentityKeys,
} from '../reco-match'
import { type RecoOutboxOp, parseOutbox, scrubOutboxAgainstBackend, scrubOutboxForDelete } from '../reco-outbox'
import { computeMirror, computeNasFallback, identitiesForDelete } from '../reco-sync'
import type { ClaudeCall } from './library-ipc.ts'
import { safeIpcError } from '../safe-ipc-error'

// The Mini backend owns enrichment for adds; reachable on the tailnet.
// Override for a local dev backend via JAKETUNES_MOBILE_BACKEND.
export const MOBILE_BACKEND_URL = process.env.JAKETUNES_MOBILE_BACKEND || 'http://homemini:3000'

// Who put a recommendation on the list. 'user' = you jotted it; 'mm' = added
// from a Music Man suggestion; 'radar' = added from the New for You feed.
// Drives the "Your jots" vs "Suggested for you" sections in the UI. Legacy
// records have no source → treated as 'user' (the original jot-it-down flow).
export type RecoSource = 'user' | 'mm' | 'radar' | 'spotify'
export interface RecommendationRecord {
  id: string
  song?: string
  artist?: string
  album?: string
  note?: string
  createdAt: string
  artworkUrl?: string
  appleMusicUrl?: string
  previewUrl?: string
  matchedTitle?: string
  matchedArtist?: string
  matchedAlbum?: string
  resolvedAt?: string
  source?: RecoSource
  // Brief 126 — sync protocol v2: what the jot wants (track/album/full
  // concert) + a stable external id (archive.org item — strongest identity).
  kind?: 'track' | 'album' | 'concert'
  externalId?: string
  // Fulfillment (backend-synced): the jot landed in the library.
  owned?: boolean
  ownedAt?: string
  ownedVia?: string
  ownedDesc?: string
}

export interface RecommendationsHost {
  claudeCall: ClaudeCall
  libraryCache: { get: () => Promise<unknown> }
  friendsCache: {
    update: (
      fn: (cur: Record<string, { name: string; adds: number; got: number; tossed: number; lastAt: number }>) =>
        Record<string, { name: string; adds: number; got: number; tossed: number; lastAt: number }>,
    ) => Promise<void>
  }
}

export function registerRecommendations(ipc: IpcRegistrar, host: RecommendationsHost) {

  function recommendationsPath(): string {
    return join(STATE_DIR, 'recommendations.json')
  }

  // Brief 126: V3 keeps ZERO tombstone state of its own. The backend's LIVE
  // tombstone file (written next to library.json on the NAS) is the only
  // delete knowledge, read here read-only to gate the NAS display fallback.
  // (The old frozen STATE_DIR/recommendations-deleted.json — whose staleness
  // powered the stray-migration resurrections — is removed by the one-time
  // boot reset.)
  async function readNasRecoTombstones(): Promise<Set<string>> {
    if (!(await nasAvailable())) return new Set()   // breaker open: no NAS IO
    try {
      // Async readFile ONLY — never existsSync/statSync here: this path is an
      // SMB mount, and a stale mount turns any sync fs call into a
      // seconds-long MAIN-PROCESS freeze (beachball) on every 60s sync tick
      // that hits the fallback leg. Missing file = catch = empty set.
      const p = join(NAS_STATE_DIR_PATH, 'recommendations-deleted.json')
      const parsed = JSON.parse(await readFile(p, 'utf-8')) as unknown
      if (Array.isArray(parsed)) return new Set(parsed.map((e) => String(e)))
    } catch { /* NAS unreachable or file missing — fallback leg imports nothing new */ }
    return new Set()
  }

  function sortRecommendations(list: RecommendationRecord[]): RecommendationRecord[] {
    return [...list].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }

  function parseRecommendationsPayload(parsed: unknown): RecommendationRecord[] {
    if (Array.isArray(parsed)) return parsed as RecommendationRecord[]
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)) {
      return (parsed as { items: RecommendationRecord[] }).items
    }
    return []
  }

  async function readRecommendationsFile(): Promise<RecommendationRecord[]> {
    try {
      const raw = await readFile(recommendationsPath(), 'utf-8')
      return parseRecommendationsPayload(JSON.parse(raw) as unknown)
    } catch {
      return []
    }
  }

  // LOCAL cache only (Brief 125): never mirrored to the NAS — the mobile backend
  // is the single writer of the shared recommendations files.
  async function writeRecommendationsFile(list: RecommendationRecord[]): Promise<void> {
    const recoPath = recommendationsPath()
    const sorted = sortRecommendations(list)
    const tmp = recoPath + '.tmp.json'
    await writeFile(tmp, JSON.stringify(sorted, null, 2))
    const { rename: renameFS } = await import('fs/promises')
    await renameFS(tmp, recoPath)
  }

  function mergeRecommendationsById(...sources: RecommendationRecord[][]): RecommendationRecord[] {
    const byId = new Map<string, RecommendationRecord>()
    for (const src of sources) {
      for (const r of src) {
        if (!r?.id) continue
        const id = String(r.id)
        const prev = byId.get(id)
        if (!prev || (r.createdAt || '').localeCompare(prev.createdAt || '') > 0) {
          byId.set(id, r)
        }
      }
    }
    return sortRecommendations([...byId.values()])
  }

  // Collapse rows that are the same SONG under different ids (the duplication
  // disease). Brief 126: grouping now uses the canonical protocol key
  // (recoDedupeKey — ext:/pair/solo:/full fallback chain, twin of the backend)
  // so artist-less jots dedupe correctly too.
  function dedupeRecommendationsByIdentity(list: RecommendationRecord[]): RecommendationRecord[] {
    const byIdentity = new Map<string, RecommendationRecord>()
    for (const r of list) {
      const k = recoDedupeKey(r)
      const prev = byIdentity.get(k)
      byIdentity.set(k, prev ? pickBetterReco(prev, r) : r)
    }
    return sortRecommendations([...byIdentity.values()])
  }

  const RECO_ITUNES_JUNK = /karaoke|tribute|cover band|made famous|made popular|in the style of|originally performed|8.?bit|chiptune|lullaby|rockabye|little rock star|music foundation|piano (tribute|version|renditions?)|string quartet|meditation|sleep baby|nursery/i

  function recoMatchKey(input: { song?: string; artist?: string; note?: string }): string {
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')   // ⚠️ NOT folded: feeds recoMatchKey, a PERSISTED identity key.
    return `${norm(input.song || '')}|${norm(input.artist || '')}|${norm(input.note || '')}`
  }

  function recoRecordKey(r: RecommendationRecord): string {
    return recoMatchKey({
      song: r.song || r.matchedTitle,
      artist: r.artist || r.matchedArtist,
      note: r.note,
    })
  }

  // Cross-surface "same song" identity — song+artist only (NOT note), so a radar
  // pick and a hand-jot of the same track collapse to one. Null when we lack both
  // fields (e.g. a note-only or album-only jot), in which case callers fall back
  // to the stricter recoMatchKey. Shares recoNorm with iTunes verify + the UI.
  function recoIdentityKey(song?: string, artist?: string): string | null {
    const s = recoNorm(song || '')
    const a = recoNorm(artist || '')
    return s && a ? `${s}|${a}` : null
  }

  function recoRecordIdentityKey(r: RecommendationRecord): string | null {
    return recoIdentityKey(r.song || r.matchedTitle, r.artist || r.matchedArtist)
  }

  type RecoItunesRow = { song: string; artist: string; album?: string; artworkUrl?: string; previewUrl?: string; appleMusicUrl?: string }

  /** In-session iTunes Search cache — Listen-to-the-List verify hits the same queries repeatedly. */
  const recoItunesSearchCache = new Map<string, RecoItunesRow[]>()
  const recoItunesInflight = new Map<string, Promise<RecoItunesRow[]>>()

  async function runWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return []
    const results: R[] = new Array(items.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        results[i] = await fn(items[i])
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, () => worker()),
    )
    return results
  }

  async function fetchItunesRecoRows(term: string, limit = 25): Promise<RecoItunesRow[]> {
    const q = term.trim()
    if (q.length < 2) return []
    const cacheKey = `${recoNorm(q)}|${limit}`
    const cached = recoItunesSearchCache.get(cacheKey)
    if (cached) return cached
    const inflight = recoItunesInflight.get(cacheKey)
    if (inflight) return inflight

    const promise = (async (): Promise<RecoItunesRow[]> => {
      try {
        const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=${limit}`
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
        if (!res.ok) return []
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> }
        const rows = (data.results || [])
          .map((r) => ({
            song: String(r.trackName ?? ''),
            artist: String(r.artistName ?? ''),
            album: r.collectionName ? String(r.collectionName) : undefined,
            artworkUrl: r.artworkUrl100 ? String(r.artworkUrl100).replace('100x100', '600x600') : undefined,
            previewUrl: r.previewUrl ? String(r.previewUrl) : undefined,
            appleMusicUrl: r.trackViewUrl ? String(r.trackViewUrl) : undefined,
          }))
          .filter((s) => s.song && s.artist && !RECO_ITUNES_JUNK.test(s.artist) && !RECO_ITUNES_JUNK.test(s.album || ''))
        recoItunesSearchCache.set(cacheKey, rows)
        return rows
      } catch {
        return []
      } finally {
        recoItunesInflight.delete(cacheKey)
      }
    })()
    recoItunesInflight.set(cacheKey, promise)
    return promise
  }

  // Verified cover-art lookup for radar / discovery cards. The renderer used to
  // hit search-itunes and take results[0] blindly — which is how a Vince Staples
  // card ended up wearing a Guns N' Roses cover. Reuse the SAME matchers the reco
  // add-path uses (recoArtistMatches / recoTitleMatches) and accept art ONLY from
  // a row whose ARTIST matches the candidate; prefer a row whose title also
  // matches (exact cover) but fall back to any same-artist row. No match → return
  // nothing, so the card keeps its honest ♪ placeholder rather than wrong art.
  // MusicBrainz asks for ≤1 request/sec per client — radar enriches up to 12
  // cards in parallel, so serialize MB calls through a promise chain with a
  // 1.1s gap. CAA/archive.org has no such limit.
  let mbCallChain: Promise<unknown> = Promise.resolve()
  function mbThrottled<T>(fn: () => Promise<T>): Promise<T> {
    const run = mbCallChain.then(fn, fn)
    mbCallChain = run.then(
      () => new Promise((r) => setTimeout(r, 1100)),
      () => new Promise((r) => setTimeout(r, 1100)),
    )
    return run
  }

  /** Brand-new releases often hit MusicBrainz/Cover Art Archive before iTunes.
   *  Artist+title verified against the release-group credit — same honesty rule
   *  as the iTunes path: wrong art is worse than no art. Returns a CAA front
   *  cover URL or null; null is cached too (don't re-ask MB every remount). */
  const caaArtCache = new Map<string, string | null>()
  async function fetchCaaArtwork(artist: string, title: string): Promise<string | null> {
    const cacheKey = `${recoNorm(artist)}|${recoNorm(title)}`
    const cached = caaArtCache.get(cacheKey)
    if (cached !== undefined) return cached
    const headers = { 'User-Agent': 'JakeTunes/4.5 ( jakerosenbaum30@gmail.com )' }
    let result: string | null = null
    try {
      const q = `releasegroup:"${title}" AND artist:"${artist}"`
      const res = await mbThrottled(() =>
        fetch(`https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=3`, { headers, signal: AbortSignal.timeout(6000) })
      )
      if (res.ok) {
        const data = await res.json() as { 'release-groups'?: Array<{ id: string; title?: string; 'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }> }> }
        const verified = (data['release-groups'] || []).find((g) => {
          const credits = (g['artist-credit'] || []).map((c) => c.name || c.artist?.name || '')
          return recoTitleMatches(title, g.title || '') && credits.some((c) => recoArtistMatches(artist, c))
        })
        if (verified) {
          // HEAD-probe the front cover so the renderer never renders a 404 <img>.
          const url = `https://coverartarchive.org/release-group/${verified.id}/front-500`
          const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(6000) }).catch(() => null)
          if (head?.ok) result = url
        }
      }
    } catch { /* fall through to null */ }
    caaArtCache.set(cacheKey, result)
    return result
  }

  // 30s preview of A SONG OFF an album, for playing in place (Home's New
  // This Week, 2026-08-07). iTunes first; Deezer keyless fallback because
  // Apple 403-limits this IP under load and the preview button then died
  // SILENTLY (Jake: "shit dont work!!!!"). Deezer search is plain-text, so
  // the artist MUST match and an album match is preferred — junk hits
  // (a Henze symphony for a metal query) get filtered, and an honest miss
  // beats a wrong song.
  ipc.handle('lookup-album-preview', async (_event, input: { artist?: string; album?: string }): Promise<{ previewUrl?: string; trackTitle?: string }> => {
    const artist = (input?.artist || '').trim()
    const album = (input?.album || '').trim()
    if (artist.length < 2 || album.length < 1) return {}
    try {
      const rows = await fetchItunesRecoRows(`${artist} ${album}`, 25)
      const same = rows.filter((r) => recoArtistMatches(artist, r.artist) && r.previewUrl)
      const best = same.find((r) => recoTitleMatches(album, r.album || '')) || same[0]
      if (best?.previewUrl) return { previewUrl: best.previewUrl, trackTitle: best.song }
    } catch { /* fall through to Deezer */ }
    try {
      const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(`${artist} ${album}`)}&limit=10`, { signal: AbortSignal.timeout(6000) })
      if (res.ok) {
        const data = await res.json() as { data?: Array<{ preview?: string; title?: string; artist?: { name?: string }; album?: { title?: string } }> }
        const hits = (data.data || []).filter((d) => d.preview && recoArtistMatches(artist, d.artist?.name || ''))
        const best = hits.find((d) => recoTitleMatches(album, d.album?.title || '')) || hits[0]
        if (best?.preview) return { previewUrl: best.preview, trackTitle: best.title }
      }
    } catch { /* no preview to be had */ }
    return {}
  }, { refuse: {} })

  ipc.handle('lookup-reco-artwork', async (_event, input: { artist?: string; title?: string }): Promise<{ artworkUrl?: string; previewUrl?: string }> => {
    const artist = (input?.artist || '').trim()
    const title = (input?.title || '').trim()
    if (artist.length < 2 || title.length < 1) return {}
    try {
      const rows = await fetchItunesRecoRows(`${artist} ${title}`, 25)
      const sameArtist = rows.filter((r) => recoArtistMatches(artist, r.artist))
      if (sameArtist.length) {
        // Radar candidates are usually releases — match the title against the
        // ALBUM name too, so the right record's cover wins over a stray single.
        const best =
          sameArtist.find((r) => recoTitleMatches(title, r.album || '')) ||
          sameArtist.find((r) => recoTitleMatches(title, r.song)) ||
          sameArtist[0]
        return { artworkUrl: best.artworkUrl, previewUrl: best.previewUrl }
      }
      // iTunes has nothing by this artist (common for week-old releases) —
      // try MusicBrainz + Cover Art Archive before giving up.
      const caa = await fetchCaaArtwork(artist, title)
      return caa ? { artworkUrl: caa } : {}
    } catch {
      return {}
    }
  }, { refuse: {} })

  /** Recommendations for suggest — reuse sync TTL so navigation does not re-pull homemini/NAS every time. */
  async function recommendationsForSuggest(): Promise<RecommendationRecord[]> {
    const stale = Date.now() - recommendationsSyncedAtMs > RECOMMENDATIONS_SYNC_TTL_MS
    if (!stale && recommendationsSyncedAtMs > 0) {
      // Local rows are all live (mirror + outbox, Brief 125) — no tombstone filter.
      return readRecommendationsFile()
    }
    return syncRecommendationsToLocal()
  }

  /** iTunes-verify a Music Man pick; return canonical song/artist or null if not real. */
  async function verifyMusicManSuggestion(s: { song: string; artist: string; note: string }): Promise<{ song: string; artist: string; note: string } | null> {
    const strictCredit = await lookupItunesForRecommendation({ song: s.song, artist: s.artist }, { requireArtist: true })
    let canonical = await lookupItunesForRecommendation({ song: s.song, artist: s.artist })
    // Wrong-artist+title queries often return 0 rows (e.g. "Territorial Pissings
    // Smashing Pumpkins"). Fall back to title-only so we can reject or correct.
    if (!canonical.matchedTitle || !canonical.matchedArtist) {
      canonical = await lookupItunesForRecommendation({ song: s.song })
    }
    const strictOk =
      Boolean(strictCredit.matchedTitle) &&
      Boolean(strictCredit.matchedArtist) &&
      recoTitleMatches(s.song, strictCredit.matchedTitle!) &&
      recoArtistMatches(s.artist, strictCredit.matchedArtist!)
    const needsTitlePool =
      Boolean(canonical.matchedTitle && canonical.matchedArtist) &&
      !recoArtistMatches(s.artist, canonical.matchedArtist ?? '') &&
      !strictOk
    const titleOnlyRows = needsTitlePool ? await fetchItunesRecoRows(s.song, 25) : []
    const verdict = evaluateMusicManVerification({
      mm: { song: s.song, artist: s.artist },
      strictCredit,
      canonical,
      titleOnlyRows,
    })
    if (!verdict.ok) {
      if (verdict.reason === 'artist_hallucination') {
        console.warn('[reco] suggest: rejected artist hallucination —', s.song, 'is not by', s.artist, canonical.matchedArtist ? `(iTunes: ${canonical.matchedArtist})` : '')
      }
      return null
    }
    if (verdict.mode === 'corrected') {
      console.warn('[reco] suggest: corrected artist credit —', s.song, s.artist, '→', verdict.artist)
    }
    return { song: verdict.song, artist: verdict.artist, note: s.note }
  }

  /** iTunes Search best-match enrichment for a single reco add (local fallback). */
  async function lookupItunesForRecommendation(
    input: { song?: string; artist?: string; album?: string },
    opts?: { requireArtist?: boolean },
  ): Promise<Pick<RecommendationRecord, 'artworkUrl' | 'appleMusicUrl' | 'previewUrl' | 'matchedTitle' | 'matchedArtist' | 'matchedAlbum'>> {
    const q = [input.song, input.artist, input.album].filter(Boolean).join(' ').trim()
    if (q.length < 2) return {}
    try {
      const raw = await fetchItunesRecoRows(q, 25)
      if (raw.length === 0) return {}
      const wantSong = recoNorm(input.song || '')
      const wantArtist = recoNorm(input.artist || '')
      const artistFreq = new Map<string, number>()
      for (const s of raw) {
        const k = s.artist.toLowerCase()
        artistFreq.set(k, (artistFreq.get(k) || 0) + 1)
      }
      const scoreOf = (s: RecoItunesRow): number => {
        if (input.song && !recoTitleMatches(input.song, s.song)) return -1000
        if (opts?.requireArtist && input.artist && !recoArtistMatches(input.artist, s.artist)) return -1000
        const songN = recoNorm(s.song)
        const artistN = recoNorm(s.artist)
        let score = (artistFreq.get(s.artist.toLowerCase()) || 1) * 2
        if (wantSong && songN === wantSong) score += 50
        else if (wantSong && recoTitleMatches(input.song || '', s.song)) score += 35
        if (wantArtist && artistN === wantArtist) score += 40
        else if (wantArtist && (artistN.includes(wantArtist) || wantArtist.includes(artistN))) score += 15
        const album = (s.album || '').toLowerCase()
        const song = s.song.toLowerCase()
        const isLive = /\blive\b|\(live/.test(song) || /\blive\b/.test(album)
        if (!isLive && !/ - single$/.test(album)) score += 4
        if (isLive) score -= 3
        if (/ - single$/.test(album) && album.startsWith(song)) score -= 6
        return score
      }
      const best = raw
        .map((s, i) => ({ s, i, score: scoreOf(s) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => (b.score - a.score) || (a.i - b.i))[0]?.s
      if (!best) return {}
      return {
        matchedTitle: best.song,
        matchedArtist: best.artist,
        matchedAlbum: best.album,
        artworkUrl: best.artworkUrl,
        previewUrl: best.previewUrl,
        appleMusicUrl: best.appleMusicUrl,
      }
    } catch {
      return {}
    }
  }

  async function appendRecommendationLocal(recommendation: RecommendationRecord): Promise<void> {
    const local = await readRecommendationsFile()
    await writeRecommendationsFile(mergeRecommendationsById(local, [recommendation]))
  }

  async function buildLocalRecommendation(input: {
    song?: string; artist?: string; album?: string; note?: string
  }, source: RecoSource = 'user'): Promise<RecommendationRecord> {
    const now = new Date().toISOString()
    const enrichment = await lookupItunesForRecommendation(input)
    const canonicalSong = enrichment.matchedTitle || input.song?.trim() || undefined
    const canonicalArtist = enrichment.matchedArtist || input.artist?.trim() || undefined
    return {
      id: randomUUID(),
      song: canonicalSong,
      artist: canonicalArtist,
      album: enrichment.matchedAlbum || input.album?.trim() || undefined,
      note: input.note?.trim() || undefined,
      createdAt: now,
      ...enrichment,
      resolvedAt: enrichment.matchedTitle ? now : undefined,
      source,
    }
  }

  /** homemini sometimes returns 500 after persisting — find the row via GET. */
  async function recoverRecommendationFromBackend(input: {
    song?: string; artist?: string; album?: string; note?: string
  }): Promise<RecommendationRecord | null> {
    const backend = (await fetchRecommendationsFromBackend()) ?? []
    if (backend.length === 0) return null
    const key = recoMatchKey(input)
    const cutoff = Date.now() - 5 * 60 * 1000
    const matches = backend.filter((r) => recoRecordKey(r) === key)
    const recent = matches.filter((r) => new Date(r.createdAt || 0).getTime() >= cutoff)
    const pool = recent.length > 0 ? recent : matches
    if (pool.length === 0) return null
    return pool.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0]
  }

  async function fetchRecommendationsFromBackend(): Promise<RecommendationRecord[] | null> {
    try {
      const res = await fetch(`${MOBILE_BACKEND_URL}/api/recommendations`, {
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        console.warn('[reco] backend GET failed:', res.status)
        return null
      }
      return parseRecommendationsPayload(await res.json() as unknown)
    } catch (err) {
      quietWarn('reco-backend-unreachable', '[reco] backend GET unreachable:', err instanceof Error ? err.message : err)
      return null
    }
  }

  async function readRecommendationsFromNas(): Promise<RecommendationRecord[] | null> {
    if (!(await nasAvailable())) return null   // breaker open: no NAS IO
    try {
      // Async readFile ONLY — no existsSync on the SMB mount (see
      // readNasRecoTombstones: a stale mount makes sync fs calls block the
      // main process for seconds = the beachball).
      const nasPath = join(NAS_STATE_DIR_PATH, 'recommendations.json')
      const raw = await readFile(nasPath, 'utf-8')
      return parseRecommendationsPayload(JSON.parse(raw) as unknown)
    } catch {
      return null
    }
  }

  // ---- Brief 125: queue-and-replay outbox --------------------------------
  // The homemini backend is the SINGLE writer of the shared recommendations
  // files. V3 mutates only via its HTTP API; when the Mini is unreachable the
  // mutation is queued here (V3-private file) and replayed on a later sync.
  function recommendationsOutboxPath(): string {
    return join(STATE_DIR, 'recommendations-outbox.json')
  }

  async function readRecoOutbox(): Promise<RecoOutboxOp[]> {
    try {
      return parseOutbox(JSON.parse(await readFile(recommendationsOutboxPath(), 'utf-8')) as unknown)
    } catch {
      return []
    }
  }

  async function writeRecoOutbox(ops: RecoOutboxOp[]): Promise<void> {
    const p = recommendationsOutboxPath()
    const tmp = p + '.tmp.json'
    await writeFile(tmp, JSON.stringify(ops, null, 2))
    const { rename: renameFS } = await import('fs/promises')
    await renameFS(tmp, p)
  }

  // Serialize every outbox read-modify-write (adds, deletes, and replay can
  // overlap) through a promise chain so ops are never lost to a lost update.
  let recoOutboxChain: Promise<void> = Promise.resolve()
  function withRecoOutbox(fn: (ops: RecoOutboxOp[]) => Promise<RecoOutboxOp[]>): Promise<void> {
    const run = recoOutboxChain.then(async () => {
      const ops = await readRecoOutbox()
      const next = await fn(ops)
      await writeRecoOutbox(next)
    })
    recoOutboxChain = run.catch((err) => console.warn('[reco] outbox op failed (mutation may be unrecorded):', err?.message ?? err))
    return run
  }

  function enqueueRecoOps(mutate: (ops: RecoOutboxOp[]) => RecoOutboxOp[]): Promise<void> {
    return withRecoOutbox(async (ops) => mutate(ops))
  }

  /** Replay queued mutations against the backend API. Failures stay queued for
   *  the next pass; a landed add adopts homemini's id in the local cache (the
   *  same swap pushLocalOnlyRecommendations used to do) so the next mirror pull
   *  can't duplicate it.
   *  Brief 126: adds declare origin 'user' (they were human actions — a
   *  deliberate re-add may un-delete); a `suppressed` response counts as
   *  landed. Deletes transmit the op's FULL identity-key set as query params,
   *  so the backend tombstones the SONG even when the id no longer resolves. */
  async function replayRecommendationsOutbox(): Promise<void> {
    await withRecoOutbox(async (ops) => {
      if (ops.length === 0) return ops
      const remaining: RecoOutboxOp[] = []
      const adoptions: Array<{ localId: string; adopted: RecommendationRecord }> = []
      let landedAdds = 0
      let landedDeletes = 0
      for (const op of ops) {
        if (op.op === 'add') {
          try {
            const res = await fetch(`${MOBILE_BACKEND_URL}/api/recommendations`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...op.input, origin: 'user', clientQueuedAt: op.queuedAt || undefined }),
              signal: AbortSignal.timeout(10000),
            })
            if (!res.ok) { remaining.push(op); continue }
            const parsed = (await res.json().catch(() => null)) as (RecommendationRecord & { suppressed?: boolean }) | { item?: RecommendationRecord } | null
            if (parsed && typeof parsed === 'object' && (parsed as { suppressed?: boolean }).suppressed) {
              landedAdds++   // backend said no (tombstoned system-class row) — op is settled
              continue
            }
            const adopted = (parsed && typeof parsed === 'object' && 'id' in parsed && (parsed as RecommendationRecord).id)
              ? (parsed as RecommendationRecord)
              : ((parsed as { item?: RecommendationRecord } | null)?.item ?? null)
            if (adopted?.id && String(adopted.id) !== op.localId) {
              adoptions.push({ localId: op.localId, adopted })
            }
            landedAdds++
          } catch {
            remaining.push(op)   // Mini unreachable — retry next sync
          }
        } else {
          const identityParams = op.identities
            .slice(0, 8)
            .map((k) => `identity=${encodeURIComponent(k)}`)
            .join('&')
          const stillDoomed: string[] = []
          for (const did of op.ids) {
            try {
              const res = await fetch(`${MOBILE_BACKEND_URL}/api/recommendations/${encodeURIComponent(did)}${identityParams ? `?${identityParams}` : ''}`, {
                method: 'DELETE',
                signal: AbortSignal.timeout(8000),
              })
              if (!res.ok && res.status !== 404) { stillDoomed.push(did); continue }
              const body = (await res.json().catch(() => null)) as { existed?: boolean } | null
              if (body && body.existed === false) {
                console.log(`[reco] delete no-op'd on backend (id ${did} unknown) — identity keys tombstoned anyway`)
              }
            } catch {
              stillDoomed.push(did)
            }
          }
          if (stillDoomed.length > 0) remaining.push({ ...op, ids: stillDoomed })
          else landedDeletes++
        }
      }
      if (adoptions.length > 0) {
        const local = await readRecommendationsFile()
        const byId = new Map(local.map((r) => [String(r.id), r] as const))
        for (const { localId, adopted } of adoptions) {
          const mine = byId.get(localId)
          byId.delete(localId)
          // Adopt homemini's id; keep our enrichment where homemini's is sparse.
          byId.set(String(adopted.id), mine ? { ...mine, ...adopted, id: adopted.id } : adopted)
        }
        await writeRecommendationsFile([...byId.values()])
      }
      if (landedAdds > 0 || landedDeletes > 0) {
        console.log(`[reco] outbox replay: ${landedAdds} add(s), ${landedDeletes} delete(s) landed on homemini; ${remaining.length} op(s) still queued`)
      }
      return remaining
    })
  }

  /** Brief 126 sync protocol v2: server-authoritative mirror through the PURE
   *  merge engine (reco-sync.ts). The backend is the only source of truth; the
   *  local file is a cache of its list overlaid with this machine's outbox.
   *  NOTHING IS INFERRED FROM ABSENCE — a local row that is not on the backend
   *  and not in the outbox was deleted elsewhere and is dropped. (The old
   *  "stray migration" that re-POSTed such rows — and thereby un-deleted every
   *  phone delete on the next desktop sync — is gone, structurally: no such
   *  branch exists in computeMirror.) When the backend is unreachable, a
   *  read-only additive import from the NAS copy keeps the display fresh,
   *  gated by the backend's LIVE NAS tombstones. */
  let recommendationsSyncedAtMs = 0
  const RECOMMENDATIONS_SYNC_TTL_MS = 60 * 1000
  interface RecoSyncMeta {
    source: 'backend' | 'cache' | 'nas-fallback'
    backendReachable: boolean
    syncedAt: number | null
    pendingOps: number
  }
  let lastRecoSyncMeta: RecoSyncMeta = { source: 'cache', backendReachable: false, syncedAt: null, pendingOps: 0 }

  async function syncRecommendationsToLocal(): Promise<RecommendationRecord[]> {
    await replayRecommendationsOutbox().catch((err) => console.warn('[reco] outbox replay failed (will retry next sync):', err?.message ?? err))
    const local = await readRecommendationsFile()
    const outbox = await readRecoOutbox()
    const backendRaw = await fetchRecommendationsFromBackend()   // null = homemini unreachable

    if (backendRaw === null) {
      const nas = (await readRecommendationsFromNas()) ?? []
      const nasTombstones = await readNasRecoTombstones()
      const incoming = computeNasFallback({ local, nas, nasTombstones, ops: outbox })
      lastRecoSyncMeta = { source: 'nas-fallback', backendReachable: false, syncedAt: recommendationsSyncedAtMs || null, pendingOps: outbox.length }
      if (incoming.length === 0) return local
      const merged = dedupeRecommendationsByIdentity(mergeRecommendationsById(local, incoming))
      await writeRecommendationsFile(merged)
      console.log(`[reco] backend unreachable — pulled ${incoming.length} new from the NAS copy (read-only)`)
      return merged
    }

    const { merged: mirrorRows, dupeDeleteIds } = computeMirror({ backend: backendRaw, local, ops: outbox })
    const merged = sortRecommendations(mirrorRows)

    // Heal server-side duplicates the dedupe collapsed: converge homemini via
    // queued API deletes (ids only — NO identity keys, the song stays live).
    if (dupeDeleteIds.length > 0) {
      await enqueueRecoOps((ops) => [
        ...ops,
        { op: 'delete', ids: dupeDeleteIds, identities: [], queuedAt: new Date().toISOString() },
      ])
      console.log(`[reco] healed ${dupeDeleteIds.length} duplicate cop${dupeDeleteIds.length === 1 ? 'y' : 'ies'} — queued homemini delete(s)`)
    }

    await writeRecommendationsFile(merged)
    recommendationsSyncedAtMs = Date.now()
    lastRecoSyncMeta = { source: 'backend', backendReachable: true, syncedAt: recommendationsSyncedAtMs, pendingOps: outbox.length }
    return merged
  }

  // ── Brief 126: freshness + push. A 60s main-process timer keeps the mirror
  // current (a phone delete disappears from an open desktop view within ≤60s);
  // any sync that changed the list pushes `recommendations-updated` so the
  // renderer never polls. Mutations schedule a converge-sync ~2s out. ──
  let recoLastPushedJson = ''
  async function runRecoSyncAndNotify(reason: string): Promise<void> {
    try {
      const list = await syncRecommendationsToLocal()
      const json = JSON.stringify(list.map((r) => r.id + (r.owned ? '!' : '')))
      if (json !== recoLastPushedJson) {
        recoLastPushedJson = json
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.send('recommendations-updated', { reason })
        }
      }
    } catch (err) {
      console.warn('[reco] scheduled sync failed:', err instanceof Error ? err.message : err)
    }
  }
  let recoSyncTimerStarted = false
  function startRecoSyncTimer(): void {
    if (recoSyncTimerStarted) return
    recoSyncTimerStarted = true
    setInterval(() => { void runRecoSyncAndNotify('timer') }, 60 * 1000)
  }
  let recoConvergeTimer: NodeJS.Timeout | null = null
  function scheduleRecoConvergeSync(): void {
    if (recoConvergeTimer) clearTimeout(recoConvergeTimer)
    recoConvergeTimer = setTimeout(() => {
      recoConvergeTimer = null
      void runRecoSyncAndNotify('mutation')
    }, 2000)
  }

  // ── Brief 126: one-time boot reset. Scrubs the outbox of stray-migration
  // residue (queued adds whose identity is live or tombstoned on the backend),
  // deletes the frozen legacy tombstone file, and forces a full mirror.
  // Safety-gated: aborts (and retries next boot) when the backend is
  // unreachable — the reset never runs blind. ──
  async function runRecoResetV2IfNeeded(): Promise<void> {
    const marker = join(STATE_DIR, 'reco-reset-v2.done')
    const { existsSync } = await import('fs')
    if (existsSync(marker)) return
    try {
      const backend = await fetchRecommendationsFromBackend()
      if (backend === null) { console.log('[reco] reset-v2 deferred — backend unreachable'); return }
      const res = await fetch(`${MOBILE_BACKEND_URL}/api/recommendations/deleted`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) { console.log('[reco] reset-v2 deferred — /deleted', res.status); return }
      const deleted = (await res.json()) as { keys?: string[] }
      const tombstoneEntries = new Set((deleted.keys || []).map(String))
      const backendKeys = new Set(backend.flatMap((r) => recordIdentityKeys(r)))
      await withRecoOutbox(async (ops) => {
        const { ops: kept, dropped } = scrubOutboxAgainstBackend(ops, backendKeys, tombstoneEntries)
        for (const d of dropped) {
          if (d.op === 'add') console.log(`[reco] reset-v2 dropped stray queued add: "${d.input.song ?? ''}" — ${d.input.artist ?? ''}`)
        }
        return kept
      })
      try { await unlink(join(STATE_DIR, 'recommendations-deleted.json')) } catch { /* already gone */ }
      await syncRecommendationsToLocal()
      await writeFile(marker, new Date().toISOString())
      console.log('[reco] reset-v2 complete — legacy tombstones removed, outbox scrubbed, mirror forced')
    } catch (err) {
      console.warn('[reco] reset-v2 failed (will retry next boot):', err instanceof Error ? err.message : err)
    }
  }

  type ReadRecosResult = { ok: boolean; recommendations: RecommendationRecord[]; meta: RecoSyncMeta }
  let readRecoInflight: Promise<ReadRecosResult> | null = null

  ipc.handle('read-recommendations', async (_event, opts?: { forceSync?: boolean }): Promise<ReadRecosResult> => {
    if (!opts?.forceSync && readRecoInflight) return readRecoInflight
    readRecoInflight = (async (): Promise<ReadRecosResult> => {
      try {
        const forceSync = opts?.forceSync === true
        const stale = Date.now() - recommendationsSyncedAtMs > RECOMMENDATIONS_SYNC_TTL_MS
        const recommendations = (forceSync || stale || recommendationsSyncedAtMs === 0)
          ? await syncRecommendationsToLocal()
          : await readRecommendationsFile()
        if (!stale && !forceSync && lastRecoSyncMeta.source === 'backend') {
          lastRecoSyncMeta = { ...lastRecoSyncMeta, source: 'cache' }
        }
        return { ok: true, recommendations, meta: lastRecoSyncMeta }
      } catch (err) {
        // Brief 126: an error NEVER masquerades as an empty list. Serve the
        // cached file with backendReachable:false — the UI shows a banner,
        // not an innocent EmptyState.
        console.warn('[reco] read/sync failed:', err instanceof Error ? err.message : err)
        const cached = await readRecommendationsFile().catch(() => [] as RecommendationRecord[])
        const outbox = await readRecoOutbox().catch(() => [] as RecoOutboxOp[])
        return {
          ok: cached.length > 0,
          recommendations: cached,
          meta: { source: 'cache', backendReachable: false, syncedAt: recommendationsSyncedAtMs || null, pendingOps: outbox.length },
        }
      } finally {
        readRecoInflight = null
      }
    })()
    return readRecoInflight
  }, { public: true })

  // Shared by the renderer's omnibox AND the iMessage watcher — one add path,
  // so attribution, friends-ledger ticks, identity dedupe, and outbox replay
  // behave identically no matter where a song came from.
  async function addRecommendationCore(input: { song?: string; artist?: string; album?: string; note?: string; source?: RecoSource; from?: string; link?: string; sentAt?: string }): Promise<{ ok: boolean; recommendation?: RecommendationRecord; error?: string; savedLocally?: boolean; deduped?: boolean }> {
    // v2 capture: friend attribution + source link ride the synced `note`
    // field (backend passes note through verbatim), and the friend gets an
    // 'add' tick in the local ledger for the Scouts ranking.
    const noteBits = [input.note?.trim(), input.from?.trim() ? `from ${input.from.trim()}` : '', input.link?.trim() || ''].filter(Boolean)
    const trimmed = {
      song: input.song?.trim() || undefined,
      artist: input.artist?.trim() || undefined,
      album: input.album?.trim() || undefined,
      note: noteBits.length ? noteBits.join(' · ') : undefined,
    }
    // The 'add' tick fires ONLY when a row actually lands on the list — at the
    // success returns below, never up front. The old top-of-function tick
    // counted (a) failed captures — Dan Gottlieb's podcast-episode link showed
    // as "1 sent" with nothing ever listed — and (b) DEDUPED re-adds, which is
    // exactly how Lorin's two retro-captured songs double-counted 13 → 15
    // on top of their manual adds (both 2026-08-07).
    const fromName = input.from?.trim() || ''
    // Durable send record — survives dedupes and list removals so the credit
    // sweep can still award the import ("lorin should get credit for the
    // latest john mayer song that i imported", 2026-08-28).
    const noteFriendSend = (): void => {
      if (!fromName) return
      void noteAttribution({ song: trimmed.song, artist: trimmed.artist, friend: fromName, at: input.sentAt || new Date().toISOString(), url: input.link }).catch((err) => console.warn('[scouts] attribution record failed:', err instanceof Error ? err.message : err))
    }
    const tickFriendAdd = (): void => {
      if (!fromName) return
      void host.friendsCache.update((cur) => {
        const key = fromName.toLowerCase()
        const f = cur[key] || { name: fromName, adds: 0, got: 0, tossed: 0, lastAt: 0 }
        f.adds += 1; f.lastAt = Date.now(); cur[key] = f
        return cur
      })
    }
    if (!trimmed.song && !trimmed.artist && !trimmed.album && !trimmed.note) {
      return { ok: false, error: 'nothing to add' }
    }
    const source: RecoSource = input.source || 'user'

    // Idempotency: if this song is already on the list (song+artist identity, or
    // exact song|artist|note for note-only jots), return the existing record
    // instead of creating a duplicate. Covers double-clicks, retries after a
    // timeout, and a radar pick the user already jotted by hand. Checked BEFORE
    // the backend POST so homemini never mints a duplicate id either.
    try {
      // Local rows are all live now (mirror + outbox — no tombstone filter needed).
      const existing = await readRecommendationsFile()
      const idKey = recoIdentityKey(trimmed.song, trimmed.artist)
      const fullKey = recoMatchKey(trimmed)
      const dupe = existing.find((r) => {
        const rid = recoRecordIdentityKey(r)
        return idKey && rid ? rid === idKey : recoRecordKey(r) === fullKey
      })
      if (dupe) {
        console.log('[reco] add deduped — already on list:', dupe.id)
        // The song was already listed, but the SEND still happened — remember
        // it (attribution + add tick) instead of dropping the friend's name
        // on the floor. This is how Lorin's 8/24 text vanished.
        noteFriendSend()
        tickFriendAdd()
        return { ok: true, recommendation: dupe, deduped: true }
      }
    } catch { /* fall through to normal add */ }

    // Un-deleting on re-add is the backend's job (it clears the identity
    // tombstone on a genuine re-add through POST) — V3 keeps no tombstones.

    const url = `${MOBILE_BACKEND_URL}/api/recommendations`
    console.log('[reco] POST →', url, JSON.stringify(trimmed))
    let recommendation: RecommendationRecord | null = null
    let backendStatus: number | null = null

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // origin:'user' — a deliberate human add; may un-delete (Brief 126).
        body: JSON.stringify({ ...trimmed, origin: 'user' }),
        signal: AbortSignal.timeout(10000),
      })
      backendStatus = res.status
      if (res.ok) {
        try {
          const parsed = await res.json() as RecommendationRecord | { item?: RecommendationRecord }
          recommendation = ('id' in parsed && parsed.id)
            ? parsed as RecommendationRecord
            : (parsed as { item?: RecommendationRecord }).item ?? null
        } catch {
          recommendation = null
        }
      } else {
        console.warn('[reco] POST failed — backend', res.status)
      }
    } catch (err) {
      console.warn('[reco] POST threw:', err instanceof Error ? err.message : err)
    }

    // homemini can return 500 even after persisting — recover via GET before local fallback.
    if (!recommendation?.id) {
      recommendation = await recoverRecommendationFromBackend(trimmed)
      if (recommendation?.id) {
        console.log('[reco] recovered from backend after POST', backendStatus ?? 'error', '—', recommendation.id)
      }
    }

    if (recommendation?.id) {
      try {
        const enriched = await buildLocalRecommendation({
          song: recommendation.song || recommendation.matchedTitle,
          artist: recommendation.artist || recommendation.matchedArtist,
          album: recommendation.album || recommendation.matchedAlbum,
          note: recommendation.note,
        })
        recommendation = { ...recommendation, ...enriched, id: recommendation.id, createdAt: recommendation.createdAt, source: recommendation.source || source }
        await appendRecommendationLocal(recommendation)
        suggestResultCache = null   // a new add changes the dedup set — force fresh MM picks
      } catch (err) {
        console.warn('[reco] local append after POST failed:', err instanceof Error ? err.message : err)
      }
      scheduleRecoConvergeSync()
      noteFriendSend()
      tickFriendAdd()
      return { ok: true, recommendation }
    }

    // Mini unreachable or broken — save locally with iTunes enrichment and QUEUE
    // the add for replay through the backend API (single-writer: the fallback is
    // never a direct write to the shared NAS files).
    try {
      const local = await buildLocalRecommendation(trimmed, source)
      await appendRecommendationLocal(local)
      await enqueueRecoOps((ops) => [
        ...ops,
        {
          op: 'add',
          localId: String(local.id),
          input: trimmed,
          identities: recordIdentityKeys(local),
          queuedAt: new Date().toISOString(),
        },
      ])
      suggestResultCache = null   // a new add changes the dedup set — force fresh MM picks
      console.log('[reco] saved locally + queued for homemini (backend', backendStatus ?? 'unreachable', ') —', local.id)
      noteFriendSend()
      tickFriendAdd()
      return { ok: true, recommendation: local, savedLocally: true }
    } catch (err) {
      console.error('[reco] local add failed:', err instanceof Error ? err.message : err)
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }
  ipc.handle('add-recommendation', (_event, input: Parameters<typeof addRecommendationCore>[0]) => addRecommendationCore(input), { refuse: { ok: false, error: 'refused-sender' } as const })

  // ── iMessage capture (2026-07-19): Spotify / Apple Music links texted to
  // Jake land on the list automatically, credited "from <sender>". The
  // watcher lives in imessage-capture.ts; it feeds addRecommendationCore so
  // every capture gets the same dedupe/attribution/outbox treatment as a
  // hand-typed jot. State is V3-local (userData) — the laptop is the only
  // machine signed into Messages.
  startImessageCapture(ipc, {
    stateFile: join(app.getPath('userData'), 'imessage-capture.json'),
    addRecommendation: (input) => addRecommendationCore(input),
  })

  ipc.handle('delete-recommendation', async (_event, id: string): Promise<{ ok: boolean; error?: string }> => {
    // Identity-wide delete: removing a song removes EVERY copy of it (the list
    // once carried 14 copies of one track under different ids). The remote
    // removal routes through the backend API via the outbox — the backend
    // tombstones the id + every transmitted identity key (Brief 126: the keys
    // ride the DELETE as query params, so the song dies even if the backend
    // re-minted its id). A queued add of the same song is cancelled instead of
    // deleted remotely, so an offline add-then-delete can't replay the POST
    // after the DELETE and resurrect it.
    const rid = String(id)
    let doomedIds: string[] = [rid]
    let identities: string[] = []
    try {
      const all = await readRecommendationsFile()
      const target = all.find((r) => String(r.id) === rid)
      if (target) {
        const plan = identitiesForDelete(target, all)
        doomedIds = plan.doomedIds
        identities = plan.identities
      }
      const next = all.filter((r) => !doomedIds.includes(String(r.id)))
      if (next.length !== all.length) await writeRecommendationsFile(next)
    } catch (err) {
      console.warn('[reco] local delete failed:', err instanceof Error ? err.message : err)
    }
    suggestResultCache = null   // deleting frees the Music Man to re-suggest
    await enqueueRecoOps((ops) => {
      const { ops: scrubbed, remoteIds } = scrubOutboxForDelete(ops, doomedIds, identities)
      // Even when every local copy was a still-queued add, the identity keys
      // must land on the backend — the song may exist there under an id this
      // machine never saw.
      if (remoteIds.length === 0 && identities.length === 0) return scrubbed
      return [...scrubbed, { op: 'delete', ids: remoteIds.length > 0 ? remoteIds : [rid], identities, queuedAt: new Date().toISOString() }]
    })
    // Replay now when the Mini is up; otherwise the op waits for the next sync.
    void replayRecommendationsOutbox().catch((err) => console.warn('[reco] outbox replay failed (will retry next sync):', err?.message ?? err))
    scheduleRecoConvergeSync()
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  // Brief 122 — Music Man suggests 3 things to add to the Listen-to-the-List.
  // DISCOVERY only: artists/songs not already in the library or on the list.
  // Over-generates per attempt and retries up to 4× until ≥3 survive the hard
  // filter (large libraries eat most LLM picks). Returns a pool (up to 10) so
  // the UI can always show 3 and backfill when one is added.
  type SuggestRecoResult = { ok: boolean; suggestions?: Array<{ song: string; artist: string; note: string }>; error?: string }
  let suggestResultCache: { at: number; suggestions: Array<{ song: string; artist: string; note: string }> } | null = null
  let suggestRecoInflight: Promise<SuggestRecoResult> | null = null
  const SUGGEST_RESULT_TTL_MS = 30 * 60 * 1000

  ipc.handle('suggest-recommendations', async (_event, opts?: { force?: boolean }): Promise<SuggestRecoResult> => {
    const force = opts?.force === true
    const now = Date.now()
    if (!force && suggestResultCache && now - suggestResultCache.at < SUGGEST_RESULT_TTL_MS) {
      return { ok: true, suggestions: suggestResultCache.suggestions }
    }
    if (!force && suggestRecoInflight) return suggestRecoInflight
    if (force) suggestResultCache = null

    suggestRecoInflight = (async (): Promise<SuggestRecoResult> => {
    try {
      const lib = (await host.libraryCache.get()) as { tracks?: Array<{ artist?: string; albumArtist?: string; title?: string; genre?: string; playCount?: number }> }
      const tracks = Array.isArray(lib.tracks) ? lib.tracks : []
      const norm = (s: string) => foldAccents(s).replace(/[^a-z0-9]/g, '')
      const playsByArtist = new Map<string, number>()
      const playsByGenre = new Map<string, number>()
      const ownedArtists = new Set<string>() // normalized — every artist in the library
      const ownedSongs = new Set<string>()   // normalized artist|title
      for (const t of tracks) {
        const a = (t.albumArtist || t.artist || '').trim()
        if (a) {
          playsByArtist.set(a, (playsByArtist.get(a) ?? 0) + (Number(t.playCount) || 0))
          ownedArtists.add(norm(a))
          if (t.title) ownedSongs.add(`${norm(a)}|${norm(t.title)}`)
        }
        const g = (t.genre || '').trim()
        if (g) playsByGenre.set(g, (playsByGenre.get(g) ?? 0) + (Number(t.playCount) || 0))
      }
      // Top 150 seed the model-facing no-fly list (bannedArtists) so famous owned
      // artists are excluded at the SOURCE, not just post-filtered; the prompt's
      // "already owns and loves" line stays a tight top-15.
      const topOwnedArtists = Array.from(playsByArtist.entries()).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([a]) => a)
      const topArtists = topOwnedArtists.slice(0, 15)
      const topGenres = Array.from(playsByGenre.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g)

      let existing: string[] = []
      const listSongs = new Set<string>() // normalized artist|title already ON the list
      const listPairs: Array<{ artist: string; title: string }> = [] // raw, for the loose-artist check
      try {
        const parsed = await recommendationsForSuggest()
        if (parsed.length > 0) {
          existing = parsed
            .map((r) => `${r.song || r.matchedTitle || ''} — ${r.artist || r.matchedArtist || ''}`.trim())
            .filter((s) => s.length > 2)
            .slice(0, 50)
          for (const r of parsed) {
            const rawA = String(r.artist || r.matchedArtist || '')
            const rawT = String(r.song || r.matchedTitle || '')
            const a = norm(rawA)
            const t = norm(rawT)
            if (a && t) {
              listSongs.add(`${a}|${t}`)
              listPairs.push({ artist: rawA, title: rawT })
            }
          }
        }
      } catch { /* no list yet */ }

      // Exact-match alone misses multi-credit lines MM writes for collabs/features
      // (e.g. "Daft Punk, Pharrell Williams & Nile Rodgers" never equals the library's
      // plain "Daft Punk"), letting already-owned artists slip past the discovery
      // filter. recoArtistMatches (substring-aware, same helper suggest-verify uses)
      // catches those; the Set.has fast path just avoids an O(n) scan on the common
      // exact-match case.
      const isOwnedArtist = (artist: string): boolean => {
        const a = norm(artist)
        if (ownedArtists.has(a)) return true
        for (const owned of ownedArtists) {
          if (recoArtistMatches(artist, owned)) return true
        }
        return false
      }

      // Same multi-credit seam on the on-list side: a list entry saved as
      // "Daft Punk" must still block a suggestion credited "Daft Punk, Pharrell
      // Williams & Nile Rodgers" for the same title.
      const isOnList = (s: { song: string; artist: string }): boolean => {
        if (listSongs.has(`${norm(s.artist)}|${norm(s.song)}`)) return true
        const title = norm(s.song)
        return listPairs.some((p) => norm(p.title) === title && recoArtistMatches(s.artist, p.artist))
      }

      const passesFilter = (s: { song: string; artist: string }) => {
        const key = `${norm(s.artist)}|${norm(s.song)}`
        return !isOwnedArtist(s.artist) && !ownedSongs.has(key) && !isOnList(s)
      }

      const accumulated: Array<{ song: string; artist: string; note: string }> = []
      const seenKeys = new Set<string>()
      const bannedArtists = new Set<string>(topOwnedArtists.map((a) => a.toLowerCase().trim()))

      for (let attempt = 0; attempt < 4 && accumulated.length < 3; attempt++) {
        const excludeArtists = Array.from(bannedArtists).slice(0, 160)
        const excludePicked = accumulated.map((s) => s.artist)
        const user = [
          `Artists this person ALREADY OWNS and loves: ${topArtists.join(', ') || '(unknown)'}.`,
          topGenres.length ? `Genres in rotation: ${topGenres.join(', ')}.` : '',
          existing.length ? `Already on their Listen-to-the-List: ${existing.join('; ')}.` : '',
          excludeArtists.length ? `NEVER suggest these artists (owned, on-list, or already rejected): ${excludeArtists.join(', ')}.` : '',
          excludePicked.length ? `Already picked this round — do NOT repeat: ${excludePicked.join(', ')}.` : '',
          attempt > 0 ? 'Your last batch was mostly artists they already own. Dig deeper — smaller labels, regional scenes, one-album wonders.' : '',
          '',
          'This is a DISCOVERY list. Suggest 20 records they almost certainly do NOT own yet — artists NEW to this collection that sit in the lineage of, or just adjacent to, what they love (their influences, contemporaries, the bands they inspired or ripped off, the deeper scene). Do NOT suggest any artist listed above, and nothing already on the list — they HAVE those. The entire point is music they have not heard.',
          'Each: a real song + the artist + a one-sentence note in your voice on why it\'s the right next step for them.',
          'The note must be about THAT SAME song/artist — never argue against your own pick or pitch a different record than the one named in the entry.',
          'CRITICAL: song + artist must be a real recording on Apple Music/iTunes — the primary credited artist on that track. Never attribute a famous song to the wrong artist (e.g. Daft Punk\'s "Around the World" is not by Modjo; Chromeo\'s "Bonafide Lovin\'" is not by Röyksopp).',
          'Return ONLY JSON, no prose, no code fence: an array of 20 objects [{"song":"...","artist":"...","note":"..."}, ...].',
        ].filter(Boolean).join('\n')

        const reply = await host.claudeCall(`listen-list:suggest:${attempt}`, {
          model: 'claude-sonnet-4-6',
          max_tokens: 1200,
          system: MUSIC_MAN_CORE,
          messages: [{ role: 'user', content: user }],
        })
        const block = reply.content[0]
        const text = block && block.type === 'text' ? block.text : ''
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
        const parsed = JSON.parse((fence ? fence[1] : text).trim()) as Array<{ song?: unknown; artist?: unknown; note?: unknown }>
        const candidates = (Array.isArray(parsed) ? parsed : [])
          .map((s) => ({ song: String(s.song || '').trim(), artist: String(s.artist || '').trim(), note: String(s.note || '').trim() }))
          .filter((s) => s.song && s.artist)

        const verifiedBatch = await runWithConcurrency(candidates, 3, async (s) => ({
          raw: s,
          verified: await verifyMusicManSuggestion(s),
        }))
        for (const { raw: s, verified } of verifiedBatch) {
          if (accumulated.length >= 10) break
          if (!verified) {
            console.warn('[reco] suggest: dropped unverified pick', s.artist, '—', s.song)
            bannedArtists.add(s.artist.toLowerCase().trim())
            continue
          }
          if (!passesFilter(verified)) {
            bannedArtists.add(verified.artist.toLowerCase().trim())
            continue
          }
          const key = `${norm(verified.artist)}|${norm(verified.song)}`
          if (seenKeys.has(key)) continue
          seenKeys.add(key)
          accumulated.push(verified)
          bannedArtists.add(verified.artist.toLowerCase().trim())
        }
      }

      if (accumulated.length < 3) console.warn('[reco] suggest: only', accumulated.length, 'survived filter after retries (wanted ≥3)')
      const suggestions = accumulated.slice(0, 10)
      suggestResultCache = { at: Date.now(), suggestions }
      return { ok: true, suggestions }
    } catch (err) {
      console.error('[reco] suggest failed:', err instanceof Error ? err.message : err)
      return { ok: false, error: safeIpcError(err, 'unknown') }
    } finally {
      suggestRecoInflight = null
    }
    })()
    return suggestRecoInflight
  }, { refuse: REFUSED_SENDER })

  return {
    readRecommendationsFile,
    syncRecommendationsToLocal,
    startRecoSyncTimer,
    addRecommendationCore,
    runRecoResetV2IfNeeded,
    fetchCaaArtwork,
    recoRecordIdentityKey,
    recoIdentityKey,
  }
}
