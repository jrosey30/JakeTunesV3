import { useLibrary } from '../../context/LibraryContext'

export default function SearchPill() {
  const { state, dispatch } = useLibrary()

  return (
    <div className="search-pill">
      <svg className="search-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#999" strokeWidth="1.5">
        <circle cx="5" cy="5" r="3.5" />
        <path d="M7.5 7.5L10.5 10.5" strokeLinecap="round" />
      </svg>
      <input
        type="text"
        className="search-input"
        placeholder="Search"
        value={state.searchQuery}
        onChange={(e) => dispatch({ type: 'SET_SEARCH', query: e.target.value })}
      />
      {state.searchQuery && (
        <button className="search-clear" onClick={() => dispatch({ type: 'SET_SEARCH', query: '' })}>
          ×
        </button>
      )}
    </div>
  )
}
