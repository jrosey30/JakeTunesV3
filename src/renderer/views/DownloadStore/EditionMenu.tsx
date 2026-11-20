/**
 * The small "Edition" menu on an album card or row (Brief 255): shown only
 * when Apple has answered with more than one real edition of the record,
 * defaulting to the one Save album takes (main/album-editions.ts), with the
 * track count of each. The last entry opens the full edition picker in Search.
 *
 * Nothing is asked on mount (a Listen List of forty albums would queue forty
 * lookups ahead of a Save album click), and nothing is asked by the menu
 * itself: the card or row it sits on asks when it is hovered or focused
 * (askEditions), and a Save album click or the songs ask at the front of the
 * line. Before that answer there is no menu at all, never a placeholder that
 * later vanishes and slides the buttons beside it under the pointer.
 *
 * `reserve`: where the menu's appearing would move something the pointer may
 * be on (the For You card's foot), an invisible menu of the same size holds
 * its place until it shows, so nothing moves either way.
 */
import { useSyncExternalStore } from 'react'
import { editionsState, loadEditions, pickEdition, showEditionMenu, subscribeEditions } from './albumEditions'
import { editionOptionLabel } from '../../../common/album-preflight'
import './edition-menu.css'

const MORE = 'more'

/** The card or row's hover / focus: asks for the editions in turn (never at the front). */
export function askEditions(artist: string, album: string): void {
  if (artist && album) void loadEditions(artist, album)
}

export default function EditionMenu({ artist, album, onMore, className, reserve }: { artist: string; album: string; onMore: () => void; className?: string; reserve?: boolean }) {
  const s = useSyncExternalStore(subscribeEditions, () => editionsState(artist, album))
  if (!artist || !album) return null
  const cls = `edition-menu${className ? ` ${className}` : ''}`
  if (!showEditionMenu(s)) {
    if (!reserve) return null
    // Same box as the menu, invisible and out of reach: its space is held, nothing else.
    return (
      <span className={`${cls} edition-menu--held`} aria-hidden="true">
        <span className="edition-menu-label">Edition</span>
        <select className="edition-menu-select" tabIndex={-1} disabled value=""><option value="">Edition…</option></select>
      </span>
    )
  }
  return (
    <label
      className={cls}
      onClick={(e) => e.stopPropagation()}
      title="Which edition Save album takes"
    >
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
