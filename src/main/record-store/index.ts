// Music Man's Record Store — main-process registration (Brief 037 §6)
//
// Phase 1 integration: the get-shelves / get-blurb handlers now drive
// the real engine (1a-1e) instead of the Phase-0 heuristic stub:
//   get-shelves → candidate pools (1a) + external context (1b) +
//                 listening summary + the combined day-theme/shelf
//                 Sonnet call (1c/1d), cached per local-calendar-date.
//   get-blurb   → relationship-aware Haiku take (1e), cached forever.
//
// The module stays Electron- and SDK-decoupled: index.ts injects the
// library/play-event readers, the persona core (MUSIC_MAN_CORE), and an
// `llm` adapter over claudeCall (§3.6 — no new SDK, no new keys).
//
// speak-blurb / cancel-speech remain Phase-0 stubs; Phase 2 wires them
// to the ElevenLabs TTS bridge + the duck pattern.

import type { BrowserWindow } from 'electron'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { RecordStoreCache } from './cache'
import type { Blurb, Persona, ShelfBundle } from './types'
import type { CandTrack } from './candidate-pool'
import {
  buildListeningSummary,
  buildShelfPools,
  generateShelves,
  type PlayEvent,
  type RecordStoreLlm,
} from './shelf-generator'
import { gatherExternalContext, topLibraryArtists } from './external-context'
import { buildItemRelationship, generateBlurb } from './blurb-generator'

// ── Public registration surface ──────────────────────────────────────

/** Empty wall returned when a non-main-window sender is refused. */
const REFUSED_SHELVES: ShelfBundle = {
  date: '',
  generatedAt: 0,
  validUntil: 0,
  theme: { date: '', theme: '', rationale: '', source: 'mood' },
  shelves: [],
  source: 'cached',
}

export interface RecordStoreDeps {
  /** Default-deny registrar — LLM spend + TTS stubs are main-window only. */
  ipc: IpcRegistrar
  /** Absolute path of the JakeTunes user-data dir (where the cache
   *  lives). Pass app.getPath('userData'). */
  userDataDir: string
  getMainWindow: () => BrowserWindow | null
  /** Canonical merged-library tracks (from libraryCache). The engine
   *  reads playCount / skipCount / lastPlayedAt / genre / year /
   *  trackCount off these — all native library.json fields. */
  getTracks: () => Promise<CandTrack[]>
  /** Parsed play events for 30d/7d windowing + time-of-day (§3.2). */
  getPlayEvents: () => Promise<PlayEvent[]>
  /** LLM adapter wrapping claudeCall (§3.6). Returns assistant text. */
  llm: RecordStoreLlm
  /** MUSIC_MAN_CORE persona prompt (index.ts owns it). */
  personaCore: string
}

let registered = false

export function registerRecordStoreIntegration(deps: RecordStoreDeps): void {
  // electron-vite main-process HMR can call this twice; the second call
  // would re-register handlers and crash. Guard with module-level flag.
  if (registered) return
  registered = true

  const cache = new RecordStoreCache(deps.userDataDir)
  const { ipc } = deps

  // record-store:get-shelves — first-open-of-day generation (§2 D1).
  // Cached 24h per local-calendar-date so the wall is stable all day.
  // LLM spend — main-window only.
  ipc.handle('record-store:get-shelves', (_e, opts?: { forceRefresh?: boolean }) =>
    resolveShelves(cache, deps, opts),
  { refuse: REFUSED_SHELVES })

  // record-store:get-blurb — lazy, relationship-aware, cached forever
  // per (itemId, persona). Returns null when the LLM is unreachable —
  // no blurb, never an error, never a fabricated take (§8).
  ipc.handle('record-store:get-blurb', (_e, args: { itemId: string; persona: Persona }) =>
    resolveBlurb(cache, deps, args),
  { refuse: null })

  // record-store:speak-blurb — Phase 0 stub. Phase 2 wires this to the
  // existing ElevenLabs TTS bridge + the duck pattern from Radio Mode.
  ipc.handle(
    'record-store:speak-blurb',
    async (_e, _args: { blurb: Blurb }): Promise<{ ok: boolean; audioId?: string; error?: string }> => {
      return { ok: true, audioId: `phase0-stub-${Date.now()}` }
    },
    { refuse: REFUSED_SENDER },
  )

  ipc.handle(
    'record-store:cancel-speech',
    async (_e, _args: { audioId: string }): Promise<{ ok: boolean; error?: string }> => {
      return { ok: true }
    },
    { refuse: REFUSED_SENDER },
  )
}

// ── Orchestration (exported so the integration probe drives the exact
//    same path the IPC handlers do — no duplicated logic to drift) ────

/** Resolve today's wall: serve the valid cache, else build it from the
 *  engine (1a-1e) and cache it. Falls back to a prior day's wall, then a
 *  heuristic wall, if the LLM is unreachable (§8). */
export async function resolveShelves(
  cache: RecordStoreCache,
  deps: RecordStoreDeps,
  opts?: { forceRefresh?: boolean },
): Promise<ShelfBundle> {
  const dateISO = todayLocalISODate()

  if (!opts?.forceRefresh) {
    const cached = await cache.getShelfBundle(dateISO)
    if (cached) return cached
  }

  const tracks = await deps.getTracks()
  const events = await deps.getPlayEvents()
  const now = Date.now()

  // Inputs to the combined day-theme + shelf Sonnet call (§1d).
  const summary = buildListeningSummary(tracks, events, now)
  const external = await gatherExternalContext({
    artists: topLibraryArtists(tracks),
    userDataDir: deps.userDataDir,
    forceRefresh: opts?.forceRefresh,
  })
  const themeHistory = await cache.getThemeHistory()
  const recentlyPicked = await cache.getRecentlyPickedIds(dateISO, 14)
  const pools = buildShelfPools(tracks, dateISO, recentlyPicked)

  const bundle = await generateShelves(
    { todayISO: dateISO, summary, external, themeHistory, personaCore: deps.personaCore, pools, llm: deps.llm },
    tracks,
  )

  if (bundle.source === 'llm') {
    await cache.putShelfBundle(bundle)
    // Burn the theme for the 21-day cooldown (§3.4). Heuristic themes
    // are generic, so we don't pollute the cooldown log with them.
    await cache.appendThemeHistory({ date: dateISO, theme: bundle.theme.theme })
    void cache.pruneOldShelves()
    return bundle
  }

  // LLM was unreachable. Prefer a real prior wall over a fresh heuristic
  // one — "served from yesterday" (§8), not an error.
  const stale = await cache.getStaleShelfBundle(dateISO)
  if (stale) return { ...stale, source: 'cached' }

  // No cache to fall back to → serve the heuristic wall, and cache it so
  // the day stays stable if the LLM stays down.
  await cache.putShelfBundle(bundle)
  void cache.pruneOldShelves()
  return bundle
}

/** Resolve a single record's blurb: cached forever, else generated from
 *  the user's relationship with the item (§3.2). null = no blurb (LLM
 *  unreachable / unknown item) — never an error, never fabricated (§8). */
export async function resolveBlurb(
  cache: RecordStoreCache,
  deps: RecordStoreDeps,
  args: { itemId: string; persona: Persona },
): Promise<Blurb | null> {
  const existing = await cache.getBlurb(args.persona, args.itemId)
  if (existing) return existing

  // Locate the item on today's wall to recover its trackIds + shelf.
  const dateISO = todayLocalISODate()
  const bundle = await cache.getStaleShelfBundle(dateISO)
  const shelf = bundle?.shelves.find((s) => s.items.some((i) => i.id === args.itemId))
  const item = shelf?.items.find((i) => i.id === args.itemId)
  if (!item) return null // unknown / stale item id

  const tracks = await deps.getTracks()
  const events = await deps.getPlayEvents()
  const tracksById = new Map(tracks.map((t) => [t.id, t]))
  const relationship = buildItemRelationship(item, tracksById, events, Date.now())

  const blurb = await generateBlurb({
    item,
    shelfTitle: shelf?.title ?? '',
    persona: args.persona,
    relationship,
    personaCore: deps.personaCore,
    llm: deps.llm,
  })
  if (blurb) await cache.putBlurb(blurb)
  return blurb
}

// ── Internals ────────────────────────────────────────────────────────

/** Local-time YYYY-MM-DD so the cache rolls over at the user's
 *  midnight, not UTC midnight. */
function todayLocalISODate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
