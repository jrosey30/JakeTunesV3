// Music Man's Record Store — Phase 0 view shell (Brief 037 §9 Phase 0)
//
// Plain HTML/CSS, no scene/FSM/art. Renders the daily ShelfBundle from
// the IPC engine as a flat list of shelves. Clicking an item starts
// playback via the existing useAudio + LibraryContext rails — never
// touches the do-not-touch list (PlaybackContext, LibraryContext,
// useAudio are READ here, never edited).
//
// Phase 1 will keep this component but the IPC payload it consumes will
// be backed by the day-theme + Sonnet curator. Phase 2 swaps the plain
// shelf rows for the illustrated storefront scene.

import { useCallback, useMemo } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio } from '../../hooks/useAudio'
import { useShelves } from './hooks/useShelves'
import type { ShelfItem, Shelf } from '../../../main/record-store/types'
import './record-store.css'

export default function RecordStoreView() {
  const { state: lib } = useLibrary()
  const { playTrack } = useAudio()
  const { state, refresh } = useShelves()

  // Map track ids referenced in the ShelfBundle to live library
  // tracks. Built once per library tick so click handlers are cheap.
  const trackById = useMemo(() => {
    const m = new Map<number, typeof lib.tracks[number]>()
    for (const t of lib.tracks) m.set(t.id, t)
    return m
  }, [lib.tracks])

  const handleItemClick = useCallback(
    (item: ShelfItem) => {
      const ids = item.payload.trackIds
      if (!ids || ids.length === 0) {
        if (item.payload.externalUrl) {
          // External release — Phase 0 just logs; Phase 1+ opens the
          // BandcampStore embedded view at this URL.
          console.log('[record-store] external item click:', item.payload.externalUrl)
        }
        return
      }
      const tracks = ids
        .map((id) => trackById.get(Number(id)))
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
      if (tracks.length === 0) {
        console.warn('[record-store] clicked item has no resolvable library tracks:', item.id)
        return
      }
      // Mirror AlbumsView / SongsView pattern: playTrack(first, queue, 0)
      // — useAudio handles the actual Howl construction + dispatch.
      playTrack(tracks[0], tracks, 0)
    },
    [trackById, playTrack],
  )

  if (state.status === 'loading') {
    return (
      <div className="recordstore">
        <header className="recordstore__header">
          <h1 className="recordstore__title">The Record Store</h1>
        </header>
        <p className="recordstore__state-line">Music Man is opening up…</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="recordstore">
        <header className="recordstore__header">
          <h1 className="recordstore__title">The Record Store</h1>
          <button className="recordstore__refresh" onClick={refresh}>Try again</button>
        </header>
        <p className="recordstore__state-line recordstore__state-line--error">
          Couldn't load today's wall: {state.error}
        </p>
      </div>
    )
  }

  const { bundle } = state

  return (
    <div className="recordstore">
      <header className="recordstore__header">
        <h1 className="recordstore__title">The Record Store</h1>
        <button
          className="recordstore__refresh"
          onClick={refresh}
          title="Re-stock the wall"
        >
          Refresh
        </button>
      </header>
      <p className="recordstore__theme">
        {bundle.theme.theme}
        {bundle.source !== 'llm' && (
          <span style={{ marginLeft: 8, color: '#a0a0a0' }}>
            · ({bundle.source})
          </span>
        )}
      </p>

      {bundle.shelves.length === 0 ? (
        <div className="recordstore__empty">
          The shop looks empty today. Try refresh.
        </div>
      ) : (
        bundle.shelves.map((shelf) => <ShelfBlock key={shelf.id} shelf={shelf} onItemClick={handleItemClick} />)
      )}
    </div>
  )
}

function ShelfBlock({ shelf, onItemClick }: { shelf: Shelf; onItemClick: (i: ShelfItem) => void }) {
  return (
    <section className="recordstore__shelf">
      <div className="recordstore__shelf-header">
        <h2 className="recordstore__shelf-title">{shelf.title}</h2>
        <span className="recordstore__shelf-curator">curated by {shelf.curator}</span>
      </div>
      <p className="recordstore__shelf-tagline">{shelf.tagline}</p>
      {shelf.items.length === 0 ? (
        <div className="recordstore__empty">Nothing on this shelf yet.</div>
      ) : (
        <ul className="recordstore__items">
          {shelf.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="recordstore__item"
                onClick={() => onItemClick(item)}
              >
                <p className="recordstore__item-title">{item.title}</p>
                <p className="recordstore__item-subtitle">{item.subtitle}</p>
                <p className="recordstore__item-placement">{item.placement}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
