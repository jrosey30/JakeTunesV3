/**
 * The one-tap offers on a refused album (Brief 257): the question, and a
 * button per offer. Shown in Downloads' Needs you (the fix this module
 * registers in NeedsYouSlot, the panel's one place for it) and on the For You
 * card, Listen List row or shop album page the save came from. Nothing is
 * taken until a button is pressed.
 */
import { useState, useSyncExternalStore } from 'react'
import { getQueue, subscribeQueue } from './downloadQueue'
import { takeOffer } from './shopOffers'
import { panelRowFor } from '../../../common/downloads-panel-model'
import { offerButton, offerTitle, type ShopOffer } from '../../../common/closest-edition'
import { setNeedsYouFix, type NeedsYouFixProps } from '../../components/NeedsYouSlot'
import '../../styles/shop-offer.css'

export default function OfferButtons({ jobKey, compact, className }: { jobKey: string | undefined; compact?: boolean; className?: string }) {
  const queue = useSyncExternalStore(subscribeQueue, getQueue)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const q = jobKey ? queue.find((x) => x.key === jobKey) : undefined
  if (!q) return null
  const row = panelRowFor(q, Date.now())
  if (row.offerTaken) return <div className={`shop-offer shop-offer--taken ${className ?? ''}`}>{said ?? row.offerTaken}</div>
  if (!row.offers.length) return null
  const asked = q.preflightAnswer?.answer === 'no' ? q.preflightAnswer.asked : undefined
  const take = (o: ShopOffer) => {
    if (busy) return
    setBusy(true)
    void takeOffer(q.key, o)
      .then((r) => { if (o.kind === 'songs' && r.listed) setSaid(`${r.queued} on the way, ${r.listed} on your Listening List`) })
      .finally(() => setBusy(false))
  }
  return (
    <div className={`shop-offer${compact ? ' shop-offer--compact' : ''} ${className ?? ''}`} onClick={(e) => e.stopPropagation()}>
      {!compact && row.offerAsk && <div className="shop-offer-ask">{row.offerAsk}</div>}
      <div className="shop-offer-buttons">
        {row.offers.map((o) => (
          <button key={o.kind} type="button" className={`shop-offer-btn shop-offer-btn--${o.kind}`} disabled={busy} onClick={() => take(o)} title={compact && row.offerAsk ? `${row.offerAsk} ${offerTitle(o)}` : offerTitle(o)}>
            {offerButton(o, { asked })}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Downloads → Needs you: the row's offers, under its one plain line. */
export function NeedsYouOffer({ item }: NeedsYouFixProps) {
  return <OfferButtons jobKey={item.key} />
}
setNeedsYouFix(NeedsYouOffer)
