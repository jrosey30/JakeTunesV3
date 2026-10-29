/**
 * Concerts IPC (2026-10-19). The client and its cache live in
 * ../concerts-client.ts; the shape and rules in ../../common/concerts-feed.ts.
 *
 *   'concerts:get'      → { ok, state }   cache or the fallback's last answer, no network — instant
 *   'concerts:refresh'  → { ok, state }   GET both routes (throttled); the fallback if they fail
 *   push 'concerts-updated' (state)       whenever what the Home draws changes
 *
 * Replaces 'get-tour-dates' and 'get-venue-shows' (moved here from index.ts):
 * their work — Bandsintown for the top-60 library artists, the venue calendars
 * with library artists marked — is now the offline fallback, reshaped into
 * feed items by legacyConcertItems(), so the section never goes empty.
 *
 * Going / I went (2026-10-29) — ../concerts-going-client.ts, rules in
 * ../../common/concerts-going.ts; answers live on homemini only:
 *   'concerts:rsvps'          → { ok, items }   every RSVP (the "Were you there?" ask included)
 *   'concerts:set-going'      (eventId, going: boolean, show?) → { ok }
 *   'concerts:set-attended'   (eventId, 'yes' | 'no' | null)   → { ok }
 *   'concerts:lately'         (artist) → { ok, lately }  "What they've been playing"; null = draw nothing
 *
 * Refresh cadence: shortly after boot, every 30 minutes (the collector runs a
 * few times a day; most polls are a 304), and when a JakeTunes window gains
 * focus (at most every 5 minutes). Read-only toward homemini.
 */
import { app, BrowserWindow } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { quietWarn } from '../flight-recorder'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'
import { createConcertsClient } from '../concerts-client.ts'
import { createConcertsGoingClient } from '../concerts-going-client.ts'
import type { AttendedAnswer, RsvpShow } from '../../common/concerts-going.ts'
import { getTourDatesForArtists } from '../external'
import { getVenueShows, markKnownShows } from '../venues'
import { librarySpellings } from '../artist-spellings-store.ts'
import { legacyConcertItems, type ConcertItem, type ConcertsFeedState } from '../../common/concerts-feed.ts'

const EVERY_MS = 30 * 60_000
const FIRST_MS = 8_000
/** Focus / Home-mount refreshes closer together than this reuse the last answer. */
const MIN_GAP_MS = 5 * 60_000

type LibTrack = { artist?: string; albumArtist?: string; playCount?: number }

export interface ConcertsIpcHost {
  libraryCache: { get: () => Promise<{ tracks?: unknown[] } | unknown> }
  /** The app's shared MusicBrainz throttle (index.ts) — for the non-Latin spellings. */
  mbThrottle: () => Promise<void>
}

export interface ConcertsIpc {
  /** The ranked feed for the Music Man (Record Store day theme): null when
   *  nothing at all is available, so it can take its own Bandsintown path. */
  forMusicMan: () => Promise<ConcertItem[] | null>
}

/** Top library artists by aggregate plays, +1 per track so unplayed artists
 *  still register — the exact pick the old 'get-tour-dates' made. */
function topArtists(tracks: LibTrack[], limit: number): string[] {
  const byArtist = new Map<string, number>()
  for (const t of tracks) {
    const a = (t.albumArtist || t.artist || '').trim()
    if (!a || a.toLowerCase() === 'unknown artist') continue
    byArtist.set(a, (byArtist.get(a) || 0) + (Number(t.playCount) || 0) + 1)
  }
  return [...byArtist.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([a]) => a)
}

export function registerConcertsIpc(ipc: IpcRegistrar, host: ConcertsIpcHost): ConcertsIpc {
  const legacy = async (): Promise<ConcertItem[]> => {
    const lib = await host.libraryCache.get()
    const tracks = (Array.isArray((lib as { tracks?: unknown[] })?.tracks) ? (lib as { tracks: unknown[] }).tracks : []) as LibTrack[]
    const [tour, venues] = await Promise.all([
      getTourDatesForArtists(topArtists(tracks, 60)).catch((err: unknown) => {
        quietWarn('concerts:bandsintown', '[concerts] Bandsintown fallback failed:', err instanceof Error ? err.message : err)
        return []
      }),
      getVenueShows().catch((err: unknown) => {
        quietWarn('concerts:venues', '[concerts] venue-calendar fallback failed:', err instanceof Error ? err.message : err)
        return []
      }),
    ])
    const spellings = await librarySpellings(tracks, { throttle: host.mbThrottle, userAgent: `JakeTunes/${app.getVersion()} (jacobrosenbaum@gmail.com)` })
    return legacyConcertItems(tour.slice(0, 60), markKnownShows(venues, tracks, spellings).slice(0, 120), Date.now())
  }

  const client = createConcertsClient({
    baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    dir: app.getPath('userData'),
    legacy,
    log: (m: string) => console.log(m),
    warn: (key: string, m: string) => quietWarn(`concerts:${key}`, m),
  })

  client.onChange((state) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('concerts-updated', state)
    }
  })

  let lastAttempt = 0
  const refresh = (force: boolean): Promise<ConcertsFeedState> => {
    if (!force && Date.now() - lastAttempt < MIN_GAP_MS) return client.read()
    lastAttempt = Date.now()
    return client.refresh()
  }

  ipc.handle('concerts:get', async () => ({ ok: true, state: await client.read() }), { refuse: REFUSED_SENDER })

  const going = createConcertsGoingClient({ baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, '') })
  const text = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
  ipc.handle('concerts:rsvps', async () => {
    const items = await going.rsvps()
    return items ? { ok: true, items } : { ok: false, items: [] }
  }, { refuse: REFUSED_SENDER })
  ipc.handle('concerts:set-going', async (_e, eventId: unknown, on: unknown, show: unknown) => {
    const id = text(eventId)
    if (!id) return { ok: false }
    const snap = show && typeof show === 'object' && text((show as RsvpShow).artist) && text((show as RsvpShow).venue) && text((show as RsvpShow).date, 10)
      ? (show as RsvpShow) : null
    const ok = await going.setGoing(id, on === true ? 'going' : null, snap)
    // The feed carries `rsvp` per item: re-read it so the cards agree.
    if (ok) tick(true)
    return { ok }
  }, { refuse: REFUSED_SENDER })
  ipc.handle('concerts:set-attended', async (_e, eventId: unknown, answer: unknown) => {
    const id = text(eventId)
    if (!id) return { ok: false }
    const a: AttendedAnswer | null = answer === 'yes' || answer === 'no' ? answer : null
    return { ok: await going.setAttended(id, a) }
  }, { refuse: REFUSED_SENDER })
  ipc.handle('concerts:lately', async (_e, artist: unknown) => {
    const a = text(artist, 200)
    return { ok: true, lately: a ? await going.lately(a) : null }
  }, { refuse: REFUSED_SENDER })
  ipc.handle('concerts:refresh', async () => ({ ok: true, state: await refresh(false) }), { refuse: REFUSED_SENDER })

  const tick = (force: boolean): void => {
    void refresh(force).catch((err: unknown) =>
      quietWarn('concerts:tick', '[concerts] refresh failed:', err instanceof Error ? err.message : err))
  }
  setTimeout(() => tick(true), FIRST_MS)
  setInterval(() => tick(true), EVERY_MS)
  app.on('browser-window-focus', () => tick(false))

  return {
    forMusicMan: async () => {
      const state = await refresh(false)
      return state.source === 'none' ? null : state.items
    },
  }
}
