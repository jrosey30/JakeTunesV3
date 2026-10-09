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
import { appendFile, copyFile, mkdir, readFile, stat, lstat, unlink } from 'fs/promises'
import { join } from 'path'
import { findIpodMount, isIpodMount, PYTHON_CMD, PYTHON_INSTALL_HINT, remountVolume } from './platform.ts'
import {
  activitySetProven,
  ACTIVITY_WIPE_EMPTY_STREAK,
  ACTIVITY_WIPE_MAX_PASSES,
  catalogBytesMatch,
  catalogOnCardProven,
  fileSizeForItunesDb,
  ipodFirmwareWillList,
  ipodPlayableDestPath,
  ipodPathExtension,
  needsIpodAlacTranscode,
  sampleRateForItunesDb,
} from './ipod-reconcile.ts'
import {
  tsaActivityOk,
  tsaAllClear,
  tsaBoardPassenger,
  tsaDestCollisions,
  tsaNormalizeColonPath,
  tsaRelFromColon,
  tsaScreen,
  tsaSealFromScreen,
  type TsaPassenger,
  type TsaScreen,
  type TsaSeal,
} from './ipod-sync-tsa.ts'
import { ensureContiguousDb } from './ipod-db-contiguity.ts'
import {
  confirmWriteOnCard,
  flushCardCaches,
  listIpodMusicFiles,
  remountVerifyEntries,
  retireIpodFirmwareScratch,
} from './ipod-sync-card.ts'
import { safeIpcError } from './safe-ipc-error.ts'
import { activityKeepPlan, wipeListingMatchesKeep, keepStreak, type KeepCandidate } from './activity-keep.ts'
import { orderForIpodCatalog, conformCatalogIdOrder } from './ipod-catalog-order.ts'
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
import { activityTrackCanBoard, pickReplacementTracks, queueActivityCandidates } from './activity-fill.ts'
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
  sendProgress: (p: { phase: string; current: number; total: number; title: string }) => void
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
}

export interface ActivitySyncInput {
  tracks: Array<Record<string, unknown>>
  playlists: Array<Record<string, unknown>>
  convertOptions?: SyncConvertOptions
  /** Explicit N (100/250/500/1000). Defaults to tracks.length. */
  requestedTarget?: number
  /** Extra eligible tracks the picker scored but did not board — copy replacements. */
  reserve?: Array<Record<string, unknown>>
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
}

export function bindActivityReplacements(
  getLibrary: () => Promise<{ tracks?: Array<Record<string, unknown>> }>,
  getIneligible: () => Promise<Set<number>>,
): NonNullable<ActivitySyncHost['loadReplacementTracks']> {
  return async (excludeIds, needed) => {
    const lib = await getLibrary()
    return pickReplacementTracks(lib.tracks || [], excludeIds, needed, await getIneligible())
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
): Promise<{ pool: Array<Record<string, unknown>>; shortfall: number }> {
  const idOf = (t: Record<string, unknown>) => Number(t.id)
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
  return { pool: queue, shortfall }
}

export async function runActivitySync(host: ActivitySyncHost, input: ActivitySyncInput): Promise<ActivitySyncResult> {
  const playlists = input.playlists
  const convertOptions = input.convertOptions
  const requested = Math.max(1, Math.floor(Number(input.requestedTarget) || input.tracks.length || 0))
  const pathSep = host.pathSep
  const python = host.pythonCmd || PYTHON_CMD || 'python3'

  let tracks: Array<Record<string, unknown>>
  {
    const expanded = await expandActivityPool(host, input.tracks, input.reserve || [], requested)
    tracks = expanded.pool.slice(0, requested + 40)
    if (expanded.pool.length < requested) {
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
  const target = requested

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
  const LOCAL_MOUNT = host.musicDir.replace(/[/\\]iPod_Control[/\\]Music$/, '')

  // ── 1. Preflight: names, then homemini-pull anything eviction removed ──
  // Unplayable rows are dropped and replaced — they do not count toward N.
  {
    const classified = await classifyActivitySyncTracks(tracks, {
      localMount: LOCAL_MOUNT,
      pathSep,
      lstat,
    })
    if (classified.blanks.length || classified.fileless.length) {
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
    if (pullFail.length > 0) {
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
  tracks = tracks.filter((t) => {
    const dest = ipodPlayableDestPath(String(t.path || ''))
    if (!dest) return false
    if (destSeen.has(dest)) return false
    destSeen.add(dest)
    return true
  })
  const collisions = tsaDestCollisions(tracks.map((t) => tsaBoardPassenger({
    ...t,
    destPath: ipodPlayableDestPath(String(t.path || '')),
  })))
  if (collisions.length > 0) {
    console.warn(`activity-sync: dest collision(s) after first-wins filter: ${collisions.slice(0, 3).join(', ')}`)
    const collide = new Set(collisions)
    tracks = tracks.filter((t) => !collide.has(ipodPlayableDestPath(String(t.path || ''))))
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
    }) + '\n', 'utf-8')
  } catch (err) {
    console.warn('activity-sync: ledger append failed (non-blocking):', err)
  }

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

  await host.writeJournal('copy')

  // ── 2. Resolve every song's source and card path BEFORE touching the card ──
  // The copy loop used to decide mirrors and paths per song AFTER the wipe.
  // Deciding first means a mirror that cannot be built refuses the sync
  // with the card untouched, and — the point — the keep plan below can
  // compare what WOULD be written against what is already there.
  const pathRewrites: Array<{ id: number; newPath: string }> = []
  interface CopyPlanEntry {
    i: number
    id: number
    title: string
    srcToCopy: string
    dstToCopy: string
    restage?: { colon: string; id: number }
    knownSourceSize?: number
  }
  const plan: CopyPlanEntry[] = []
  // #47 (fill-to-N): tracks[target..] are copy-time replacements. They are
  // resolved here like everything else, but never kept from a previous
  // card and only copied when a primary miss leaves the card short of N.
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
      // track.path becomes the CARD path (DB payload + TSA read it), but a
      // rewrite is only exported to the LIBRARY when the extension changed
      // (flac/FAT-temp → m4a, the mechanism's original purpose). The 8.3
      // stem shortening is card-only — exporting it rewrote 702 library
      // rows to names that exist nowhere in the farm (2026-08-31).
      if (ipodPathExtension(rawColon) !== ipodPathExtension(destColon)) {
        pathRewrites.push({ id, newPath: destColon })
      }
      track.path = destColon
    }
    const localFile = join(LOCAL_MOUNT, rawColon.replace(/:/g, pathSep))
    let srcToCopy = localFile
    let dstToCopy = join(IPOD_MOUNT, destColon.replace(/:/g, pathSep))
    let restage: { colon: string; id: number } | undefined
    let knownSourceSize: number | undefined

    host.sendProgress({ phase: 'copy', current: Math.min(i, target), total: target, title: `Preparing: ${title}` })

    const kind = await classifyLocalLibraryFile(rawColon, { localMount: LOCAL_MOUNT, pathSep, lstat })
    const needsPull = kind === 'streamed' || kind === 'missing'
    let bytesForMirror = localFile
    let stageCleanup: (() => Promise<void>) | null = null
    if (needsPull && (convertOptions?.enabled || needsIpodAlacTranscode(localFile))) {
      const staged = await host.stageTrack(rawColon, id)
      if (!staged.ok) {
        const msg = staged.reason === 'free-space'
          ? `Activity sync refused — ${staged.error}. Nothing was wiped.`
          : `Could not stage "${title}" for the iPod (${staged.error}). Nothing was wiped.`
        console.error(`activity-sync: ${msg}`)
        if (i >= target) { console.warn(`activity-sync: reserve "${title}" skipped`); continue }
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
            phase: 'copy', current: Math.min(i, target), total: target,
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
              pathRewrites.push({ id, newPath: newColon })
            }
          }
        } catch (err) {
          console.warn(`activity-sync: AAC mirror failed for ${title}, copying original:`, err)
        }
      }

      if (needsIpodAlacTranscode(srcToCopy === localFile ? bytesForMirror : srcToCopy)) {
        try {
          host.sendProgress({
            phase: 'copy', current: Math.min(i, target), total: target,
            title: `Converting → ALAC: ${title}`,
          })
          // bytesForMirror is a real file: a library master, or one staged
          // temp. The library symlink is not replaced.
          const mirror = await host.buildIpodSafeAlacMirror(bytesForMirror)
          if (!mirror) {
            if (i >= target) { console.warn(`activity-sync: reserve "${title}" has no iPod-safe ALAC — skipped`); continue }
            await host.writeJournal(null)
            return fail({ copied: 0, error: `Could not build an iPod-safe ALAC for "${title}". Nothing was wiped.`, target })
          }
          srcToCopy = mirror
          dstToCopy = ipodPlayableDestPath(dstToCopy)
          const newRel = dstToCopy.startsWith(IPOD_MOUNT) ? dstToCopy.slice(IPOD_MOUNT.length + 1) : dstToCopy
          track.path = tsaNormalizeColonPath(newRel)
          track.codec = 'alac'
          pathRewrites.push({ id, newPath: String(track.path) })
        } catch (err) {
          console.error(`activity-sync: FLAC→ALAC failed for ${title}:`, err)
          if (i >= target) { console.warn(`activity-sync: reserve "${title}" skipped`); continue }
          await host.writeJournal(null)
          return fail({ copied: 0, error: `FLAC→ALAC failed for "${title}" (${err instanceof Error ? err.message : String(err)}). Nothing was wiped.`, target })
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
    plan.push({ i, id, title, srcToCopy, dstToCopy, restage, knownSourceSize })
  }

  // ── 2b. Keep plan: what is already right on the card, by identity ──
  // A song is kept only when the last SEALED manifest lists this id at this
  // card path with this fingerprint identity AND the card file is exactly
  // the size of what we would copy (activity-keep.ts). Anything else is
  // copied; everything else on the card is deleted. All proof stages
  // downstream are unchanged, so a wrong keep cannot seal.
  let manifest: unknown = null
  try { manifest = JSON.parse(await readFile(join(host.stateDir, 'last-sync-manifest.json'), 'utf-8')) } catch { manifest = null }
  const identityById = new Map(tsaBoarded.map((p) => [p.id, p.identity]))
  const candidates: KeepCandidate[] = []
  const srcSizeById = new Map<number, number>()
  const cardSizeById = new Map<number, number>()
  for (const e of plan) {
    if (e.i >= target) continue   // a reserve is never kept — it lands only if a primary misses
    const rel = e.dstToCopy.startsWith(IPOD_MOUNT) ? e.dstToCopy.slice(IPOD_MOUNT.length + 1) : e.dstToCopy
    const sourceSize = e.knownSourceSize ?? (await stat(e.srcToCopy).catch(() => null))?.size ?? 0
    const onCardSize = (await stat(e.dstToCopy).catch(() => null))?.size
    srcSizeById.set(e.id, sourceSize)
    if (onCardSize !== undefined) cardSizeById.set(e.id, onCardSize)
    candidates.push({
      id: e.id,
      destPath: tsaNormalizeColonPath(rel),
      identity: identityById.get(e.id) || '',
      sourceSize,
      onCardSize,
    })
  }
  const keep = activityKeepPlan(candidates, manifest as Parameters<typeof activityKeepPlan>[1])
  const keepAbs = new Set(plan.filter((e) => keep.keepIds.has(e.id)).map((e) => e.dstToCopy))
  console.log(`activity-sync: KEEP ${keep.keepIds.size} already on the card by identity, COPY ${keep.copyIds.length}` +
    (keep.copyIds.length ? ` (${Object.entries(keep.reasons).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''))

  // ── 3. Targeted wipe: delete everything outside the keep set, prove it ──
  host.sendProgress({
    phase: 'copy', current: 0, total: 1,
    title: keep.keepIds.size > 0
      ? `Keeping ${keep.keepIds.size.toLocaleString()} already on the iPod · clearing the rest…`
      : 'Wiping the iPod for a clean rebuild…',
  })
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
      console.log(`activity-sync: WIPE pass ${pass + 1}/${ACTIVITY_WIPE_MAX_PASSES} listed=${listed.length} now=${listedNow.length} keep=${keepAbs.size} streak=${streak}`)
      if (streak >= ACTIVITY_WIPE_EMPTY_STREAK) break
      await new Promise((r) => setTimeout(r, 250))
    }
    if (streak < ACTIVITY_WIPE_EMPTY_STREAK) {
      const extra = listedNow.filter((p) => !keepAbs.has(p)).length
      const missing = [...keepAbs].filter((p) => !listedNow.includes(p)).length
      return fail({
        copied: 0,
        error: `Activity wipe could not settle the iPod (${extra} leftover file${extra === 1 ? '' : 's'}, ${missing} kept file${missing === 1 ? '' : 's'} vanished). Reseat the cable and sync again — nothing new was copied.`,
        target,
      })
    }
    await retireIpodFirmwareScratch(IPOD_MOUNT)
    console.log(`activity-sync: WIPE deleted ${wiped} file(s) — card holds exactly the ${keepAbs.size} kept, rebuilding to ${target}`)
  } catch (e) {
    return fail({
      copied: 0,
      error: `Activity wipe failed (${e instanceof Error ? e.message : String(e)}). Nothing was copied.`,
      target,
    })
  }

  const rewipeAndStop = async (why: ActivitySyncResult): Promise<ActivitySyncResult> => {
    try {
      for (const p of await listIpodMusicFiles(IPOD_MOUNT)) {
        try { await unlink(p) } catch { /* best effort */ }
      }
      await retireIpodFirmwareScratch(IPOD_MOUNT)
    } catch { /* best effort */ }
    console.error(`activity-sync: abort after wipe — re-emptied Music so Mini cannot index a ${why.landed ?? 'partial'} set. ${why.error}`)
    return why
  }

  // ── 3b. Copy what is not already there ──
  const writtenById = new Map<number, { srcPath: string; dstPath: string; expectedSize: number }>()
  const restageById = new Map<number, { colon: string; id: number }>()
  for (const e of plan) if (e.restage) restageById.set(e.id, e.restage)
  const prepareSource = async (entry: { id: number; localFile: string }): Promise<{ abs: string; cleanup: () => Promise<void> }> => {
    const rs = restageById.get(entry.id)
    if (!rs) return { abs: entry.localFile, cleanup: async () => {} }
    const staged = await host.stageTrack(rs.colon, rs.id)
    if (!staged.ok) throw new Error(staged.error)
    return { abs: staged.abs, cleanup: staged.cleanup }
  }
  let copied = 0
  let kept = 0
  let copyErrors = 0

  for (const e of plan) {
    if (writtenById.size >= target) break   // #47: N reached — the rest were reserves
    if (host.isCancelled()) {
      host.sendProgress({ phase: 'cancelled', current: copied + kept + copyErrors, total: target, title: '' })
      return rewipeAndStop({ ok: false, copied, kept, copyErrors, cancelled: true, error: 'Sync cancelled by user', target })
    }
    if (keep.keepIds.has(e.id)) {
      const sz = cardSizeById.get(e.id) ?? srcSizeById.get(e.id) ?? 0
      writtenById.set(e.id, { srcPath: e.srcToCopy, dstPath: e.dstToCopy, expectedSize: sz })
      kept++
      host.sendProgress({ phase: 'copy', current: copied + kept + copyErrors, total: target, title: `Kept: ${e.title}` })
      continue
    }
    host.sendProgress({ phase: 'copy', current: copied + kept + copyErrors, total: target, title: e.title })
    let copySrc = e.srcToCopy
    let release = async () => {}
    if (e.restage) {
      const staged = await host.stageTrack(e.restage.colon, e.restage.id)
      if (!staged.ok) {
        console.error(`activity-sync: skipping "${e.title}" — ${staged.error}`)
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
      host.sendProgress({ phase: 'copy', current: copied + kept + copyErrors, total: target, title: e.title })
    } catch (err) {
      console.error(`activity-sync: copy failed for "${e.title}":`, err)
      copyErrors++
    } finally {
      await release()
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
    return rewipeAndStop(fail({
      copied, kept, copyErrors, target, landed: writtenById.size,
      shortfall: target - writtenById.size,
      error: `Only ${writtenById.size} of ${target} songs confirmed on the card after copy. Not writing a catalog — that is how Songs became 486. Sync again.`,
    }))
  }
  if (copyErrors > 0) {
    console.warn(`activity-sync: ${copyErrors} copy miss(es) replaced — still ${target}/${target} on the card`)
  }

  // ── 4. Prove N files across remounts ──
  if (!host.isMac) {
    return rewipeAndStop(fail({
      copied, copyErrors, target,
      error: 'Activity Sync can only prove the card on macOS (cold remount). Nothing was sealed.',
    }))
  }

  const verify = tracks.map((t) => {
    const id = Number(t.id)
    const remembered = writtenById.get(id)!
    return { id, dstPath: remembered.dstPath, localFile: remembered.srcPath, expectedSize: remembered.expectedSize }
  })

  host.sendProgress({
    phase: 'verify', current: 1, total: 16,
    title: `Verifying all ${target} songs actually landed on the iPod…`,
  })
  const verified = await remountVerifyEntries(IPOD_MOUNT, verify, {
    maxPasses: 16,
    label: 'activity-files',
    isCancelled: () => host.isCancelled(),
    prepareSource,
  })
  let landedIds = verified.landedIds
  let verifyAttempts = verified.attempts

  if (verified.remountFailed && landedIds.size === 0) {
    return rewipeAndStop(fail({
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
    return rewipeAndStop(fail({
      copied, copyErrors, target, landed: landedIds.size, shortfall: target - landedIds.size, verifyAttempts,
      error: `Only ${landedIds.size} of ${target} songs held across two remounts. Not writing a catalog (N means N). Sync again.`,
    }))
  }

  // Stamp iTunesDB sizes from the card, not library.json.
  // Write tracks in firmware-fold title order so Music > Songs is A–Z
  // even if type-52 key 7 is discarded. stamp sortArtist for mhod 22
  // (Artists). mhia + type-52 3/5 are built inside write_itunesdb.
  tracks = orderTracksForIpodTitleIndex(tracks.map((t) => stampIpodSortArtist(t)))
  for (const t of tracks) {
    const remembered = writtenById.get(Number(t.id))
    if (!remembered) continue
    try {
      const sz = (await stat(remembered.dstPath)).size
      t.fileSize = fileSizeForItunesDb(sz)
      t.sampleRate = sampleRateForItunesDb(t.sampleRate as number | undefined)
      remembered.expectedSize = sz
    } catch { /* prove already passed */ }
    if (!String(t.title || '').trim()) {
      const base = String(t.path || '').split(':').pop() || 'Unknown'
      t.title = base.replace(/\.[^.]+$/, '') || 'Unknown'
    }
    if (!String(t.artist || '').trim()) t.artist = String(t.albumArtist || t.album || 'Unknown Artist')
  }
  const unlistable = tracks.filter((t) => !ipodFirmwareWillList(t))
  if (unlistable.length > 0) {
    return rewipeAndStop(fail({
      copied, copyErrors, target, landed: target - unlistable.length, shortfall: unlistable.length, verifyAttempts,
      error: `${unlistable.length} song(s) Mini 1.4.1 will not list. Not writing a catalog. ${unlistable.slice(0, 3).map((t) => `${t.artist} — ${t.title}`).join('; ')}`,
    }))
  }

  // Mini 1.4.1 lists artists in mhit PHYSICAL order (no type-52 sort
  // tables in that firmware) — the catalog is written alphabetically so
  // the Artists menu reads A-Z. Playlists reference dbids, so their order
  // is untouched. (2026-08-28, Jake: "why are the artists not in
  // alphabetical order?")
  tracks = orderForIpodCatalog(tracks)

  // ── 5. Build catalog locally, copy to CF, prove bytes+hash+N ──
  await host.writeJournal('db')
  host.sendProgress({ phase: 'db', current: 0, total: 1, title: 'Writing iTunesDB...' })
  const ipodDb = join(IPOD_MOUNT, 'iPod_Control', 'iTunes', 'iTunesDB')
  try { await copyFile(ipodDb, ipodDb + '.bak') } catch { /* non-fatal */ }
  const localDb = join(host.tempDir, `jaketunes-itunesdb-${host.pid}`)
  const written = await spawnJson(
    python,
    [host.coreScript('core/db_reader.py'), '--write', localDb, '--template', ipodDb, '--ipod-root', IPOD_MOUNT],
    JSON.stringify({ tracks, playlists }),
  )
  if (written.err && (written.err as NodeJS.ErrnoException).code === 'ENOENT') {
    return rewipeAndStop(fail({ copied, copyErrors, error: host.pythonHint || PYTHON_INSTALL_HINT, target }))
  }
  if (written.code !== 0) {
    try { await unlink(localDb) } catch { /* temp */ }
    return rewipeAndStop(fail({
      copied, copyErrors, target,
      error: safeIpcError(`DB write failed (code ${written.code}): ${written.stderr}`, 'tool-failed'),
    }))
  }
  console.log('activity-sync stderr:', written.stderr)
  // Firmware finds songs by binary search on mhit id — ids must ascend in
  // record order or songs silently vanish from About (the 819 saga).
  const conform = await conformCatalogIdOrder(localDb)
  if (!conform.ok) {
    try { await unlink(localDb) } catch { /* temp */ }
    await retireIpodFirmwareScratch(IPOD_MOUNT)
    return rewipeAndStop(fail({
      copied, copyErrors, target,
      error: `The catalog could not be conformed to firmware id order (${conform.error}). Previous catalog is untouched. Sync again.`,
    }))
  }
  console.log(`activity-sync: ${conform.summary}`)
  const contig = await ensureContiguousDb(localDb, python)
  console.log(`activity-sync: ${contig.summary}`)
  if (!contig.ok) {
    try { await unlink(localDb) } catch { /* temp */ }
    await retireIpodFirmwareScratch(IPOD_MOUNT)
    return rewipeAndStop(fail({
      copied, copyErrors, target,
      error: `The catalog was written but could not be laid down as one piece (${contig.error}). Previous catalog is untouched. Sync again.`,
    }))
  }
  host.sendProgress({ phase: 'db', current: 1, total: 1, title: 'iTunesDB written' })

  host.sendProgress({
    phase: 'db', current: 1, total: 1,
    title: `Putting the ${target}-song catalog on the card…`,
  })
  let catalogConsecutive = 0
  let readback: { tracks: Array<Record<string, unknown>> } | null = null
  const CATALOG_PROOF_ROUNDS = 4
  for (let round = 1; round <= CATALOG_PROOF_ROUNDS; round++) {
    if (catalogConsecutive === 0) {
      try {
        await copyFile(localDb, ipodDb)
        const conf = await confirmWriteOnCard(localDb, ipodDb)
        if (!conf.ok) {
          console.error(`activity-sync: catalog copy not confirmed (${conf.reason})`)
          continue
        }
      } catch (copyErr) {
        console.error('activity-sync: catalog copy onto the card failed:', copyErr)
        continue
      }
    }
    await retireIpodFirmwareScratch(IPOD_MOUNT)
    const flush = await remountVolume(IPOD_MOUNT)
    if (!flush.ok) {
      await retireIpodFirmwareScratch(IPOD_MOUNT)
      try { await unlink(localDb) } catch { /* temp */ }
      return fail({
        copied, copyErrors, target, landed: 0, shortfall: target, verifyAttempts,
        error: `The catalog file never made it onto the card — remount failed (${flush.error}). The Mini does not have ${target} songs. Do not unplug — sync again.`,
      })
    }
    host.setDetectedMount(flush.mountPoint || IPOD_MOUNT)
    await retireIpodFirmwareScratch(flush.mountPoint || IPOD_MOUNT)
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
    console.log(`activity-sync: catalog proof ${round}/${CATALOG_PROOF_ROUNDS} — card ${onCard.length}b md5 ${cardMd5.slice(0, 8)} tracks=${readback.tracks.length} vs local ${contig.bytes}b md5 ${contig.md5.slice(0, 8)} target=${target} match=${match}`)
    if (match) {
      catalogConsecutive++
      if (catalogOnCardProven(catalogConsecutive, match)) {
        console.log(`activity-sync: catalog ON CARD — ${target} tracks, ${contig.bytes} bytes, held across two remounts`)
        break
      }
    } else {
      catalogConsecutive = 0
    }
  }
  try { await unlink(localDb) } catch { /* temp */ }
  if (!readback || !catalogOnCardProven(catalogConsecutive, catalogConsecutive >= 2)) {
    return fail({
      copied, copyErrors, target, landed: 0, shortfall: target, verifyAttempts,
      error: `The ${target}-song catalog never committed to the card. Mac cache is not the Mini — that is how Songs became 450. Not calling this done. Sync again without unplugging.`,
    })
  }

  const onDevice = readback.tracks.length
  if (onDevice !== target) {
    return fail({
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
    return fail({
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
    return fail({
      copied, copyErrors, target, landed: 0, shortfall: target, verifyAttempts,
      error: `The ${target} files are on the iPod, but its catalog contains firmware-invalid song records. JakeTunes refused to claim success. Sync again to rebuild the catalog.`,
    })
  }
  console.log(`activity-sync: firmware-semantic validation GREEN for all ${target} tracks`)

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
      await host.writeManifest({
        syncedAt: seal.sealedAt,
        status: 'sealed',
        sealed: true,
        count: seal.target,
        tracks: seal.passengers.map((p) => ({ id: p.id, destPath: p.destPath, identity: p.identity })),
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

  await retireIpodFirmwareScratch(IPOD_MOUNT)
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
  try {
    await appendFile(join(host.stateDir, 'activity-sync-ledger.jsonl'), JSON.stringify({
      kind: 'result', when: new Date().toISOString(), picksWhen: ledgerWhen,
      target, landed: target, sealedOk, copied, copyErrors,
    }) + '\n', 'utf-8')
  } catch (err) {
    console.warn('activity-sync: ledger result append failed (non-blocking):', err)
  }

  return {
    ok: sealedOk,
    copied,
    copyErrors,
    totalTracks: tracks.length,
    target,
    landed: target,
    shortfall: sealedOk ? 0 : target,
    verifyAttempts,
    pathRewrites: pathRewrites.map((r) => ({ id: r.id, newPath: r.newPath })),
    error: sealedOk ? undefined : `Activity set of ${target} did not seal. Not calling this a success.`,
  }
}
