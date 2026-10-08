/** Pure adapters for the next shop/queue migration. No matcher, I/O or effects. */
import { shopSnapshot, type ShopItem, type ShopListEntry, type ShopRecommendation, type Snapshot, type ShopSelection, type ShopAcquisitionResult } from './record-shop.ts'
import type { Alternative, DownloadOutcome } from './acquisition-identity.ts'

/** Structural subset of today's renderer Recommendation; legacy sync unchanged. */
export interface LegacyShopRecommendation {
  id: string; song?: string; artist?: string; album?: string; note?: string; createdAt: string
  artworkUrl?: string; previewUrl?: string
  appleMusicUrl?: string; matchedTitle?: string; matchedArtist?: string; matchedAlbum?: string; resolvedAt?: string
  source?: 'user' | 'mm' | 'radar'
  kind?: 'track' | 'album' | 'concert'; externalId?: string
  owned?: boolean; ownedAt?: string; ownedVia?: string; ownedDesc?: string
}

/** A legacy jot carries hints, not a selected catalogue edition. Even an owned
 * jot stays unresolved; main's ownership assessment is the authority. */
export function shopEntryFromLegacy(rec: LegacyShopRecommendation): Snapshot<ShopListEntry> {
  const kind = rec.kind === 'concert' ? 'concert' : rec.kind === 'album' ? 'release'
    : rec.kind === 'track' || rec.song ? 'recording' : rec.album ? 'release' : rec.artist ? 'artist' : 'note'
  const item: ShopItem = {
    itemId: `legacy-recommendation:${rec.id}`, kind,
    display: { title: rec.song || rec.album || rec.artist || rec.note || '', artist: rec.artist, artworkUrl: rec.artworkUrl, catalogueUrl: rec.appleMusicUrl,
      preview: rec.previewUrl && rec.song ? { url: rec.previewUrl, trackTitle: rec.song } : undefined },
    ...(kind === 'concert' ? { externalId: rec.externalId } : {}),
  }
  return shopSnapshot({
    entryId: rec.id, savedAt: rec.createdAt, note: rec.note, item,
    recommendations: [{
      recommendationId: rec.id, itemId: item.itemId, receivedAt: rec.createdAt,
      source: { kind: rec.source === 'mm' || rec.source === 'radar' ? 'ai' : rec.source === 'user' ? 'user' : 'unknown', legacySource: rec.source },
    }],
    legacyFulfillment: { owned: rec.owned, ownedAt: rec.ownedAt, ownedVia: rec.ownedVia, ownedDesc: rec.ownedDesc },
    legacyResolution: { title: rec.matchedTitle, artist: rec.matchedArtist, album: rec.matchedAlbum, resolvedAt: rec.resolvedAt },
  })
}

export interface ShopFeedCard {
  type: 'song' | 'album' | 'artist'; artist: string; title: string
  why: string; lane: string; because?: string; artUrl?: string
  previewUrl?: string; hookPreviewUrl?: string; hookTitle?: string
}

/** Caller supplies stable entry ids; artist/title are not cross-provider ids. */
export function shopItemFromFeed(card: ShopFeedCard, ids: { itemId: string; recommendationId: string; receivedAt: string }): {
  item: ShopItem; recommendation: ShopRecommendation
} {
  const preview = card.type === 'song' && card.previewUrl ? { url: card.previewUrl, trackTitle: card.title }
    : card.type === 'album' && card.hookPreviewUrl && card.hookTitle ? { url: card.hookPreviewUrl, trackTitle: card.hookTitle } : undefined
  return {
    item: { itemId: ids.itemId, kind: card.type === 'song' ? 'recording' : card.type === 'album' ? 'release' : 'artist',
      display: { title: card.title, artist: card.artist, artworkUrl: card.artUrl, preview } },
    recommendation: { recommendationId: ids.recommendationId, itemId: ids.itemId, receivedAt: ids.receivedAt,
      source: { kind: 'ai', legacySource: 'radar' }, reason: card.why, becauseArtist: card.because, lane: card.lane },
  }
}

/** Called after an explicit catalogue selection, built by main's existing
 * identity builders. This does not infer a selection from a feed title. */
export function shopItemWithSelection(item: ShopItem, selection: ShopSelection): ShopItem {
  if (item.kind !== selection.kind) throw new Error('Selection kind does not match the shop item')
  const copy = structuredClone(item)
  return selection.kind === 'release'
    ? { ...copy, kind: 'release', selection: structuredClone(selection) }
    : { ...copy, kind: 'recording', selection: structuredClone(selection) }
}

/** Preserve backend truth. Missing fields stay unknown, never guessed from the
 * album title, queue item count, or a successful transfer. */
export function shopResultFromDownload(result: {
  ok: boolean; outcome?: DownloadOutcome; imported?: number; dupes?: number
  expected?: number; missing?: number; completion?: string
  primary?: string; detail?: string; error?: string; alternatives?: Alternative[]
}): ShopAcquisitionResult {
  return structuredClone({
    ok: result.ok, outcome: result.outcome, imported: result.imported, alreadyOwned: result.dupes,
    expected: result.expected, missing: result.missing, completion: result.completion,
    primary: result.primary, detail: result.detail, error: result.error, alternatives: result.alternatives,
  })
}
