/**
 * Overnight pre-load (2026-10-19) — thin-link machines only (workmini today).
 *
 * Jake: "Each night, while the office network is quiet, workmini downloads
 * the songs you're most likely to play (recent adds, heavy rotation, your
 * playlists, island albums) to its own disk. During the day those play
 * locally, with nothing crossing the bad connection. Workmini has about
 * 89 GB free; I'd use up to about 30 GB."
 *
 * Measured on workmini's office network the same day: lookups 1–1.6 s or
 * timing out, Tailscale round trips to homemini 2–4 s, SSH dropping — while
 * ICMP to 1.1.1.1 still answered in ~33 ms and homemini was healthy. Pacing
 * (#179 / #180) keeps JakeTunes light on that link, but every daytime song
 * still had to cross it. This moves the crossing to 01:00–06:00.
 *
 * Not a new cache. Tracks land in the stream spool (stream-spool.ts) under
 * the exact URL + key a daytime play derives (homeminiStreamTarget), so
 * spoolAwareServe serves a pre-loaded song from local disk with no other
 * change. Bytes come from homemini HTTP only — never the NAS mount.
 *
 * One night:
 *   1. Plan (pure, below): the priority list, de-duplicated by stream id.
 *   2. Select: walk it in order against the budget (landed files at their
 *      real size, the rest estimated at the stream bitrate) and write the
 *      pin file, so the spool's cap pass can never evict tonight's picks to
 *      make room for a random daytime track.
 *   3. Fetch what is missing, one at a time through the spool's single slot,
 *      at a 1 MB/s ceiling; pause between tracks while music plays; never
 *      take the disk below 30 GB free; stop at 06:00, at the budget, or
 *      after three link failures in a row. The rest waits for tomorrow.
 *
 * Priority, highest first:
 *   recent-add       added in the last 30 days, newest first
 *   heavy-rotation   played in the last 90 days, most plays first — from
 *                    play-events.jsonl, the per-play log (this Mac's plays +
 *                    iPod round-trips) that Top 25's Last Week / Last Month
 *                    and Home's spotlight already read
 *   island-album     the 10 island albums, slot order, disc / track order
 *   favorite-artist  the 5 favorite artists' tracks, slot order, most played first
 *   playlist         Jake's own playlists, most recently edited first
 *   most-played      everything else with plays, by lifetime playCount
 *
 * Fat-link machines: startOvernightPreload checks the marker once at boot and
 * returns — no timer, no reads, no downloads. Electron-free: every input and
 * effect is injected; src/main/__tests__/overnight-preload.test.ts drives it.
 */
import { readFile, readdir, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { homeminiStreamTarget } from './stream-format.ts'
import {
  preloadSpool, spoolReady, writePreloadPins, spoolLimitsFor, SPOOL_DIR_NAME,
  THIN_LINK_SPOOL_CAP_BYTES, type PreloadOutcome,
} from './stream-spool.ts'
import { parsePlayEvents } from '../common/home-spotlight-doc.ts'
import { createSyncedPicksClient } from './synced-picks-client.ts'
import {
  ISLAND_ALBUMS_SPEC, FAVORITE_ARTISTS_SPEC, islandAlbumKey, identityKey, primaryArtistOf,
  type IslandSlot, type FavoriteSlot,
} from '../common/synced-picks.ts'

// ── Knobs ────────────────────────────────────────────────────────────────

/** Local hours [start, end): 01:00 up to (not including) 06:00. */
export const PRELOAD_WINDOW_START_HOUR = 1
export const PRELOAD_WINDOW_END_HOUR = 6
/** What the pre-load may pin. The spool cap is 30 GB on a thin link; the
 *  2 GB between them stays free for whatever gets played during the day. */
export const PRELOAD_BUDGET_BYTES = THIN_LINK_SPOOL_CAP_BYTES - 2e9
/** Never take the volume below this much free space. */
export const DISK_FLOOR_BYTES = 30e9
/** Night ceiling. The daytime spool pace (96 KB/s for 256 kbps) would need
 *  days for this list; the quiet link carries a lot more. */
export const NIGHT_PACE_BYTES_PER_SEC = 1_000_000
export const RECENT_ADD_DAYS = 30
export const HEAVY_ROTATION_DAYS = 90
/** Three link failures in a row = the link is bad tonight; try tomorrow. */
export const MAX_CONSECUTIVE_FAILURES = 3
const FAILURE_BACKOFF_MS = 30_000
/** Zero body bytes this long = a stalled download. */
const STALL_MS = 20_000
/** homemini transcodes the whole track before its first header. Its ffmpeg
 *  budget is max(120 s, duration / 18x + 60 s) since 2026-10-19 (it was a
 *  flat 120 s, which killed every multi-hour concert). */
const HEADER_TIMEOUT_MS = 120_000
/** A full concert (hours of audio) transcodes far longer before its first
 *  header than a song does — anything this big gets the long wait. Must
 *  outlast the hub's budget for a show (Nassau, 2.6 h: 580 s).
 *  ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/transcodePolicy.ts */
const BIG_FILE_BYTES = 100e6
const BIG_FILE_HEADER_TIMEOUT_MS = 10 * 60_000
/** Concert fetches that fail tonight before the rest of the concerts are
 *  skipped (they're too big to burn the window retrying). */
const MAX_CONCERT_FAILURES = 2
/** Slower than this for the whole file = a trickle, not a link. */
const MIN_RATE_BYTES_PER_SEC = 50_000
/** Playback must have been off this long before the next download — track
 *  changes flip isPlaying off for a moment. */
const RESUME_QUIET_MS = 60_000
const POLL_MS = 5_000
const WATCH_MS = 1_000
/** How often the scheduler looks at the clock. */
const CHECK_EVERY_MS = 5 * 60_000
const DAY_MS = 86_400_000

// ── Inputs ───────────────────────────────────────────────────────────────

export interface PreloadTrack {
  id: number | string
  path?: string
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  /** ms */
  duration?: number
  dateAdded?: string
  playCount?: number
  lastPlayedAt?: number
  discNumber?: number
  trackNumber?: number
  codec?: string
  audioMissing?: boolean
}

export interface PreloadPlaylist {
  id?: string
  name?: string
  trackIds?: ReadonlyArray<number | string>
  modifiedAt?: string
  category?: string
}

export interface PlanInputs {
  tracks: readonly PreloadTrack[]
  plays: ReadonlyArray<{ id: number | string; ts: number }>
  playlists: readonly PreloadPlaylist[]
  islandAlbums: readonly IslandSlot[]
  favoriteArtists: readonly FavoriteSlot[]
  /** Declared Full Live Concerts (live-sets.json): each one's merged
   *  full-show track. Jake 2026-10-19: "add concerts to the overnight
   *  pre-load" — a show is hours long, the slowest thing to stream over
   *  workmini's office link. */
  liveSets?: ReadonlyArray<{ mergedTrackId: number | string; totalDurationMs?: number }>
  now: number
}

export type PreloadTier = 'concert' | 'recent-add' | 'heavy-rotation' | 'island-album' | 'favorite-artist' | 'playlist' | 'most-played'
export const PRELOAD_TIERS: readonly PreloadTier[] = ['concert', 'recent-add', 'heavy-rotation', 'island-album', 'favorite-artist', 'playlist', 'most-played']

export interface PlanEntry { streamId: number | string; track: PreloadTrack; tier: PreloadTier }

// ── Plan (pure) ──────────────────────────────────────────────────────────

/** iPod-imported copies of the built-in smart playlists (rule-driven, hidden
 *  from the sidebar) — not playlists Jake made.
 *  ⚠️ TWIN: src/renderer/utils/playlistMenu.ts SMART_PLAYLIST_NAMES / manualPlaylists. */
export function manualPlaylistFilter(year: number): (p: PreloadPlaylist) => boolean {
  const smart = new Set([
    `Best of ${year}`, 'Recently Added', 'Recently Played', 'Top 25 Most Played', 'My Top Rated',
    'Starred', "Songs You'd Star", 'Classical Music',
  ])
  return (p) => !smart.has(p.name ?? '') && p.category !== 'synced-set'
}

/** Can playback stream this row from homemini at all? Same gates as the pool
 *  (pool-health.ts): audio not missing, and a library path the ipod-audio
 *  handler can map back to an id (it keys on the iPod_Control segment). */
function streamable(t: PreloadTrack): boolean {
  return t.audioMissing !== true && typeof t.path === 'string' && t.path.includes('iPod_Control')
}

const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function buildPreloadPlan(inp: PlanInputs): PlanEntry[] {
  // The id playback will ask homemini for. ⚠️ TWIN: index.ts trackIdForAbsPath —
  // a colon path maps to the LAST library row carrying it.
  const idByPath = new Map<string, number | string>()
  for (const t of inp.tracks) if (t.path) idByPath.set(t.path, t.id)
  const byId = new Map<string, PreloadTrack>()
  for (const t of inp.tracks) byId.set(String(t.id), t)

  const out: PlanEntry[] = []
  const seen = new Set<string>()
  const add = (t: PreloadTrack | undefined, tier: PreloadTier): void => {
    if (!t || !streamable(t)) return
    const streamId = idByPath.get(t.path as string) ?? t.id
    const k = String(streamId)
    if (seen.has(k)) return
    seen.add(k)
    out.push({ streamId, track: byId.get(k) ?? t, tier })
  }

  // 0. Full Live Concerts — first: a few GB in all, and the worst thing to
  // stream live. The merged track's id is stable across machines (library.json
  // travels whole), so a show still missing from THIS machine's library is
  // pre-loaded by id anyway: homemini serves it from its own library.
  for (const s of inp.liveSets ?? []) {
    const k = String(s.mergedTrackId)
    const row = byId.get(k)
    if (row && streamable(row)) { add(row, 'concert'); continue }
    if (seen.has(k) || row?.audioMissing === true) continue
    seen.add(k)
    out.push({ streamId: s.mergedTrackId, track: { id: s.mergedTrackId, codec: 'alac', duration: s.totalDurationMs }, tier: 'concert' })
  }

  // 1. Recent adds
  const addedSince = inp.now - RECENT_ADD_DAYS * DAY_MS
  inp.tracks
    .filter((t) => ms(t.dateAdded) >= addedSince)
    .sort((a, b) => ms(b.dateAdded) - ms(a.dateAdded))
    .forEach((t) => add(t, 'recent-add'))

  // 2. Heavy rotation
  const playedSince = inp.now - HEAVY_ROTATION_DAYS * DAY_MS
  const rotation = new Map<string, { n: number; last: number }>()
  for (const p of inp.plays) {
    if (!(p.ts >= playedSince && p.ts <= inp.now)) continue
    const r = rotation.get(String(p.id)) ?? { n: 0, last: 0 }
    r.n++
    r.last = Math.max(r.last, p.ts)
    rotation.set(String(p.id), r)
  }
  ;[...rotation.entries()]
    .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)
    .forEach(([id]) => add(byId.get(id), 'heavy-rotation'))

  // 3a. Island albums — a slot matches under the primary artist (what the
  // phone writes) or the desktop's grouping artist, like islandSlots.ts.
  const byAlbumKey = new Map<string, PreloadTrack[]>()
  for (const t of inp.tracks) {
    if (!t.album) continue
    const keys = new Set([
      islandAlbumKey({ artist: primaryArtistOf(t), album: t.album }),
      islandAlbumKey({ artist: (t.albumArtist || t.artist || '').trim() || 'Unknown Artist', album: t.album }),
    ])
    for (const k of keys) {
      const list = byAlbumKey.get(k)
      if (list) list.push(t)
      else byAlbumKey.set(k, [t])
    }
  }
  const albumOrder = (a: PreloadTrack, b: PreloadTrack): number =>
    num(a.discNumber) - num(b.discNumber) || num(a.trackNumber) - num(b.trackNumber)
  for (const slot of inp.islandAlbums) {
    if (!slot) continue
    ;[...(byAlbumKey.get(islandAlbumKey(slot)) ?? [])].sort(albumOrder).forEach((t) => add(t, 'island-album'))
  }

  // 3b. Favorite artists
  for (const name of inp.favoriteArtists) {
    if (!name) continue
    const key = identityKey(name)
    inp.tracks
      .filter((t) => [primaryArtistOf(t), t.albumArtist ?? '', t.artist ?? ''].some((a) => a && identityKey(a) === key))
      .sort((a, b) => num(b.playCount) - num(a.playCount) || (a.album ?? '').localeCompare(b.album ?? '') || albumOrder(a, b))
      .forEach((t) => add(t, 'favorite-artist'))
  }

  // 4. Playlists — most recently edited first; never-stamped ones keep file order.
  const manual = manualPlaylistFilter(new Date(inp.now).getFullYear())
  inp.playlists
    .map((p, i) => ({ p, i, at: ms(p.modifiedAt) }))
    .filter(({ p }) => manual(p))
    .sort((a, b) => (Number.isFinite(b.at) ? b.at : -Infinity) - (Number.isFinite(a.at) ? a.at : -Infinity) || a.i - b.i)
    .forEach(({ p }) => { for (const id of p.trackIds ?? []) add(byId.get(String(id)), 'playlist') })

  // 5. The rest of the most-played
  inp.tracks
    .filter((t) => num(t.playCount) > 0)
    .sort((a, b) => num(b.playCount) - num(a.playCount) || num(b.lastPlayedAt) - num(a.lastPlayedAt))
    .forEach((t) => add(t, 'most-played'))

  return out
}

/** Expected size at the stream bitrate (+2% container, + moov). Unknown
 *  length counts as four minutes. */
export function estimateBytes(t: PreloadTrack, kbps: number): number {
  const durMs = num(t.duration) > 0 ? num(t.duration) : 240_000
  return Math.ceil((durMs / 1000) * kbps * 125 * 1.02) + 50_000
}

/** Mirrors index.ts wantsHomeminiFlac for a library row. On a thin link the
 *  variant is AAC either way — passed through so the key is derived exactly
 *  as playback derives it. */
function wantsFlac(t: PreloadTrack): boolean {
  const codec = (t.codec ?? '').toLowerCase()
  const ext = (t.path ?? '').slice((t.path ?? '').lastIndexOf('.')).toLowerCase()
  return codec === 'alac' || ext === '.alac' || (ext === '.m4a' && !codec)
}

/** The URL + spool key a daytime play of this entry will use. */
export function preloadTarget(audioBase: string, kbps: number, e: PlanEntry): { url: string; spoolKey: string } {
  const { url, spoolKey } = homeminiStreamTarget(audioBase, e.streamId, { compressed: true, kbps, wantFlac: wantsFlac(e.track) })
  return { url, spoolKey }
}

export function inPreloadWindow(d: Date): boolean {
  const h = d.getHours()
  return h >= PRELOAD_WINDOW_START_HOUR && h < PRELOAD_WINDOW_END_HOUR
}

// ── One night ────────────────────────────────────────────────────────────

export type StopReason = 'complete' | 'window' | 'budget' | 'disk' | 'playback' | 'errors'

export interface NightReport {
  stoppedBy: StopReason
  listSize: number
  tierCounts: Record<PreloadTier, number>
  /** Of the whole priority list, landed before tonight's downloads. */
  localAtStart: number
  /** Selected (pinned) within the budget. */
  selected: number
  loaded: number
  loadedBytes: number
  pinnedLandedBytes: number
  failures: number
  missing: number
  pausedForPlaybackMs: number
}

export interface NightDeps {
  spoolDir: string
  audioBase: string
  kbps: number
  inputs: () => Promise<PlanInputs>
  isPlaying: () => boolean
  freeBytes: () => Promise<number>
  /** Default: preloadSpool at the night pace through the shared slot. */
  download?: (key: string, url: string, signal: AbortSignal, estBytes: number) => Promise<PreloadOutcome>
  /** Default: spoolReady — the size of a fully landed spool, else null. */
  landedBytes?: (key: string) => Promise<number | null>
  /** Default: writePreloadPins into the spool dir. */
  writePins?: (keys: string[]) => Promise<void>
  /** Default: total of the spool's landed files (for the log). */
  spoolUsage?: () => Promise<number>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  budgetBytes?: number
  floorBytes?: number
  pollMs?: number
  quietMs?: number
  watchMs?: number
  backoffMs?: number
}

const gb = (b: number): string => `${(b / 1e9).toFixed(1)} GB`
export const headerTimeoutFor = (estBytes: number): number => (estBytes > BIG_FILE_BYTES ? BIG_FILE_HEADER_TIMEOUT_MS : HEADER_TIMEOUT_MS)

async function spoolDirUsage(dir: string): Promise<number> {
  let total = 0
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.done')) continue
      try { total += (await stat(join(dir, name))).size } catch { /* raced with the cap pass */ }
    }
  } catch { /* no spool yet */ }
  return total
}

export async function runPreloadNight(deps: NightDeps): Promise<NightReport> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)))
  const log = deps.log ?? ((line: string) => console.log(line))
  const budget = deps.budgetBytes ?? PRELOAD_BUDGET_BYTES
  const floor = deps.floorBytes ?? DISK_FLOOR_BYTES
  const pollMs = deps.pollMs ?? POLL_MS
  const quietMs = deps.quietMs ?? RESUME_QUIET_MS
  const watchMs = deps.watchMs ?? WATCH_MS
  const backoffMs = deps.backoffMs ?? FAILURE_BACKOFF_MS
  const landedBytes = deps.landedBytes ?? (async (key: string) => (await spoolReady(deps.spoolDir, key))?.total ?? null)
  const writePins = deps.writePins ?? ((keys: string[]) => writePreloadPins(deps.spoolDir, keys))
  const spoolUsage = deps.spoolUsage ?? (() => spoolDirUsage(deps.spoolDir))
  const download = deps.download ?? ((key: string, url: string, signal: AbortSignal, est: number) => preloadSpool(deps.spoolDir, key, url, {
    paceBytesPerSec: NIGHT_PACE_BYTES_PER_SEC,
    signal,
    stallMs: STALL_MS,
    headerTimeoutMs: headerTimeoutFor(est),
    deadlineMs: headerTimeoutFor(est) + Math.ceil((est / MIN_RATE_BYTES_PER_SEC) * 1000),
    limits: spoolLimitsFor(true),
  }))

  const plan = buildPreloadPlan(await deps.inputs())
  const tierCounts = Object.fromEntries(PRELOAD_TIERS.map((t) => [t, 0])) as Record<PreloadTier, number>
  for (const e of plan) tierCounts[e.tier]++

  // Select: the longest prefix of the list that fits the budget.
  type Row = { key: string; url: string; est: number; tier: PreloadTier }
  const todo: Row[] = []
  const pins: string[] = []
  let localAtStart = 0
  let selectedBytes = 0
  let pinnedLandedBytes = 0
  let budgetFull = false
  for (const e of plan) {
    const { url, spoolKey } = preloadTarget(deps.audioBase, deps.kbps, e)
    const landed = await landedBytes(spoolKey)
    if (landed !== null) localAtStart++
    if (budgetFull) continue
    const bytes = landed ?? estimateBytes(e.track, deps.kbps)
    if (selectedBytes + bytes > budget) { budgetFull = true; continue }
    selectedBytes += bytes
    pins.push(spoolKey)
    if (landed !== null) pinnedLandedBytes += landed
    else todo.push({ key: spoolKey, url, est: bytes, tier: e.tier })
  }
  await writePins(pins)

  const tiers = PRELOAD_TIERS.map((t) => `${t} ${tierCounts[t]}`).join(', ')
  log(`[preload] night start — priority list ${plan.length} tracks (${tiers}); ${localAtStart} already local; ` +
    `pinning ${pins.length} (${gb(selectedBytes)} of ${gb(budget)} budget), ${todo.length} to fetch; free ${gb(await deps.freeBytes())}`)

  let loaded = 0
  let landedMeanwhile = 0
  let loadedBytes = 0
  let failures = 0
  let consecutive = 0
  let concertFailures = 0
  let missing = 0
  let pausedForPlaybackMs = 0
  let lastPlayingAt = -Infinity
  let stoppedBy: StopReason = budgetFull ? 'budget' : 'complete'

  /** Between tracks: go only once playback has been off for quietMs. */
  const waitForQuiet = async (): Promise<'ok' | 'window' | 'playback'> => {
    let paused = false
    for (;;) {
      const t = now()
      if (deps.isPlaying()) lastPlayingAt = t
      if (!inPreloadWindow(new Date(t))) return paused ? 'playback' : 'window'
      if (t - lastPlayingAt >= quietMs) return 'ok'
      if (!paused) { paused = true; log('[preload] music is playing — paused between tracks') }
      await sleep(pollMs)
      pausedForPlaybackMs += Math.max(0, now() - t)
    }
  }

  walk: for (let i = 0; i < todo.length; i++) {
    const row = todo[i]
    if (row.tier === 'concert' && concertFailures >= MAX_CONCERT_FAILURES) continue
    // Actual sizes can run past the estimates — re-check before each fetch.
    if (pinnedLandedBytes + row.est > budget) { stoppedBy = 'budget'; break }
    const gate = await waitForQuiet()
    if (gate !== 'ok') { stoppedBy = gate; break }
    if ((await deps.freeBytes()) - row.est < floor) { stoppedBy = 'disk'; break }

    // Playback starting (or 06:00) mid-download: abort it, and the slot is
    // free for the playing song's own spool right away.
    const ac = new AbortController()
    let abortedFor: 'playback' | 'window' | null = null
    const watch = setInterval(() => {
      if (deps.isPlaying()) { abortedFor = 'playback'; lastPlayingAt = now(); ac.abort() }
      else if (!inPreloadWindow(new Date(now()))) { abortedFor = 'window'; ac.abort() }
    }, watchMs)
    let out: PreloadOutcome
    try { out = await download(row.key, row.url, ac.signal, row.est) } finally { clearInterval(watch) }

    switch (out.kind) {
      case 'landed':
        loaded++
        loadedBytes += out.bytes
        pinnedLandedBytes += out.bytes
        consecutive = 0
        break
      case 'local':   // a play spooled it meanwhile
        landedMeanwhile++
        pinnedLandedBytes += out.bytes
        consecutive = 0
        break
      case 'aborted':
        if (abortedFor !== 'playback') { stoppedBy = 'window'; break walk }
        i--   // same track again once the music stops
        break
      case 'busy':   // the slot is a playing song's — wait it out
        await sleep(pollMs)
        i--
        break
      case 'missing':   // not on homemini (yet) — not the link's fault
        missing++
        log(`[preload] ${row.key} not on homemini (HTTP ${out.status}) — skipped`)
        break
      case 'failed':
        failures++
        // A failed concert doesn't count as a link failure — a multi-hour
        // transcode can fail on its own; the songs after it still deserve
        // the night. Two failed concerts skip the rest of the concerts.
        if (row.tier === 'concert') {
          concertFailures++
          log(`[preload] concert ${row.key} failed (${concertFailures} tonight): ${out.reason}`)
          break
        }
        consecutive++
        log(`[preload] ${row.key} failed (${consecutive} in a row): ${out.reason}`)
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) { stoppedBy = 'errors'; break walk }
        await sleep(backoffMs * consecutive)
        break
    }
  }

  const localNow = localAtStart + loaded + landedMeanwhile
  const why = { complete: 'whole list is local', window: '06:00', budget: 'budget full', disk: 'disk floor (30 GB free)', playback: '06:00 while music was playing', errors: `${MAX_CONSECUTIVE_FAILURES} link failures in a row` }[stoppedBy]
  log(`[preload] night end — stopped: ${why}; pre-loaded ${loaded} tonight (${gb(loadedBytes)}); ` +
    `pinned ${gb(pinnedLandedBytes)} landed, spool ${gb(await spoolUsage())}; ${localNow}/${plan.length} of the priority list local; ` +
    `${failures} failed, ${missing} missing on homemini, paused for playback ${Math.round(pausedForPlaybackMs / 60_000)} min`)

  return {
    stoppedBy, listSize: plan.length, tierCounts, localAtStart, selected: pins.length,
    loaded, loadedBytes, pinnedLandedBytes, failures, missing, pausedForPlaybackMs,
  }
}

// ── The schedule ─────────────────────────────────────────────────────────

export interface SchedulerDeps {
  /** The stream-compressed marker (and a homemini streaming client). */
  isThinLink: () => Promise<boolean>
  /** Built when a night starts, so it sees that night's settings. */
  night: () => Promise<NightDeps>
  run?: (deps: NightDeps) => Promise<NightReport>
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  log?: (line: string) => void
  checkEveryMs?: number
}

export interface PreloadSchedule { tick: () => Promise<void>; stop: () => void }

const nightKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

/** Fat link → null, and nothing else happens. Thin link → one run per night
 *  inside the window, including right now if the app launches inside it. */
export async function scheduleOvernightPreload(deps: SchedulerDeps): Promise<PreloadSchedule | null> {
  if (!(await deps.isThinLink())) return null
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const run = deps.run ?? runPreloadNight
  let running = false
  let ranNight: string | null = null
  const tick = async (): Promise<void> => {
    const d = new Date(now())
    if (running || !inPreloadWindow(d) || ranNight === nightKey(d)) return
    running = true
    ranNight = nightKey(d)   // every ending — even a throw — waits for tomorrow
    try {
      if (await deps.isThinLink()) await run(await deps.night())
    } catch (err) {
      log(`[preload] night run threw: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      running = false
    }
  }
  const every = deps.setInterval ?? ((fn: () => void, t: number) => setInterval(fn, t))
  const handle = every(() => { void tick() }, deps.checkEveryMs ?? CHECK_EVERY_MS)
  log(`[preload] thin link — overnight pre-load armed (${PRELOAD_WINDOW_START_HOUR}:00–${PRELOAD_WINDOW_END_HOUR}:00 local)`)
  void tick()
  return { tick, stop: () => (deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(handle) }
}

// ── The app's wiring (index.ts passes what only it owns) ─────────────────

export interface PreloadHost {
  userData: string
  audioBase: string
  isPlaying: () => boolean
  streamCompressed: () => Promise<{ on: boolean; kbps: number }>
  isStreamingClient: () => Promise<boolean>
  library: () => Promise<unknown>
  playlists: () => Promise<unknown>
  playEventsPath: string
  /** live-sets.json through the app's cache (Full Live Concerts). */
  liveSets?: () => Promise<unknown>
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** live-sets.json's entries → the merged full-show tracks to pre-load. */
export function liveSetsFrom(raw: unknown): Array<{ mergedTrackId: number | string; totalDurationMs?: number }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const out: Array<{ mergedTrackId: number | string; totalDurationMs?: number }> = []
  for (const v of Object.values(raw as Record<string, unknown>)) {
    const e = v as { mergedTrackId?: unknown; totalDurationMs?: unknown } | null
    const id = e?.mergedTrackId
    if (typeof id !== 'number' && typeof id !== 'string') continue
    out.push({ mergedTrackId: id, totalDurationMs: typeof e?.totalDurationMs === 'number' ? e.totalDurationMs : undefined })
  }
  return out
}

/** Tonight's inputs from this machine's own files — library.json and
 *  playlists.json through the app's caches, play-events.jsonl, and the
 *  island / favorites documents through the synced-picks client's disk-only
 *  read (no network; the cache homemini last served). */
export async function loadPlanInputs(host: PreloadHost, now = Date.now()): Promise<PlanInputs> {
  // baseUrl is never used: read() touches only the local cache + outbox.
  const island = createSyncedPicksClient({ spec: ISLAND_ALBUMS_SPEC, baseUrl: 'http://unused', dir: host.userData })
  const favorites = createSyncedPicksClient({ spec: FAVORITE_ARTISTS_SPEC, baseUrl: 'http://unused', dir: host.userData })
  const [lib, playlists, events, islandState, favoriteState, sets] = await Promise.all([
    host.library(),
    host.playlists(),
    readFile(host.playEventsPath, 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== 'ENOENT') console.warn('[preload] play-events read failed:', err?.message ?? err)
      return ''
    }),
    island.read(),
    favorites.read(),
    (host.liveSets?.() ?? Promise.resolve(null)).catch(() => null),
  ])
  return {
    tracks: arr((lib as { tracks?: unknown })?.tracks) as PreloadTrack[],
    plays: parsePlayEvents(events),
    playlists: arr(playlists) as PreloadPlaylist[],
    islandAlbums: islandState.values,
    favoriteArtists: favoriteState.values,
    liveSets: liveSetsFrom(sets),
    now,
  }
}

async function freeBytesAt(dir: string): Promise<number> {
  try {
    const s = await statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch (err) {
    console.warn('[preload] free-space check failed:', err instanceof Error ? err.message : err)
    return 0   // unknown = treat as full: the disk floor stops the night
  }
}

export function startOvernightPreload(host: PreloadHost): Promise<PreloadSchedule | null> {
  return scheduleOvernightPreload({
    isThinLink: async () => (await host.streamCompressed()).on && (await host.isStreamingClient()),
    night: async () => ({
      spoolDir: join(host.userData, SPOOL_DIR_NAME),
      audioBase: host.audioBase,
      kbps: (await host.streamCompressed()).kbps,
      isPlaying: host.isPlaying,
      inputs: () => loadPlanInputs(host),
      freeBytes: () => freeBytesAt(host.userData),
    }),
  })
}
