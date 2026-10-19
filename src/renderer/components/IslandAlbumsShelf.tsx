/**
 * TOP 10 ISLAND ALBUMS (2026-10-18) — the phone's Letterboxd-style shelf
 * (JakeTunesMobile IslandAlbumsSection.swift), now on the desktop Albums
 * page and synced both ways through homemini (renderer/syncedPicks.ts).
 *
 * Ten ranked slots. A filled slot opens the album; right-click → Replace… /
 * Remove / Move Left / Move Right. An empty slot opens the picker, which only
 * offers COMPLETE albums (utils/islandEligible.ts — the desktop completeness
 * doctrine) that aren't already on the shelf. A pick the phone made for an
 * album this Mac doesn't have stays put, drawn faded — the desktop never
 * prunes the shared document on its own (clearing it here would delete the
 * pick on the phone too). Slots match library albums under either artist
 * form (islandKeysOf); the desktop writes the primary-artist form.
 * Read-only until homemini's document has been seen once (picksEditable).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import AlbumArtImage from './AlbumArtImage'
import ContextMenu, { type MenuEntry } from './ContextMenu'
import PicksPicker, { type PickerItem } from './PicksPicker'
import type { Album } from '../utils/albumGroups'
import { albumKeyFromStrings } from '../utils/albumKey'
import { islandEligible } from '../utils/islandEligible'
import { islandPickOf, islandKeysOf, indexAlbumsForIsland, slotOfAlbum } from '../utils/islandSlots'
import { setNotice } from '../activity'
import { useIslandAlbums, saveIslandSlots, picksStatusLine, picksEditable } from '../syncedPicks'
import {
  clearSlot, islandAlbumKey, moveSlot, placeInSlot, ISLAND_SLOT_COUNT,
  type AnyPicksState, type IslandAlbum, type IslandSlot,
} from '../../common/synced-picks'
import '../styles/synced-picks.css'

interface Props {
  /** The library's albums (AlbumsView's grouping, declared live sets excluded). */
  albums: Album[]
  findArtHash: (album: Album) => string | undefined
  /** Cover for a pick that isn't a library album here (artist, album) → hash. */
  lookupArt: (artist: string, album: string) => string | undefined
  /** Ask main to resolve covers the shelf needs but the artwork map lacks. */
  requestArt: (list: Array<{ artist: string; album: string }>) => void
  onOpenAlbum: (albumKey: string) => void
}

async function commit(next: IslandSlot[]): Promise<void> {
  const r = await saveIslandSlots(next)
  // A refused save (homemini's 400 sentence, or "not synced yet") — say it.
  if (!r.ok) setNotice(r.error, { kind: 'error' })
}

/** The album right-click entry: "Add to Island Albums…" (a slot flyout) for a
 *  complete album, "Remove from Island Albums" when it's already on the shelf,
 *  nothing for an incomplete one (same gating idiom as Play Album). Disabled
 *  until the shelf has synced once (picksEditable). */
export function islandMenuEntry(album: Album, state: AnyPicksState & { values: IslandSlot[] }): MenuEntry | null {
  const values = state.values
  const at = slotOfAlbum(values, album)
  const editable = picksEditable(state)
  if (at >= 0) return { label: `Remove from Island Albums (#${at + 1})`, disabled: !editable, onClick: () => { void commit(clearSlot(values, at)) } }
  if (!islandEligible(album.tracks)) return null
  if (!editable) return { label: 'Add to Island Albums…', disabled: true }
  const pick = islandPickOf(album)
  return {
    label: 'Add to Island Albums…',
    submenu: values.map((v, i) => ({
      label: v ? `${i + 1}. Replace “${v.album}”` : `${i + 1}. Empty slot`,
      onClick: () => {
        void commit(placeInSlot(values, i, pick, islandAlbumKey))
        setNotice(`${album.name} is island album #${i + 1}`)
      },
    })),
  }
}

function DiscGlyph(): JSX.Element {
  // Same empty-cover disc the Albums grid draws (AlbumsView), scaled to the tile.
  return (
    <svg className="isl-disc" viewBox="0 0 32 32" fill="none" stroke="#bbb" strokeWidth="1" aria-hidden="true">
      <circle cx="16" cy="16" r="14" />
      <circle cx="16" cy="16" r="5" />
      <circle cx="16" cy="16" r="1.5" fill="#bbb" />
    </svg>
  )
}

export default function IslandAlbumsShelf({ albums, findArtHash, lookupArt, requestArt, onOpenAlbum }: Props): JSX.Element {
  const picks = useIslandAlbums()
  const values = picks.values
  const [menu, setMenu] = useState<{ x: number; y: number; slot: number } | null>(null)
  const [picking, setPicking] = useState<number | null>(null)

  const editable = picksEditable(picks)
  // Slot identity → library album, under BOTH artist forms (islandKeysOf).
  const byKey = useMemo(() => indexAlbumsForIsland(albums), [albums])

  const slots = useMemo(() => values.map((pick) => {
    if (!pick) return { pick: null, album: undefined, hash: undefined }
    const album = byKey.get(islandAlbumKey(pick))
    return { pick, album, hash: album ? findArtHash(album) : lookupArt(pick.artist, pick.album) }
  }), [values, byKey, findArtHash, lookupArt])

  // Covers the artwork map doesn't have yet — same idle resolver the grid uses.
  useEffect(() => {
    const missing = slots.filter((s) => s.pick && !s.hash).map((s) => ({ artist: s.album?.artist ?? s.pick!.artist, album: s.album?.name ?? s.pick!.album }))
    if (missing.length) requestArt(missing)
  }, [slots, requestArt])

  const choose = useCallback((slot: number) => {
    if (editable) setPicking(slot)
    else setNotice(picks.syncedAt === null
      ? 'Island Albums sync through homemini — editing unlocks after the first sync.'
      : 'Waiting for your phone’s picks — open JakeTunes on the phone once to bring them over.')
  }, [editable, picks.syncedAt])

  const open = useCallback((slot: number) => {
    const s = slots[slot]
    if (!s?.pick) { choose(slot); return }
    if (s.album) onOpenAlbum(albumKeyFromStrings(s.album.artist, s.album.name))
    else setNotice(`${s.pick.album} by ${s.pick.artist} isn't in this library`)
  }, [slots, onOpenAlbum, choose])

  const menuItems = (slot: number): MenuEntry[] => {
    if (!values[slot]) return [{ label: 'Choose Album…', disabled: !editable, onClick: () => setPicking(slot) }]
    return [
      { label: 'Replace…', disabled: !editable, onClick: () => setPicking(slot) },
      { label: 'Remove', disabled: !editable, onClick: () => { void commit(clearSlot(values, slot)) } },
      { separator: true },
      { label: 'Move Left', disabled: !editable || slot === 0, onClick: () => { void commit(moveSlot(values, slot, -1)) } },
      { label: 'Move Right', disabled: !editable || slot === ISLAND_SLOT_COUNT - 1, onClick: () => { void commit(moveSlot(values, slot, 1)) } },
    ]
  }

  // The picker's list: complete albums not already on the shelf (the slot
  // being replaced stays offered, as on the phone). Built only while open.
  // Keyed by the album's primary-artist identity — what gets written.
  const candidates = useMemo((): Map<string, Album> => {
    if (picking === null) return new Map()
    const occupied = new Set(values.filter((v, i): v is IslandAlbum => v !== null && i !== picking).map(islandAlbumKey))
    const out = new Map<string, Album>()
    for (const a of new Set(byKey.values())) {
      const keys = islandKeysOf(a)
      if (keys.some((k) => occupied.has(k)) || out.has(keys[0]) || !islandEligible(a.tracks)) continue
      out.set(keys[0], a)
    }
    return out
  }, [picking, values, byKey])
  const pickerItems = useMemo((): PickerItem[] => [...candidates.entries()].map(([key, a]) => {
    const hash = findArtHash(a)
    return {
      key,
      title: a.name,
      subtitle: [a.artist, a.year ? String(a.year) : '', `${a.tracks.length} tracks`].filter(Boolean).join(' · '),
      art: hash ? <AlbumArtImage hash={hash} alt="" size={96} /> : <DiscGlyph />,
    }
  }), [candidates, findArtHash])

  const status = picksStatusLine(picks)

  return (
    <section className="isl" aria-label="Top 10 Island Albums">
      <div className="isl-head">
        <h2 className="isl-h2">Top 10 Island Albums</h2>
        {status && <span className={`picks-status picks-status--${status.tone}`}>{status.text}</span>}
      </div>
      <div className="isl-grid">
        {slots.map((s, i) => (s.pick ? (
          <button
            key={i}
            type="button"
            className={`isl-slot${s.album ? '' : ' isl-slot--missing'}`}
            title={`${i + 1}. ${s.pick.album} — ${s.pick.artist}${s.album ? '' : ' (not in this library)'}`}
            aria-label={`Number ${i + 1}: ${s.pick.album} by ${s.pick.artist}`}
            onClick={() => open(i)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, slot: i }) }}
          >
            <span className="isl-cover">
              {s.hash ? <AlbumArtImage hash={s.hash} alt="" className="isl-cover-img" size={240} /> : <DiscGlyph />}
            </span>
            <span className="isl-rank">{i + 1}</span>
          </button>
        ) : (
          <button
            key={i}
            type="button"
            className="isl-slot isl-slot--empty"
            title={`Island slot ${i + 1} — choose an album`}
            aria-label={`Empty island slot ${i + 1}. Choose an album.`}
            onClick={() => choose(i)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, slot: i }) }}
          >
            <span className="isl-empty-rank">{i + 1}</span>
            {/* 10×10 plus in the tile's lower half, ~1/9 of a 90px tile */}
            <svg className="isl-plus" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )))}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.slot)} onClose={() => setMenu(null)} />}
      {picking !== null && (
        <PicksPicker
          title={`Island slot ${picking + 1}`}
          sub="Complete albums only — the whole record has to be in your library, not a partial rip."
          placeholder="Search complete albums"
          items={pickerItems}
          emptyText="No complete albums to choose from."
          shape="square"
          onClose={() => setPicking(null)}
          onPick={(key) => {
            const a = candidates.get(key)
            const slot = picking
            setPicking(null)
            if (a) void commit(placeInSlot(values, slot, islandPickOf(a), islandAlbumKey))
          }}
        />
      )}
    </section>
  )
}
