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

/** A refusal older than this is Downloads' to show, not the banner's. */
export const BANNER_WINDOW_MS = 10 * 60_000

export interface ShopBanner {
  /** The refused job (the offer is taken on it). */
  key: string
  line: string
  button: string
  /** The differences, for the button's tooltip. */
  title: string
  offer: ShopOffer
}

type BannerItem = PanelQueueItem & { result: PanelQueueItem['result'] & { surface?: string } }

export function shopBanner(items: readonly BannerItem[], now: number, dismissed: ReadonlySet<string> = new Set()): ShopBanner | null {
  let best: { q: BannerItem; offer: ShopOffer } | null = null
  for (const q of items) {
    if (q.result.mediaType !== 'album' || q.result.surface !== 'search' || dismissed.has(q.key)) continue
    if (q.endedAt == null || now - q.endedAt > BANNER_WINDOW_MS || q.endedAt > now) continue
    const offer = panelRowFor(q, now).offers[0]
    if (!offer) continue
    if (!best || (q.endedAt ?? 0) > (best.q.endedAt ?? 0)) best = { q, offer }
  }
  if (!best) return null
  const { q, offer } = best
  const pa = q.preflightAnswer?.answer === 'no' ? q.preflightAnswer : null
  const album = (q.result.album || q.result.desc || '').trim()
  return {
    key: q.key,
    line: offerBanner(offer, { album, asked: pa?.asked, askedCount: pa?.askedCount }),
    button: offerButton(offer, { asked: pa?.asked }),
    title: offerTitle(offer),
    offer,
  }
}
