/**
 * The banner at the top of the Search tab when an album saved there can't be
 * had in its exact edition (Record Shop Phase 4; the rule is
 * common/shop-banner.ts): one line, one button that takes the offer, and ✕.
 * It steps aside while that album's own page is open (the page has the same
 * buttons), goes by itself ten minutes after the refusal, and a reload never
 * brings back one from before it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getQueue, subscribeQueue } from './downloadQueue'
import { takeOffer } from './shopOffers'
import { bannerIsForPage, shopBanner } from '../../../common/shop-banner'

/** Waved away, by refusal (job and when it ended). */
const dismissed = new Set<string>()
/** Refusals that ended before this window loaded are Downloads' to show. */
const LOADED_AT = Date.now()

export default function ShopBanner({ openAlbum }: { openAlbum: { artist: string; name: string; collectionId?: number } | null }) {
  const queue = useSyncExternalStore(subscribeQueue, getQueue)
  const [, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const b = shopBanner(queue, Date.now(), dismissed, LOADED_AT)
  // Gone by itself when its ten minutes are up, counted from the refusal.
  useEffect(() => {
    if (!b) return
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, b.until - Date.now()) + 50)
    return () => clearTimeout(t)
  }, [b?.refusal, b?.until])
  if (!b || bannerIsForPage(b, openAlbum)) return null
  return (
    <div className="shop-banner" role="status">
      <span className="shop-banner-line">{b.line}</span>
      <button
        type="button"
        className="shop-banner-btn"
        disabled={busy}
        title={b.title}
        onClick={() => { setBusy(true); void takeOffer(b.key, b.offer).finally(() => setBusy(false)) }}
      >{b.button}</button>
      <button type="button" className="shop-banner-close" aria-label="Not now" title="Not now" onClick={() => { dismissed.add(b.refusal); setTick((n) => n + 1) }}>✕</button>
    </div>
  )
}
