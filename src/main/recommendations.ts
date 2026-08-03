/**
 * Brief 122 — "Listen to the List" backend.
 *
 * recommendations.json is the local source of truth; homemini/NAS are
 * synced on read (additive pull + reconcile-up). All IPC for the feature
 * lives here so index.ts stays thin.
 */

import { ipcMain } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import {
  evaluateMusicManVerification,
  recoArtistMatches,
  recoNorm,
  recoTitleMatches,
} from './reco-match'
import {
  isRecordTombstoned,
  recoIdentityKey,
  recoMatchKey,
  recoRecordIdentityKey,
  recoRecordKey,
  tombstoneKeysForRecord,
  RECO_FULL_TOMBSTONE_PREFIX,
  RECO_IDENTITY_TOMBSTONE_PREFIX,
} from './reco-tombstone'

export type RecoSource = 'user' | 'mm' | 'radar'

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
}

export interface ItunesSuggestion {
  song: string
  artist: string
  album?: string
  artworkUrl?: string
  previewUrl?: string
  appleMusicUrl?: string
}

type ClaudeCall = (callKey: string, params: MessageCreateParamsNonStreaming) => Promise<Message>

export interface RecommendationsHost {
  stateDir: string
  nasStateDir: string
  isNasMounted: () => boolean
  libraryPath: string
  claudeCall: ClaudeCall
  musicManCore: string
}

const MOBILE_BACKEND_URL = process.env.JAKETUNES_MOBILE_BACKEND || 'http://homemini:3000'
const RECO_ITUNES_JUNK = /karaoke|tribute|cover band|made famous|made popular|in the style of|originally performed|8.?bit|chiptune|lullaby|rockabye|little rock star|music foundation|piano (tribute|version|renditions?)|string quartet|meditation|sleep baby|nursery/i
const RECOMMENDATIONS_SYNC_TTL_MS = 5 * 60 * 1000
const SUGGEST_RESULT_TTL_MS = 30 * 60 * 1000

let host: RecommendationsHost
let recommendationsSyncedAtMs = 0
let readRecoInflight: Promise<{ ok: boolean; recommendations: RecommendationRecord[] }> | null = null
let suggestResultCache: { at: number; suggestions: Array<{ song: string; artist: string; note: string }> } | null = null
let suggestRecoInflight: Promise<{ ok: boolean; suggestions?: Array<{ song: string; artist: string; note: string }>; error?: string }> | null = null

const recoItunesSearchCache = new Map<string, RecoItunesRow[]>()
const recoItunesInflight = new Map<string, Promise<RecoItunesRow[]>>()

type RecoItunesRow = {
  song: string
  artist: string
  album?: string
  artworkUrl?: string
  previewUrl?: string
  appleMusicUrl?: string
}

function recommendationsPath(): string {
  return join(host.stateDir, 'recommendations.json')
}

function recommendationsDeletedPath(): string {
  return join(host.stateDir, 'recommendations-deleted.json')
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

async function readRecommendationTombstones(): Promise<Set<string>> {
  try {
    const raw = await readFile(recommendationsDeletedPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return new Set(parsed.map((id) => String(id)))
  } catch { /* no tombstones yet */ }
  return new Set()
}

async function writeRecommendationTombstones(tombstones: Set<string>): Promise<void> {
  const path = recommendationsDeletedPath()
  const tmp = path + '.tmp.json'
  await writeFile(tmp, JSON.stringify([...tombstones], null, 2))
  const { rename: renameFS } = await import('fs/promises')
  await renameFS(tmp, path)
  void mirrorTombstonesToNas(tombstones)
}

async function mirrorTombstonesToNas(tombstones: Set<string>): Promise<void> {
  if (!host?.isNasMounted()) return
  try {
    const nasPath = join(host.nasStateDir, 'recommendations-deleted.json')
    const tmp = nasPath + '.tmp.json'
    await writeFile(tmp, JSON.stringify([...tombstones], null, 2))
    const { rename: renameFS } = await import('fs/promises')
    await renameFS(tmp, nasPath)
  } catch (err) {
    console.warn('[reco] NAS tombstone mirror failed:', err instanceof Error ? err.message : err)
  }
}

async function addRecommendationTombstones(entries: string[]): Promise<void> {
  if (entries.length === 0) return
  const tombstones = await readRecommendationTombstones()
  for (const e of entries) tombstones.add(String(e))
  await writeRecommendationTombstones(tombstones)
}

async function filterTombstoned(list: RecommendationRecord[]): Promise<RecommendationRecord[]> {
  const tombstones = await readRecommendationTombstones()
  return list.filter((r) => !isRecordTombstoned(tombstones, r))
}

async function clearRecommendationIdentityTombstone(song?: string, artist?: string, note?: string): Promise<void> {
  try {
    const tombstones = await readRecommendationTombstones()
    let changed = false
    const identity = recoIdentityKey(song, artist)
    if (identity && tombstones.delete(RECO_IDENTITY_TOMBSTONE_PREFIX + identity)) changed = true
    const fullKey = recoMatchKey({ song, artist, note })
    if (tombstones.delete(RECO_FULL_TOMBSTONE_PREFIX + fullKey)) changed = true
    if (changed) await writeRecommendationTombstones(tombstones)
  } catch { /* best-effort */ }
}

async function mirrorRecommendationsToNas(list: RecommendationRecord[]): Promise<void> {
  if (!host.isNasMounted()) return
  try {
    const nasPath = join(host.nasStateDir, 'recommendations.json')
    const tmp = nasPath + '.tmp.json'
    await writeFile(tmp, JSON.stringify(sortRecommendations(list), null, 2))
    const { rename: renameFS } = await import('fs/promises')
    await renameFS(tmp, nasPath)
  } catch (err) {
    console.warn('[reco] NAS mirror failed:', err instanceof Error ? err.message : err)
  }
}

async function readRecommendationsFile(): Promise<RecommendationRecord[]> {
  try {
    const raw = await readFile(recommendationsPath(), 'utf-8')
    return parseRecommendationsPayload(JSON.parse(raw) as unknown)
  } catch {
    return []
  }
}

async function writeRecommendationsFile(list: RecommendationRecord[]): Promise<void> {
  const recoPath = recommendationsPath()
  const sorted = sortRecommendations(list)
  const tmp = recoPath + '.tmp.json'
  await writeFile(tmp, JSON.stringify(sorted, null, 2))
  const { rename: renameFS } = await import('fs/promises')
  await renameFS(tmp, recoPath)
  void mirrorRecommendationsToNas(sorted)
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

function dedupeRecommendationsByIdentity(list: RecommendationRecord[]): RecommendationRecord[] {
  const byIdentity = new Map<string, RecommendationRecord>()
  const pick = (a: RecommendationRecord, b: RecommendationRecord): RecommendationRecord => {
    if (Boolean(a.resolvedAt) !== Boolean(b.resolvedAt)) return a.resolvedAt ? a : b
    return (a.createdAt || '').localeCompare(b.createdAt || '') >= 0 ? a : b
  }
  for (const r of list) {
    const k = recoRecordIdentityKey(r) ?? `full:${recoRecordKey(r)}`
    const prev = byIdentity.get(k)
    byIdentity.set(k, prev ? pick(r, prev) : r)
  }
  return sortRecommendations([...byIdentity.values()])
}

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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
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
      let score = (artistFreq.get(s.artist.toLowerCase()) || 1) * 10
      if (wantSong && recoTitleMatches(input.song || '', s.song)) score += 40
      if (wantArtist && recoArtistMatches(input.artist || '', s.artist)) score += 30
      if (opts?.requireArtist && wantArtist && !recoArtistMatches(input.artist || '', s.artist)) return -1
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

async function verifyMusicManSuggestion(s: { song: string; artist: string; note: string }): Promise<{ song: string; artist: string; note: string } | null> {
  const strictCredit = await lookupItunesForRecommendation({ song: s.song, artist: s.artist }, { requireArtist: true })
  let canonical = await lookupItunesForRecommendation({ song: s.song, artist: s.artist })
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
      console.warn('[reco] suggest: rejected artist hallucination —', s.song, 'is not by', s.artist)
    }
    return null
  }
  if (verdict.mode === 'corrected') {
    console.warn('[reco] suggest: corrected artist credit —', s.song, s.artist, '→', verdict.artist)
  }
  return { song: verdict.song, artist: verdict.artist, note: s.note }
}

async function appendRecommendationLocal(recommendation: RecommendationRecord): Promise<void> {
  const local = await readRecommendationsFile()
  await writeRecommendationsFile(mergeRecommendationsById(local, [recommendation]))
}

async function buildLocalRecommendation(
  input: { song?: string; artist?: string; album?: string; note?: string },
  source: RecoSource = 'user',
): Promise<RecommendationRecord> {
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

async function fetchRecommendationsFromBackend(): Promise<RecommendationRecord[] | null> {
  try {
    const res = await fetch(`${MOBILE_BACKEND_URL}/api/recommendations`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      console.warn('[reco] backend GET failed:', res.status)
      return null
    }
    return parseRecommendationsPayload(await res.json() as unknown)
  } catch (err) {
    console.warn('[reco] backend GET unreachable:', err instanceof Error ? err.message : err)
    return null
  }
}

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

async function deleteRemoteRecommendation(id: string): Promise<void> {
  try {
    const res = await fetch(`${MOBILE_BACKEND_URL}/api/recommendations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok && res.status !== 404) {
      console.warn('[reco] backend delete returned', res.status, 'for', id)
    }
  } catch (err) {
    console.warn('[reco] backend delete unreachable for', id, ':', err instanceof Error ? err.message : err)
  }
}

async function pushLocalOnlyRecommendations(
  local: RecommendationRecord[],
  backendRaw: RecommendationRecord[] | null,
  tombstones: Set<string>,
): Promise<RecommendationRecord[] | null> {
  if (backendRaw === null) return null
  const backendIds = new Set(backendRaw.map((r) => String(r.id)))
  const backendIdentity = new Set(
    backendRaw.map((r) => recoRecordIdentityKey(r)).filter((k): k is string => Boolean(k)),
  )
  const localOnly = local.filter((r) => {
    if (isRecordTombstoned(tombstones, r)) return false
    if (backendIds.has(String(r.id))) return false
    if (!(r.song || r.artist || r.album || r.note)) return false
    const idk = recoRecordIdentityKey(r)
    return !(idk && backendIdentity.has(idk))
  }).slice(0, 20)
  if (localOnly.length === 0) return null

  const byId = new Map(local.map((r) => [String(r.id), r] as const))
  let pushed = 0
  for (const r of localOnly) {
    try {
      const res = await fetch(`${MOBILE_BACKEND_URL}/api/recommendations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ song: r.song, artist: r.artist, album: r.album, note: r.note }),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) continue
      const parsed = (await res.json().catch(() => null)) as RecommendationRecord | { item?: RecommendationRecord } | null
      const adopted = (parsed && typeof parsed === 'object' && 'id' in parsed && (parsed as RecommendationRecord).id)
        ? (parsed as RecommendationRecord)
        : ((parsed as { item?: RecommendationRecord } | null)?.item ?? null)
      if (adopted?.id && String(adopted.id) !== String(r.id)) {
        byId.delete(String(r.id))
        byId.set(String(adopted.id), { ...r, ...adopted, id: adopted.id })
        pushed++
      }
    } catch { /* retry next sync */ }
  }
  if (pushed === 0) return null
  const reconciled = sortRecommendations([...byId.values()])
  await writeRecommendationsFile(reconciled)
  console.log(`[reco] reconciled ${pushed} local-only recommendation(s) up to homemini`)
  return reconciled
}

async function syncRecommendationsToLocal(): Promise<RecommendationRecord[]> {
  const tombstones = await readRecommendationTombstones()
  const rawLocal = await readRecommendationsFile()
  const afterTombstones = rawLocal.filter((r) => !isRecordTombstoned(tombstones, r))
  const local = dedupeRecommendationsByIdentity(afterTombstones)

  // Purge tombstoned rows still on disk (heals drift) and collapse dupes.
  if (afterTombstones.length !== rawLocal.length || local.length !== afterTombstones.length) {
    const keptIds = new Set(local.map((r) => String(r.id)))
    const droppedDupeIds = afterTombstones.filter((r) => !keptIds.has(String(r.id))).map((r) => String(r.id))
    if (droppedDupeIds.length > 0) {
      await addRecommendationTombstones(droppedDupeIds)
      for (const did of droppedDupeIds) void deleteRemoteRecommendation(did)
      console.log(`[reco] healed ${droppedDupeIds.length} duplicate cop${droppedDupeIds.length === 1 ? 'y' : 'ies'} off the list`)
    }
    await writeRecommendationsFile(local)
  }

  const localIds = new Set(local.map((r) => String(r.id)))
  const localIdentities = new Set(local.map((r) => recoRecordIdentityKey(r)).filter((k): k is string => Boolean(k)))
  const backendRaw = await fetchRecommendationsFromBackend()
  const backend = backendRaw ?? []

  // homemini is the only remote SOURCE. NAS is write-only mirror — reading it
  // resurrected deletes when the mirror was stale or another machine hadn't
  // caught up yet (the "delete then reappear" bug).
  const incoming = backend.filter((r) => {
    if (!r?.id) return false
    const id = String(r.id)
    if (isRecordTombstoned(tombstones, r) || localIds.has(id)) return false
    const idk = recoRecordIdentityKey(r)
    return !(idk && localIdentities.has(idk))
  })

  // Remote still has tombstoned rows — purge so the next sync can't resurrect them.
  const remoteStale = backend.filter((r) => isRecordTombstoned(tombstones, r))
  if (remoteStale.length > 0) {
    const staleIds = [...new Set(remoteStale.map((r) => String(r.id)))]
    await Promise.all(staleIds.map((id) => deleteRemoteRecommendation(id)))
    console.log(`[reco] purged ${staleIds.length} tombstoned row(s) still on homemini`)
  }

  const merged = dedupeRecommendationsByIdentity(mergeRecommendationsById(local, incoming))
  if (incoming.length > 0) {
    await writeRecommendationsFile(merged)
    console.log(`[reco] synced ${merged.length} recommendations to local (was ${local.length}, pulled ${incoming.length} new from homemini)`)
  }
  recommendationsSyncedAtMs = Date.now()
  const reconciled = await pushLocalOnlyRecommendations(merged, backendRaw, tombstones)
  return filterTombstoned(reconciled ?? merged)
}

async function recommendationsForSuggest(): Promise<RecommendationRecord[]> {
  const stale = Date.now() - recommendationsSyncedAtMs > RECOMMENDATIONS_SYNC_TTL_MS
  if (!stale && recommendationsSyncedAtMs > 0) {
    return filterTombstoned(await readRecommendationsFile())
  }
  return syncRecommendationsToLocal()
}

async function loadLibraryTracks(): Promise<Array<{ artist?: string; albumArtist?: string; title?: string; genre?: string; playCount?: number }>> {
  try {
    const raw = await readFile(host.libraryPath, 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: Array<{ artist?: string; albumArtist?: string; title?: string; genre?: string; playCount?: number }> }
    return Array.isArray(lib.tracks) ? lib.tracks : []
  } catch {
    return []
  }
}

function rankItunesSuggestions(raw: ItunesSuggestion[]): ItunesSuggestion[] {
  const artistFreq = new Map<string, number>()
  for (const s of raw) {
    const k = s.artist.toLowerCase()
    artistFreq.set(k, (artistFreq.get(k) || 0) + 1)
  }
  const scoreOf = (s: ItunesSuggestion): number => {
    let score = (artistFreq.get(s.artist.toLowerCase()) || 1) * 10
    const album = (s.album || '').toLowerCase()
    const song = s.song.toLowerCase()
    const isLive = /\blive\b|\(live/.test(song) || /\blive\b/.test(album)
    if (!isLive && !/ - single$/.test(album)) score += 4
    if (isLive) score -= 3
    if (/ - single$/.test(album) && album.startsWith(song)) score -= 6
    return score
  }
  return raw
    .map((s, i) => ({ s, i, score: scoreOf(s) }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .slice(0, 10)
    .map((x) => x.s)
}

/** Register all Listen-to-the-List IPC handlers. Call once from index.ts after claudeCall exists. */
export function registerRecommendationsIpc(h: RecommendationsHost): void {
  host = h

  ipcMain.handle('read-recommendations', async (_event, opts?: { forceSync?: boolean }): Promise<{ ok: boolean; recommendations: RecommendationRecord[] }> => {
    if (!opts?.forceSync && readRecoInflight) return readRecoInflight
    readRecoInflight = (async (): Promise<{ ok: boolean; recommendations: RecommendationRecord[] }> => {
      try {
        const forceSync = opts?.forceSync === true
        const stale = Date.now() - recommendationsSyncedAtMs > RECOMMENDATIONS_SYNC_TTL_MS
        const recommendations = (forceSync || stale || recommendationsSyncedAtMs === 0)
          ? await syncRecommendationsToLocal()
          : await filterTombstoned(await readRecommendationsFile())
        return { ok: true, recommendations }
      } catch (err) {
        console.warn('[reco] read/sync failed:', err instanceof Error ? err.message : err)
        return { ok: true, recommendations: [] }
      } finally {
        readRecoInflight = null
      }
    })()
    return readRecoInflight
  })

  ipcMain.handle('add-recommendation', async (_event, input: { song?: string; artist?: string; album?: string; note?: string; source?: RecoSource }): Promise<{ ok: boolean; recommendation?: RecommendationRecord; error?: string; savedLocally?: boolean; deduped?: boolean }> => {
    const trimmed = {
      song: input.song?.trim() || undefined,
      artist: input.artist?.trim() || undefined,
      album: input.album?.trim() || undefined,
      note: input.note?.trim() || undefined,
    }
    if (!trimmed.song && !trimmed.artist && !trimmed.album && !trimmed.note) {
      return { ok: false, error: 'nothing to add' }
    }
    const source: RecoSource = input.source || 'user'

    try {
      const tombstones = await readRecommendationTombstones()
      const existing = (await readRecommendationsFile()).filter((r) => !isRecordTombstoned(tombstones, r))
      const idKey = recoIdentityKey(trimmed.song, trimmed.artist)
      const fullKey = recoMatchKey(trimmed)
      const dupe = existing.find((r) => {
        const rid = recoRecordIdentityKey(r)
        return idKey && rid ? rid === idKey : recoRecordKey(r) === fullKey
      })
      if (dupe) {
        return { ok: true, recommendation: dupe, deduped: true }
      }
    } catch { /* fall through */ }

    await clearRecommendationIdentityTombstone(trimmed.song, trimmed.artist, trimmed.note)

    const url = `${MOBILE_BACKEND_URL}/api/recommendations`
    let recommendation: RecommendationRecord | null = null
    let backendStatus: number | null = null

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trimmed),
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
      }
    } catch (err) {
      console.warn('[reco] POST threw:', err instanceof Error ? err.message : err)
    }

    if (!recommendation?.id) {
      recommendation = await recoverRecommendationFromBackend(trimmed)
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
        suggestResultCache = null
      } catch (err) {
        console.warn('[reco] local append after POST failed:', err instanceof Error ? err.message : err)
      }
      return { ok: true, recommendation }
    }

    try {
      const local = await buildLocalRecommendation(trimmed, source)
      await appendRecommendationLocal(local)
      suggestResultCache = null
      console.log('[reco] saved locally (backend', backendStatus ?? 'unreachable', ') —', local.id)
      return { ok: true, recommendation: local, savedLocally: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'could not save recommendation' }
    }
  })

  ipcMain.handle('delete-recommendation', async (event, id: string): Promise<{ ok: boolean; error?: string }> => {
    const rid = String(id)
    try {
      const all = await readRecommendationsFile()
      const target = all.find((r) => String(r.id) === rid)
      if (!target) {
        // Row already gone locally — still purge homemini in case it lingers there.
        void deleteRemoteRecommendation(rid)
        await addRecommendationTombstones([rid])
        recommendationsSyncedAtMs = 0
        suggestResultCache = null
        return { ok: true }
      }

      // Delete ONLY the confirmed stable id. Text-identity cascade used to
      // wipe every other local/remote row with the same song/artist when
      // the UI confirmed a single item (CLAUDE.md destructive-ops rule).
      // Identity tombstones still block resurrection of the same song.
      const tombstoneEntries = new Set<string>(tombstoneKeysForRecord(target))
      await addRecommendationTombstones([...tombstoneEntries])
      const next = all.filter((r) => String(r.id) !== rid)
      await writeRecommendationsFile(next)
      await deleteRemoteRecommendation(rid)

      recommendationsSyncedAtMs = 0
      suggestResultCache = null
      console.log(`[reco] deleted`, target.song || target.note || rid, `(id ${rid})`)
      return { ok: true }
    } catch (err) {
      console.warn('[reco] local delete failed:', err instanceof Error ? err.message : err)
      await addRecommendationTombstones([rid]).catch(() => {})
      recommendationsSyncedAtMs = 0
      return { ok: false, error: err instanceof Error ? err.message : 'delete failed' }
    }
  })

  ipcMain.handle('suggest-recommendations', async (_event, opts?: { force?: boolean }): Promise<{ ok: boolean; suggestions?: Array<{ song: string; artist: string; note: string }>; error?: string }> => {
    const force = opts?.force === true
    const now = Date.now()
    if (!force && suggestResultCache && now - suggestResultCache.at < SUGGEST_RESULT_TTL_MS) {
      return { ok: true, suggestions: suggestResultCache.suggestions }
    }
    if (!force && suggestRecoInflight) return suggestRecoInflight
    if (force) suggestResultCache = null

    suggestRecoInflight = (async () => {
      try {
        const tracks = await loadLibraryTracks()
        const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        const playsByArtist = new Map<string, number>()
        const playsByGenre = new Map<string, number>()
        const ownedArtists = new Set<string>()
        const ownedSongs = new Set<string>()
        for (const t of tracks) {
          const a = (t.albumArtist || t.artist || '').trim()
          if (a) {
            playsByArtist.set(a, (playsByArtist.get(a) ?? 0) + (Number(t.playCount) || 0))
            ownedArtists.add(norm(a))
            if (t.title) ownedSongs.add(`${norm(a)}|${norm(t.title)}`)
          }
          const g = (t.genre || '').trim()
          if (g) playsByGenre.set(g, (playsByGenre.get(g) ?? 0) + 1)
        }
        const topArtists = Array.from(playsByArtist.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([a]) => a)
        const topGenres = Array.from(playsByGenre.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g)

        let existing: string[] = []
        const listSongs = new Set<string>()
        try {
          const parsed = await recommendationsForSuggest()
          existing = parsed
            .map((r) => `${r.song || r.matchedTitle || ''} — ${r.artist || r.matchedArtist || ''}`.trim())
            .filter((s) => s.length > 2)
            .slice(0, 50)
          for (const r of parsed) {
            const a = norm(String(r.artist || r.matchedArtist || ''))
            const t = norm(String(r.song || r.matchedTitle || ''))
            if (a && t) listSongs.add(`${a}|${t}`)
          }
        } catch { /* no list yet */ }

        const passesFilter = (s: { song: string; artist: string }) => {
          const key = `${norm(s.artist)}|${norm(s.song)}`
          return !ownedArtists.has(norm(s.artist)) && !ownedSongs.has(key) && !listSongs.has(key)
        }

        const accumulated: Array<{ song: string; artist: string; note: string }> = []
        const seenKeys = new Set<string>()
        const bannedArtists = new Set<string>(topArtists.map((a) => a.toLowerCase().trim()))

        for (let attempt = 0; attempt < 4 && accumulated.length < 3; attempt++) {
          const excludeArtists = Array.from(bannedArtists).slice(0, 80)
          const excludePicked = accumulated.map((s) => s.artist)
          const user = [
            `Artists this person ALREADY OWNS and loves: ${topArtists.join(', ') || '(unknown)'}.`,
            topGenres.length ? `Genres in rotation: ${topGenres.join(', ')}.` : '',
            existing.length ? `Already on their Listen-to-the-List: ${existing.join('; ')}.` : '',
            excludeArtists.length ? `NEVER suggest these artists (owned, on-list, or already rejected): ${excludeArtists.join(', ')}.` : '',
            excludePicked.length ? `Already picked this round — do NOT repeat: ${excludePicked.join(', ')}.` : '',
            attempt > 0 ? 'Your last batch was mostly artists they already own. Dig deeper — smaller labels, regional scenes, one-album wonders.' : '',
            '',
            'This is a DISCOVERY list. Suggest 20 records they almost certainly do NOT own yet — artists NEW to this collection that sit in the lineage of, or just adjacent to, what they love.',
            'Each: a real song + the artist + a one-sentence note in your voice on why it\'s the right next step for them.',
            'CRITICAL: song + artist must be a real recording on Apple Music/iTunes.',
            'Return ONLY JSON, no prose, no code fence: an array of 20 objects [{"song":"...","artist":"...","note":"..."}, ...].',
          ].filter(Boolean).join('\n')

          const reply = await host.claudeCall(`listen-list:suggest:${attempt}`, {
            model: 'claude-sonnet-4-6',
            max_tokens: 1200,
            system: host.musicManCore,
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

        const suggestions = accumulated.slice(0, 10)
        suggestResultCache = { at: Date.now(), suggestions }
        return { ok: true, suggestions }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'suggest failed' }
      } finally {
        suggestRecoInflight = null
      }
    })()
    return suggestRecoInflight
  })

  ipcMain.handle('search-itunes', async (_event, query: string): Promise<{ ok: boolean; results: ItunesSuggestion[] }> => {
    const q = (query || '').trim()
    if (q.length < 2) return { ok: true, results: [] }
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=25`
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) return { ok: false, results: [] }
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> }
      const raw: ItunesSuggestion[] = (data.results || [])
        .map((r) => ({
          song: String(r.trackName ?? ''),
          artist: String(r.artistName ?? ''),
          album: r.collectionName ? String(r.collectionName) : undefined,
          artworkUrl: r.artworkUrl100 ? String(r.artworkUrl100).replace('100x100', '200x200') : undefined,
          previewUrl: r.previewUrl ? String(r.previewUrl) : undefined,
          appleMusicUrl: r.trackViewUrl ? String(r.trackViewUrl) : undefined,
        }))
        .filter((s) => s.song && s.artist && !RECO_ITUNES_JUNK.test(s.artist) && !RECO_ITUNES_JUNK.test(s.album || ''))
      return { ok: true, results: rankItunesSuggestions(raw) }
    } catch {
      return { ok: false, results: [] }
    }
  })

  ipcMain.handle('lookup-reco-artwork', async (_event, input: { artist?: string; title?: string }) => {
    const artist = (input?.artist || '').trim()
    const title = (input?.title || '').trim()
    if (!artist && !title) return {}
    const hit = await lookupItunesForRecommendation({ song: title, artist })
    return { artworkUrl: hit.artworkUrl, previewUrl: hit.previewUrl }
  })
}

/** Warm-sync recommendations from homemini on app boot. */
export async function warmRecommendationsSync(): Promise<void> {
  if (!host) return
  try {
    await syncRecommendationsToLocal()
  } catch (err) {
    console.warn('[reco] warm sync failed:', err instanceof Error ? err.message : err)
  }
}

/** Identity keys for active recommendations — used by Discovery Brain to skip list dupes. */
export async function getActiveRecommendationIdentityKeys(): Promise<Set<string>> {
  const tombstones = await readRecommendationTombstones()
  const recos = (await readRecommendationsFile()).filter((r) => !isRecordTombstoned(tombstones, r))
  const keys = new Set<string>()
  for (const r of recos) {
    const k = recoRecordIdentityKey(r)
    if (k) keys.add(k)
  }
  return keys
}
