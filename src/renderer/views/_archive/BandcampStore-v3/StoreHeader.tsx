import { useState } from 'react'

interface Props {
  auth: { loggedIn: boolean; username?: string }
  onSearch: (query: string) => void
  onConnect: () => void
  connecting: boolean
}

export default function StoreHeader({ auth, onSearch, onConnect, connecting }: Props) {
  const [q, setQ] = useState('')
  return (
    <header className="bcs-header">
      <div className="bcs-logo">JakeTunes&nbsp;<span className="bcs-logo-store">Store</span></div>

      <form
        className="bcs-search"
        onSubmit={(e) => { e.preventDefault(); onSearch(q.trim()) }}
      >
        <span className="bcs-search-icon" aria-hidden>⌕</span>
        <input
          className="bcs-search-input"
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the Bandcamp catalog"
        />
      </form>

      <div className="bcs-account">
        {auth.loggedIn
          ? <span className="bcs-account-user">{auth.username ? `@${auth.username}` : 'Connected'}</span>
          : <button className="bcs-connect" onClick={onConnect} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect Bandcamp'}
            </button>}
      </div>
    </header>
  )
}
