/**
 * The small "Edition" menu on an album card or row (Brief 255): shown when
 * Apple has more than one real edition of the record, defaulting to the one
 * Save album takes (main/album-editions.ts), with the track count of each.
 * The last entry opens the full edition picker in Search.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { editionsState, loadEditions, pickEdition, subscribeEditions } from './albumEditions'
import { editionOptionLabel } from '../../../common/album-preflight'
import './edition-menu.css'

const MORE = 'more'

export default function EditionMenu({ artist, album, onMore, className }: { artist: string; album: string; onMore: () => void; className?: string }) {
  const s = useSyncExternalStore(subscribeEditions, () => editionsState(artist, album))
  useEffect(() => { if (artist && album) void loadEditions(artist, album) }, [artist, album])
  if (s.state !== 'ready' || s.editions.length < 2) return null
  return (
    <label className={`edition-menu${className ? ` ${className}` : ''}`} onClick={(e) => e.stopPropagation()} title="Which edition Save album takes">
      <span className="edition-menu-label">Edition</span>
      <select
        className="edition-menu-select"
        value={s.chosenId != null ? String(s.chosenId) : ''}
        onChange={(e) => {
          const v = e.target.value
          if (v === MORE) { onMore(); return }
          if (v) pickEdition(artist, album, Number(v))
        }}
      >
        {s.chosenId == null && <option value="">Choose…</option>}
        {s.editions.map((ed) => <option key={ed.collectionId} value={String(ed.collectionId)}>{editionOptionLabel(ed, s.editions)}</option>)}
        <option value={MORE}>Other editions in Search…</option>
      </select>
    </label>
  )
}
