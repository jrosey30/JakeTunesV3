// Music Man's Record Store — Phase 2 immersive scene (Brief 037 §4 FSM).
//
// The whole window IS the shop. One illustrated storefront backdrop +
// the Music Man sprites + code-driven "camera" moves stand in for a
// multi-scene FSM (no per-angle art needed — consistency was a losing
// battle in Midjourney):
//
//   wide  → you're in the shop: theme on the sign, three bins to dig into
//   bin   → push in on a shelf; YOUR real album covers fill the crate
//   (talk)→ click a record: it plays and Music Man pops in with his take
//           in a Pokémon-GBC dialogue box, then steps back out
//
// Real covers come from the live library artwork (album-art:// protocol).
// Playback / Library / useAudio are READ here, never edited.

import { useCallback, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useLibrary } from '../../context/LibraryContext'
import { useAudio } from '../../hooks/useAudio'
import { buildNormalizedArtworkIndex, lookupArtwork } from '../../utils/artworkLookup'
import { useShelves } from './hooks/useShelves'
import { DialogueBox } from './components/DialogueBox'
import { CrateBrowse } from './components/CrateBrowse'
import type { Blurb, Persona, ShelfId, ShelfItem } from './types'
import storefrontBg from './art/storefront.png'
import mmSmug from './art/musicman-smug.png'
import mmThink from './art/musicman-think.png'
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

type Scene = { view: 'wide' } | { view: 'bin'; shelfId: ShelfId }

// Clickable regions over the storefront art's drawn bins (point-and-click
// adventure style). Percentages of the scene box — tune these to line up
// with the painted crates. Keyed by shelf; FALLBACK_RECTS covers any
// shelf id without an explicit mapping (positional).
const HOTSPOT_RECTS: Partial<Record<ShelfId, CSSProperties>> = {
  'mm-picks': { left: '24%', top: '63%', width: '20%', height: '29%' },
  'new-arrivals': { left: '45%', top: '63%', width: '22%', height: '29%' },
  'deep-cuts': { left: '70%', top: '59%', width: '27%', height: '35%' },
}
const FALLBACK_RECTS: CSSProperties[] = [
  { left: '24%', top: '63%', width: '20%', height: '29%' },
  { left: '45%', top: '63%', width: '22%', height: '29%' },
  { left: '70%', top: '59%', width: '27%', height: '35%' },
]

export default function RecordStoreView() {
  const { state: lib } = useLibrary()
  const { playTrack } = useAudio()
  const { state, refresh } = useShelves()
  const [take, setTake] = useState<TakeState>({ status: 'idle' })
  const [scene, setScene] = useState<Scene>({ view: 'wide' })

  const trackById = useMemo(() => {
    const m = new Map<number, typeof lib.tracks[number]>()
    for (const t of lib.tracks) m.set(t.id, t)
    return m
  }, [lib.tracks])

  const artIndex = useMemo(() => buildNormalizedArtworkIndex(lib.artworkMap), [lib.artworkMap])

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
  const activeShelf =
    scene.view === 'bin' ? bundle.shelves.find((s) => s.id === scene.shelfId) ?? null : null

  // Push the "camera" toward the crate you opened (transform-origin at the
  // crate's center) so digging in feels like leaning into that bin.
  const activeRect = scene.view === 'bin' ? HOTSPOT_RECTS[scene.shelfId] : undefined
  const bgOrigin = activeRect
    ? `${parseFloat(String(activeRect.left)) + parseFloat(String(activeRect.width)) / 2}% ` +
      `${parseFloat(String(activeRect.top)) + parseFloat(String(activeRect.height)) / 2}%`
    : '50% 72%'

  return (
    <div className="recordstore recordstore--immersive">
      <div className={`recordstore__scene recordstore__scene--${scene.view}`}>
        <img
          className="recordstore__scene-bg"
          src={storefrontBg}
          alt=""
          aria-hidden="true"
          style={{ transformOrigin: bgOrigin }}
        />

        <div className="recordstore__sign">
          <span className="recordstore__sign-name">WJLR Records · Greenpoint</span>
          <span className="recordstore__sign-theme">{bundle.theme.theme}</span>
        </div>

        {/* WIDE: the bins in the ART are the buttons. Hover highlights +
            labels a crate; click digs into that shelf. */}
        {scene.view === 'wide' && (
          <>
            {bundle.theme.rationale && (
              <p className="recordstore__rationale">
                {bundle.theme.rationale}
                {bundle.source !== 'llm' && (
                  <span className="recordstore__source-pill">
                    {bundle.source === 'cached' ? 'served from yesterday' : 'house picks'}
                  </span>
                )}
              </p>
            )}
            {bundle.shelves.map((shelf, i) => (
              <button
                key={shelf.id}
                className="rs-hotspot"
                style={HOTSPOT_RECTS[shelf.id] ?? FALLBACK_RECTS[i] ?? FALLBACK_RECTS[0]}
                disabled={shelf.items.length === 0}
                onClick={() => setScene({ view: 'bin', shelfId: shelf.id })}
              >
                <span className="rs-hotspot__label">
                  {shelf.title}
                  <em>{shelf.items.length} records</em>
                </span>
              </button>
            ))}
          </>
        )}

        {/* BIN: dig through the crate — fanned real covers, flip to play. */}
        {scene.view === 'bin' && activeShelf && (
          <CrateBrowse
            shelf={activeShelf}
            coverSrc={coverSrc}
            onPlay={handleItemClick}
            onBack={() => setScene({ view: 'wide' })}
            selectedId={take.status !== 'idle' ? take.item.id : null}
          />
        )}

        {/* Music Man pops in to talk (any view). */}
        {take.status !== 'idle' && (
          <div className="recordstore__mm-stage">
            <img
              className="recordstore__mm"
              src={take.status === 'loading' ? mmThink : mmSmug}
              alt="Music Man"
            />
            <DialogueBox
              speaker="Music Man"
              loading={take.status === 'loading'}
              text={take.status === 'ready' ? take.text : null}
              onAdvance={() => setTake({ status: 'idle' })}
            />
          </div>
        )}

        <button
          className="recordstore__refresh recordstore__refresh--scene"
          onClick={refresh}
          title="Re-stock the wall"
        >
          Refresh
        </button>
      </div>
    </div>
  )
}
