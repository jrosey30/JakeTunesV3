/**
 * FAVORITE ARTISTS (2026-10-18) — Jake's 5 ranked artists, top of the
 * Artists page, synced both ways with the phone through homemini
 * (renderer/syncedPicks.ts). Same photo circles as the grid below
 * (artist-photo.ts portraits via artist-image://, initials disc when there is
 * no photo — never album art). Click → the artist page; right-click →
 * Replace… / Remove / Move Left / Move Right; an empty slot opens the picker
 * (library artists not already in the row).
 */
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import ContextMenu, { type MenuEntry } from './ContextMenu'
import PicksPicker, { type PickerItem } from './PicksPicker'
import { sessionArtistImages, hashColor, initials } from '../utils/artistPortrait'
import { canonicalArtist } from '../utils/artistAlias'
import { setNotice } from '../activity'
import { useFavoriteArtists, saveFavoriteArtists, picksStatusLine, picksEditable } from '../syncedPicks'
import {
  clearSlot, favoriteArtistKey, moveSlot, placeInSlot, FAVORITE_ARTIST_SLOT_COUNT,
  type FavoriteSlot,
} from '../../common/synced-picks'
import '../styles/synced-picks.css'

export interface FavoriteCandidate {
  name: string
  albums: number
  songs: number
}

interface Props {
  /** The library's artists (ArtistsView's canonical cards). */
  artists: FavoriteCandidate[]
  onOpenArtist: (name: string) => void
}

const plural = (n: number, w: string): string => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

async function commit(next: FavoriteSlot[]): Promise<void> {
  const r = await saveFavoriteArtists(next)
  // A refused save (homemini's 400 sentence, or "not synced yet") — say it.
  if (!r.ok) setNotice(r.error, { kind: 'error' })
}

function Portrait({ name, slug }: { name: string; slug: string | null | undefined }): JSX.Element {
  return slug
    ? <img src={`artist-image://${slug}.jpg`} alt="" draggable={false} decoding="async" />
    : <div className="ag-ini" style={{ background: hashColor(name) }}>{initials(name.replace(/^the\s+/i, ''))}</div>
}

export default function FavoriteArtistsRow({ artists, onOpenArtist }: Props): JSX.Element {
  const picks = useFavoriteArtists()
  const values = picks.values
  const [menu, setMenu] = useState<{ x: number; y: number; slot: number } | null>(null)
  const [picking, setPicking] = useState<number | null>(null)
  const [photos, setPhotos] = useState<Map<string, string | null>>(() => new Map(sessionArtistImages))

  // nameKey of the canonical name → the library's card (the phone may spell
  // the artist differently: "beyonce", "The Beatles" vs "Beatles").
  const byKey = useMemo(() => {
    const m = new Map<string, FavoriteCandidate>()
    for (const a of artists) {
      const k = favoriteArtistKey(a.name)
      if (k && !m.has(k)) m.set(k, a)
    }
    return m
  }, [artists])
  const cardFor = (name: string): FavoriteCandidate | undefined =>
    byKey.get(favoriteArtistKey(canonicalArtist(name))) ?? byKey.get(favoriteArtistKey(name))

  // Portraits for the five names (single-flight + 30-day cache live in main).
  useEffect(() => {
    let live = true
    for (const v of values) {
      if (!v) continue
      const name = cardFor(v)?.name ?? v
      if (sessionArtistImages.has(name)) continue
      window.electronAPI.getArtistImage(name).then((r) => (r.ok ? r.slug : null)).catch(() => null).then((slug) => {
        sessionArtistImages.set(name, slug)
        if (live) setPhotos((prev) => new Map(prev).set(name, slug))
      })
    }
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, byKey])

  // Read-only until homemini's document has been seen once (picksEditable).
  const editable = picksEditable(picks)
  const choose = (slot: number): void => {
    if (editable) setPicking(slot)
    else setNotice('Favorite artists sync through homemini — editing unlocks after the first sync.')
  }

  const menuItems = (slot: number): MenuEntry[] => {
    if (!values[slot]) return [{ label: 'Choose Artist…', disabled: !editable, onClick: () => setPicking(slot) }]
    return [
      { label: 'Replace…', disabled: !editable, onClick: () => setPicking(slot) },
      { label: 'Remove', disabled: !editable, onClick: () => { void commit(clearSlot(values, slot)) } },
      { separator: true },
      { label: 'Move Left', disabled: !editable || slot === 0, onClick: () => { void commit(moveSlot(values, slot, -1)) } },
      { label: 'Move Right', disabled: !editable || slot === FAVORITE_ARTIST_SLOT_COUNT - 1, onClick: () => { void commit(moveSlot(values, slot, 1)) } },
    ]
  }

  const candidates = useMemo((): Map<string, FavoriteCandidate> => {
    if (picking === null) return new Map()
    const occupied = new Set(values.filter((v, i): v is string => v !== null && i !== picking).map((v) => favoriteArtistKey(cardFor(v)?.name ?? v)))
    const out = new Map<string, FavoriteCandidate>()
    for (const [k, a] of byKey) if (!occupied.has(k) && a.name !== 'Unknown Artist') out.set(k, a)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, values, byKey])
  const pickerItems = useMemo((): PickerItem[] => [...candidates.entries()].map(([key, a]) => ({
    key,
    title: a.name,
    subtitle: [a.albums ? plural(a.albums, 'album') : '', plural(a.songs, 'song')].filter(Boolean).join(' · '),
    art: <Portrait name={a.name} slug={photos.get(a.name)} />,
  })), [candidates, photos])

  const open = (slot: number): void => {
    const v = values[slot]
    if (!v) { choose(slot); return }
    const card = cardFor(v)
    if (card) onOpenArtist(card.name)
    else setNotice(`${v} isn't in this library`)
  }

  const status = picksStatusLine(picks)

  return (
    <section className="ag-shelf fav" aria-label="Favorite artists">
      <div className="fav-head">
        <h2 className="ag-h2">Favorite artists <small>top 5 · synced with your phone</small></h2>
        {status && <span className={`picks-status picks-status--${status.tone}`}>{status.text}</span>}
      </div>
      <div className="fav-row">
        {values.map((v, i) => {
          // Same markup as the grid's cards below (ArtistsView: a div with
          // role=button), so .ag-ph / .ag-name / .ag-meta draw identically.
          const act = v ? () => open(i) : () => choose(i)
          const common = {
            role: 'button' as const,
            tabIndex: 0,
            onClick: act,
            onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act() } },
            onContextMenu: (e: ReactMouseEvent) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, slot: i }) },
          }
          if (!v) {
            return (
              <div
                key={i}
                {...common}
                className="ag-card fav-card fav-card--empty"
                title={`Favorite artist ${i + 1} — choose an artist`}
                aria-label={`Empty favorite artist slot ${i + 1}. Choose an artist.`}
              >
                <div className="fav-ph-wrap"><div className="ag-ph fav-ph--empty"><span className="fav-empty-rank">{i + 1}</span></div></div>
                <div className="ag-meta">Choose an artist</div>
              </div>
            )
          }
          const card = cardFor(v)
          const name = card?.name ?? v
          return (
            <div
              key={i}
              {...common}
              className={`ag-card fav-card${card ? '' : ' fav-card--missing'}`}
              title={`${i + 1}. ${name}${card ? '' : ' (not in this library)'}`}
              aria-label={`Favorite artist number ${i + 1}: ${name}`}
            >
              <div className="fav-ph-wrap">
                <div className="ag-ph"><Portrait name={name} slug={photos.get(name)} /></div>
                <span className="fav-rank">{i + 1}</span>
              </div>
              <div className="ag-name">{name}</div>
              {card && <div className="ag-meta">{card.albums ? `${plural(card.albums, 'album')} · ` : ''}{plural(card.songs, 'song')}</div>}
            </div>
          )
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.slot)} onClose={() => setMenu(null)} />}
      {picking !== null && (
        <PicksPicker
          title={`Favorite artist #${picking + 1}`}
          sub="Pick from the artists in your library. Your phone gets the same five."
          placeholder="Search artists"
          items={pickerItems}
          emptyText="No artists in the library yet."
          shape="round"
          onClose={() => setPicking(null)}
          onPick={(key) => {
            const a = candidates.get(key)
            const slot = picking
            setPicking(null)
            if (a) void commit(placeInSlot(values, slot, a.name, favoriteArtistKey))
          }}
        />
      )}
    </section>
  )
}
