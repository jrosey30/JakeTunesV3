/**
 * The playlists ON each iPod, under its row in the sidebar's iPODS section
 * (2026-11-14; ~/concert-repair/ipod-playlists-plan.md, approved). Jake:
 * "default playlists are standard for each ipod, like it was back in the day";
 * "default playlists on top, on the go, then the per ipod playlists in a to z
 * order"; "i also have the ability to create my own per ipod playlist".
 *
 * Why under the row and not on the iPod's page: the sidebar is where an iPod
 * already is a thing you open, and an old iPod's own Playlists menu is a list
 * of names, which is what the sidebar draws. The page's top is the ad, one
 * iPod and one line, and a list of 16 names there would turn the ad into a
 * menu. So each iPod row opens like a folder in iTunes: the triangle to the
 * left of its picture shows its playlists; opening the iPod or one of its
 * playlists shows them too. Closed by default, so the section stays one row per
 * iPod. No counts on these rows (the page says how many): at the sidebar's
 * 170px a count left a name like "Top 25 Most Played" no room.
 *
 * Under an open iPod, in the order the iPod shows them:
 *   the defaults (worked out with the sync's own code; the iPod's own list is
 *   the row above, never drawn again here),
 *   On-The-Go, then everything else A to Z (homemini's order), then
 *   "New Playlist on <iPod>…".
 * Defaults and On-The-Go are read-only. Jake's own take dropped songs, and
 * Rename… / Delete… on right-click.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Track } from '../../types'
import SidebarItem from './SidebarItem'
import ContextMenu from '../ContextMenu'
import ConfirmDialog from '../ConfirmDialog'
import { setNotice } from '../../activity'
import {
  createIpodPlaylist, deleteIpodPlaylist, getOpenIpodPlaylistKey, saveIpodPlaylist, setOpenIpodPlaylist,
  subscribeOpenIpodPlaylist, useIpodDefaults, useIpodPlaylists, rememberIpod,
} from '../../ipodPlaylists'
import { askToAddToIpodPlaylist } from '../../ipodPlaylistAdd'
import { checkPlaylistName } from '../../../common/ipod-playlists-view'

const PURPLE = '#7351a3'

function DefaultIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M1 2.5h5M1 5h4" stroke={PURPLE} strokeWidth="1.2" strokeLinecap="round" />
      <g transform="translate(8,8)">
        <circle cx="0" cy="0" r="1.2" stroke={PURPLE} strokeWidth="0.7" fill="none" />
        <path d="M0-2.8v1M0 1.8v1M-2.8 0h1M1.8 0h1M-2-2 l.7.7M1.3 1.3 l.7.7M2-2 l-.7.7M-1.3 1.3 l-.7.7" stroke={PURPLE} strokeWidth="0.7" strokeLinecap="round" />
      </g>
    </svg>
  )
}
/** On-The-Go: a click wheel. */
function OnTheGoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.6" stroke={PURPLE} strokeWidth="1.1" />
      <circle cx="6" cy="6" r="1.6" stroke={PURPLE} strokeWidth="1" />
    </svg>
  )
}
function OwnIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={PURPLE} strokeWidth="1.2" aria-hidden="true">
      <path d="M1 3h8M1 6h8M1 9h5" strokeLinecap="round" />
    </svg>
  )
}
function NewIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={PURPLE} strokeWidth="1.2" aria-hidden="true">
      <path d="M6 2v8M2 6h8" strokeLinecap="round" />
    </svg>
  )
}
/** The triangle in the row's left margin, where iTunes put a folder's. */
export function IpodDisclosure({ device, ipodName, active }: { device: string; ipodName: string; active: boolean }) {
  useSyncExternalStore(subscribeOpen, getOpenVersion)
  const shown = ipodOpenNow(device, active)
  return (
    <button
      type="button"
      className="sidebar-ipod-disclosure"
      aria-expanded={shown}
      title={shown ? `Hide ${ipodName}’s playlists` : `Show ${ipodName}’s playlists`}
      aria-label={shown ? `Hide ${ipodName}’s playlists` : `Show ${ipodName}’s playlists`}
      onClick={(e) => { e.stopPropagation(); toggleIpodOpen(device, shown, active) }}
    >
      <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: shown ? 'rotate(90deg)' : undefined, transition: 'transform var(--motion-instant) var(--motion-ease)' }}>
        <path d="M2.5 1 L8 5 L2.5 9 Z" fill="currentColor" />
      </svg>
    </button>
  )
}

// Which iPods are open, for this session (not saved: closed is the resting state).
// `closed` is the triangle closing an iPod whose own page is showing. Jake
// (2026-11-17): "the collapsing of sub playlists on each ipod doesnt happen on
// desktop" — showing the page used to force the playlists open, so the
// triangle could never close them.
const opened = new Set<string>()
const closed = new Set<string>()
const openListeners = new Set<() => void>()
let openVersion = 0
/** The triangle: close what is shown, open what isn't. Closing only sticks over a page
 *  that is showing; an iPod closed while its page isn't still opens with its page. */
export function toggleIpodOpen(device: string, shownNow: boolean, active: boolean): void {
  if (shownNow) { opened.delete(device); if (active) closed.add(device) }
  else { opened.add(device); closed.delete(device) }
  openVersion++
  for (const l of openListeners) l()
}
const subscribeOpen = (cb: () => void): (() => void) => { openListeners.add(cb); return () => { openListeners.delete(cb) } }
const getOpenVersion = (): number => openVersion
/** The sidebar re-draws when a row is opened or closed. */
export function useIpodOpenVersion(): number {
  return useSyncExternalStore(subscribeOpen, getOpenVersion)
}
/** Opened by its triangle. */
export const ipodIsOpened = (device: string): boolean => opened.has(device)
/** Shown: opened by its ▸, or its own list or one of its playlists is the page showing (unless its ▾ closed it). */
export const ipodOpenNow = (device: string, active: boolean): boolean =>
  opened.has(device) || (active && !closed.has(device))

export interface IpodPlaylistsTreeProps {
  /** 'top1000' for the Original, the list id otherwise. */
  device: string
  /** What Jake calls this iPod in words ("punkPod", "The Original"). */
  ipodName: string
  /** The name the iPod's own list is written under: 'Top 1000' on the Original, the list's name otherwise. */
  setName: string
  /** The iPod's songs, in its list's order. */
  ipodIds: readonly number[]
  library: readonly Track[]
  open: boolean
  /** The 'ipod-playlist' page is showing (and which one, by getOpenIpodPlaylistKey). */
  onPage: boolean
  /** Open the iPod's own list (the row above). */
  openOwnList: () => void
  openPage: () => void
}

export default function IpodPlaylistsTree(props: IpodPlaylistsTreeProps) {
  const { device, ipodName, setName, ipodIds, library, open, onPage } = props
  const stored = useIpodPlaylists(device, ipodName)
  const defaults = useIpodDefaults(device, library, ipodIds, setName, open)
  const openKey = useSyncExternalStore(subscribeOpenIpodPlaylist, getOpenIpodPlaylistKey)
  const defaultNames = useMemo(() => defaults.map((d) => d.name), [defaults])
  useEffect(() => { rememberIpod({ device, ipodName, setName, ipodIds, defaultNames: open ? defaultNames : null }) }, [device, ipodName, setName, ipodIds, defaultNames, open])

  const [naming, setNaming] = useState<{ id: string | null; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; name: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (naming) inputRef.current?.focus() }, [naming])

  const commitName = useCallback(async () => {
    if (!naming) return
    const others = stored.rows.filter((p) => p.id !== naming.id).map((p) => p.name)
    const check = checkPlaylistName(naming.value, ipodName, { defaults: defaultNames, others })
    if (!check.ok) { setError(check.error); return }
    setNaming(null)
    setError(null)
    const r = naming.id
      ? await saveIpodPlaylist({ device, ipodName, id: naming.id, name: check.name, defaults: defaultNames })
      : await createIpodPlaylist({ device, ipodName, name: check.name, trackIds: [], defaults: defaultNames })
    if (!r.ok) { setNotice(r.error, { kind: 'error', durationMs: 5000 }); return }
    if (!naming.id) { setOpenIpodPlaylist(device, r.id); props.openPage() }
  }, [naming, stored.rows, ipodName, defaultNames, device, props])

  if (!open) return null

  const isOpen = (id: string): boolean => onPage && openKey === `${device}/${id}`
  const show = (id: string): void => { setOpenIpodPlaylist(device, id); props.openPage() }
  const nameBox = (id: string | null) => (
    <li className="sidebar-item sidebar-item--ipod-playlist sidebar-item--naming" key={`naming-${id ?? 'new'}`}>
      <span className="sidebar-item-icon"><OwnIcon /></span>
      <input
        ref={inputRef}
        className="sidebar-inline-input"
        aria-label={id ? 'Playlist name' : `New playlist on ${ipodName}`}
        placeholder={id ? '' : `New playlist on ${ipodName}`}
        value={naming?.value ?? ''}
        maxLength={80}
        onChange={(e) => { setNaming((n) => (n ? { ...n, value: e.target.value } : n)); setError(null) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void commitName() }
          if (e.key === 'Escape') { setNaming(null); setError(null) }
        }}
        onBlur={() => { if (!naming?.value.trim()) { setNaming(null); setError(null) } }}
      />
    </li>
  )

  return (
    <ul className="sidebar-ipod-playlists" aria-label={`Playlists on ${ipodName}`}>
      {/* The iPod's own list is the row above, not one of its playlists. Jake (2026-11-17):
          "seeing top 1000 on original as a playlist is dumb". The sync still writes it. */}
      {defaults.filter((p) => p.kind !== 'set').map((p) => (
        <SidebarItem
          key={`d-${p.id}`}
          className="sidebar-item--ipod-playlist"
          wrap
          label={p.name}
          icon={<DefaultIcon />}
          selected={isOpen(p.id)}
          onClick={() => show(p.id)}
        />
      ))}
      {stored.rows.map((p) => naming?.id === p.id ? nameBox(p.id) : (
        <div
          key={`s-${p.id}`}
          onContextMenu={p.source === 'jake' ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: p.id, name: p.name }) } : undefined}
        >
          <SidebarItem
            className={`sidebar-item--ipod-playlist${p.waiting ? ' sidebar-item--waiting' : ''}${p.hold ? ' sidebar-item--held' : ''}`}
            wrap
            label={p.name}
            detail={p.hold ? 'needs an answer' : undefined}
            icon={p.source === 'on-the-go' ? <OnTheGoIcon /> : p.source === 'jake' ? <OwnIcon /> : <DefaultIcon />}
            selected={isOpen(p.id)}
            onClick={() => show(p.id)}
            droppable={p.source === 'jake'}
            onDrop={p.source === 'jake'
              ? (ids) => { void askToAddToIpodPlaylist({ device, ipodName, ipodIds, playlist: p, trackIds: ids, library }) }
              : undefined}
          />
        </div>
      ))}
      {naming?.id === null ? nameBox(null) : (
        <SidebarItem
          className="sidebar-item--ipod-playlist sidebar-item--ipod-new"
          wrap
          label={`New Playlist on ${ipodName}…`}
          icon={<NewIcon />}
          onClick={() => { setNaming({ id: null, value: '' }); setError(null) }}
        />
      )}
      {error && <li className="sidebar-ipod-playlists-error" role="alert">{error}</li>}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Rename…', onClick: () => { setNaming({ id: menu.id, value: menu.name }); setMenu(null) } },
            { label: 'Delete…', onClick: () => { setConfirmDelete({ id: menu.id, name: menu.name }); setMenu(null) } },
          ]}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          message={`Delete “${confirmDelete.name}” from ${ipodName}?`}
          detail={`The songs stay on ${ipodName} and in your library. The playlist leaves ${ipodName} at its next sync.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const target = confirmDelete
            setConfirmDelete(null)
            void deleteIpodPlaylist({ device, ipodName, id: target.id }).then((r) => {
              if (!r.ok) { setNotice(r.error, { kind: 'error', durationMs: 5000 }); return }
              if (getOpenIpodPlaylistKey() === `${device}/${target.id}`) props.openOwnList()
            })
          }}
        />
      )}
    </ul>
  )
}
