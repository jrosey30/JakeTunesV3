/**
 * The sidebar's iPODS section (2026-11-07). Jake: "activity sync on the sidebar
 * is obsolete right? the ipod pool for each ipod is in the playlists area...but
 * now that I think about it, they should have their own section".
 *
 * Since one Sync button per iPod (PR #372) each iPod syncs exactly one list:
 *   - the Original: its Top 1000 (homemini's quiz ranking, playlist 'top-1000')
 *   - every other iPod: its own list on homemini (playlist ipodListPlaylistId(id))
 *
 * One place (2026-11-09). Jake: "i dont see punkpod on workmini for some reason.
 * and why are there 2 places that i can access the ipod playlists on the same
 * side bar?" The rows came from THIS Mac's ipod-devices.json, so a Mac that never
 * had punkPod plugged in had no punkPod row, and a pin on Top 1000 drew it a
 * second time at the top of PLAYLISTS. Now the section is every list homemini
 * keeps, on every Mac: Top 1000 first, then each list by name. And: "they
 * shouldnt have to be plugged into homemini and workmini....those 2 see the ipod
 * playlists as ipod playlists but really just playlists. macbook is the only one
 * that actually syncs and works directly with each ipod". So:
 *   - the hub (the MacBook): the iPod bits — the registry's colour (since 2026-11-09 the
 *     row draws the iPod itself, utils/ipodCovers.ts, not a dot), the
 *     Original's name, "planned" on a list no iPod carries yet;
 *   - a replica (homemini's and workmini's apps): plain playlists, nothing read
 *     from the registry, nothing about plugging in or syncing.
 * A pinned iPod list stays in this section (moved up, after Top 1000) and is
 * never drawn again under PLAYLISTS (isIpodPlaylistId).
 *
 * Pure — node --test loads it.
 *
 * ⚠️ TWIN: JakeTunesMobile ios PlaylistGroups.swift (2026-11-09) draws the same iPODS
 * section on the phone: Top 1000 first, a pinned list next, the rest by name, from
 * homemini's built-in playlists (backend/src/util/builtInPlaylists.ts).
 */
import { ipodListPlaylistId, parseIpodListPlaylistId } from './ipod-list-doc.ts'

export const TOP_1000_PLAYLIST_ID = 'top-1000'

/** Is this playlist id one of the iPODS section's rows? (Top 1000 or an iPod list.) */
export function isIpodPlaylistId(id: string | null | undefined): boolean {
  return id === TOP_1000_PLAYLIST_ID || parseIpodListPlaylistId(id) !== null
}

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
  /** An iPod in this Mac's registry carries it (hub only). false/absent = homemini keeps it for an iPod not set up here. */
  registered?: boolean
}

export interface SidebarIpodRow {
  /** React key: the marker id, or 'original' / 'top-1000' when no Original is known. */
  key: string
  /** The list's name (renamed by hand, 2026-11-09), else the iPod's; the Top 1000's name on a replica. */
  name: string
  /** A quieter second part after the name: the Top 1000's name on the Original's row, "planned" on a list no iPod carries yet (hub only). */
  detail: string | null
  /** A safe CSS colour for the dot, or null (grey). Always null on a replica. */
  color: string | null
  /** The smart playlist id the row opens. */
  playlistId: string
  /** Songs of that list in this library; null = not known yet (homemini hasn't answered). */
  count: number | null
  primary: boolean
  /** Hub only: homemini keeps this list but no iPod in this Mac's registry carries it. */
  planned: boolean
}

export type SidebarIpodRole = 'hub' | 'replica'

export interface SidebarIpodInput {
  /** 'hub' (the MacBook: syncs iPods, shows their colours) or 'replica' (plain playlists). Default 'hub'. */
  role?: SidebarIpodRole
  /** ipod-devices.json, any order. Empty when the read failed or no iPod was ever met. Ignored on a replica. */
  devices: readonly SidebarIpodDevice[]
  /** Every list homemini keeps, registered or not (renderer/ipodLists.ts). */
  lists: readonly SidebarIpodList[]
  /** The Top 1000 song ids, rank order; null until homemini has answered once. */
  top1000Ids: readonly number[] | null
  /** Is this song in the library? (What the playlist page will actually show.) */
  inLibrary: (id: number) => boolean
  /** The pinned playlist ids (playlist-pins.json). A pinned list moves up, right after Top 1000. */
  pinned?: readonly string[]
  /** The Top 1000's display name (renamed by Jake, 2026-11-09; renderer/top1000Name.ts). Default "Top 1000". */
  top1000Name?: string
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

const byName = (a: SidebarIpodRow, b: SidebarIpodRow): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key)

/**
 * The rows: Top 1000 first, then every list by name (a pinned one first, in pin
 * order). Top 1000 always has a row, on every Mac. A list homemini keeps always
 * has a row, whether or not this Mac has met its iPod (workmini never has).
 */
export function ipodSidebarRows(input: SidebarIpodInput): SidebarIpodRow[] {
  const hub = (input.role ?? 'hub') === 'hub'
  const devices = hub ? input.devices : []
  const original = devices.find((d) => d.primary) ?? null
  const topName = input.top1000Name?.trim() || 'Top 1000'
  const first: SidebarIpodRow = hub
    ? {
        key: original?.id ?? 'original',
        name: original?.name?.trim() || 'Original',
        detail: topName,
        color: safeDotColor(original?.color),
        playlistId: TOP_1000_PLAYLIST_ID,
        count: countIn(input.top1000Ids, input.inLibrary),
        primary: true,
        planned: false,
      }
    : {
        key: TOP_1000_PLAYLIST_ID,
        name: topName,
        detail: null,
        color: null,
        playlistId: TOP_1000_PLAYLIST_ID,
        count: countIn(input.top1000Ids, input.inLibrary),
        primary: true,
        planned: false,
      }
  const listById = new Map(input.lists.map((l) => [l.id, l]))
  const deviceIds = new Set(devices.map((d) => d.id))
  const seen = new Set<string>()
  const rest: SidebarIpodRow[] = []
  const push = (id: string, name: string, color: string | null): void => {
    if (seen.has(id) || (original && id === original.id)) return
    seen.add(id)
    const list = listById.get(id)
    const planned = hub && !deviceIds.has(id) && list?.registered !== true
    rest.push({
      key: id,
      // The list's own name first (2026-11-09: a list is renamed on its own; the iPod keeps its name).
      name: list?.name?.trim() || name.trim() || 'iPod',
      detail: planned ? 'planned' : null,
      color: hub && !planned ? safeDotColor(color ?? list?.color) : null,
      playlistId: ipodListPlaylistId(id),
      count: countIn(list?.ids, input.inLibrary),
      primary: false,
      planned,
    })
  }
  for (const d of devices) if (!d.primary) push(d.id, d.name, d.color)
  for (const l of input.lists) push(l.id, l.name, l.color)
  rest.sort(byName)
  const pins = (input.pinned ?? []).filter((p) => p !== TOP_1000_PLAYLIST_ID)
  const pinnedRows = pins.map((p) => rest.find((r) => r.playlistId === p)).filter((r): r is SidebarIpodRow => r !== undefined)
  return [first, ...pinnedRows, ...rest.filter((r) => !pinnedRows.includes(r))]
}
