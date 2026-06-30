interface Props {
  query?: string
  noun: string
}

export default function EmptyState({ query, noun }: Props) {
  const q = (query || '').trim()
  return (
    <div className="empty-state">
      <div className="empty-state-glyph" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <circle cx="14" cy="14" r="9" stroke="currentColor" strokeWidth="1.6" />
          <line x1="21" y1="21" x2="27" y2="27" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <div className="empty-state-title">
        {q ? <>No {noun} match &quot;<strong>{q}</strong>&quot;</> : <>No {noun} here yet</>}
      </div>
      <div className="empty-state-sub">
        {q ? 'Try a shorter or different search.' : 'Jot down a song to start your list.'}
      </div>
    </div>
  )
}
