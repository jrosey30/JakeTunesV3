/**
 * The foot of a Record Shop album card (Phase 2, Jake's approved picture,
 * 2026-11-24): "Save album" and the edition it saves, always shown, never
 * only on hover. One edition known: its name. Two or more: "Deluxe ▾", a
 * small menu over the real <select>, and the edition picked is the one saved
 * (common/shop-card-edition.ts).
 *
 * The editions are asked when the card is hovered or focused, in turn with
 * every other lookup (albumEditions.ts), never on mount: a search shows up to
 * thirty albums, and Apple answers a burst with 403.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { albumJobFor, editionsState, pickEdition, subscribeEditions } from './albumEditions'
import type { QResult } from './downloadQueue'
import { cardEdition, cardSaveEdition, type CardRecord } from '../../../common/shop-card-edition'
import { baseAlbumTitle } from '../../../common/shop-search'

/** The name the editions are looked up by: the record, without its edition words. */
export const editionsKeyName = (name: string): string => baseAlbumTitle(name) || name

export default function AlbumCardFoot({ artist, card, cardJob, action }: {
  artist: string
  card: CardRecord
  /** The card's own Save album job (its own edition). */
  cardJob: QResult
  /** The Save album button, or the job's state, for the job a click would make. */
  action: (job: QResult) => ReactNode
}) {
  const key = editionsKeyName(card.name)
  const s = useSyncExternalStore(subscribeEditions, () => editionsState(artist, key))
  const ed = cardEdition(card, s)
  const other = cardSaveEdition(card, ed)
  const job = other
    ? albumJobFor({ artist, album: card.name, edition: other, editionFrom: 'picked', surface: 'search', clickedAt: Date.now() })
    : cardJob
  return (
    <span className="dl-rel-foot" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {action(job)}
      {ed.kind === 'label' && <span className="dl-rel-ed" title="The edition Save album takes">{ed.label}</span>}
      {ed.kind === 'menu' && (
        <label className="dl-rel-ed dl-rel-ed--menu" title="Which edition Save album takes">
          <span aria-hidden="true">{ed.selected.label} ▾</span>
          <select
            aria-label="Edition"
            value={String(ed.selectedId)}
            onChange={(e) => pickEdition(artist, key, Number(e.target.value))}
          >
            {ed.options.map((o) => <option key={o.id} value={String(o.id)}>{o.label}</option>)}
          </select>
        </label>
      )}
    </span>
  )
}
