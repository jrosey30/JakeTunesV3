/**
 * The banner at the top of the Search tab when an album saved there can't be
 * had in its exact edition (Record Shop Phase 4; the rule is
 * common/shop-banner.ts): one line, one button that takes the offer, and ✕.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getQueue, subscribeQueue } from './downloadQueue'
import { takeOffer } from './shopOffers'
import { shopBanner, BANNER_WINDOW_MS } from '../../../common/shop-banner'

/** Waved away this session. */
const dismissed = new Set<string>()

export default function ShopBanner() {
  const queue = useSyncExternalStore(subscribeQueue, getQueue)
  const [, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const b = shopBanner(queue, Date.now(), dismissed)
  // Gone by itself once the refusal is older than the window.
  useEffect(() => {
    if (!b) return
    const t = setTimeout(() => setTick((n) => n + 1), BANNER_WINDOW_MS)
    return () => clearTimeout(t)
  }, [b?.key])
  if (!b) return null
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
      <button type="button" className="shop-banner-close" aria-label="Not now" title="Not now" onClick={() => { dismissed.add(b.key); setTick((n) => n + 1) }}>✕</button>
    </div>
  )
}
