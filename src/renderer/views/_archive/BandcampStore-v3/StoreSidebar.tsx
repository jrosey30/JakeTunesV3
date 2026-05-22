import { ScoredTermWire } from '../../types'

interface Props {
  topTags: ScoredTermWire[]
  activeTag: string | null
  onSelect: (tag: string) => void
}

/** Genre nav ordered by Jake's unified tag frequency (personalization). */
export default function StoreSidebar({ topTags, activeTag, onSelect }: Props) {
  return (
    <nav className="bcs-sidebar">
      <div className="bcs-sidebar-head">Genres</div>
      {topTags.length === 0 && <div className="bcs-sidebar-empty">Connect Bandcamp for personalized genres</div>}
      <ul className="bcs-sidebar-list">
        {topTags.slice(0, 20).map((t) => (
          <li key={t.term}>
            <button
              className={`bcs-sidebar-item ${activeTag === t.term ? 'bcs-sidebar-item--active' : ''}`}
              onClick={() => onSelect(t.term)}
            >
              {t.term}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
