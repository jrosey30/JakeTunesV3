/**
 * The sidebar's iPODS section (2026-11-07). Jake: "activity sync on the sidebar
 * is obsolete right? the ipod pool for each ipod is in the playlists area...but
 * now that I think about it, they should have their own section".
 *
 * Since one Sync button per iPod (PR #372) each iPod syncs exactly one list:
 *   - the Original: its Top 1000 (homemini's quiz ranking, playlist 'top-1000')
 *   - every other iPod: its own list on homemini (playlist ipodListPlaylistId(id))
 * So the section is one row per registered iPod, opening that list. The
 * Original's hand-built iPod Pool feeds no iPod any more and has no row.
 *
 * Pure — node --test loads it.
 *
 * ⚠️ TWIN (not yet built): JakeTunesMobile shows Top 1000 and each iPod's list as
 * built-in playlists (backend/src/util/builtInPlaylists.ts, ios PlaylistGroups.swift).
 */
import { ipodListPlaylistId } from './ipod-list-doc.ts'

export const TOP_1000_PLAYLIST_ID = 'top-1000'

/** One registered iPod, as ipod-devices.json knows it. */
export interface SidebarIpodDevice {
  id: string
  name: string
  color: string | null
  primary: boolean
}

/** One non-Original iPod's list, as the renderer's ipodLists store holds it. */
export interface SidebarIpodList {
  id: string
  name: string
  color: string | null
  ids: readonly number[]
}

export interface SidebarIpodRow {
  /** React key: the marker id, or 'original' when this Mac has never met the Original. */
  key: string
  /** The iPod's name. */
  name: string
  /** What the row opens, shown after the name ("Top 1000"); null for a list iPod. */
  detail: string | null
  /** A safe CSS colour for the dot, or null (grey). */
  color: string | null
  /** The smart playlist id the row opens. */
  playlistId: string
  /** Songs of that list in this library; null = not known yet (homemini hasn't answered). */
  count: number | null
  primary: boolean
}

export interface SidebarIpodInput {
  /** ipod-devices.json, any order. Empty when the read failed or no iPod was ever met. */
  devices: readonly SidebarIpodDevice[]
  /** Every non-Original iPod's list (renderer/ipodLists.ts). */
  lists: readonly SidebarIpodList[]
  /** The Top 1000 song ids, rank order; null until homemini has answered once. */
  top1000Ids: readonly number[] | null
  /** Is this song in the library? (What the playlist page will actually show.) */
  inLibrary: (id: number) => boolean
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const WORD = /^[a-z]{3,20}$/i

/** A marker's colour as something safe to put in a style: a hex or a plain colour word. */
export function safeDotColor(c: string | null | undefined): string | null {
  if (typeof c !== 'string') return null
  const v = c.trim()
  return HEX.test(v) || WORD.test(v) ? v : null
}

function countIn(ids: readonly number[] | null | undefined, inLibrary: (id: number) => boolean): number | null {
  if (!ids) return null
  let n = 0
  for (const id of ids) if (inLibrary(id)) n++
  return n
}

/**
 * The rows, Original first, then the other iPods in the order this Mac met them.
 * The Original always has a row: the Top 1000 is its list even on a Mac that has
 * never had it plugged in (workmini), and it must not vanish from the sidebar.
 */
export function ipodSidebarRows(input: SidebarIpodInput): SidebarIpodRow[] {
  const original = input.devices.find((d) => d.primary) ?? null
  const rows: SidebarIpodRow[] = [{
    key: original?.id ?? 'original',
    name: original?.name?.trim() || 'Original',
    detail: 'Top 1000',
    color: safeDotColor(original?.color),
    playlistId: TOP_1000_PLAYLIST_ID,
    count: countIn(input.top1000Ids, input.inLibrary),
    primary: true,
  }]
  const listById = new Map(input.lists.map((l) => [l.id, l]))
  const seen = new Set<string>()
  const push = (id: string, name: string, color: string | null): void => {
    if (seen.has(id)) return
    seen.add(id)
    const list = listById.get(id)
    rows.push({
      key: id,
      name: name.trim() || list?.name?.trim() || 'iPod',
      detail: null,
      color: safeDotColor(color ?? list?.color),
      playlistId: ipodListPlaylistId(id),
      count: countIn(list?.ids, input.inLibrary),
      primary: false,
    })
  }
  for (const d of input.devices) if (!d.primary) push(d.id, d.name, d.color)
  // A list whose iPod the registry read missed still gets its row.
  for (const l of input.lists) if (!original || l.id !== original.id) push(l.id, l.name, l.color)
  return rows
}
