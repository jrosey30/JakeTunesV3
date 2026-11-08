/**
 * Activity Sync — dedicated wipe+rebuild engine.
 *
 * This is NOT the full-library copy loop with extra gates. Activity Sync
 * of N (100 / 250 / 500 / 1000) is one pipeline:
 *
 *   1. Board N by identity. Streamed songs are probed on homemini, then
 *      staged one file at a time at copy. Refuse dest collisions and blanks.
 *   2. Wipe Music until two consecutive empty listings.
 *   3. Copy every song (ALAC, or AAC if the convert toggle is on) + F_FULLFSYNC.
 *   4. Two consecutive remounts must show N files at the intended sizes.
 *   5. Build iTunesDB on the Mac. Copy it to the CF. Two remounts must
 *      show the same bytes, md5, and N rows. Never treat a cache parse as N.
 *   6. Retire Play Counts / OTG. TSA by identity. Seal only on all-clear.
 *
 * Success is Mini Songs === N, proven the same way for every target.
 * A shortfall does not write a catalog — that is how 500 became 486.
 *
 * Plug-in / restart cannot call this. origin must be activity-click
 * (enforced in ipod-sync-origin.ts before we run).
 */

import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { appendFile, copyFile, mkdir, readFile, stat, statfs, lstat, unlink } from 'fs/promises'
import { join } from 'path'
import { findIpodMount, isIpodMount, PYTHON_CMD, PYTHON_INSTALL_HINT, remountVolume as platformRemountVolume } from './platform.ts'
import {
  activitySetProven,
  ACTIVITY_WIPE_EMPTY_STREAK,
  ACTIVITY_WIPE_MAX_PASSES,
  catalogBytesMatch,
  catalogOnCardProven,
  exceedsIpodPlayableCeiling,
  fileSizeForItunesDb,
  ipodFirmwareWillList,
  ipodPlayableDestPath,
  needsIpodAlacTranscode,
  sampleRateForItunesDb,
} from './ipod-reconcile.ts'
import {
  tsaActivityOk,
  tsaAllClear,
  tsaBoardPassenger,
  tsaDestCollisions,
  parseTsaSeal,
  tsaNormalizeColonPath,
  tsaRelFromColon,
  tsaScreen,
  tsaSealFromScreen,
  type TsaPassenger,
  type TsaScreen,
  type TsaSeal,
} from './ipod-sync-tsa.ts'
import { ensureContiguousDb as platformEnsureContiguousDb } from './ipod-db-contiguity.ts'
import {
  confirmWriteOnCard,
  flushCardCaches,
  listIpodMusicFiles,
  remountVerifyEntries,
  retireIpodFirmwareScratch,
} from './ipod-sync-card.ts'
import { safeIpcError } from './safe-ipc-error.ts'
import { wipeListingMatchesKeep, keepStreak } from './activity-keep.ts'
import {
  LAST_SYNC_MANIFEST_FILE,
  SWAP_MANIFEST_FORMAT,
  TSA_SEAL_FILE,
  catalogDigest,
  catalogIdsAscend,
  fullCopyLine,
  nextSwapHistory,
  swapBackstop,
  planSwap,
  proveCardForSwap,
  rowsMissingOnCard,
  swapResultLine,
  swapTooBig,
  type CardState,
  type SwapCandidate,
  type SwapManifestRow,
  type SwapPlan,
} from './ipod-swap-sync.ts'
import { startRoundTripGeneration } from './sync-engine/roundtrip.ts'
import { orderForIpodCatalog, conformCatalogIdOrder } from './ipod-catalog-order.ts'
import { REWIPED_NOTE, swapKeptNote } from '../common/sync-failure-copy.ts'
import type { SyncConvertOptions } from './ipc/sync-ipc.ts'
import {
  classifyActivitySyncTracks,
  classifyLocalLibraryFile,
  formatHomeminiPullRefuse,
  formatSyncSetFileRefuse,
} from './activity-boardable.ts'
import {
  diskWriteWouldBreachFloor,
  formatFreeSpaceRefuse,
  type StageTrackResult,
} from './ipod-sync-materialize.ts'
import {
  activityTrackCanBoard, leftOffSong, pickReplacementTracks, planListOnlyBoarding, queueActivityCandidates,
  whyActivityTrackCannotBoard, type LeftOffSong,
} from './activity-fill.ts'
import { orderTracksForIpodTitleIndex, stampIpodSortArtist } from './ipod-artist-sort.ts'

export interface ActivitySyncHost {
  pythonCmd: string
  pythonHint: string
  coreScript: (rel: string) => string
  tempDir: string
  stateDir: string
  pid: number
  musicDir: string
  pathSep: '/' | '\\'
  isMac: boolean
  /** mode/summary: the swap-or-full decision and the result line (sync-progress-model.ts). */
  sendProgress: (p: { phase: string; current: number; total: number; title: string; mode?: 'swap' | 'full'; summary?: string }) => void
  isCancelled: () => boolean
  isStreamedTrackFile: (abs: string) => Promise<boolean>
  buildAacMirror: (src: string, kbps: number) => Promise<string | null>
  buildIpodSafeAlacMirror: (src: string) => Promise<string | null>
  readIpodDatabase: () => Promise<{ tracks: Array<Record<string, unknown>>; playlists?: unknown[] }>
  writeJournal: (phase: string | null) => Promise<void>
  writeManifest: (payload: Record<string, unknown>) => Promise<void>
  writeSeal: (seal: TsaSeal) => Promise<void>
  clearSeal: () => Promise<void>
  writeReport: (r: {
    syncedAt: string
    target: number
    landed: number
    shortfall: number
    verifyPasses: number
    copied: number
    copyErrors: number
    failed: Array<{ id: number; title: string; artist: string; path: string }>
  }) => Promise<void>
  getDetectedMount: () => string | null
  setDetectedMount: (mount: string | null) => void
  /** Range probe. No bytes land on this Mac. A 404 is known before wipe. */
  probeHomeminiTrack: (trackId: number) => Promise<{ ok: boolean; error?: string; bytes?: number }>
  /** One song into a temp file. Caller must cleanup. The library symlink stays. */
  stageTrack: (colonPath: string, trackId: number) => Promise<StageTrackResult>
  /** Free bytes on the laptop volume. Used to refuse a pull under the 10 GB floor. */
  freeBytes: () => Promise<number>
  /** Next eligible library tracks when a boarded song cannot copy.
   *  Needed so 15 firmware-unlistable / dead-path rows do not shrink a
   *  1000-song request to 985. */
  loadReplacementTracks?: (excludeIds: Set<number>, needed: number) => Promise<Array<Record<string, unknown>>>
  /** Tests only: a fake card has no device node to unmount. Production leaves it unset. */
  remountVolume?: typeof platformRemountVolume
  /** Tests only: force the contiguity step to fail. Production leaves it unset. */
  ensureContiguousDb?: typeof platformEnsureContiguousDb
  /** Tests only: the card's size in bytes. Production reads it with statfs. */
  cardCapacityBytes?: (mount: string) => Promise<number | null>
}

export interface ActivitySyncInput {
  tracks: Array<Record<string, unknown>>
  playlists: Array<Record<string, unknown>>
  convertOptions?: SyncConvertOptions
  /** Explicit N (100/250/500/1000). Defaults to tracks.length. */
  requestedTarget?: number
  /** Extra eligible tracks the picker scored but did not board — copy replacements. */
  reserve?: Array<Record<string, unknown>>
  /** A list-only iPod (every iPod but the Original, 2026-11-07): the set is
   *  exactly these tracks. Nothing from the library or a reserve ever takes
   *  a seat; a song that can't go on is left off and named in `leftOff`, and
   *  the set lands that many fewer instead of refusing. */
  listOnly?: boolean
  /** The iPod's own name (its marker): written as the catalog's master playlist
   *  title, which is the name the iPod shows for itself (2026-11-07). */
  ipodName?: string
}

export interface ActivitySyncResult {
  ok: boolean
  copied: number
  /** Songs already on the card by identity + size, left in place (2026-09-19). */
  kept?: number
  copyErrors?: number
  error?: string
  cancelled?: boolean
  target?: number
  landed?: number
  shortfall?: number
  verifyAttempts?: number
  totalTracks?: number
  pathRewrites?: Array<{ id: number; newPath: string }>
  streamed?: number
  destCollisions?: number
  /** Songs whose audio could not be converted for the iPod (a damaged
   *  file, e.g. the 2026-10-10/11 ALAC imports). Skipped and replaced from
   *  reserve so N still means N — never the reason a whole sync stops. */
  unconvertible?: Array<{ id: number; title: string; artist: string }>
  /** List-only sets: what was asked for, and each song left off with why. */
  requested?: number
  leftOff?: LeftOffSong[]
  /** 'swap': only the songs that changed moved (2026-11-07). 'full': wiped and
   *  copied the whole set; fullReason says why in plain words. */
  mode?: 'swap' | 'full'
  fullReason?: string
  swap?: { out: number; in: number; stayed: number; changed: number }
  /** One plain line for the result: "Swapped 7 songs: 7 out, 7 in. 993 stayed." */
  summary?: string
}

export function bindActivityReplacements(
  getLibrary: () => Promise<{ tracks?: Array<Record<string, unknown>> }>,
  getIneligible: () => Promise<Set<number>>,
): NonNullable<ActivitySyncHost['loadReplacementTracks']> {
  return async (excludeIds, needed) => {
    const lib = await getLibrary()
    const picked = pickReplacementTracks(lib.tracks || [], excludeIds, needed, await getIneligible())
    if (picked.length > 0) {
      console.log(`activity-sync: library fallback offered ${picked.length} most-loved song(s) (starred, then most played) as last-resort replacements`)
    }
    return picked
  }
}

function fail(partial: Omit<ActivitySyncResult, 'ok'> & { error: string }): ActivitySyncResult {
  // copied is REQUIRED on ActivitySyncResult and partial carries it, so the
  // explicit key was dead (overwritten by the spread) and the ?? 0 was
  // unreachable. Diagnosed by the mobile session, landed here 2026-08-16
  // to clear the repo-wide type gate. NOT a behaviour change — and do not
  // reorder a default AFTER the spread; that WOULD be one.
  return { ok: false, ...partial }
}

async function spawnJson(cmd: string, args: string[], stdin: string): Promise<{ code: number; stdout: string; stderr: string; err?: Error }> {
  return await new Promise((resolve) => {
    const py = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    py.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    py.on('error', (err: Error) => resolve({ code: -1, stdout, stderr, err }))
    py.stdin.on('error', (err: Error) => resolve({ code: -1, stdout, stderr, err }))
    py.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    try {
      py.stdin.write(stdin)
      py.stdin.end()
    } catch (err) {
      resolve({ code: -1, stdout, stderr, err: err instanceof Error ? err : new Error(String(err)) })
    }
  })
}

async function expandActivityPool(
  host: ActivitySyncHost,
  primary: Array<Record<string, unknown>>,
  reserve: Array<Record<string, unknown>>,
  requested: number,
  listOnly: boolean,
): Promise<{ pool: Array<Record<string, unknown>>; shortfall: number; target: number; leftOff: LeftOffSong[] }> {
  const idOf = (t: Record<string, unknown>) => Number(t.id)
  if (listOnly) {
    // Its own list, nothing else: no library fill, no reserve.
    const plan = planListOnlyBoarding(primary, requested, idOf)
    return { pool: plan.pool, shortfall: 0, target: plan.target, leftOff: plan.leftOff }
  }
  const exclude = new Set([...primary, ...reserve].map(idOf).filter((id) => Number.isFinite(id)))
  let extra: Array<Record<string, unknown>> = []
  if (host.loadReplacementTracks) {
    const need = Math.max(0, requested - primary.filter(activityTrackCanBoard).length) + 40
    extra = await host.loadReplacementTracks(exclude, need)
  }
  const { queue, shortfall } = queueActivityCandidates({
    requested,
    primary,
    reserve,
    extra,
    canBoard: activityTrackCanBoard,
    idOf,
  })
  return { pool: queue, shortfall, target: requested, leftOff: [] }
}

/** A list-only song whose audio homemini could not send (probe, fetch ahead, or copy). */
const LEFT_OFF_NO_FETCH = "homemini couldn't send its audio file"

export async function runActivitySync(host: ActivitySyncHost, input: ActivitySyncInput): Promise<ActivitySyncResult> {
  // Arrivals fetched from homemini before the card is touched (swap only) are
  // held on the Mac until the run ends, however it ends.
  const preStaged = new Map<number, { abs: string; cleanup: () => Promise<void> }>()
  try {
    return await runActivitySyncHolding(host, input, preStaged)
  } finally {
    for (const s of preStaged.values()) {
      await s.cleanup().catch((err) => console.warn('activity-sync: a staged arrival could not be released:', err))
    }
    preStaged.clear()
  }
}

async function runActivitySyncHolding(
  host: ActivitySyncHost,
  input: ActivitySyncInput,
  preStaged: Map<number, { abs: string; cleanup: () => Promise<void> }>,
): Promise<ActivitySyncResult> {
  const playlists = input.playlists
  const convertOptions = input.convertOptions
  const requested = Math.max(1, Math.floor(Number(input.requestedTarget) || input.tracks.length || 0))
  const pathSep = host.pathSep
  const python = host.pythonCmd || PYTHON_CMD || 'python3'
  const remountVolume = host.remountVolume ?? platformRemountVolume
  const ensureContiguousDb = host.ensureContiguousDb ?? platformEnsureContiguousDb

  const listOnly = input.listOnly === true
  // List-only: songs that cannot go on, each with why (result + ledger).
  const leftOff: LeftOffSong[] = []
  let tracks: Array<Record<string, unknown>>
  let target = requested
  {
    const expanded = await expandActivityPool(host, input.tracks, input.reserve || [], requested, listOnly)
    tracks = expanded.pool.slice(0, requested + 40)
    if (listOnly) {
      leftOff.push(...expanded.leftOff)
      target = expanded.target
      if (leftOff.length > 0) {
        console.warn(`activity-sync: list-only set — ${leftOff.length} song(s) left off, landing ${target} of ${requested}:`,
          leftOff.slice(0, 10).map((l) => `${l.artist} — ${l.title} (${l.why})`))
      }
      if (target === 0) {
        return fail({
          copied: 0, target: 0, requested, landed: 0, shortfall: 0, leftOff,
          error: `None of the ${requested} songs on this iPod's list can go on it. Nothing was wiped. ${leftOff.slice(0, 3).map((l) => `${l.artist} — ${l.title}: ${l.why}`).join('; ')}`,
        })
      }
    } else if (expanded.pool.length < requested) {
      console.error(`activity-sync: REFUSING — library only has ${expanded.pool.length} boardable songs for a ${requested}-song set`)
      return fail({
        copied: 0,
        target: requested,
        landed: expanded.pool.length,
        shortfall: requested - expanded.pool.length,
        error: `Activity sync refused — only ${expanded.pool.length} of ${requested} requested songs can land on the iPod (skits, blanks, concert-owned, and firmware-unlistable rows do not count). Nothing was wiped.`,
      })
    }
    if (tracks.length > requested) {
      console.log(`activity-sync: boarded ${requested} with ${tracks.length - requested} replacement(s) in reserve`)
    }
  }

  // List-only: drop rows from the set, name them, and shrink the set to
  // what is left. Never a replacement, never a refusal (unless nothing is left).
  const leaveOff = (keep: (t: Record<string, unknown>) => boolean, why: (t: Record<string, unknown>) => string): void => {
    const next: Array<Record<string, unknown>> = []
    for (const t of tracks) {
      if (keep(t)) next.push(t)
      else leftOff.push(leftOffSong(t, why(t)))
    }
    tracks = next
    target = Math.min(target, tracks.length)
  }

  console.log(`activity-sync: START — dedicated wipe+rebuild for ${target} songs (not the full-library engine)`)

  let mount = host.getDetectedMount()
  if (mount && !(await isIpodMount(mount))) {
    console.error(`activity-sync: refusing stale/non-iPod mount ${mount}`)
    host.setDetectedMount(null)
    mount = null
  }
  if (!mount) {
    mount = await findIpodMount()
    host.setDetectedMount(mount)
  }
  if (!mount) return fail({ copied: 0, error: 'No verified iPod mount detected' })
  try {
    await stat(mount)
  } catch {
    return fail({ copied: 0, error: 'iPod is not mounted' })
  }
  const IPOD_MOUNT = mount
  // Every scratch retire keeps a copy in THIS iPod's state dir first (2026-10-28).
  const retireScratch = (m: string, why: string): Promise<number> =>
    retireIpodFirmwareScratch(m, { stateDir: host.stateDir, reason: `activity sync: ${why}` })
  const LOCAL_MOUNT = host.musicDir.replace(/[/\\]iPod_Control[/\\]Music$/, '')

  // ── 1. Preflight: names, then homemini-pull anything eviction removed ──
  // Unplayable rows are dropped and replaced — they do not count toward N.
  {
    const classified = await classifyActivitySyncTracks(tracks, {
      localMount: LOCAL_MOUNT,
      pathSep,
      lstat,
    })
    if (listOnly && (classified.blanks.length || classified.fileless.length)) {
      const before = tracks.length
      leaveOff((t) => {
        if (!activityTrackCanBoard(t)) return false
        const label = `${String(t.title || '').trim()} — ${String(t.artist || '').trim()}`
        if (classified.fileless.some((f) => f.startsWith(label))) return false
        if (classified.blanks.some((b) => b.includes(`id ${t.id}:`))) return false
        return true
      }, (t) => whyActivityTrackCannotBoard(t) || 'its audio file is not on this Mac or homemini')
      console.warn(`activity-sync: list-only set — left off ${before - tracks.length} song(s) with no playable file; landing ${target}`)
    } else if (classified.blanks.length || classified.fileless.length) {
      const before = tracks.length
      tracks = tracks.filter((t) => {
        if (!activityTrackCanBoard(t)) return false
        const label = `${String(t.title || '').trim()} — ${String(t.artist || '').trim()}`
        if (classified.fileless.some((f) => f.startsWith(label))) return false
        if (classified.blanks.some((b) => b.includes(`id ${t.id}:`))) return false
        return true
      })
      console.warn(`activity-sync: dropped ${before - tracks.length} unplayable row(s); filling from reserve so ${target} still means ${target}`)
      if (tracks.filter(activityTrackCanBoard).length < target && host.loadReplacementTracks) {
        const have = new Set(tracks.map((t) => Number(t.id)))
        const more = await host.loadReplacementTracks(have, target - tracks.length + 20)
        tracks = queueActivityCandidates({
          requested: target + 40,
          primary: tracks,
          extra: more,
          canBoard: activityTrackCanBoard,
          idOf: (t) => Number(t.id),
        }).queue
      }
      if (tracks.filter(activityTrackCanBoard).length < target) {
        console.error(`activity-sync: REFUSING — ${target}-song set has unplayable tracks and no replacements`)
        for (const b of [...classified.blanks, ...classified.fileless].slice(0, 20)) console.error('   •', b)
        await host.writeJournal(null)
        return fail({
          copied: 0,
          error: formatSyncSetFileRefuse({
            lead: 'Activity sync refused',
            blanks: classified.blanks,
            fileless: classified.fileless,
            total: target,
            nothingVerb: 'wiped',
          }),
          target,
          shortfall: target - tracks.filter(activityTrackCanBoard).length,
        })
      }
    }
  }
  const { toPull } = await classifyActivitySyncTracks(tracks, {
    localMount: LOCAL_MOUNT,
    pathSep,
    lstat,
  })
  const remoteBytes = new Map<number, number>()
  if (toPull.length > 0) {
    const free = await host.freeBytes().catch(() => 0)
    if (diskWriteWouldBreachFloor(free, 0)) {
      const msg = `Activity sync refused — ${formatFreeSpaceRefuse(free)}. Nothing was wiped.`
      console.error(`activity-sync: ${msg}`)
      await host.writeJournal(null)
      return fail({ copied: 0, error: msg, target })
    }
    console.log(`activity-sync: ${toPull.length}/${target} not on this Mac — probing homemini before wipe (one file staged at copy; library symlink stays)`)
    const pullFail: string[] = []
    for (let i = 0; i < toPull.length; i++) {
      if (host.isCancelled()) {
        await host.writeJournal(null)
        return fail({ copied: 0, cancelled: true, error: 'Sync cancelled by user', target })
      }
      const p = toPull[i]
      host.sendProgress({
        phase: 'preflight',
        current: i + 1,
        total: toPull.length,
        title: `Checking homemini: ${p.label}`,
      })
      const r = await host.probeHomeminiTrack(p.id)
      if (!r.ok) {
        pullFail.push(`${p.label} (${r.error || 'homemini miss'})`)
        console.error(`activity-sync: homemini probe failed — ${p.label}: ${r.error}`)
      } else if (r.bytes && r.bytes > 0) {
        remoteBytes.set(p.id, r.bytes)
      }
    }
    if (pullFail.length > 0 && listOnly) {
      const failedIds = new Set(toPull.filter((p) => pullFail.some((f) => f.startsWith(p.label))).map((p) => p.id))
      leaveOff((t) => !failedIds.has(Number(t.id)), () => LEFT_OFF_NO_FETCH)
      console.warn(`activity-sync: list-only set — homemini miss on ${failedIds.size} song(s), left off; landing ${target}`)
    } else if (pullFail.length > 0) {
      const failedIds = new Set(toPull.filter((p) => pullFail.some((f) => f.startsWith(p.label))).map((p) => p.id))
      tracks = tracks.filter((t) => !failedIds.has(Number(t.id)))
      console.warn(`activity-sync: homemini miss on ${failedIds.size} song(s) — replacing so ${target} still means ${target}`)
      if (tracks.filter(activityTrackCanBoard).length < target && host.loadReplacementTracks) {
        const have = new Set(tracks.map((t) => Number(t.id)))
        const more = await host.loadReplacementTracks(have, target - tracks.length + 20)
        tracks = queueActivityCandidates({
          requested: target + 40,
          primary: tracks,
          extra: more,
          canBoard: activityTrackCanBoard,
          idOf: (t) => Number(t.id),
        }).queue
      }
      if (tracks.filter(activityTrackCanBoard).length < target) {
        await host.writeJournal(null)
        return fail({
          copied: 0,
          error: formatHomeminiPullRefuse(pullFail, target),
          target,
          shortfall: target - tracks.filter(activityTrackCanBoard).length,
        })
      }
    }
  }

  const destSeen = new Set<string>()
  const firstAtDest = (t: Record<string, unknown>): boolean => {
    const dest = ipodPlayableDestPath(String(t.path || ''))
    if (!dest) return false
    if (destSeen.has(dest)) return false
    destSeen.add(dest)
    return true
  }
  if (listOnly) leaveOff(firstAtDest, () => 'another song on the list has the same file name on the iPod')
  else tracks = tracks.filter(firstAtDest)
  const collisions = tsaDestCollisions(tracks.map((t) => tsaBoardPassenger({
    ...t,
    destPath: ipodPlayableDestPath(String(t.path || '')),
  })))
  if (collisions.length > 0) {
    console.warn(`activity-sync: dest collision(s) after first-wins filter: ${collisions.slice(0, 3).join(', ')}`)
    const collide = new Set(collisions)
    const clear = (t: Record<string, unknown>) => !collide.has(ipodPlayableDestPath(String(t.path || '')))
    if (listOnly) leaveOff(clear, () => 'another song on the list has the same file name on the iPod')
    else tracks = tracks.filter(clear)
  }
  if (listOnly && target === 0) {
    return fail({
      copied: 0, target: 0, requested, landed: 0, shortfall: 0, leftOff,
      error: `None of the ${requested} songs on this iPod's list can go on it. Nothing was wiped.`,
    })
  }
  if (tracks.length < target) {
    return fail({
      copied: 0,
      error: `Activity TSA boarded ${tracks.length} for a ${target}-song set. Nothing was wiped.`,
      target,
      shortfall: target - tracks.length,
    })
  }
  let tsaBoarded: TsaPassenger[] = tracks.slice(0, target).map((t) => tsaBoardPassenger({
    ...t,
    destPath: ipodPlayableDestPath(String(t.path || '')),
  }))

  // ── Activity Sync Ledger (2026-08-31, Jake: "we need records of this on
  // the back end so that we know what is going in and what is coming off
  // each activity sync"). Append-only JSONL in STATE_DIR — one 'picks'
  // entry per attempt with the added/removed diff vs the previous attempt,
  // one 'result' entry when a sync seals. A picks entry with no matching
  // result = a refused/aborted run. Never blocks a sync.
  // What the LAST sync left behind, read before this one clears the seal and
  // writes its own in-flight manifest over it. Reading it after (as the keep
  // plan did from 2026-09-19) meant every sync saw an unsealed manifest, kept
  // nothing, and copied all 1,000 again.
  const readStateJson = async (name: string): Promise<unknown> => {
    try { return JSON.parse(await readFile(join(host.stateDir, name), 'utf-8')) } catch { return null }
  }
  const priorManifestRaw = await readStateJson(LAST_SYNC_MANIFEST_FILE)
  const priorSealRaw = await readStateJson(TSA_SEAL_FILE)

  const ledgerPath = join(host.stateDir, 'activity-sync-ledger.jsonl')
  const ledgerWhen = new Date().toISOString()
  try {
    let prevIds: number[] = []
    try {
      const lines = (await readFile(ledgerPath, 'utf-8')).trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = JSON.parse(lines[i]) as { kind?: string; pickedIds?: number[] }
        if (e.kind === 'picks') { prevIds = e.pickedIds || []; break }
      }
    } catch { /* first ledger entry ever */ }
    const prevSet = new Set(prevIds)
    const pickedIds = tsaBoarded.map((p) => p.id)
    const nowSet = new Set(pickedIds)
    await appendFile(ledgerPath, JSON.stringify({
      kind: 'picks', when: ledgerWhen, target,
      pickedIds,
      added: pickedIds.filter((i) => !prevSet.has(i)),
      removed: prevIds.filter((i) => !nowSet.has(i)),
      picked: tsaBoarded.map((p) => ({ id: p.id, t: String(p.title || ''), a: String(p.artist || '') })),
      ...(listOnly ? { listOnly: true, requested } : {}),
      ...(leftOff.length > 0 ? { leftOff: leftOff.map((l) => ({ id: l.id, t: l.title, a: l.artist, why: l.why })) } : {}),
    }) + '\n', 'utf-8')
  } catch (err) {
    console.warn('activity-sync: ledger append failed (non-blocking):', err)
  }

  await host.writeJournal('copy')

  // ── 2. Resolve every song's source and card path BEFORE touching the card ──
  // The copy loop used to decide mirrors and paths per song AFTER the wipe.
  // Deciding first means a mirror that cannot be built refuses the sync
  // with the card untouched, and — the point — the keep plan below can
  // compare what WOULD be written against what is already there.
  //
  // Card names never reach the library (2026-10-26). Every path this engine
  // changes below — .flac/FAT-temp → .m4a, the 8.3 stem, an AAC or ALAC
  // mirror — is the CARD's name for a file whose library master is never
  // renamed or converted (mirrors are staged temps; the library file stays).
  // The 8/31 rule still exported a rewrite whenever the EXTENSION changed
  // ("flac → m4a, the mechanism's original purpose"), and the 2026-09-19
  // Activity Sync wrote 8 FLAC imports into library.json as `F04:12004.m4a`,
  // a name that exists only on the card, so every player 404'd them for five
  // weeks. track.path still becomes the card path (the DB payload and TSA
  // read it); the result carries NO library path rewrites. cardOnlyIds only
  // counts, for the log.
  const cardOnlyIds = new Set<number>()
  interface CopyPlanEntry {
    i: number
    id: number
    title: string
    srcToCopy: string
    dstToCopy: string
    restage?: { colon: string; id: number }
    knownSourceSize?: number
    /** Size of the library master (local file, or homemini's), before any mirror. */
    masterSize: number
  }
  const plan: CopyPlanEntry[] = []
  // Everything in this loop happens BEFORE the wipe, so its progress is
  // 'preflight' (the Prepare step). It used to say 'copy', and when a
  // song failed here the screen claimed Wipe ✓ / Copy ✗ and "the copied
  // songs were cleared" — while the card had not been touched (2026-10-17).
  // A song whose audio cannot be converted (damaged file) is dropped like an
  // unplayable row and replaced from reserve — one bad file must not stop a
  // 1000-song sync (2026-10-17: "Breeze" stopped one; 44 such files exist).
  const unconvertible: Array<{ id: number; title: string; artist: string }> = []
  const skipUnconvertible = (title: string, artist: string, id: number, why: string): void => {
    unconvertible.push({ id, title, artist })
    console.warn(`activity-sync: "${title}" (id ${id}) cannot be converted for the iPod (${why}) — skipped, a reserve takes its place`)
    host.sendProgress({ phase: 'preflight', current: 0, total: target, title: `Skipped (damaged file): ${title}` })
  }
  // #47 (fill-to-N): tracks[target..] are copy-time replacements. They are
  // resolved here like everything else, but never kept from a previous
  // card and only copied when a primary miss leaves the card short of N.
  // A list-only set has none (tracks.length === target).
  const reserveFrom = target
  for (let i = 0; i < tracks.length; i++) {
    if (host.isCancelled()) {
      await host.writeJournal(null)
      return fail({ copied: 0, cancelled: true, error: 'Sync cancelled by user — nothing on the iPod was touched.', target })
    }
    const track = tracks[i]
    const title = String(track.title || '')
    const id = Number(track.id)
    const rawColon = String(track.path || '')
    const destColon = ipodPlayableDestPath(rawColon)
    if (destColon !== rawColon) {
      // CARD path only (DB payload + TSA read it). Never exported to the
      // library — see cardOnlyIds above (2026-08-31: 702 rows; 2026-09-19: 8).
      cardOnlyIds.add(id)
      track.path = destColon
    }
    const localFile = join(LOCAL_MOUNT, rawColon.replace(/:/g, pathSep))
    let srcToCopy = localFile
    let dstToCopy = join(IPOD_MOUNT, destColon.replace(/:/g, pathSep))
    let restage: { colon: string; id: number } | undefined
    let knownSourceSize: number | undefined

    host.sendProgress({ phase: 'preflight', current: Math.min(i, target), total: target, title: `Preparing: ${title}` })

    const kind = await classifyLocalLibraryFile(rawColon, { localMount: LOCAL_MOUNT, pathSep, lstat })
    const needsPull = kind === 'streamed' || kind === 'missing'
    // Lossless but not stereo CD-quality — a high-res (24-bit / 96–192 kHz)
    // or multichannel ALAC .m4a. The Mini cannot play it, and its >2000 kbps
    // record fails the firmware-semantic gate, which refuses the WHOLE sync
    // ("6/1000 track(s) have out-of-range bitrate", 2026-10-17 — six hi-res
    // streamrip downloads). The full sync learned this on 2026-09-07
    // (sync-engine exceedsIpodPlayableCeiling); Activity Sync only ever
    // checked the .flac extension. Same rescue: the 16-bit / 44.1 kHz
    // stereo ALAC mirror. The master is untouched.
    const sourceBytes = needsPull
      ? (remoteBytes.get(id) || Number(track.fileSize) || 0)
      : ((await stat(localFile).catch(() => null))?.size ?? 0)
    const overCeiling = !needsIpodAlacTranscode(localFile)
      && exceedsIpodPlayableCeiling(sourceBytes, Number(track.duration || 0))
    let bytesForMirror = localFile
    let stageCleanup: (() => Promise<void>) | null = null
    if (needsPull && (convertOptions?.enabled || needsIpodAlacTranscode(localFile) || overCeiling)) {
      const staged = await host.stageTrack(rawColon, id)
      if (!staged.ok) {
        const msg = staged.reason === 'free-space'
          ? `Activity sync refused — ${staged.error}. Nothing was wiped.`
          : `Could not stage "${title}" for the iPod (${staged.error}). Nothing was wiped.`
        console.error(`activity-sync: ${msg}`)
        if (i >= reserveFrom) { console.warn(`activity-sync: reserve "${title}" skipped`); continue }
        await host.writeJournal(null)
        return fail({ copied: 0, error: msg, target })
      }
      bytesForMirror = staged.abs
      stageCleanup = staged.cleanup
    }

    try {
      if (convertOptions?.enabled) {
        try {
          host.sendProgress({
            phase: 'preflight', current: Math.min(i, target), total: target,
            title: `Converting → ${convertOptions.targetKbps}k AAC: ${title}`,
          })
          const mirror = await host.buildAacMirror(bytesForMirror, convertOptions.targetKbps)
          if (mirror) {
            srcToCopy = mirror
            const srcExt = localFile.slice(localFile.lastIndexOf('.')).toLowerCase()
            if (srcExt !== '.m4a' && srcExt !== '.mp4') {
              const dotIdx = dstToCopy.lastIndexOf('.')
              dstToCopy = dotIdx > 0 ? dstToCopy.slice(0, dotIdx) + '.m4a' : dstToCopy + '.m4a'
              const newRel = dstToCopy.slice(IPOD_MOUNT.length + 1)
              const newColon = ':' + newRel.split(pathSep).join(':')
              track.path = newColon
              cardOnlyIds.add(id)
            }
          }
        } catch (err) {
          console.warn(`activity-sync: AAC mirror failed for ${title}, copying original:`, err)
        }
      }

      // overCeiling only while the source is still the original: an AAC
      // mirror (convert toggle on) already brought the bitrate down.
      if (needsIpodAlacTranscode(srcToCopy === localFile ? bytesForMirror : srcToCopy)
        || (overCeiling && srcToCopy === localFile)) {
        try {
          host.sendProgress({
            phase: 'preflight', current: Math.min(i, target), total: target,
            title: `Converting → ALAC: ${title}`,
          })
          // bytesForMirror is a real file: a library master, or one staged
          // temp. The library symlink is not replaced.
          const mirror = await host.buildIpodSafeAlacMirror(bytesForMirror)
          if (!mirror) {
            if (i >= reserveFrom) { console.warn(`activity-sync: reserve "${title}" has no iPod-safe ALAC — skipped`); continue }
            skipUnconvertible(title, String(track.artist || ''), id, 'no iPod-safe ALAC')
            continue
          }
          srcToCopy = mirror
          dstToCopy = ipodPlayableDestPath(dstToCopy)
          const newRel = dstToCopy.startsWith(IPOD_MOUNT) ? dstToCopy.slice(IPOD_MOUNT.length + 1) : dstToCopy
          track.path = tsaNormalizeColonPath(newRel)
          track.codec = 'alac'
          // The mirror is the card's copy; the library master is untouched,
          // so this name is never exported (see cardOnlyIds above).
          cardOnlyIds.add(id)
        } catch (err) {
          console.error(`activity-sync: FLAC→ALAC failed for ${title}:`, err)
          if (i >= reserveFrom) { console.warn(`activity-sync: reserve "${title}" skipped`); continue }
          skipUnconvertible(title, String(track.artist || ''), id, err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120))
          continue
        }
      }
    } finally {
      if (stageCleanup) {
        if (srcToCopy === bytesForMirror) {
          knownSourceSize = (await stat(bytesForMirror).catch(() => null))?.size
          restage = { colon: rawColon, id }
          srcToCopy = localFile
        }
        await stageCleanup()
      }
    }

    if (needsPull && srcToCopy === localFile) {
      restage = { colon: rawColon, id }
      const remote = remoteBytes.get(id)
      if (knownSourceSize == null && remote && remote > 0) knownSourceSize = remote
    }

    dstToCopy = ipodPlayableDestPath(dstToCopy)
    plan.push({ i, id, title, srcToCopy, dstToCopy, restage, knownSourceSize, masterSize: sourceBytes })
  }

  // Damaged songs were dropped above; reserves fill their places. Only if
  // there are not enough reserves does the sync stop — still before the wipe.
  if (unconvertible.length > 0) {
    const names = unconvertible.slice(0, 5).map((u) => `${u.artist} — ${u.title}`).join('; ')
    console.warn(`activity-sync: ${unconvertible.length} damaged song(s) skipped and replaced: ${names}`)
    if (listOnly) {
      // Its own list: the damaged songs are left off, the set lands fewer.
      const gone = new Set(unconvertible.map((u) => u.id))
      for (const u of unconvertible) leftOff.push(leftOffSong(u, "its audio couldn't be converted for the iPod (damaged file)"))
      tracks = tracks.filter((t) => !gone.has(Number(t.id)))
      tsaBoarded = tsaBoarded.filter((p) => !gone.has(p.id))
      target = plan.length
      console.warn(`activity-sync: list-only set — landing ${target} of ${requested}`)
      if (target === 0) {
        await host.writeJournal(null)
        return fail({
          copied: 0, target: 0, requested, landed: 0, shortfall: 0, unconvertible, leftOff,
          error: `None of the songs on this iPod's list could be converted for it. Nothing was wiped. ${names}`,
        })
      }
    } else if (plan.length < target) {
      await host.writeJournal(null)
      return fail({
        copied: 0, target, unconvertible,
        error: `${unconvertible.length} song(s) have damaged audio and there are not enough replacements to make ${target}. Nothing was wiped. ${names}`,
      })
    }
  }

  // ── 2b. Swap or full: what can stay on the card, PROVEN (2026-11-07) ──
  // Jake: "it shouldnt wipe the ipod and start the 1000 from scratch, it
  // should just swap out the songs that they are being replaced with."
  // A song stays only when the last sync's sealed manifest (this format), its
  // seal, the card's own catalog (byte-for-byte) and every file on the card
  // all agree (proveCardForSwap), and the song is the same file by
  // fingerprint and size (planSwap). Anything unproven is a full
  // wipe-and-copy, with one plain reason in the result.
  const identityById = new Map(tsaBoarded.map((p) => [p.id, p.identity]))
  const relOf = (abs: string): string =>
    tsaNormalizeColonPath(abs.startsWith(IPOD_MOUNT) ? abs.slice(IPOD_MOUNT.length + 1) : abs)
  const dstById = new Map(plan.map((e) => [e.id, e.dstToCopy]))
  const masterSizeById = new Map(plan.map((e) => [e.id, e.masterSize || 0]))
  const candidates: SwapCandidate[] = []
  for (const e of plan) {
    if (e.i >= reserveFrom) continue   // a reserve never stays — it lands only if a primary misses
    candidates.push({
      id: e.id,
      destPath: relOf(e.dstToCopy),
      identity: identityById.get(e.id) || '',
      copySize: e.knownSourceSize ?? (await stat(e.srcToCopy).catch(() => null))?.size ?? 0,
      sourceSize: e.masterSize || 0,
    })
  }
  const proof = proveCardForSwap(priorManifestRaw, priorSealRaw, await readCardState(IPOD_MOUNT))
  let swap: SwapPlan | null = null
  let fullReason: string | null = null
  const stayRows = new Map<number, SwapManifestRow>()
  if (!proof.ok) {
    fullReason = proof.why
  } else {
    const candidate = planSwap(candidates, proof.rows)
    fullReason = swapTooBig(candidate, target)
    if (!fullReason) {
      // The fragmentation backstop: enough holes since the last full copy
      // and the card gets a fresh one.
      const capacity = await (host.cardCapacityBytes ?? cardCapacityBytes)(IPOD_MOUNT).catch(() => null)
      fullReason = swapBackstop(proof.history, candidate.leave.reduce((n, r) => n + r.size, 0), capacity)
    }
    if (!fullReason) {
      swap = candidate
      for (const id of swap.stay) stayRows.set(id, proof.rows.get(id)!)
    }
  }
  const mode: 'swap' | 'full' = swap ? 'swap' : 'full'
  const keepIds = swap ? swap.stay : new Set<number>()
  const keepAbs = new Set(plan.filter((e) => keepIds.has(e.id)).map((e) => e.dstToCopy))
  if (swap) {
    console.log(`activity-sync: SWAP — ${swap.leave.length} out, ${swap.arrive.length} in, ${swap.stay.size} stay` +
      (swap.changed.length ? ` (${swap.changed.length} re-copied: the library file changed)` : ''))
    host.sendProgress({
      phase: 'preflight', current: target, total: target, mode,
      title: `Swapping: ${swap.leave.length.toLocaleString()} out, ${swap.arrive.length.toLocaleString()} in, ${swap.stay.size.toLocaleString()} stay`,
    })
  } else {
    console.log(`activity-sync: FULL copy — ${fullReason}`)
    host.sendProgress({ phase: 'preflight', current: target, total: target, mode, title: fullCopyLine(fullReason || 'nothing to keep') })
  }

  // ── 2c. Swap: fetch every arriving song from homemini BEFORE the card changes ──
  // 2026-11-08 (punkPod, Jake away on a slow Tailscale relay): one arrival's
  // fetch failed at copy time, after the interim catalog and the removals,
  // and stopped the whole swap ("Only 828 of 829 songs confirmed"). Fetched
  // first, a song homemini can't send is known while the card is still the
  // last sync's: a list-only iPod leaves it off (the set lands one fewer, the
  // reason in the result and the ledger), the Original lets a reserve take its
  // seat. A Mac too full to hold them stops the fetching early, and the rest
  // are fetched at copy time as before. A full copy is not fetched ahead (up
  // to 1,000 songs on the Mac's disk at once).
  const fetchFailedIds = new Set<number>()
  if (swap) {
    const toFetch = plan.filter((e) => e.restage && e.i < reserveFrom && !keepIds.has(e.id))
    for (let k = 0; k < toFetch.length; k++) {
      const e = toFetch[k]
      if (host.isCancelled()) {
        await host.writeJournal(null)
        return fail({ copied: 0, cancelled: true, error: 'Sync cancelled by user — nothing on the iPod was touched.', target })
      }
      host.sendProgress({ phase: 'preflight', current: k + 1, total: toFetch.length, mode, title: `Fetching from homemini: ${e.title}` })
      const staged = await host.stageTrack(e.restage!.colon, e.restage!.id)
      if (staged.ok) {
        preStaged.set(e.id, { abs: staged.abs, cleanup: staged.cleanup })
        continue
      }
      if (staged.reason === 'free-space') {
        console.warn(`activity-sync: fetching arrivals ahead stopped at ${k} of ${toFetch.length} (${staged.error}); the rest are fetched at copy time`)
        break
      }
      console.error(`activity-sync: arriving "${e.title}" (id ${e.id}) — homemini couldn't send it (${staged.error}); the card is untouched`)
      fetchFailedIds.add(e.id)
    }
  }
  if (swap && fetchFailedIds.size > 0) {
    const gone = fetchFailedIds
    if (listOnly) {
      for (const t of tracks) if (gone.has(Number(t.id))) leftOff.push(leftOffSong(t, LEFT_OFF_NO_FETCH))
      tracks = tracks.filter((t) => !gone.has(Number(t.id)))
      tsaBoarded = tsaBoarded.filter((p) => !gone.has(p.id))
      for (let k = plan.length - 1; k >= 0; k--) if (gone.has(plan[k].id)) plan.splice(k, 1)
      swap.arrive = swap.arrive.filter((id) => !gone.has(id))
      swap.changed = swap.changed.filter((id) => !gone.has(id))
      target -= gone.size
      console.warn(`activity-sync: list-only set — homemini couldn't send ${gone.size} arriving song(s), left off; landing ${target} of ${requested}`)
      if (target === 0) {
        await host.writeJournal(null)
        return fail({
          copied: 0, target: 0, requested, landed: 0, shortfall: 0, leftOff,
          error: `None of the songs on this iPod's list could be fetched from homemini. Nothing on the iPod was touched.`,
        })
      }
    } else if (plan.filter((e) => !gone.has(e.id)).length < target) {
      await host.writeJournal(null)
      return fail({
        copied: 0, target, shortfall: gone.size,
        error: `homemini couldn't send ${gone.size} arriving song(s) and there are not enough replacements to make ${target}. Nothing on the iPod was touched.`,
      })
    } else {
      console.warn(`activity-sync: homemini couldn't send ${gone.size} arriving song(s); a reserve takes each seat at copy time`)
    }
  }

  // Never a half-updated card (swap only). At every moment the card's catalog
  // names only files that are on it: the old catalog until a catalog of the
  // songs that STAY replaces it, and only then does anything leave; arrivals
  // are files no catalog names until the final one. Unplugged at any point,
  // the iPod boots onto a whole list.
  //   cataloguedAbs — the files the catalog now on the card can name
  //   interimTouched / finalTouched — a catalog copy onto the card began
  let cataloguedAbs = new Set<string>(
    proof.ok ? [...proof.rows.values()].map((r) => join(IPOD_MOUNT, tsaRelFromColon(r.destPath, pathSep))) : [],
  )
  let interimTouched = false
  let finalTouched = false
  let catalogBakDone = false

  const writtenById = new Map<number, { srcPath: string; dstPath: string; expectedSize: number }>()
  let copied = 0
  let kept = 0
  let copyErrors = 0
  let verifyAttempts = 0

  const rewipeAndStop = async (why: ActivitySyncResult): Promise<ActivitySyncResult> => {
    try {
      for (const p of await listIpodMusicFiles(IPOD_MOUNT)) {
        try { await unlink(p) } catch { /* best effort */ }
      }
      await retireScratch(IPOD_MOUNT, 'abort after wipe')
    } catch { /* best effort */ }
    console.error(`activity-sync: abort after wipe — re-emptied Music so Mini cannot index a ${why.landed ?? 'partial'} set. ${why.error}`)
    // Say so in the result: the screen used to claim "the new songs are on
    // the card" after a Verify abort that had just removed them (10-17).
    const error = [why.error || 'Sync stopped.', REWIPED_NOTE].join(' ')
    return { ...why, error }
  }

  // A swap that stops leaves the card on a whole catalog: the files this run
  // copied (which no catalog on the card names) come off again; the songs the
  // catalog names are never touched. Once the final catalog's copy has begun,
  // every file it names is already on the card, so nothing is removed.
  const swapStop = async (why: ActivitySyncResult): Promise<ActivitySyncResult> => {
    // Whatever catalog the card holds now, the round trip's ledger must
    // match it: if Play Counts is gone but the catalog is the one whose
    // totals the gate recorded, those totals start over (else the next plays
    // read as negative deltas and are lost).
    try {
      const itunes = join(IPOD_MOUNT, 'iPod_Control', 'iTunes')
      const db = await readFile(join(itunes, 'iTunesDB'))
      const pcLeft = await stat(join(itunes, 'Play Counts')).then(() => true, () => false)
      await startRoundTripGeneration(host.stateDir, db, pcLeft)
    } catch (err) {
      console.warn('activity-sync: swap stop — round-trip generation check failed (non-blocking):', err)
    }
    if (finalTouched) return { ...why, mode, swap: swapCounts() }
    let removed = 0
    try {
      for (const p of await listIpodMusicFiles(IPOD_MOUNT)) {
        if (cataloguedAbs.has(p)) continue
        try { await unlink(p); removed++ } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
    let restored = false
    if (!interimTouched && proveCardForSwap(priorManifestRaw, priorSealRaw, await readCardState(IPOD_MOUNT)).ok) {
      // The card re-proves as exactly what the last sync left (its catalog,
      // every file, nothing else): give back its seal and manifest, so the
      // next Sync swaps again instead of copying everything.
      const seal = parseTsaSeal(priorSealRaw)
      if (seal && priorManifestRaw && typeof priorManifestRaw === 'object') {
        try {
          await host.writeSeal(seal)
          await host.writeManifest(priorManifestRaw as Record<string, unknown>)
          restored = true
        } catch (err) {
          console.warn('activity-sync: swap stop — could not give back the last seal (next sync copies in full):', err)
        }
      }
    }
    console.error(`activity-sync: swap stopped — took ${removed} file(s) copied this run back off; the card's catalog names ${cataloguedAbs.size} song(s), all on it${restored ? ' (the last sync\'s seal is back)' : ''}. ${why.error}`)
    const error = [why.error || 'Sync stopped.', swapKeptNote(cataloguedAbs.size, restored)].join(' ')
    return { ...why, error, mode, swap: swapCounts() }
  }
  const stopAfterTouch = (why: ActivitySyncResult): Promise<ActivitySyncResult> =>
    swap ? swapStop(why) : rewipeAndStop(why)
  const swapCounts = () => swap
    ? { out: swap.leave.length, in: copied, stayed: kept, changed: swap.changed.length }
    : undefined

  // ── The catalog, written, put on the card and proven (interim or final) ──
  // 'final' is the whole set. 'interim' (swap only) is the songs that stay,
  // written BEFORE any file leaves; its progress stays on the Remove step.
  type CatalogOk = { ok: true; tracks: Array<Record<string, unknown>>; readback: { tracks: Array<Record<string, unknown>> }; md5: string; bytes: number }
  type CatalogFail = { ok: false; touchedCard: boolean; result: ActivitySyncResult }
  const putCatalog = async (
    tracks: Array<Record<string, unknown>>,
    playlists: Array<Record<string, unknown>>,
    kind: 'interim' | 'final',
    /** Size each song's card file must have — what was proven, never a fresh stat. */
    expectedSize: Map<number, number>,
  ): Promise<CatalogOk | CatalogFail> => {
    const target = tracks.length
    const interim = kind === 'interim'
    const say = (title: string, current = 1, total = 1): void => host.sendProgress(interim
      ? { phase: 'copy', current, total, title: `Removing — ${title}`, mode }
      : { phase: 'db', current, total, title })
    const stop = (touchedCard: boolean, r: Omit<ActivitySyncResult, 'ok'> & { error: string }): CatalogFail =>
      ({ ok: false, touchedCard, result: fail(r) })
    await host.writeJournal('db')
    if (interim) say('writing the song list for the songs that stay…', 0)
    else host.sendProgress({ phase: 'db', current: 0, total: 1, title: 'Writing iTunesDB...' })

    // Stamp iTunesDB sizes from the card, not library.json.
    // Write tracks in firmware-fold title order so Music > Songs is A–Z
    // even if type-52 key 3 (Songs) is discarded. stamp sortArtist for mhod 22
    // (Artists). mhia + the type-52 tables (3 Songs, 4 Albums, 5 Artists,
    // 7 Genres) are built inside write_itunesdb.
    tracks = orderTracksForIpodTitleIndex(tracks.map((t) => stampIpodSortArtist(t)))
    for (const t of tracks) {
      const dst = dstById.get(Number(t.id))
      if (!dst) continue
      try {
        const sz = (await stat(dst)).size
        t.fileSize = fileSizeForItunesDb(sz)
        t.sampleRate = sampleRateForItunesDb(t.sampleRate as number | undefined)
        const remembered = writtenById.get(Number(t.id))
        if (remembered) remembered.expectedSize = sz
      } catch { /* the guard below names it */ }
      if (!String(t.title || '').trim()) {
        const base = String(t.path || '').split(':').pop() || 'Unknown'
        t.title = base.replace(/\.[^.]+$/, '') || 'Unknown'
      }
      if (!String(t.artist || '').trim()) t.artist = String(t.albumArtist || t.album || 'Unknown Artist')
    }
    const unlistable = tracks.filter((t) => !ipodFirmwareWillList(t))
    if (unlistable.length > 0) {
      return stop(false, {
        copied, copyErrors, target, landed: target - unlistable.length, shortfall: unlistable.length, verifyAttempts,
        error: `${unlistable.length} song(s) Mini 1.4.1 will not list. Not writing a catalog. ${unlistable.slice(0, 3).map((t) => `${t.artist} — ${t.title}`).join('; ')}`,
      })
    }

    // The catalog is written alphabetically (artist > album > track). The
    // 2026-08-28 belief that Mini 1.4.1 lists Artists in this PHYSICAL order
    // was wrong: its Music menus read the type-52 tables, which db_reader
    // had keyed in the wrong numbering until 2026-10-17 (see _sort_indices).
    // The physical order stays — harmless, and conformCatalogIdOrder re-mints
    // ids against it. Playlists reference dbids, so their order is untouched.
    tracks = orderForIpodCatalog(tracks)

    // Never catalog a missing file: every song this catalog names must be on
    // the card right now at the size that was proven. Firmware 1.4.1 aborts
    // Songs on a missing file; it does not skip it.
    const onCardNow = new Map<string, number>()
    const guardRows: Array<{ id: number; destPath: string; size: number }> = []
    for (const t of tracks) {
      const id = Number(t.id)
      const dst = dstById.get(id) || ''
      const colon = relOf(dst)
      const sz = dst ? (await stat(dst).catch(() => null))?.size : undefined
      if (sz !== undefined) onCardNow.set(colon, sz)
      guardRows.push({ id, destPath: colon, size: expectedSize.get(id) ?? -1 })
    }
    const notOnCard = rowsMissingOnCard(guardRows, onCardNow)
    if (notOnCard.length > 0) {
      const gone = new Set(notOnCard)
      const sample = tracks.filter((t) => gone.has(Number(t.id))).slice(0, 3).map((t) => `${t.artist} — ${t.title}`).join('; ')
      return stop(false, {
        copied, copyErrors, target, landed: target - notOnCard.length, shortfall: notOnCard.length, verifyAttempts,
        error: `${notOnCard.length} song(s) the catalog would list are not on the card at their proven size. Not writing a catalog. ${sample}`,
      })
    }

    // ── 5. Build catalog locally, copy to CF, prove bytes+hash+N ──
    const ipodDb = join(IPOD_MOUNT, 'iPod_Control', 'iTunes', 'iTunesDB')
    // One .bak per run (the catalog the run started from): a swap's second
    // catalog write must not spend another write on a copy of its interim.
    if (!catalogBakDone) {
      catalogBakDone = true
      try { await copyFile(ipodDb, ipodDb + '.bak') } catch { /* non-fatal */ }
    }
    const localDb = join(host.tempDir, `jaketunes-itunesdb-${host.pid}`)
    const written = await spawnJson(
      python,
      [host.coreScript('core/db_reader.py'), '--write', localDb, '--template', ipodDb, '--ipod-root', IPOD_MOUNT],
      JSON.stringify({ tracks, playlists, masterName: input.ipodName }),
    )
    if (written.err && (written.err as NodeJS.ErrnoException).code === 'ENOENT') {
      return stop(false, { copied, copyErrors, error: host.pythonHint || PYTHON_INSTALL_HINT, target })
    }
    if (written.code !== 0) {
      try { await unlink(localDb) } catch { /* temp */ }
      return stop(false, {
        copied, copyErrors, target,
        error: safeIpcError(`DB write failed (code ${written.code}): ${written.stderr}`, 'tool-failed'),
      })
    }
    console.log('activity-sync stderr:', written.stderr)
    // Firmware finds songs by binary search on mhit id — ids must ascend in
    // record order or songs silently vanish from About (the 819 saga).
    const conform = await conformCatalogIdOrder(localDb)
    if (!conform.ok) {
      try { await unlink(localDb) } catch { /* temp */ }
      // A swap hasn't touched this catalog: its Play Counts still belongs to
      // it and must stay (retiring it made later plays read as negative
      // deltas against the round trip's totals — review of #377).
      if (!swap) await retireScratch(IPOD_MOUNT, 'catalog order conform failed')
      return stop(false, {
        copied, copyErrors, target,
        error: `The catalog could not be conformed to firmware id order (${conform.error}). Previous catalog is untouched. Sync again.`,
      })
    }
    console.log(`activity-sync: ${conform.summary}`)
    const contig = await ensureContiguousDb(localDb, python)
    console.log(`activity-sync: ${contig.summary}`)
    if (!contig.ok) {
      try { await unlink(localDb) } catch { /* temp */ }
      if (!swap) await retireScratch(IPOD_MOUNT, 'catalog contiguity failed')
      return stop(false, {
        copied, copyErrors, target,
        error: `The catalog was written but could not be laid down as one piece (${contig.error}). Previous catalog is untouched. Sync again.`,
      })
    }
    if (interim) say('song list for the songs that stay written')
    else host.sendProgress({ phase: 'db', current: 1, total: 1, title: 'iTunesDB written' })

    if (interim) say(`putting the ${target}-song list on the card…`)
    else host.sendProgress({ phase: 'db', current: 1, total: 1, title: `Putting the ${target}-song catalog on the card…` })
    const writeCatalogManifest = async (): Promise<void> => {
      try {
        await host.writeManifest({
          syncedAt: new Date().toISOString(),
          status: interim ? 'interim' : 'catalogued',
          sealed: false,
          count: target,
          tracks: tracks.map((t) => ({
            id: Number(t.id),
            destPath: relOf(dstById.get(Number(t.id)) || ''),
            identity: identityById.get(Number(t.id)) || '',
          })),
        })
      } catch (mErr) {
        console.warn(`activity-sync: ${kind} manifest write failed (non-fatal):`, mErr)
      }
    }
    let catalogConsecutive = 0
    let readback: { tracks: Array<Record<string, unknown>> } | null = null
    let cardBytes: Buffer | null = null
    const CATALOG_PROOF_ROUNDS = 4
    for (let round = 1; round <= CATALOG_PROOF_ROUNDS; round++) {
      if (catalogConsecutive === 0) {
        try {
          if (interim) interimTouched = true
          else finalTouched = true
          await copyFile(localDb, ipodDb)
          const conf = await confirmWriteOnCard(localDb, ipodDb)
          if (!conf.ok) {
            console.error(`activity-sync: catalog copy not confirmed (${conf.reason})`)
            continue
          }
          // The card's catalog has changed: say at once which song each
          // record is, so the round trip and the iPod's identity can map it
          // even if the run (or the power) stops during the proof below.
          // Unsealed — a swap never trusts it.
          await writeCatalogManifest()
        } catch (copyErr) {
          console.error('activity-sync: catalog copy onto the card failed:', copyErr)
          continue
        }
      }
      await retireScratch(IPOD_MOUNT, 'after catalog copy')
      const flush = await remountVolume(IPOD_MOUNT)
      if (!flush.ok) {
        await retireScratch(IPOD_MOUNT, 'remount failed after catalog copy')
        try { await unlink(localDb) } catch { /* temp */ }
        return stop(true, {
          copied, copyErrors, target, landed: 0, shortfall: target, verifyAttempts,
          error: `The catalog file never made it onto the card — remount failed (${flush.error}). The Mini does not have ${target} songs. Do not unplug — sync again.`,
        })
      }
      host.setDetectedMount(flush.mountPoint || IPOD_MOUNT)
      await retireScratch(flush.mountPoint || IPOD_MOUNT, 'after remount')
      let onCard: Buffer
      try {
        onCard = await readFile(ipodDb)
      } catch {
        catalogConsecutive = 0
        continue
      }
      const cardMd5 = createHash('md5').update(onCard).digest('hex')
      try {
        readback = await host.readIpodDatabase()
      } catch {
        catalogConsecutive = 0
        continue
      }
      const match = catalogBytesMatch({
        onCardBytes: onCard.length,
        localBytes: contig.bytes,
        onCardMd5: cardMd5,
        localMd5: contig.md5,
        trackCount: readback.tracks.length,
        target,
      })
      console.log(`activity-sync: ${kind} catalog proof ${round}/${CATALOG_PROOF_ROUNDS} — card ${onCard.length}b md5 ${cardMd5.slice(0, 8)} tracks=${readback.tracks.length} vs local ${contig.bytes}b md5 ${contig.md5.slice(0, 8)} target=${target} match=${match}`)
      if (match) {
        cardBytes = onCard
        catalogConsecutive++
        if (catalogOnCardProven(catalogConsecutive, match)) {
          console.log(`activity-sync: ${kind} catalog ON CARD — ${target} tracks, ${contig.bytes} bytes, held across two remounts`)
          break
        }
      } else {
        catalogConsecutive = 0
      }
    }
    try { await unlink(localDb) } catch { /* temp */ }
    if (!readback || !cardBytes || !catalogOnCardProven(catalogConsecutive, catalogConsecutive >= 2)) {
      return stop(true, {
        copied, copyErrors, target, landed: 0, shortfall: target, verifyAttempts,
        error: `The ${target}-song catalog never committed to the card. Mac cache is not the Mini — that is how Songs became 450. Not calling this done. Sync again without unplugging.`,
      })
    }

    const onDevice = readback.tracks.length
    if (onDevice !== target) {
      return stop(true, {
        copied, copyErrors, target, landed: onDevice, shortfall: target - onDevice, verifyAttempts,
        error: `Catalog on the card lists ${onDevice} of ${target}. Not calling this done.`,
      })
    }

    const missingRows: Array<{ title: string; artist: string; path: string }> = []
    for (const t of readback.tracks as Array<{ path?: string; title?: string; artist?: string }>) {
      const colon = String(t.path || '')
      const abs = colon ? join(IPOD_MOUNT, tsaRelFromColon(colon, pathSep)) : ''
      try {
        if (!colon) throw new Error('no-path')
        const sz = (await stat(abs)).size
        if (sz <= 0) throw new Error('empty')
      } catch {
        missingRows.push({ title: String(t.title || ''), artist: String(t.artist || ''), path: colon })
      }
    }
    if (missingRows.length > 0) {
      const sample = missingRows.slice(0, 8).map((r) => `${r.artist} — ${r.title}`).join('; ')
      await host.writeReport({
        syncedAt: new Date().toISOString(), target,
        landed: onDevice - missingRows.length, shortfall: missingRows.length,
        verifyPasses: verifyAttempts, copied, copyErrors,
        failed: missingRows.slice(0, 40).map((r, i) => ({ id: i, title: r.title, artist: r.artist, path: r.path })),
      })
      return stop(true, {
        copied, copyErrors, target, landed: onDevice - missingRows.length, shortfall: missingRows.length, verifyAttempts,
        error: `Sync verify failed: ${missingRows.length} of ${onDevice} catalog songs are not on the card. Firmware 1.4.1 aborts Songs, it does not skip ${missingRows.length}. ${sample}`,
      })
    }

    const semanticScript = host.coreScript('core/tools/itdb_verify.py')
    const semantic = await new Promise<{ ok: boolean; output: string }>((done) => {
      const check = spawn(python, [semanticScript, ipodDb, '--root', IPOD_MOUNT, '--expect', String(target)])
      let output = ''
      check.stdout.on('data', (d: Buffer) => { output += d.toString() })
      check.stderr.on('data', (d: Buffer) => { output += d.toString() })
      check.on('error', (err: Error) => done({ ok: false, output: safeIpcError(err, 'tool-failed') }))
      check.on('close', (checkCode: number) => done({ ok: checkCode === 0, output }))
    })
    if (!semantic.ok) {
      console.error(`activity-sync: FIRMWARE SEMANTIC VALIDATION FAILED:\n${semantic.output}`)
      await host.writeReport({
        syncedAt: new Date().toISOString(), target, landed: 0, shortfall: target,
        verifyPasses: verifyAttempts, copied, copyErrors,
        failed: [{ id: 0, title: 'iTunesDB semantic validation failed', artist: '', path: '' }],
      })
      return stop(true, {
        copied, copyErrors, target, landed: 0, shortfall: target, verifyAttempts,
        error: `The ${target} files are on the iPod, but its catalog contains firmware-invalid song records. JakeTunes refused to claim success. Sync again to rebuild the catalog.`,
      })
    }
    console.log(`activity-sync: firmware-semantic validation GREEN for all ${target} tracks`)

    // A new catalog is a new play-count generation. The writer is not
    // byte-deterministic today, so the sha1 always moves; if it ever stops
    // moving, the round trip must still start counting from zero for this
    // catalog (the old Play Counts was ingested before the sync and retired).
    const playCountsLeft = await stat(join(IPOD_MOUNT, 'iPod_Control', 'iTunes', 'Play Counts')).then(() => true, () => false)
    await startRoundTripGeneration(host.stateDir, cardBytes, playCountsLeft)
      .catch((err) => console.warn('activity-sync: round-trip generation note failed (non-blocking):', err))

    return { ok: true, tracks, readback, md5: contig.md5, bytes: contig.bytes }
  }

  // The card is about to change: from here until a new seal, the last
  // sync's seal no longer describes it. (Cleared here, not before Prepare:
  // a refusal that never touched the card keeps the last seal, so the next
  // Sync can still swap.)
  await host.clearSeal()
  try {
    await host.writeManifest({
      syncedAt: new Date().toISOString(),
      status: 'in-flight',
      sealed: false,
      count: target,
      tracks: tracks.map((t) => ({
        id: Number(t.id),
        title: String(t.title || ''),
        artist: String(t.artist || ''),
        album: String(t.album || ''),
      })),
    })
    console.log(`activity-sync: MANIFEST in-flight — ${target} songs boarded, not sealed`)
  } catch (mErr) {
    console.warn('activity-sync: manifest write failed (non-fatal):', mErr instanceof Error ? mErr.message : mErr)
  }

  // ── 3. Remove (swap) or wipe (full) ──
  if (swap && swap.leave.length > 0) {
    // First the card gets a catalog of only the songs that stay. From then
    // on, deleting a leaving song can't leave the iPod pointing at nothing.
    const out = swap.leave.length
    host.sendProgress({ phase: 'copy', current: 0, total: out, mode, title: `Removing ${out.toLocaleString()} song${out === 1 ? '' : 's'} leaving the iPod…` })
    const stayIds = keepIds
    const stayTracks = tracks.filter((t) => stayIds.has(Number(t.id)))
    const stayPlaylists = playlists
      .map((p) => ({ ...p, trackIds: (Array.isArray(p.trackIds) ? p.trackIds : []).filter((id) => stayIds.has(Number(id))) }))
      .filter((p) => p.trackIds.length > 0)
    const interim = await putCatalog(stayTracks, stayPlaylists, 'interim', new Map([...stayRows].map(([id, r]) => [id, r.size])))
    if (!interim.ok) return swapStop(interim.result)
    cataloguedAbs = new Set(keepAbs)
    host.sendProgress({ phase: 'copy', current: 0, total: out, mode, title: `Removing ${out.toLocaleString()} song${out === 1 ? '' : 's'} — the iPod now lists the ${stayIds.size.toLocaleString()} that stay` })
  } else if (!swap) {
    host.sendProgress({ phase: 'copy', current: 0, total: 1, mode, title: 'Wiping the iPod for a clean rebuild…' })
  }
  if (!swap || swap.leave.length > 0) {
    let wiped = 0
    try {
      let streak = 0
      let listedNow: string[] = []
      for (let pass = 0; pass < ACTIVITY_WIPE_MAX_PASSES; pass++) {
        const listed = await listIpodMusicFiles(IPOD_MOUNT)
        for (const p of listed) {
          if (keepAbs.has(p)) continue
          try { await unlink(p); wiped++ } catch { /* retry */ }
        }
        listedNow = await listIpodMusicFiles(IPOD_MOUNT)
        streak = keepStreak(wipeListingMatchesKeep(listedNow, keepAbs), streak)
        console.log(`activity-sync: ${swap ? 'REMOVE' : 'WIPE'} pass ${pass + 1}/${ACTIVITY_WIPE_MAX_PASSES} listed=${listed.length} now=${listedNow.length} keep=${keepAbs.size} streak=${streak}`)
        if (streak >= ACTIVITY_WIPE_EMPTY_STREAK) break
        await new Promise((r) => setTimeout(r, 250))
      }
      if (streak < ACTIVITY_WIPE_EMPTY_STREAK) {
        const extra = listedNow.filter((p) => !keepAbs.has(p)).length
        const missing = [...keepAbs].filter((p) => !listedNow.includes(p)).length
        if (swap) {
          return swapStop(fail({
            copied: 0, target,
            error: `The swap’s removal step could not settle the iPod (${extra} leaving file${extra === 1 ? '' : 's'} still there, ${missing} staying file${missing === 1 ? '' : 's'} vanished). Reseat the cable and sync again — nothing new was copied.`,
          }))
        }
        return fail({
          copied: 0,
          error: `Activity wipe could not settle the iPod (${extra} leftover file${extra === 1 ? '' : 's'}, ${missing} kept file${missing === 1 ? '' : 's'} vanished). Reseat the cable and sync again — nothing new was copied.`,
          target,
        })
      }
      await retireScratch(IPOD_MOUNT, swap ? 'after remove' : 'after wipe')
      console.log(`activity-sync: ${swap ? 'REMOVE' : 'WIPE'} deleted ${wiped} file(s) — card holds exactly the ${keepAbs.size} kept, rebuilding to ${target}`)
    } catch (e) {
      if (swap) {
        return swapStop(fail({
          copied: 0, target,
          error: `The swap’s removal step failed (${e instanceof Error ? e.message : String(e)}). Nothing new was copied.`,
        }))
      }
      return fail({
        copied: 0,
        error: `Activity wipe failed (${e instanceof Error ? e.message : String(e)}). Nothing was copied.`,
        target,
      })
    }
  }

  // ── 3b. Copy what is not already there ──
  const restageById = new Map<number, { colon: string; id: number }>()
  for (const e of plan) if (e.restage) restageById.set(e.id, e.restage)
  const prepareSource = async (entry: { id: number; localFile: string }): Promise<{ abs: string; cleanup: () => Promise<void> }> => {
    const held = preStaged.get(entry.id)
    if (held) return { abs: held.abs, cleanup: async () => {} }   // released when the run ends
    const rs = restageById.get(entry.id)
    if (!rs) return { abs: entry.localFile, cleanup: async () => {} }
    const staged = await host.stageTrack(rs.colon, rs.id)
    if (!staged.ok) throw new Error(staged.error)
    return { abs: staged.abs, cleanup: staged.cleanup }
  }
  // Copy counts only arrivals: a song that stays is not copied and says nothing.
  const copyTotal = Math.max(1, target - keepIds.size)
  // List-only: an arrival homemini can't send at copy time is left off, as at
  // Prepare, never a stopped sync (2026-11-08). Not a full Mac disk: that stops.
  const droppedAtCopy = new Set<number>()

  for (const e of plan) {
    if (writtenById.size >= target) break   // #47: N reached — the rest were reserves
    if (host.isCancelled()) {
      host.sendProgress({ phase: 'cancelled', current: copied, total: copyTotal, title: '' })
      return stopAfterTouch({ ok: false, copied, kept, copyErrors, cancelled: true, error: 'Sync cancelled by user', target })
    }
    if (keepIds.has(e.id)) {
      writtenById.set(e.id, { srcPath: e.srcToCopy, dstPath: e.dstToCopy, expectedSize: stayRows.get(e.id)?.size ?? 0 })
      kept++
      continue
    }
    host.sendProgress({ phase: 'copy', current: copied + copyErrors, total: copyTotal, title: e.title })
    if (fetchFailedIds.has(e.id)) {   // the Original: homemini couldn't send it ahead; a reserve takes the seat
      copyErrors++
      continue
    }
    let copySrc = e.srcToCopy
    let release = async () => {}
    const held = preStaged.get(e.id)
    if (held) {
      copySrc = held.abs   // fetched before the card changed; released when the run ends
    } else if (e.restage) {
      const staged = await host.stageTrack(e.restage.colon, e.restage.id)
      if (!staged.ok) {
        console.error(`activity-sync: skipping "${e.title}" — ${staged.error}`)
        if (listOnly && staged.reason !== 'free-space') {
          const t = tracks.find((x) => Number(x.id) === e.id)
          leftOff.push(leftOffSong(t ?? { id: e.id, title: e.title }, LEFT_OFF_NO_FETCH))
          droppedAtCopy.add(e.id)
          continue
        }
        copyErrors++
        continue
      }
      copySrc = staged.abs
      release = staged.cleanup
    }
    try {
      const dir = e.dstToCopy.substring(0, e.dstToCopy.lastIndexOf(pathSep))
      await mkdir(dir, { recursive: true })
      await copyFile(copySrc, e.dstToCopy)
      const conf = await confirmWriteOnCard(copySrc, e.dstToCopy)
      if (!conf.ok) {
        console.error(`activity-sync: write NOT confirmed for "${e.title}" — ${conf.reason}`)
        copyErrors++
        continue
      }
      const sz = (await stat(copySrc)).size
      writtenById.set(e.id, { srcPath: e.srcToCopy, dstPath: e.dstToCopy, expectedSize: sz })
      copied++
      host.sendProgress({ phase: 'copy', current: copied + copyErrors, total: copyTotal, title: e.title })
    } catch (err) {
      console.error(`activity-sync: copy failed for "${e.title}":`, err)
      copyErrors++
    } finally {
      await release()
    }
  }

  if (droppedAtCopy.size > 0) {
    target -= droppedAtCopy.size
    console.warn(`activity-sync: list-only set — homemini couldn't send ${droppedAtCopy.size} song(s) at copy time, left off; landing ${target} of ${requested}`)
    if (target === 0) {
      return stopAfterTouch(fail({
        copied, kept, copyErrors, target: 0, requested, landed: 0, shortfall: 0, leftOff,
        error: `None of the songs on this iPod's list could be fetched from homemini. Not writing a catalog.`,
      }))
    }
  }
  // #47: the card holds what landed (primaries + any reserve that replaced a
  // miss); a miss that was replaced is not a failure, so copyErrors no longer
  // refuses the catalog on its own.
  tracks = tracks.filter((t) => writtenById.has(Number(t.id)))
  tsaBoarded = tracks.map((t) => tsaBoardPassenger({
    ...t,
    destPath: ipodPlayableDestPath(String(t.path || '')),
  }))
  if (copied + kept !== target || writtenById.size !== target || tracks.length !== target) {
    return stopAfterTouch(fail({
      copied, kept, copyErrors, target, landed: writtenById.size,
      shortfall: target - writtenById.size,
      error: `Only ${writtenById.size} of ${target} songs confirmed on the card after copy. Not writing a catalog — that is how Songs became 486. Sync again.`,
    }))
  }
  if (copyErrors > 0) {
    console.warn(`activity-sync: ${copyErrors} copy miss(es) replaced — still ${target}/${target} on the card`)
  }

  // ── 4. Prove N files across remounts (the whole set, staying songs too) ──
  if (!host.isMac) {
    return stopAfterTouch(fail({
      copied, copyErrors, target,
      error: 'Activity Sync can only prove the card on macOS (cold remount). Nothing was sealed.',
    }))
  }

  const verify = tracks.map((t) => {
    const id = Number(t.id)
    const remembered = writtenById.get(id)!
    return { id, dstPath: remembered.dstPath, localFile: remembered.srcPath, expectedSize: remembered.expectedSize }
  })
  const provenSize = new Map(verify.map((v) => [v.id, v.expectedSize]))

  host.sendProgress({
    phase: 'verify', current: 1, total: 16,
    title: `Verifying all ${target} songs actually landed on the iPod…`,
  })
  const verified = await remountVerifyEntries(IPOD_MOUNT, verify, {
    maxPasses: 16,
    label: 'activity-files',
    isCancelled: () => host.isCancelled(),
    prepareSource,
    remount: remountVolume,
  })
  let landedIds = verified.landedIds
  verifyAttempts = verified.attempts

  if (verified.remountFailed && landedIds.size === 0) {
    return stopAfterTouch(fail({
      copied, copyErrors, target, landed: 0, shortfall: target, verifyAttempts,
      error: 'Could not verify the iPod (remount failed after writing). The mount cache lies on this card — sync again without unplugging. No catalog was written.',
    }))
  }

  const gapFill = async () => {
    const missing = verify.filter((e) => !landedIds.has(e.id))
    if (missing.length === 0) return
    console.warn(`activity-sync: GAP-FILL — ${missing.length} missing; copy + F_FULLFSYNC + remount per song`)
    for (const e of missing) {
      if (host.isCancelled()) break
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (host.isCancelled()) break
        let release = async () => {}
        try {
          const prepared = await prepareSource(e)
          release = prepared.cleanup
          const dir = e.dstPath.substring(0, Math.max(e.dstPath.lastIndexOf('/'), e.dstPath.lastIndexOf('\\')))
          if (dir) await mkdir(dir, { recursive: true })
          await copyFile(prepared.abs, e.dstPath)
          const conf = await confirmWriteOnCard(prepared.abs, e.dstPath)
          if (!conf.ok) continue
          await flushCardCaches()
          const rm = await remountVolume(IPOD_MOUNT)
          if (!rm.ok) continue
          const sz = (await stat(e.dstPath).catch(() => null))?.size ?? -1
          if (sz === e.expectedSize) {
            landedIds.add(e.id)
            break
          }
        } catch { /* next attempt */ } finally {
          await release()
        }
      }
    }
  }
  if (landedIds.size < target) await gapFill()

  let consecutiveFull = 0
  for (let round = 1; round <= 4 && consecutiveFull < 2; round++) {
    if (host.isCancelled()) break
    const rm = await remountVolume(IPOD_MOUNT)
    if (!rm.ok) {
      consecutiveFull = 0
      console.warn(`activity-sync: proof ${round} remount failed — treating as not proven`)
      continue
    }
    let still = 0
    for (const e of verify) {
      try {
        if ((await stat(e.dstPath)).size === e.expectedSize) still++
        else landedIds.delete(e.id)
      } catch {
        landedIds.delete(e.id)
      }
    }
    if (still === target && landedIds.size === target) {
      consecutiveFull++
      console.log(`activity-sync: proof ${round} full (${consecutiveFull} consecutive) — ${target}/${target}`)
    } else {
      consecutiveFull = 0
      console.error(`activity-sync: proof ${round} lost songs (now ${landedIds.size}/${target})`)
      await gapFill()
    }
  }

  if (!activitySetProven(consecutiveFull, landedIds.size, target)) {
    return stopAfterTouch(fail({
      copied, copyErrors, target, landed: landedIds.size, shortfall: target - landedIds.size, verifyAttempts,
      error: `Only ${landedIds.size} of ${target} songs held across two remounts. Not writing a catalog (N means N). Sync again.`,
    }))
  }

  // ── 5. The whole set's catalog (always rebuilt in full: the firmware's
  // order, id and sort-table rules hold for the whole set, never a splice) ──
  const catalog = await putCatalog(tracks, playlists, 'final', provenSize)
  if (!catalog.ok) {
    if (swap) return swapStop(catalog.result)
    return catalog.touchedCard ? catalog.result : rewipeAndStop(catalog.result)
  }
  tracks = catalog.tracks
  const readback = catalog.readback

  // ── 6. TSA by identity, then seal ──
  host.sendProgress({
    phase: 'verify', current: 1, total: 1,
    title: `TSA — inspecting all ${target} songs by identity…`,
  })
  const byId = new Map(tracks.map((t) => [Number(t.id), t]))
  for (const p of tsaBoarded) {
    const t = byId.get(p.id)
    if (t) {
      p.destPath = tsaNormalizeColonPath(String(t.path || p.destPath))
      p.title = String(t.title || p.title)
      p.artist = String(t.artist || p.artist)
      const remembered = writtenById.get(p.id)
      p.expectedSize = remembered?.expectedSize || Number(t.fileSize) || p.expectedSize
    } else {
      p.destPath = tsaNormalizeColonPath(p.destPath)
    }
  }
  const onCard = new Map<string, number>()
  for (const p of tsaBoarded) {
    const remembered = writtenById.get(p.id)
    const dest = remembered?.dstPath || join(IPOD_MOUNT, tsaRelFromColon(p.destPath, pathSep))
    try { onCard.set(p.destPath, (await stat(dest)).size) } catch { /* hold */ }
  }
  const catalogPaths = new Set(
    readback.tracks.map((t) => tsaNormalizeColonPath(String(t.path || ''))),
  )
  const screen: TsaScreen = tsaScreen({ boarded: tsaBoarded, onCard, catalogPaths })
  if (!tsaAllClear(tsaBoarded.length, screen.cleared.length, screen.held.length) || tsaBoarded.length !== target) {
    const sample = screen.held.slice(0, 8).map((h) => `${h.artist} — ${h.title} (${h.reason})`).join('; ')
    await host.writeReport({
      syncedAt: new Date().toISOString(), target,
      landed: screen.cleared.length,
      shortfall: Math.max(screen.held.length, target - screen.cleared.length),
      verifyPasses: verifyAttempts, copied, copyErrors,
      failed: screen.held.slice(0, 40).map((h) => ({ id: h.id, title: h.title, artist: h.artist, path: h.destPath })),
    })
    return fail({
      copied, copyErrors, target, landed: screen.cleared.length,
      shortfall: Math.max(screen.held.length, target - screen.cleared.length), verifyAttempts,
      error: `TSA held ${Math.max(screen.held.length, target - screen.cleared.length)} of ${target} songs — the Mini would not show ${target}. ${sample}`,
    })
  }

  const seal = tsaSealFromScreen(screen, new Date().toISOString())
  if (!seal || seal.target !== target) {
    return fail({
      copied, copyErrors, target, landed: screen.cleared.length, shortfall: 0, verifyAttempts,
      error: `Activity set of ${target} cleared the lane but TSA could not build a seal. Sync again.`,
    })
  }
  try {
    await host.writeSeal(seal)
    console.log(`activity-sync: TSA sealed ${seal.target} songs — plug-in will inspect, not auto-sync`)
    try {
      // The swap's proof: this catalog's bytes and every file's size, so the
      // next Sync can trust the card and move only what changes.
      await host.writeManifest({
        format: SWAP_MANIFEST_FORMAT,
        syncedAt: seal.sealedAt,
        status: 'sealed',
        sealed: true,
        count: seal.target,
        catalog: { md5: catalog.md5, bytes: catalog.bytes },
        ...nextSwapHistory(swap && proof.ok ? proof.history : null, swap ? swap.leave.reduce((n, r) => n + r.size, 0) : 0),
        tracks: seal.passengers.map((p) => ({
          id: p.id, destPath: p.destPath, identity: p.identity, size: p.expectedSize, sourceSize: masterSizeById.get(p.id) || 0,
        })),
      })
    } catch (mErr) {
      console.warn('activity-sync: sealed, but last-sync-manifest update failed:', mErr)
    }
  } catch (sealErr) {
    return fail({
      copied, copyErrors, target, landed: screen.cleared.length, shortfall: 0, verifyAttempts,
      error: `The ${target} songs are on the card but TSA could not seal the set (${sealErr instanceof Error ? sealErr.message : String(sealErr)}). Sync again without unplugging.`,
    })
  }

  await retireScratch(IPOD_MOUNT, 'after seal')
  const sealedOk = tsaActivityOk({
    target,
    boarded: tsaBoarded.length,
    cleared: screen.cleared.length,
    held: screen.held.length,
    sealed: true,
    shortfall: false,
  })
  await host.writeReport({
    syncedAt: new Date().toISOString(),
    target,
    landed: target,
    shortfall: sealedOk ? 0 : target,
    verifyPasses: verifyAttempts,
    copied,
    copyErrors,
    failed: [],
  })
  const counts = swapCounts()
  const changedNote = counts && counts.changed > 0
    ? ` ${counts.changed.toLocaleString()} of them ${counts.changed === 1 ? 'was' : 'were'} re-copied because the library file changed.`
    : ''
  const summary = counts
    ? swapResultLine(counts.out, counts.in, counts.stayed) + changedNote
    : fullCopyLine(fullReason || 'nothing to keep')
  console.log(`activity-sync: ${summary}`)
  host.sendProgress({ phase: 'verify', current: 1, total: 1, title: 'Sealed', mode, summary })
  try {
    await appendFile(join(host.stateDir, 'activity-sync-ledger.jsonl'), JSON.stringify({
      kind: 'result', when: new Date().toISOString(), picksWhen: ledgerWhen,
      target, landed: target, sealedOk, copied, copyErrors,
      mode, ...(counts ? { swap: counts } : { fullReason }),
      ...(unconvertible.length > 0 ? { unconvertible: unconvertible.map((u) => u.id) } : {}),
      ...(listOnly ? { requested } : {}),
      ...(leftOff.length > 0 ? { leftOff: leftOff.map((l) => ({ id: l.id, t: l.title, a: l.artist, why: l.why })) } : {}),
    }) + '\n', 'utf-8')
  } catch (err) {
    console.warn('activity-sync: ledger result append failed (non-blocking):', err)
  }

  if (cardOnlyIds.size > 0) {
    console.log(`activity-sync: ${cardOnlyIds.size} song(s) ride under a card-only name (converted or 8.3 stem); library.json untouched`)
  }
  return {
    ok: sealedOk,
    copied,
    kept,
    copyErrors,
    totalTracks: tracks.length,
    target,
    landed: target,
    shortfall: sealedOk ? 0 : target,
    verifyAttempts,
    // No pathRewrites: card names never reach the library (see cardOnlyIds).
    ...(unconvertible.length > 0 ? { unconvertible } : {}),
    ...(listOnly ? { requested } : {}),
    ...(leftOff.length > 0 ? { leftOff } : {}),
    mode,
    ...(counts ? { swap: counts } : { fullReason: fullReason || undefined }),
    summary,
    error: sealedOk ? undefined : `Activity set of ${target} did not seal. Not calling this a success.`,
  }
}

/** The card's size in bytes (statfs), or null when it can't be read. */
async function cardCapacityBytes(mount: string): Promise<number | null> {
  try {
    const st = await statfs(mount)
    const bytes = Number(st.blocks) * Number(st.bsize)
    return bytes > 0 ? bytes : null
  } catch {
    return null
  }
}

/** What the card holds, read without writing: every music file's size, and
 *  the catalog's digest and id order. */
async function readCardState(mount: string): Promise<CardState> {
  const files = new Map<string, number>()
  for (const abs of await listIpodMusicFiles(mount)) {
    const sz = (await stat(abs).catch(() => null))?.size
    if (sz !== undefined) files.set(tsaNormalizeColonPath(abs.startsWith(mount) ? abs.slice(mount.length + 1) : abs), sz)
  }
  const db = await readFile(join(mount, 'iPod_Control', 'iTunes', 'iTunesDB')).catch(() => null)
  return { files, catalog: db ? catalogDigest(db) : null, catalogIdsAscend: db ? catalogIdsAscend(db) : null }
}
