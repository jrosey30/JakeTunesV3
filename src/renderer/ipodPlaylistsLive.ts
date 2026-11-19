// Keeping an iPod's playlists fresh while they are on screen (Brief 250, 2026-11-19).
//
// A sidebar row stays mounted for the life of the window, so asking only when the
// hook mounted read homemini once at launch: 23 playlists PUT for the Best of
// Bandcamp iPod never reached the MacBook's row. Now each iPod on screen is asked
// again on window focus (or becoming visible), every 5 minutes while visible, and
// when the library-version poll moves (replicas only). Those asks are at most one
// per device per 30 s; overlapping ones are one request through
// refreshIpodPlaylists' inFlight map. Pure: the window is passed in, so the rules
// are tested without a DOM.

export const IPOD_PLAYLISTS_REFRESH_MS = 5 * 60_000
export const IPOD_PLAYLISTS_MIN_GAP_MS = 30_000

export interface IpodPlaylistsLiveDeps {
  /** A fresh read of one iPod (coalesced by the caller). */
  refresh: (device: string, ipodName: string) => unknown
  now: () => number
  /** The window can be seen (not minimised or hidden). */
  visible: () => boolean
  /** Start a repeating timer; returns its stop. */
  every: (fn: () => void, ms: number) => () => void
  /** Window focus, or becoming visible; returns its stop. */
  onWake: (fn: () => void) => () => void
  /** The library-version poll moved; returns its stop. */
  onLibraryMoved: (fn: () => void) => () => void
}

export interface IpodPlaylistsLive {
  /** This iPod is on screen: ask now, then keep it fresh. Returns the release. */
  watch: (device: string, ipodName: string) => () => void
  /** Devices on screen now (tests). */
  watching: () => string[]
}

export function createIpodPlaylistsLive(deps: IpodPlaylistsLiveDeps): IpodPlaylistsLive {
  const live = new Map<string, { ipodName: string; count: number }>()
  const lastAsked = new Map<string, number>()
  let stops: Array<() => void> | null = null

  function ask(device: string, force: boolean): void {
    const e = live.get(device)
    if (!e) return
    const t = deps.now()
    const last = lastAsked.get(device)
    if (!force && last !== undefined && t - last < IPOD_PLAYLISTS_MIN_GAP_MS) return
    lastAsked.set(device, t)
    void deps.refresh(device, e.ipodName)
  }
  function askAll(): void {
    if (!deps.visible()) return
    for (const device of live.keys()) ask(device, false)
  }

  function start(): void {
    if (stops) return
    stops = [
      deps.every(askAll, IPOD_PLAYLISTS_REFRESH_MS),
      deps.onWake(askAll),
      deps.onLibraryMoved(askAll),
    ]
  }
  function stop(): void {
    if (!stops) return
    for (const s of stops) s()
    stops = null
  }

  return {
    watch(device, ipodName) {
      const e = live.get(device)
      if (e) { e.count++; e.ipodName = ipodName } else live.set(device, { ipodName, count: 1 })
      start()
      ask(device, true)
      let released = false
      return () => {
        if (released) return
        released = true
        const cur = live.get(device)
        if (!cur) return
        cur.count--
        if (cur.count <= 0) live.delete(device)
        if (live.size === 0) stop()
      }
    },
    watching: () => [...live.keys()],
  }
}
