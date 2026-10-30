/**
 * Album credits, already there (Jake 2026-10-30: "it should just be there.
 * it shouldnt have to load everytime").
 *
 * Ninety seconds after launch the app starts walking the library's albums —
 * the ones Jake loves, plays and just added first — and asks MusicBrainz for
 * each album not yet in the personnel cache, with the very lookup the album
 * page uses (album-personnel.ts `get`), so by the time a page opens its
 * people, and its released / label / producer line, come off the disk.
 *
 * Pace: one album at a time, and every request through the service's
 * background gate — it waits while a page has a lookup of its own in flight
 * (a user's open always goes first), keeps its own spacing of a request
 * every 2.5 s on top of the app-wide 1.1 s MusicBrainz throttle (both of
 * Jake's Macs do this behind one home IP), and goes through the shared
 * throttle like every other caller. ~2,600 albums × ≤ 3 requests × 2.5 s ≈
 * 5.4 h at worst for a cold cache; every later pass only fills what is new
 * or stale.
 *
 * It remembers where it was (userData/album-personnel-prefetch.json: how many
 * done, the last album, when it started) so a relaunch carries on after the
 * last album instead of starting over, stops when every album is cached,
 * and runs again a day later for the stale ones (empty answers older than
 * 30 days, new albums). After five MusicBrainz failures in a row it waits
 * fifteen minutes rather than hammer a server that is down. Never two at
 * once; `JT_PERSONNEL_PREFETCH=0` turns it off.
 *
 * Every world-touching thing is injected (clock, sleep, files, the service),
 * so the planning and the loop run in the tests on fakes.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.ts'
import { isPersonnelStale, personnelCacheKey, type AlbumPersonnel, type GetOptions, type PersonnelCacheEntry } from './album-personnel.ts'

export const PREFETCH_ENV = 'JT_PERSONNEL_PREFETCH'
/** The app settles first: library loaded, the first page painted, the hub ticks begun. */
export const PREFETCH_START_DELAY_MS = 90_000
/** A finished pass runs again this much later, for what went stale meanwhile. */
export const PREFETCH_RERUN_MS = 24 * 3600 * 1000
export const PREFETCH_LOG_EVERY = 50
/** How often a paused prefetch looks again for the page's lookup to finish. */
export const PREFETCH_BUSY_POLL_MS = 500
/** MusicBrainz failures in a row before the pass pauses, and for how long. */
export const PREFETCH_FAILURES_BEFORE_PAUSE = 5
export const PREFETCH_FAILURE_PAUSE_MS = 15 * 60_000
export const PREFETCH_CURSOR_FILE = 'album-personnel-prefetch.json'

// ── Ranking the library ────────────────────────────────────────────────────

export interface LibraryAlbum {
  /** The album artist (or the artist) and the album, as the page asks for them. */
  artist: string
  album: string
  /** The tag year the credits line's plausibility check runs against ('' = none). */
  year: string
  /** Higher first: rating ×2 (0–5; a starred song is 5), plays ×1, and up to 25 for a fresh add (fading over 90 days). */
  score: number
}

/** The cache key the album page's lookup uses for this album. */
export const libraryAlbumKey = (a: Pick<LibraryAlbum, 'artist' | 'album'>): string => personnelCacheKey(a.artist, a.album)

const DAY_MS = 24 * 3600 * 1000
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * The library's albums, the most-wanted first. Grouped the way the page is
 * (album artist, else artist; and the album title), scored from the tracks'
 * fields: each rating point counts 2 (rating is 0–5; a starred song is 5, so
 * a star is worth 10), each play 1, and an album added lately gets up to 25
 * more, fading to nothing over 90 days — so what Jake loves and plays comes
 * first, then what he just added, then the rest. Ties break on the key, so
 * the order is stable between launches. Tracks without an album or an artist
 * are skipped (nothing to ask).
 */
export function rankLibraryAlbums(tracks: ReadonlyArray<unknown>, now: number = Date.now()): LibraryAlbum[] {
  const acc = new Map<string, { artist: string; album: string; year: string; stars: number; plays: number; newest: number }>()
  for (const raw of tracks) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as Record<string, unknown>
    const artist = str(t.albumArtist) || str(t.artist)
    const album = str(t.album)
    if (!artist || !album) continue
    const key = personnelCacheKey(artist, album)
    let a = acc.get(key)
    if (!a) {
      a = { artist, album, year: '', stars: 0, plays: 0, newest: 0 }
      acc.set(key, a)
    }
    if (!a.year) a.year = str(t.year)
    a.stars += Math.min(num(t.rating), 5)
    a.plays += num(t.playCount)
    const added = Date.parse(str(t.dateAdded))
    if (Number.isFinite(added) && added > a.newest) a.newest = added
  }
  const out: LibraryAlbum[] = []
  for (const a of acc.values()) {
    const ageDays = a.newest ? Math.max(0, (now - a.newest) / DAY_MS) : Infinity
    const recency = ageDays < 90 ? (1 - ageDays / 90) * 25 : 0
    out.push({ artist: a.artist, album: a.album, year: a.year, score: Math.round((a.stars * 2 + a.plays + recency) * 100) / 100 })
  }
  return out.sort((x, y) => y.score - x.score || libraryAlbumKey(x).localeCompare(libraryAlbumKey(y)))
}

// ── The cursor ─────────────────────────────────────────────────────────────

export interface PrefetchCursor {
  v: 1
  /** When this pass began. */
  startedAt: number
  /** Albums processed in this pass (failures included — they are retried next pass). */
  done: number
  /** The last album processed; a relaunch carries on after it. */
  lastKey: string
  /** Set when the pass reached the end of the plan; the next pass is a day later. */
  finishedAt?: number
}

export const prefetchCursorPath = (dir: string): string => join(dir, PREFETCH_CURSOR_FILE)

/** A well-formed cursor, or null — anything odd in the file starts a fresh pass. */
export function normalizePrefetchCursor(raw: unknown): PrefetchCursor | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (!isTime(c.startedAt) || !isTime(c.done) || !Number.isInteger(c.done) || typeof c.lastKey !== 'string') return null
  const out: PrefetchCursor = { v: 1, startedAt: c.startedAt, done: c.done, lastKey: c.lastKey }
  if (isTime(c.finishedAt)) out.finishedAt = c.finishedAt
  return out
}

export async function readPrefetchCursor(file: string, log: (m: string) => void): Promise<PrefetchCursor | null> {
  try {
    return normalizePrefetchCursor(JSON.parse(await readFile(file, 'utf8')))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log(`[album-personnel] prefetch: ${PREFETCH_CURSOR_FILE} unreadable (${err instanceof Error ? err.message : String(err)}) — starting a fresh pass`)
    return null
  }
}

// ── Planning (pure) ────────────────────────────────────────────────────────

export type AlbumStatus = 'fresh' | 'stale' | 'missing'

/** What the cache knows about an album: nothing, an answer, or an answer due a re-check. */
export function albumStatus(entry: PersonnelCacheEntry | undefined, now: number): AlbumStatus {
  if (!entry) return 'missing'
  return isPersonnelStale(entry, now) ? 'stale' : 'fresh'
}

/**
 * The albums this pass fetches, in order: every album not fresh in the
 * cache, ranked — rotated, when a pass is being resumed, so the albums after
 * the cursor's last one come first and the ones before it (the failures, the
 * skipped) are reached at the end rather than lost.
 */
export function planPass(albums: readonly LibraryAlbum[], status: (a: LibraryAlbum) => AlbumStatus, cursor: PrefetchCursor | null): LibraryAlbum[] {
  const todo = albums.filter((a) => status(a) !== 'fresh')
  if (!cursor || cursor.finishedAt || !cursor.lastKey) return todo
  const at = albums.findIndex((a) => libraryAlbumKey(a) === cursor.lastKey)
  if (at < 0) return todo
  const after = new Set(albums.slice(at + 1).map(libraryAlbumKey))
  return [...todo.filter((a) => after.has(libraryAlbumKey(a))), ...todo.filter((a) => !after.has(libraryAlbumKey(a)))]
}

/** How long until the next pass may start: now, unless the last one finished less than a day ago. */
export function nextPassDelay(cursor: PrefetchCursor | null, now: number, rerunMs: number = PREFETCH_RERUN_MS): number {
  if (!cursor?.finishedAt) return 0
  return Math.max(0, cursor.finishedAt + rerunMs - now)
}

/** "1,240 of 2,603 albums known, 980 with credits" */
export function progressLine(statuses: ReadonlyArray<{ status: AlbumStatus; withCredits: boolean }>): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  const known = statuses.filter((s) => s.status !== 'missing').length
  const withCredits = statuses.filter((s) => s.withCredits).length
  return `${n(known)} of ${n(statuses.length)} albums known, ${n(withCredits)} with credits`
}

// ── The loop ───────────────────────────────────────────────────────────────

/** The slice of AlbumPersonnelService the prefetch uses. */
export interface PrefetchService {
  get(artist: string, album: string, opts?: GetOptions): Promise<AlbumPersonnel>
  peek(artist: string, album: string): Promise<PersonnelCacheEntry | undefined>
  busy(): boolean
}

export interface PrefetchDeps {
  /** Where the cursor lives — the app's userData. */
  dir: string
  /** The library's albums, ranked (rankLibraryAlbums). Read at the start of every pass. */
  listAlbums: () => Promise<readonly LibraryAlbum[]> | readonly LibraryAlbum[]
  service: PrefetchService
  /** Fill the page's credits line from what the lookup just learned (no network). */
  fillCredits?: (album: LibraryAlbum) => Promise<void>
  now?: () => number
  wait?: (ms: number) => Promise<void>
  log?: (m: string) => void
  env?: Readonly<Record<string, string | undefined>>
  startDelayMs?: number
  rerunMs?: number
  failurePauseMs?: number
  busyPollMs?: number
}

export interface PrefetchHandle {
  /** False when the kill switch is set. */
  enabled: boolean
  /** Ask the loop to stop after the album in hand. */
  stop(): void
  /** Resolves when the loop has exited (tests). */
  done: Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let running: PrefetchHandle | null = null

/**
 * Start the prefetch — once per process. A second call returns the running
 * one instead of starting another (never two at once). Returns at once; the
 * work begins after `startDelayMs`.
 */
export function startAlbumPersonnelPrefetch(deps: PrefetchDeps): PrefetchHandle {
  if (running) return running
  const log = deps.log ?? ((m: string) => console.log(m))
  if ((deps.env ?? process.env)[PREFETCH_ENV] === '0') {
    log(`[album-personnel] prefetch off (${PREFETCH_ENV}=0)`)
    return { enabled: false, stop: () => undefined, done: Promise.resolve() }
  }
  const now = deps.now ?? Date.now
  const wait = deps.wait ?? sleep
  const file = prefetchCursorPath(deps.dir)
  const rerunMs = deps.rerunMs ?? PREFETCH_RERUN_MS
  const failurePauseMs = deps.failurePauseMs ?? PREFETCH_FAILURE_PAUSE_MS
  const busyPollMs = deps.busyPollMs ?? PREFETCH_BUSY_POLL_MS
  let stopped = false

  const writeCursor = async (c: PrefetchCursor): Promise<void> => {
    try {
      await writeJsonAtomic(file, c)
    } catch (err) {
      log(`[album-personnel] prefetch: could not write ${PREFETCH_CURSOR_FILE}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const progress = async (albums: readonly LibraryAlbum[]): Promise<string> => {
    const statuses: Array<{ status: AlbumStatus; withCredits: boolean }> = []
    for (const a of albums) {
      const e = await deps.service.peek(a.artist, a.album)
      statuses.push({ status: albumStatus(e, now()), withCredits: !!e && e.people.length > 0 })
    }
    return progressLine(statuses)
  }

  const runPass = async (cursor: PrefetchCursor | null): Promise<void> => {
    const albums = await deps.listAlbums()
    const status = new Map<string, AlbumStatus>()
    for (const a of albums) status.set(libraryAlbumKey(a), albumStatus(await deps.service.peek(a.artist, a.album), now()))
    const resumed = cursor && !cursor.finishedAt ? cursor : null
    const plan = planPass(albums, (a) => status.get(libraryAlbumKey(a)) ?? 'missing', resumed)
    const cur: PrefetchCursor = resumed ?? { v: 1, startedAt: now(), done: 0, lastKey: '' }
    if (plan.length) log(`[album-personnel] prefetch: ${resumed ? `resuming after ${cur.done.toLocaleString('en-US')} albums, ` : ''}${plan.length.toLocaleString('en-US')} of ${albums.length.toLocaleString('en-US')} albums to ask about`)
    let failures = 0
    for (const a of plan) {
      while (deps.service.busy() && !stopped) await wait(busyPollMs)
      if (stopped) return
      const r = await deps.service.get(a.artist, a.album, { background: true })
      if (r.ok) {
        failures = 0
        try {
          await deps.fillCredits?.(a)
        } catch (err) {
          log(`[album-personnel] prefetch: credits for ${a.artist} — ${a.album} not filled: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (++failures >= PREFETCH_FAILURES_BEFORE_PAUSE) {
        log(`[album-personnel] prefetch: MusicBrainz is not answering (${r.error}); pausing ${Math.round(failurePauseMs / 60_000)} min`)
        failures = 0
        await wait(failurePauseMs)
      }
      cur.done++
      cur.lastKey = libraryAlbumKey(a)
      await writeCursor(cur)
      if (cur.done % PREFETCH_LOG_EVERY === 0) log(`[album-personnel] prefetch: ${await progress(albums)}`)
      if (stopped) return
    }
    cur.finishedAt = now()
    await writeCursor(cur)
    log(`[album-personnel] prefetch: ${await progress(albums)} — pass complete, next in ${Math.round(rerunMs / 3600_000)} h`)
  }

  const done = (async () => {
    await wait(deps.startDelayMs ?? PREFETCH_START_DELAY_MS)
    while (!stopped) {
      try {
        const cursor = await readPrefetchCursor(file, log)
        const delay = nextPassDelay(cursor, now(), rerunMs)
        if (delay > 0) {
          await wait(delay)
          continue
        }
        await runPass(cursor)
      } catch (err) {
        log(`[album-personnel] prefetch: pass failed (${err instanceof Error ? err.message : String(err)}); retrying in ${Math.round(failurePauseMs / 60_000)} min`)
        await wait(failurePauseMs)
      }
    }
  })().finally(() => { running = null })

  running = { enabled: true, stop: () => { stopped = true }, done }
  return running
}
