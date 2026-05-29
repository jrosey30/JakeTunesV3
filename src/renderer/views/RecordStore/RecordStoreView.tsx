// Music Man's Record Store — Phase 2 foundation (Brief 037).
//
// Renders the daily ShelfBundle from the IPC engine (1a-1e) as shelves of
// REAL album-cover cards pulled from the live library artwork (same
// `album-art://<hash>.jpg` protocol the Albums view uses). Clicking a
// cover plays the album AND asks Music Man for his take (the get-blurb
// Haiku call) — playback never waits on the blurb (§8).
//
// This is the structural foundation. The illustrated Backyard-Baseball
// scene (storefront background, Music Man sprite at the counter, the
// speech-bubble + bin art, the scene FSM, and TTS/duck) layers on top of
// this once the art PNGs are dropped into ./art. Playback/Library/useAudio
// are READ here, never edited (do-not-touch).

import { useCallback, useMemo, useState } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio } from '../../hooks/useAudio'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../../utils/artworkLookup'
import { useShelves } from './hooks/useShelves'
import type { Blurb, Persona, Shelf, ShelfItem } from '../../../main/record-store/types'
import './record-store.css'

interface RecordStoreApi {
  getBlurb?: (args: { itemId: string; persona: Persona }) => Promise<Blurb | null>
}
function recordStoreApi(): RecordStoreApi | null {
  const api = (window as unknown as { electronAPI?: { recordStore?: RecordStoreApi } }).electronAPI
  return api?.recordStore ?? null
}

type TakeState =
  | { status: 'idle' }
  | { status: 'loading'; item: ShelfItem }
  | { status: 'ready'; item: ShelfItem; text: string | null }

export default function RecordStoreView() {
  const { state: lib } = useLibrary()
  const { playTrack } = useAudio()
  const { state, refresh } = useShelves()
  const [take, setTake] = useState<TakeState>({ status: 'idle' })

  // trackId → live library track, for play + artwork resolution.
  const trackById = useMemo(() => {
    const m = new Map<number, typeof lib.tracks[number]>()
    for (const t of lib.tracks) m.set(t.id, t)
    return m
  }, [lib.tracks])

  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])

  // Resolve a shelf item to its real library cover (album-art:// protocol),
  // preferring the matched track's metadata over the item's display strings.
  const coverSrc = useCallback(
    (item: ShelfItem): string | null => {
      const ids = item.payload.trackIds
      const t = ids && ids.length ? trackById.get(Number(ids[0])) : undefined
      const artist = t ? t.albumArtist || t.artist : item.subtitle
      const album = t ? t.album : item.title
      const hash = lookupArtwork(lib.artworkMap, artIndex, artist || '', album || '')
      return hash ? `album-art://${hash}.jpg` : null
    },
    [trackById, artIndex, lib.artworkMap],
  )

  const askMusicMan = useCallback(async (item: ShelfItem) => {
    const api = recordStoreApi()
    if (!api?.getBlurb) return
    setTake({ status: 'loading', item })
    try {
      const blurb = await api.getBlurb({ itemId: item.id, persona: 'music-man' })
      setTake({ status: 'ready', item, text: blurb?.text ?? null })
    } catch {
      setTake({ status: 'ready', item, text: null })
    }
  }, [])

  const handleItemClick = useCallback(
    (item: ShelfItem) => {
      // Play immediately — never block on the blurb (§8).
      const ids = item.payload.trackIds
      if (ids && ids.length) {
        const tracks = ids
          .map((id) => trackById.get(Number(id)))
          .filter((t): t is NonNullable<typeof t> => Boolean(t))
        if (tracks.length) playTrack(tracks[0], tracks, 0)
        else console.warn('[record-store] item has no resolvable tracks:', item.id)
      } else if (item.payload.externalUrl) {
        console.log('[record-store] external item:', item.payload.externalUrl)
      }
      void askMusicMan(item)
    },
    [trackById, playTrack, askMusicMan],
  )

  if (state.status === 'loading') {
    return (
      <div className="recordstore">
        <header className="recordstore__header">
          <h1 className="recordstore__title">The Record Store</h1>
        </header>
        <p className="recordstore__state-line">Music Man is opening up… (first visit today can take a moment)</p>
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
        <button className="recordstore__refresh" onClick={refresh} title="Re-stock the wall">
          Refresh
        </button>
      </header>

      <div className="recordstore__sign">
        <p className="recordstore__theme">{bundle.theme.theme}</p>
        {bundle.theme.rationale && <p className="recordstore__rationale">{bundle.theme.rationale}</p>}
        {bundle.source !== 'llm' && (
          <span className="recordstore__source-pill">
            {bundle.source === 'cached' ? 'served from yesterday' : 'house picks'}
          </span>
        )}
      </div>

      {/* Music Man's counter — previews the speech bubble; the sprite +
          bubble art + TTS land in the scene pass. */}
      {take.status !== 'idle' && (
        <div className="recordstore__counter">
          <span className="recordstore__mm-label">Music Man</span>
          <p className="recordstore__mm-take">
            {take.status === 'loading' ? '…' : take.text || "[he's got nothing on this one]"}
          </p>
        </div>
      )}

      {bundle.shelves.length === 0 ? (
        <div className="recordstore__empty">The shop looks empty today. Try refresh.</div>
      ) : (
        bundle.shelves.map((shelf) => (
          <ShelfBlock
            key={shelf.id}
            shelf={shelf}
            coverSrc={coverSrc}
            selectedId={take.status !== 'idle' ? take.item.id : null}
            onItemClick={handleItemClick}
          />
        ))
      )}
    </div>
  )
}

function ShelfBlock({
  shelf,
  coverSrc,
  selectedId,
  onItemClick,
}: {
  shelf: Shelf
  coverSrc: (i: ShelfItem) => string | null
  selectedId: string | null
  onItemClick: (i: ShelfItem) => void
}) {
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
          {shelf.items.map((item) => {
            const cover = coverSrc(item)
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`recordstore__card${selectedId === item.id ? ' recordstore__card--selected' : ''}`}
                  onClick={() => onItemClick(item)}
                  title={item.placement}
                >
                  <div className="recordstore__cover">
                    {cover ? (
                      <img src={cover} alt={item.title} className="recordstore__cover-img" />
                    ) : (
                      <div className="recordstore__cover-blank">{item.title}</div>
                    )}
                  </div>
                  <p className="recordstore__card-title">{item.title}</p>
                  <p className="recordstore__card-subtitle">{item.subtitle}</p>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
