/**
 * Synced sidebar pins (2026-08-28) — the last per-machine piece of the
 * Spotify-style playlist model.
 *
 * Jake, 2026-08-26: "if i make a new playlist on workmini, it should appear
 * everywhere else too. same order and everything. same pins."
 *
 * Track order already travels (it IS the trackIds array in playlists.json)
 * and the sidebar's ordering is deterministic (pins → defaults → A–Z), so
 * pins were the only state that never left the machine — they lived in
 * ui-state.json, which is deliberately per-machine. They move to their own
 * tiny sidecar, playlist-pins.json, stamped with updatedAt so two machines
 * merge Spotify-style: the LAST change anywhere wins, wholesale. Pins are
 * one small ordered set the user rearranges as a unit — merging them
 * per-entry would invent a sidebar nobody asked for.
 *
 * Electron-free so node --test can load it (the tombstones lesson).
 */
import { readFile, writeFile, rename } from 'fs/promises'
import { join } from 'path'

export interface PlaylistPins {
  /** Raw ids, max 3 — user playlists and smart ids never collide. */
  pinnedPlaylists: string[]
  /** ISO stamp of the last user change — last writer wins across machines. */
  updatedAt: string
}

export const MAX_PINS = 3

export const pinsPath = (stateDir: string): string => join(stateDir, 'playlist-pins.json')

/** Validate an unknown shape into pins, or null if it isn't one. */
export function normalizePins(v: unknown): PlaylistPins | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { pinnedPlaylists?: unknown; updatedAt?: unknown }
  if (!Array.isArray(o.pinnedPlaylists)) return null
  return {
    pinnedPlaylists: o.pinnedPlaylists.filter((x): x is string => typeof x === 'string').slice(0, MAX_PINS),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
  }
}

/** Last writer wins. An empty/missing side never beats a real one. */
export function newestPins(a: PlaylistPins | null, b: PlaylistPins | null): PlaylistPins | null {
  if (!a) return b
  if (!b) return a
  return b.updatedAt > a.updatedAt ? b : a
}

export async function loadPins(file: string): Promise<PlaylistPins | null> {
  try {
    return normalizePins(JSON.parse(await readFile(file, 'utf-8')))
  } catch {
    return null
  }
}

export async function savePins(pins: PlaylistPins, file: string): Promise<void> {
  // Unique tmp name (the ui-state shared-staging-file lesson) + atomic rename.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`
  await writeFile(tmp, JSON.stringify(pins, null, 2), 'utf-8')
  await rename(tmp, file)
}
