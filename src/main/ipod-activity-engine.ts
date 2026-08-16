/**
 * Activity Sync — dedicated wipe+rebuild engine.
 *
 * This is NOT the full-library copy loop with extra gates. Activity Sync
 * of N (100 / 250 / 500 / 1000) is one pipeline:
 *
 *   1. Board N by identity. Refuse streamed, dest collisions, blanks.
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
import { copyFile, mkdir, readFile, stat, lstat, unlink } from 'fs/promises'
import { join } from 'path'
import { findIpodMount, isIpodMount, PYTHON_CMD, PYTHON_INSTALL_HINT, remountVolume } from './platform.ts'
import {
  activitySetProven,
  activityWipeEmptyStreak,
  activityWipeProvenEmpty,
  ACTIVITY_WIPE_MAX_PASSES,
  catalogBytesMatch,
  catalogOnCardProven,
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
import type { SyncConvertOptions } from './ipc/sync-ipc.ts'
import {
  classifyActivitySyncTracks,
  formatHomeminiPullRefuse,
  formatSyncSetFileRefuse,
} from './activity-boardable.ts'

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
  /** Pull homemini bytes onto this Mac when eviction (or a symlink) left
   *  nothing copyFile can send to the Mini. HTTP only — never SMB. */
  materializeTrack: (colonPath: string, trackId: number) => Promise<{ ok: boolean; error?: string; pulled?: boolean }>
}

export interface ActivitySyncInput {
  tracks: Array<Record<string, unknown>>
  playlists: Array<Record<string, unknown>>
  convertOptions?: SyncConvertOptions
}

export interface ActivitySyncResult {
  ok: boolean
  copied: number
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

function fail(partial: Omit<ActivitySyncResult, 'ok'> & { error: string }): ActivitySyncResult {
  return { ok: false, copied: partial.copied ?? 0, ...partial }
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

export async function runActivitySync(host: ActivitySyncHost, input: ActivitySyncInput): Promise<ActivitySyncResult> {
  let tracks = input.tracks
  const playlists = input.playlists
  const convertOptions = input.convertOptions
  const target = tracks.length
  const pathSep = host.pathSep
  const python = host.pythonCmd || PYTHON_CMD || 'python3'

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
  const { blanks, fileless, toPull } = await classifyActivitySyncTracks(tracks, {
    localMount: LOCAL_MOUNT,
    pathSep,
    lstat,
  })
  if (blanks.length || fileless.length) {
    console.error(`activity-sync: REFUSING — ${target}-song set has unplayable tracks`)
    for (const b of [...blanks, ...fileless].slice(0, 20)) console.error('   •', b)
    await host.writeJournal(null)
    return fail({
      copied: 0,
      error: formatSyncSetFileRefuse({
        lead: 'Activity sync refused',
        blanks,
        fileless,
        total: target,
        nothingVerb: 'wiped',
      }),
      target,
    })
  }
  if (toPull.length > 0) {
    console.log(`activity-sync: ${toPull.length}/${target} not on this Mac — pulling from homemini before wipe`)
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
        title: `Pulling from homemini: ${p.label}`,
      })
      const r = await host.materializeTrack(p.path, p.id)
      if (!r.ok) {
        pullFail.push(`${p.label} (${r.error || 'homemini miss'})`)
        console.error(`activity-sync: homemini pull failed — ${p.label}: ${r.error}`)
      } else if (r.pulled) {
        console.log(`activity-sync: pulled ${p.label} from homemini`)
      }
    }
    if (pullFail.length > 0) {
      await host.writeJournal(null)
      return fail({
        copied: 0,
        error: formatHomeminiPullRefuse(pullFail, target),
        target,
      })
    }
  }

  const tsaBoarded: TsaPassenger[] = tracks.map((t) => tsaBoardPassenger({
    ...t,
    destPath: ipodPlayableDestPath(String(t.path || '')),
  }))
  if (tsaBoarded.length !== target || target <= 0) {
    return fail({ copied: 0, error: `Activity TSA boarded ${tsaBoarded.length} for a ${target}-song set. Nothing was wiped.`, target })
  }
  const emptyDest = tsaBoarded.filter((p) => !p.destPath)
  if (emptyDest.length > 0) {
    return fail({ copied: 0, error: `Activity TSA: ${emptyDest.length} song(s) have no dest path. Nothing was wiped.`, target })
  }
  const collisions = tsaDestCollisions(tsaBoarded)
  if (collisions.length > 0) {
    return fail({
      copied: 0,
      error: `Activity TSA: ${collisions.length} dest path(s) would collide on the Mini. Nothing was wiped. Examples: ${collisions.slice(0, 3).join(', ')}`,
      target,
      destCollisions: collisions.length,
    })
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

  // ── 2. Wipe until two consecutive empty listings ──
  host.sendProgress({ phase: 'copy', current: 0, total: 1, title: 'Wiping the iPod for a clean rebuild…' })
  let wiped = 0
  try {
    let emptyStreak = 0
    let remaining = 0
    for (let pass = 0; pass < ACTIVITY_WIPE_MAX_PASSES; pass++) {
      const listed = await listIpodMusicFiles(IPOD_MOUNT)
      for (const p of listed) {
        try { await unlink(p); wiped++ } catch { /* retry */ }
      }
      remaining = (await listIpodMusicFiles(IPOD_MOUNT)).length
      emptyStreak = activityWipeEmptyStreak(remaining, emptyStreak)
      console.log(`activity-sync: WIPE pass ${pass + 1}/${ACTIVITY_WIPE_MAX_PASSES} deleted-this-listing=${listed.length} remaining=${remaining} emptyStreak=${emptyStreak}`)
      if (activityWipeProvenEmpty(emptyStreak)) break
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!activityWipeProvenEmpty(emptyStreak)) {
      return fail({
        copied: 0,
        error: `Activity wipe could not empty the iPod (${remaining} leftover file${remaining === 1 ? '' : 's'}). Reseat the cable and sync again — nothing new was copied.`,
        target,
      })
    }
    await retireIpodFirmwareScratch(IPOD_MOUNT)
    console.log(`activity-sync: WIPE deleted ${wiped} file(s) — card is empty, rebuilding to ${target}`)
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

  // ── 3. Copy every boarded song ──
  const pathRewrites: Array<{ id: number; newPath: string }> = []
  const writtenById = new Map<number, { srcPath: string; dstPath: string; expectedSize: number }>()
  let copied = 0
  let copyErrors = 0

  for (let i = 0; i < tracks.length; i++) {
    if (host.isCancelled()) {
      host.sendProgress({ phase: 'cancelled', current: copied + copyErrors, total: target, title: '' })
      return rewipeAndStop({ ok: false, copied, copyErrors, cancelled: true, error: 'Sync cancelled by user', target })
    }
    const track = tracks[i]
    const title = String(track.title || '')
    const id = Number(track.id)
    const rawColon = String(track.path || '')
    const destColon = ipodPlayableDestPath(rawColon)
    if (destColon !== rawColon) {
      pathRewrites.push({ id, newPath: destColon })
      track.path = destColon
    }
    const localFile = join(LOCAL_MOUNT, rawColon.replace(/:/g, pathSep))
    let srcToCopy = localFile
    let dstToCopy = join(IPOD_MOUNT, destColon.replace(/:/g, pathSep))

    host.sendProgress({ phase: 'copy', current: copied + copyErrors, total: target, title })

    if (convertOptions?.enabled) {
      try {
        host.sendProgress({
          phase: 'copy', current: copied + copyErrors, total: target,
          title: `Converting → ${convertOptions.targetKbps}k AAC: ${title}`,
        })
        const mirror = await host.buildAacMirror(localFile, convertOptions.targetKbps)
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

    if (needsIpodAlacTranscode(srcToCopy)) {
      try {
        host.sendProgress({
          phase: 'copy', current: copied + copyErrors, total: target,
          title: `Converting → ALAC: ${title}`,
        })
        const mirror = await host.buildIpodSafeAlacMirror(localFile)
        if (!mirror) {
          copyErrors++
          continue
        }
        srcToCopy = mirror
        dstToCopy = ipodPlayableDestPath(dstToCopy)
        const newRel = dstToCopy.startsWith(IPOD_MOUNT) ? dstToCopy.slice(IPOD_MOUNT.length + 1) : dstToCopy
        track.path = tsaNormalizeColonPath(newRel)
        track.codec = 'alac'
        pathRewrites.push({ id, newPath: String(track.path) })
      } catch (err) {
        console.error(`activity-sync: FLAC→ALAC failed for ${title}:`, err)
        copyErrors++
        continue
      }
    }

    dstToCopy = ipodPlayableDestPath(dstToCopy)
    try {
      const dir = dstToCopy.substring(0, dstToCopy.lastIndexOf(pathSep))
      await mkdir(dir, { recursive: true })
      await copyFile(srcToCopy, dstToCopy)
      const conf = await confirmWriteOnCard(srcToCopy, dstToCopy)
      if (!conf.ok) {
        console.error(`activity-sync: write NOT confirmed for "${title}" — ${conf.reason}`)
        copyErrors++
        continue
      }
      const sz = (await stat(srcToCopy)).size
      writtenById.set(id, { srcPath: srcToCopy, dstPath: dstToCopy, expectedSize: sz })
      copied++
      host.sendProgress({ phase: 'copy', current: copied + copyErrors, total: target, title })
    } catch (err) {
      console.error(`activity-sync: copy failed for "${title}":`, err)
      copyErrors++
    }
  }

  if (copied !== target || copyErrors > 0 || writtenById.size !== target) {
    return rewipeAndStop(fail({
      copied, copyErrors, target, landed: writtenById.size,
      shortfall: target - writtenById.size,
      error: `Only ${writtenById.size} of ${target} songs confirmed on the card after copy. Not writing a catalog — that is how Songs became 486. Sync again.`,
    }))
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
        try {
          const dir = e.dstPath.substring(0, Math.max(e.dstPath.lastIndexOf('/'), e.dstPath.lastIndexOf('\\')))
          if (dir) await mkdir(dir, { recursive: true })
          await copyFile(e.localFile, e.dstPath)
          const conf = await confirmWriteOnCard(e.localFile, e.dstPath)
          if (!conf.ok) continue
          await flushCardCaches()
          const rm = await remountVolume(IPOD_MOUNT)
          if (!rm.ok) continue
          const sz = (await stat(e.dstPath).catch(() => null))?.size ?? -1
          if (sz === e.expectedSize) {
            landedIds.add(e.id)
            break
          }
        } catch { /* next attempt */ }
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
