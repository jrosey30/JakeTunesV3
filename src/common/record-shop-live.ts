/**
 * Record Shop — the LIVE session, composed from what already exists:
 * the Listen List (saved items + who recommended them), the one Downloads
 * scheduler (jobs and their results), and main's ownership verdicts by
 * recording identity. Pure: no window, no IPC, no React — the renderer
 * hook feeds it and every presentation reads the same answer.
 *
 * Ids: a live item is `legacy-recommendation:<list uuid>`; a fixture item
 * is `fx:…`. The two never meet — live commands refuse fixture ids.
 */
import type { RequestedAlbum, RequestedRecording, DownloadOutcome, Alternative, Provider } from './acquisition-identity.ts'
import { shopSnapshot, type ShopItem, type ShopSelection, type ShopSession, type ShopAcquisitionJob, type ShopOwnership, type ShopListEntry, type ShopRecommendation, type Snapshot } from './record-shop.ts'
import { shopEntryFromLegacy, shopResultFromDownload, type LegacyShopRecommendation } from './record-shop-adapters.ts'

export const LIVE_ITEM_PREFIX = 'legacy-recommendation:'
export const FIXTURE_ID_PREFIX = 'fx:'
export const isFixtureId = (id: string): boolean => String(id).startsWith(FIXTURE_ID_PREFIX)
export const liveItemId = (recommendationId: string): string => `${LIVE_ITEM_PREFIX}${recommendationId}`
export const recommendationIdOf = (itemId: string): string | null => itemId.startsWith(LIVE_ITEM_PREFIX) ? itemId.slice(LIVE_ITEM_PREFIX.length) : null

/** Structural twin of the scheduler's QueueOrigin / QResult / QItem — the
 *  fields the shop reads. Kept structural so common never imports renderer. */
export interface QueueOriginLike { recommendationIds: readonly string[]; entryId?: string; sourceKind?: string; sourceLabel?: string }
export interface QueueResultLike {
  source: string; mediaType: string; id: string; desc: string; kind?: 'id' | 'query'; origin?: QueueOriginLike
  artist?: string; title?: string; album?: string; durationMs?: number; releaseYear?: number; collectionId?: number; trackCount?: number
}
export interface QueueItemLike {
  key: string; result: QueueResultLike; status: 'queued' | 'downloading' | 'done' | 'failed' | 'canceled'; attempt?: number
  imported?: number; dupes?: number; error?: string; outcome?: string
  alternatives?: ReadonlyArray<{ provider: string; desc: string; reason: string }>
  primary?: string; detail?: string; completion?: string; matchDesc?: string; startedAt?: number; endedAt?: number
}

const norm = (s: string): string => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** A song jot is its own selection: the regular shop queues it by artist +
 *  title and main proves the recording. Revision keys on the jot. */
export function recordingSelectionFromJot(rec: Pick<LegacyShopRecommendation, 'id' | 'artist' | 'song' | 'album' | 'matchedArtist' | 'matchedTitle' | 'matchedAlbum'>): Extract<ShopSelection, { kind: 'recording' }> | undefined {
  const artist = (rec.matchedArtist || rec.artist || '').trim(), title = (rec.matchedTitle || rec.song || '').trim(), album = (rec.matchedAlbum || rec.album || '').trim()
  if (!title) return undefined
  const request: RequestedRecording = { artist, title, album, artistNorm: norm(artist), titleNorm: norm(title), durationSec: 0, durationTolSec: 5, explicit: 'unknown', requestedMarkers: [], providerIds: {} }
  return { kind: 'recording', revision: `jot:${rec.id}`, request }
}

/** The edition or recording a queued job is FOR, read off its query. An
 *  album job carries the iTunes collection id Jake chose in the Download
 *  view — that choice is the selection. No tracklist here; main's resolve
 *  fills it for Inspect and ownership. */
export function selectionFromQueueResult(r: QueueResultLike): ShopSelection | undefined {
  if (r.kind !== 'query') return undefined
  const artist = (r.artist || '').trim()
  if (r.mediaType === 'album') {
    const title = (r.album || '').trim(); if (!title) return undefined
    const request: RequestedAlbum = { artist, title, baseTitle: title, packaging: [], versionMarkers: [], trackCount: r.trackCount, tracks: [], releaseYear: r.releaseYear, explicit: 'unknown', providerIds: { itunesCollectionId: r.collectionId } }
    return { kind: 'release', revision: r.collectionId ? `itunes:collection:${r.collectionId}` : `queue:${r.id}`, request }
  }
  if (r.mediaType === 'track') {
    const title = (r.title || '').trim(); if (!title) return undefined
    const request: RequestedRecording = { artist, title, album: (r.album || '').trim(), artistNorm: norm(artist), titleNorm: norm(title), durationSec: r.durationMs ? Math.round(r.durationMs / 1000) : 0, durationTolSec: 5, releaseYear: r.releaseYear, explicit: 'unknown', requestedMarkers: [], providerIds: {} }
    return { kind: 'recording', revision: `queue:${r.id}`, request }
  }
  return undefined
}

/** One scheduler job → one shop job. jobId IS the queue key, so cancel /
 *  retry from any presentation address the same job. */
export function jobFromQueueItem(q: QueueItemLike, item: Snapshot<ShopItem> | ShopItem, entryId: string, now: string): Snapshot<ShopAcquisitionJob> {
  const selection = (item.kind === 'release' || item.kind === 'recording') && item.selection ? item.selection : selectionFromQueueResult(q.result)
  const finished = q.status === 'done' || q.status === 'failed'
  const result = finished
    ? shopResultFromDownload({ ok: q.status === 'done', outcome: (q.outcome ?? (q.status === 'done' ? 'imported' : undefined)) as DownloadOutcome | undefined, imported: q.imported, dupes: q.dupes, completion: q.completion, primary: q.primary, detail: q.detail, error: q.error, alternatives: q.alternatives ? q.alternatives.map((a): Alternative => ({ provider: a.provider as Provider, desc: a.desc, reason: a.reason })) : undefined })
    : undefined
  return shopSnapshot({
    jobId: q.key, itemId: item.itemId, entryId,
    recommendationIds: [...(q.result.origin?.recommendationIds ?? [])],
    selection: selection as ShopSelection,
    attempt: q.attempt ?? 1,
    createdAt: q.startedAt ? new Date(q.startedAt).toISOString() : now,
    status: q.status, result,
  })
}

/** The scheduler entry a selected item becomes. Ids come from the
 *  scheduler's own builders (injected, so this stays a mirror of the
 *  Download view's Get and never a second implementation). */
export function queueResultForSelection(
  item: Snapshot<ShopItem>, origin: QueueOriginLike,
  ids: { track: (artist: string, title: string) => string; album: (artist: string, album: string) => string },
): QueueResultLike | undefined {
  if (item.kind === 'release' && item.selection) {
    const r = item.selection.request
    return { kind: 'query', source: 'qobuz', mediaType: 'album', id: ids.album(r.artist, r.title), desc: `${r.title} — ${r.artist} (album)`, artist: r.artist, album: r.title, collectionId: r.providerIds.itunesCollectionId, trackCount: r.trackCount, releaseYear: r.releaseYear, origin: { ...origin, recommendationIds: [...origin.recommendationIds] } }
  }
  if (item.kind === 'recording' && item.selection) {
    const r = item.selection.request
    return { kind: 'query', source: 'qobuz', mediaType: 'track', id: ids.track(r.artist, r.title), desc: `${r.title} — ${r.artist}`, artist: r.artist, title: r.title, album: r.album || undefined, durationMs: r.durationSec ? r.durationSec * 1000 : undefined, releaseYear: r.releaseYear, origin: { ...origin, recommendationIds: [...origin.recommendationIds] } }
  }
  return undefined
}

/** What main is asked to resolve for an item: the tracklist behind a chosen
 *  edition (by the id Jake picked) or, for an unselected record, the edition
 *  that answers to its name — for INSPECTING ownership, never a choice made
 *  on his behalf. */
export type ShopResolveRequest =
  | { kind: 'release'; artist: string; album: string; collectionId?: number; trackCount?: number; releaseYear?: number }
  | { kind: 'recording'; artist: string; title: string; album?: string; durationSec?: number }
export type ShopResolveResult =
  | { ok: true; selection: Snapshot<ShopSelection>; ownership: Snapshot<ShopOwnership>; libraryRevision: string }
  | { ok: false; error: string }

export function resolveRequestFor(item: Snapshot<ShopItem>, rec: LegacyShopRecommendation | undefined): ShopResolveRequest | null {
  const artist = (rec?.matchedArtist || rec?.artist || item.display.artist || '').trim()
  if (item.kind === 'release') {
    const sel = item.selection
    const album = (sel?.request.title || rec?.matchedAlbum || rec?.album || item.display.title || '').trim()
    if (!album) return null
    return { kind: 'release', artist: sel?.request.artist || artist, album, collectionId: sel?.request.providerIds.itunesCollectionId, trackCount: sel?.request.trackCount, releaseYear: sel?.request.releaseYear }
  }
  if (item.kind === 'recording') {
    const sel = item.selection
    const title = (sel?.request.title || rec?.matchedTitle || rec?.song || item.display.title || '').trim()
    if (!title) return null
    return { kind: 'recording', artist: sel?.request.artist || artist, title, album: sel?.request.album || rec?.matchedAlbum || rec?.album || undefined, durationSec: sel?.request.durationSec || undefined }
  }
  return null
}

export interface ResolvedShopItem {
  /** The item's selection revision at the time main was asked — a verdict is only ever shown for that. */
  forRevision?: string
  selection?: Snapshot<ShopSelection>; ownership?: Snapshot<ShopOwnership>; libraryRevision?: string; error?: string; at: number
}

/** Compose the live session. Selection precedence: the job's chosen edition
 *  (Jake picked it) > a song jot's own identity > nothing (a record whose
 *  edition is still to be chosen). Ownership is attached only when its
 *  verdict was made for the item's current selection revision — one
 *  coherent state per card, never a verdict about some other edition. */
export function shopSessionFromLive(input: { recs: readonly LegacyShopRecommendation[]; queue: readonly QueueItemLike[]; resolved: Readonly<Record<string, ResolvedShopItem>>; now: string }): ShopSession {
  const items: Snapshot<ShopItem>[] = []
  const entries: Snapshot<ShopListEntry>[] = []
  const recommendations: Snapshot<ShopRecommendation>[] = []
  const ownership: Record<string, Snapshot<ShopOwnership>> = {}
  const jobs: Record<string, Snapshot<ShopAcquisitionJob>> = {}
  for (const rec of input.recs) {
    const entry = shopEntryFromLegacy(rec)
    const base = structuredClone(entry.item) as ShopItem
    const q = input.queue.find((x) => x.result.origin?.recommendationIds.includes(rec.id))
    const res = input.resolved[base.itemId]
    if (base.kind === 'release' || base.kind === 'recording') {
      const fromQueue = q ? selectionFromQueueResult(q.result) : undefined
      let selection: ShopSelection | undefined = fromQueue && fromQueue.kind === base.kind ? fromQueue : undefined
      if (!selection && base.kind === 'recording') selection = recordingSelectionFromJot(rec)
      // The resolved copy of the SAME selection carries the tracklist / runtime; the item keeps its own revision.
      if (selection && res?.selection && res.forRevision === selection.revision && res.selection.kind === selection.kind) selection = { ...(structuredClone(res.selection) as ShopSelection), revision: selection.revision } as ShopSelection
      if (selection) (base as Extract<ShopItem, { kind: 'release' | 'recording' }>).selection = selection as never
    }
    const item = shopSnapshot(base)
    const own = res?.ownership
    const selRev = (item.kind === 'release' || item.kind === 'recording') ? item.selection?.revision : undefined
    ownership[item.itemId] = own && own.status !== 'unknown' && selRev && res?.forRevision === selRev ? { ...own, selectionRevision: selRev } : { status: 'unknown' }
    if (q) jobs[item.itemId] = jobFromQueueItem(q, item, entry.entryId, input.now)
    items.push(item)
    entries.push(shopSnapshot({ ...structuredClone(entry), item }))
    recommendations.push(...entry.recommendations)
  }
  return { items, entries, recommendations, ownership, jobs, shelves: [] }
}
