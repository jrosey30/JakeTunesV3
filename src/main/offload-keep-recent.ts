/**
 * What Jake just got, or just played, stays on this Mac (2026-11-10).
 *
 * Jake imported 311's "Transistor" at 13:13Z. At 13:18Z the offload queue
 * turned the album's files into links to homemini, and the first play of each
 * song waited 7 to 31 s on a busy homemini. PR 401 (the day before) is what
 * made that conversion succeed within minutes; before it most tries failed and
 * the file stayed.
 *
 * The rule: a song added in the last 14 days, played in the last 7, or asked
 * for by the player in the last 6 hours (what is playing, and what the player
 * loaded ahead as next) is not offloaded. Its queue row stays, so it is
 * offloaded later, when it is none of those.
 *
 * Why 14 and 7, measured on the MacBook that day: 1,573 songs (71.7 GB) were
 * added in the last 14 days and 302 (7.8 GB) played in the last 7, against
 * 251 GB free of 926. When the disk has under 60 GB free the windows drop to
 * 2 days each, so this rule can't be what fills it.
 *
 * What it can't see: the play queue itself lives in the renderer. The player's
 * own requests are the nearest thing the main process has, and a queued song
 * the player hasn't loaded yet is still covered by the second rule in
 * flac-variant.ts (its playable copy must be ready on homemini first).
 *
 * Pure; every effect is injected (__tests__/offload-keep-recent.test.ts).
 */

const DAY = 24 * 60 * 60 * 1000
export const KEEP_ADDED_DAYS = 14
export const KEEP_PLAYED_DAYS = 7
/** Under this much free disk the windows become TIGHT_DAYS. */
export const ROOMY_FREE_BYTES = 60 * 1024 * 1024 * 1024
/**
 * They only go back to the long windows at this much free. One edge at 60 GB
 * would flip 1,588 songs between "stays" and "may go" each time the disk
 * crossed it (review of PR 409); with 20 GB between the two edges, dropping
 * a few files can't be what flips them back.
 */
export const ROOMY_ENTER_BYTES = 80 * 1024 * 1024 * 1024
export const TIGHT_DAYS = 2
export const PLAYER_TOUCH_MS = 6 * 60 * 60 * 1000

export interface KeepWindows { addedMs: number; playedMs: number; roomy: boolean }

/**
 * `wasRoomy`: what the last look decided (null = no look yet). Long windows
 * are left under ROOMY_FREE_BYTES and entered only at ROOMY_ENTER_BYTES; a
 * first look is long only at the higher edge.
 */
export function keepWindows(freeBytes: number, wasRoomy: boolean | null = null): KeepWindows {
  const known = Number.isFinite(freeBytes)
  const roomy = known && (wasRoomy === true ? freeBytes >= ROOMY_FREE_BYTES : freeBytes >= ROOMY_ENTER_BYTES)
  return roomy
    ? { addedMs: KEEP_ADDED_DAYS * DAY, playedMs: KEEP_PLAYED_DAYS * DAY, roomy }
    : { addedMs: TIGHT_DAYS * DAY, playedMs: TIGHT_DAYS * DAY, roomy }
}

/**
 * Remembers the last look, so the windows have two edges (keepWindows). With a
 * `store` the side is kept across restarts: between 60 and 80 GB free a
 * restart must not turn long windows into tight ones. A store that fails to
 * load is "no look yet"; one that fails to save costs nothing but the memory.
 */
export function createKeepWindowState(store?: {
  load: () => Promise<boolean | null>
  save: (roomy: boolean) => Promise<void>
}): { look(freeBytes: number): Promise<KeepWindows> } {
  let was: boolean | null = null
  let loaded = !store
  return {
    async look(freeBytes) {
      if (!loaded) {
        loaded = true
        try { const saved = await store!.load(); was = typeof saved === 'boolean' ? saved : null } catch { was = null }
      }
      const w = keepWindows(freeBytes, was)
      if (store && w.roomy !== was) await store.save(w.roomy).catch(() => undefined)
      was = w.roomy
      return w
    },
  }
}

/** Epoch ms from the library's two shapes: an ISO string (dateAdded) or a number (lastPlayedAt). */
export function whenMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  if (typeof v !== 'string' || !v.trim()) return null
  const n = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export interface RecentTrack { path?: unknown; dateAdded?: unknown; lastPlayedAt?: unknown }

/** Why this song stays, or null. A date in the future (a clock step) counts as recent. */
export function recentReason(t: RecentTrack, now: number, w: KeepWindows): 'added' | 'played' | null {
  const added = whenMs(t.dateAdded)
  if (added != null && now - added < w.addedMs) return 'added'
  const played = whenMs(t.lastPlayedAt)
  if (played != null && now - played < w.playedMs) return 'played'
  return null
}

/** Colon path → why it stays, for every recent song in the library. */
export function buildRecentKeep(tracks: ReadonlyArray<RecentTrack>, now: number, w: KeepWindows): Map<string, 'added' | 'played'> {
  const out = new Map<string, 'added' | 'played'>()
  for (const t of tracks) {
    const p = typeof t?.path === 'string' ? t.path : ''
    if (!p) continue
    const why = recentReason(t, now, w)
    if (why) out.set(p, why)
  }
  return out
}

/** The paths kept because they were ADDED lately (not merely played): the only songs worth fetching back. */
export function addedLately(keep: ReadonlyMap<string, 'added' | 'played'>): Set<string> {
  const out = new Set<string>()
  for (const [p, why] of keep) if (why === 'added') out.add(p)
  return out
}

/** ":iPod_Control:Music:F01:x.m4a" from an absolute path, or null. */
export function colonFromAbs(absPath: string): string | null {
  const i = absPath.indexOf('iPod_Control')
  return i < 0 ? null : ':' + absPath.slice(i).replace(/[\\/]/g, ':')
}

/** The songs the player asked for lately: what is playing and what it loaded ahead. In memory only. */
export interface PlayerTouches {
  noteAbs(absPath: string, now: number): void
  has(colonPath: string, now: number): boolean
  /** Every path asked for inside the window with when it was last asked for, newest first. */
  recent(now: number): Array<{ path: string; at: number }>
  readonly size: number
}

export function createPlayerTouches(windowMs = PLAYER_TOUCH_MS, max = 5000): PlayerTouches {
  const at = new Map<string, number>()
  return {
    noteAbs(absPath, now) {
      const colon = colonFromAbs(absPath)
      if (!colon) return
      at.delete(colon)   // re-insert: the Map's order is "least recently asked first"
      at.set(colon, now)
      if (at.size > max) at.delete(at.keys().next().value as string)
    },
    has(colonPath, now) {
      const t = at.get(colonPath)
      if (t == null) return false
      if (now - t >= windowMs) { at.delete(colonPath); return false }
      return true
    },
    recent(now) {
      return [...at].filter(([, t]) => now - t < windowMs).map(([path, t]) => ({ path, at: t })).reverse()
    },
    get size() { return at.size },
  }
}
