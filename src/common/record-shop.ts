/** Record Shop domain v1. Data only; main owns verification and acquisition.
 * The regular shop and Step Inside must consume these same values.
 * Persistence/IPC and the legacy queues are migrated in a separate slice.
 */
import type { Alternative, DownloadOutcome, RequestedAlbum, RequestedRecording } from './acquisition-identity.ts'

export type Snapshot<T> = T extends object ? { readonly [K in keyof T]: Snapshot<T[K]> } : T

export type ShopSelection =
  | { kind: 'recording'; revision: string; request: RequestedRecording }
  | { kind: 'release'; revision: string; request: RequestedAlbum }

export interface ShopDisplay {
  title: string
  artist?: string
  artworkUrl?: string
  /** A browse link from the source; not proof of cross-provider identity. */
  catalogueUrl?: string
  /** An album preview names the hook track, never the whole album. */
  preview?: { url: string; trackTitle: string }
}

type ItemBase = { itemId: string; display: ShopDisplay }
export type ShopItem = ItemBase & (
  | { kind: 'recording'; selection?: Extract<ShopSelection, { kind: 'recording' }> }
  | { kind: 'release'; selection?: Extract<ShopSelection, { kind: 'release' }> }
  | { kind: 'artist' | 'note'; selection?: never }
  | { kind: 'concert'; externalId?: string; selection?: never }
)

export interface RecommendationSource {
  /** Catalogue/download provider is deliberately not a recommendation source. */
  kind: 'ai' | 'person' | 'radio' | 'user' | 'unknown'
  id?: string
  name?: string
  legacySource?: 'user' | 'mm' | 'radar'
}

export interface ShopRecommendation {
  recommendationId: string
  itemId: string
  source: RecommendationSource
  reason?: string
  becauseArtist?: string
  lane?: string
  receivedAt: string
}

export interface ShopListEntry {
  /** Keep the existing recommendation UUID; never derive it from a title. */
  entryId: string
  savedAt: string
  note?: string
  item: Snapshot<ShopItem>
  recommendations: readonly Snapshot<ShopRecommendation>[]
  /** Historical fulfillment hint; never promoted to an ownership assessment. */
  legacyFulfillment?: { owned?: boolean; ownedAt?: string; ownedVia?: string; ownedDesc?: string }
  legacyResolution?: { title?: string; artist?: string; album?: string; resolvedAt?: string }
}

export type ShopOwnership =
  | { status: 'unknown' }
  | {
    status: 'none' | 'partial' | 'complete'
    selectionRevision: string
    libraryRevision: string
    expected: number
    owned: number
    matches: readonly { position: number; libraryTrackId: number }[]
  }

export interface ShopAcquisitionResult {
  ok: boolean
  outcome?: DownloadOutcome
  imported?: number
  alreadyOwned?: number
  expected?: number
  missing?: number
  completion?: string
  primary?: string
  detail?: string
  error?: string
  alternatives?: readonly Alternative[]
}

export interface ShopAcquisitionJob {
  jobId: string
  itemId: string
  entryId: string
  recommendationIds: readonly string[]
  selection: Snapshot<ShopSelection>
  attempt: number
  createdAt: string
  status: 'queued' | 'downloading' | 'done' | 'failed' | 'canceled'
  result?: ShopAcquisitionResult
}

export interface ShopShelf {
  shelfId: string
  title: string
  itemIds: readonly string[]
  recommendationIds: readonly string[]
  source?: RecommendationSource
  generatedAt?: string
  stale?: boolean
}

/** Clone before freezing: view enrichment must not mutate a saved selection,
 * and freezing must not freeze the caller's catalogue/cache objects. */
export function shopSnapshot<T extends object>(value: T): Snapshot<T> {
  const copy = structuredClone(value)
  const freeze = (v: object): void => {
    for (const child of Object.values(v)) if (child && typeof child === 'object') freeze(child)
    Object.freeze(v)
  }
  freeze(copy)
  return copy as Snapshot<T>
}

export function saveShopItem(input: {
  entryId: string; savedAt: string; item: ShopItem; note?: string
  recommendations?: ShopRecommendation[]
}): Snapshot<ShopListEntry> {
  if (!input.entryId || !input.item.itemId) throw new Error('A saved item requires stable ids')
  const recommendations = input.recommendations ?? []
  if (recommendations.some((r) => r.itemId !== input.item.itemId)) throw new Error('Recommendation belongs to another item')
  return shopSnapshot({
    entryId: input.entryId, savedAt: input.savedAt, note: input.note,
    item: input.item, recommendations,
  })
}

export type ShopJobDraft =
  | { ok: true; job: Snapshot<ShopAcquisitionJob> }
  | { ok: false; reason: 'select-recording' | 'select-edition' | 'browse-only' }

/** Draft only: never enqueues or downloads. Main must still judge candidates. */
export function draftShopJob(entry: Snapshot<ShopListEntry>, jobId: string, createdAt: string): ShopJobDraft {
  const item = entry.item
  if (item.kind !== 'recording' && item.kind !== 'release') return { ok: false, reason: 'browse-only' }
  if (!item.selection) return { ok: false, reason: item.kind === 'release' ? 'select-edition' : 'select-recording' }
  if (!jobId || !item.selection.revision) throw new Error('A job requires a stable id and selection revision')
  return { ok: true, job: shopSnapshot({
    jobId, itemId: item.itemId, entryId: entry.entryId,
    recommendationIds: entry.recommendations.map((r) => r.recommendationId),
    selection: item.selection, attempt: 1, createdAt, status: 'queued' as const,
  }) }
}

export function retryShopJob(job: Snapshot<ShopAcquisitionJob>, createdAt: string): Snapshot<ShopAcquisitionJob> {
  if (job.status !== 'failed' && job.status !== 'canceled') throw new Error('Only failed or canceled jobs can be retried')
  return shopSnapshot({ ...job, attempt: job.attempt + 1, createdAt, status: 'queued' as const, result: undefined })
}
