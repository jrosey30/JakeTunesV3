/**
 * The Record Shop's banner when the exact edition isn't there (Record Shop
 * Phase 4, Jake's approved picture, 2026-11-24): the moment an album saved
 * from Search is refused, one plain line across the top of the results, "The
 * Deluxe of Animals isn’t on Qobuz. The Standard (5 songs) is.", and one
 * button, "Save the Standard". Nothing is taken until it is pressed (Jake,
 * 2026-11-19: "ask, with one tap"). The other offers stay where they were:
 * the album page, and Downloads under Needs you.
 *
 * Which refusal: the newest album save from Search refused in the last ten
 * minutes, with an offer, not yet taken and not waved away. Pure.
 */
import { panelRowFor, type PanelQueueItem } from './downloads-panel-model.ts'
import { offerBanner, offerButton, offerTitle, type ShopOffer } from './closest-edition.ts'
import { recordName } from './shop-card-edition.ts'

/** A refusal older than this is Downloads' to show, not the banner's. */
export const BANNER_WINDOW_MS = 10 * 60_000

export interface ShopBanner {
  /** The refused job (the offer is taken on it). */
  key: string
  /** This refusal, for ✕: the job and when it ended, so a later refusal of the same edition still shows. */
  refusal: string
  /** When the banner goes by itself: the refusal's end plus the window. */
  until: number
  /** The record, so the banner steps aside while its own album page (with the same offers) is open. */
  artist: string
  album: string
  collectionId?: number
  line: string
  button: string
  /** The differences, for the button's tooltip. */
  title: string
  offer: ShopOffer
}

type BannerItem = PanelQueueItem & { result: PanelQueueItem['result'] & { surface?: string } }

/** A refusal's own name for ✕: the job and when it ended. */
export const refusalKey = (key: string, endedAt: number): string => `${key}@${endedAt}`

/**
 * `since`: refusals that ended before this (the window's load) are not shown:
 * a reload doesn't bring back a banner already seen or waved away. Downloads
 * still has them.
 */
export function shopBanner(items: readonly BannerItem[], now: number, dismissed: ReadonlySet<string> = new Set(), since = 0): ShopBanner | null {
  let best: { q: BannerItem; offer: ShopOffer; endedAt: number } | null = null
  for (const q of items) {
    if (q.result.mediaType !== 'album' || q.result.surface !== 'search') continue
    const endedAt = q.endedAt
    if (endedAt == null || endedAt < since || now - endedAt > BANNER_WINDOW_MS || endedAt > now) continue
    if (dismissed.has(refusalKey(q.key, endedAt))) continue
    const offer = panelRowFor(q, now).offers[0]
    if (!offer) continue
    if (!best || endedAt > best.endedAt) best = { q, offer, endedAt }
  }
  if (!best) return null
  const { q, offer, endedAt } = best
  const pa = q.preflightAnswer?.answer === 'no' ? q.preflightAnswer : null
  // The record by its own name: the edition is said in the line ("The Deluxe of Animals").
  const album = recordName((q.result.album || q.result.desc || '').trim())
  return {
    key: q.key,
    refusal: refusalKey(q.key, endedAt),
    until: endedAt + BANNER_WINDOW_MS,
    artist: (q.result.artist || '').trim(),
    album,
    ...(q.result.collectionId ? { collectionId: q.result.collectionId } : {}),
    line: offerBanner(offer, { album, asked: pa?.asked, askedCount: pa?.askedCount }),
    button: offerButton(offer, { asked: pa?.asked }),
    title: offerTitle(offer),
    offer,
  }
}

/** Whether an open album page is this banner's record (its page shows the same offers). */
export function bannerIsForPage(b: Pick<ShopBanner, 'artist' | 'album' | 'collectionId'>, page: { artist: string; name: string; collectionId?: number } | null): boolean {
  if (!page) return false
  if (b.collectionId && page.collectionId) return b.collectionId === page.collectionId
  const k = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return k(b.artist) === k(page.artist) && k(b.album) === k(recordName(page.name))
}
