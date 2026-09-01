// ════════════════════════════════════════════════════════════════════════
//  sync-engine — the iPod sync pipeline, extracted from index.ts
//  (6.0 Phase 1 / renovation-roadmap P1C2, 2026-09-01).
//
//  MOVE-ONLY cut: function bodies are verbatim from index.ts except the
//  enumerated substitutions (MUSIC_DIR → host.getMusicDir(),
//  detectedIpodMount/Volume reads+writes → host.getMount()/setMount()).
//  Behavior changes do NOT ride along with structure moves — roadmap rule.
//
//  Mutable state shared with the main process arrives through
//  SyncEngineHost suppliers; the engine owns its own in-flight/cancel
//  state and exposes accessors for it.
// ════════════════════════════════════════════════════════════════════════

import { app } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { copyFile, lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { IS_MAC, IS_WINDOWS, PYTHON_CMD, PYTHON_INSTALL_HINT, findIpodMount, isIpodMount, remountVolume } from '../platform'
import { STATE_DIR } from '../state-dir'
import { writeJsonAtomic } from '../atomic-write'
import { safeIpcError } from '../safe-ipc-error'
import { normalize } from '../normalize'
import { refuseIpodSyncUnlessUserClick, type IpodSyncOpts } from '../ipod-sync-origin'
import type { SyncConvertOptions } from '../ipc/sync-ipc.ts'
import { runActivitySync } from '../ipod-activity-engine.ts'
import { ensureContiguousDb } from '../ipod-db-contiguity.ts'
import {
  ACTIVITY_WIPE_MAX_PASSES, activitySetProven, activityWipeEmptyStreak, activityWipeProvenEmpty,
  catalogBytesMatch, catalogOnCardProven, fileSizeForItunesDb, ipodFirmwareWillList,
  ipodPlayableDestPath, needsIpodAlacTranscode, sampleRateForItunesDb,
} from '../ipod-reconcile.ts'
import { confirmWriteOnCard, flushCardCaches, remountVerifyEntries, retireIpodFirmwareScratch } from '../ipod-sync-card.ts'
import {
  tsaActivityOk, tsaAllClear, tsaBoardPassenger, tsaDestCollisions,
  tsaNormalizeColonPath, tsaRelFromColon, tsaScreen, tsaSealFromScreen,
  type TsaPassenger, type TsaScreen,
} from '../ipod-sync-tsa.ts'
import { classifyActivitySyncTracks, formatHomeminiPullRefuse, formatSyncSetFileRefuse } from '../activity-boardable.ts'

// Contract of the silent post-sync verifier (implementation stays in the
// main process; these shapes moved here with its only caller).
export interface VerifyTrackInput {
  id: number
  path: string
  duration: number
  audioFingerprint?: string
  // Current flag, so a track that is fine again can have it RETRACTED.
  audioMissing?: boolean
}
export interface VerifyTrackUpdate {
  id: number
  audioFingerprint?: string
  path?: string
  audioMissing?: boolean
}

export interface SyncEngineHost {
  LOSSLESS_EXTS: Set<string>
  LOSSLESS_CODECS: Set<string>
  codecByAbsPath: Map<string, string>
  getMusicDir: () => string
  getMount: () => string | null
  /** Sets the detected mount AND derives the volume name — the exact
   *  two-write pattern every extracted call site used. */
  setMount: (m: string | null) => void
  buildAacMirror: (srcPath: string, targetKbps: number) => Promise<string | null>
  buildIpodSafeAlacMirror: (srcPath: string) => Promise<string | null>
  candidateMusicMounts: () => Promise<string[]>
  cleanOrphansOnMusicRoot: (musicRoot: string, tracks: Array<{ path?: string }>, protectMtimeAfterMs?: number) => Promise<{ deleted: number; bytesFreed: number; protected: number }>
  computeAudioFingerprint: (absPath: string, durationMs: number) => Promise<string | null>
  getConcertOwnedTrackIds: () => Promise<Set<number>>
  isStreamedTrackFile: (absPath: string) => Promise<boolean>
  materializeLibraryTrack: (colonPath: string, trackId: number | string) => Promise<{ ok: boolean; error?: string; pulled?: boolean }>
  readIpodDatabase: () => Promise<{ tracks: Array<Record<string, unknown>>; playlists: Array<{ name: string; trackIds: number[] }> }>
  resolveTrackAbsPath: (colonPath: string, mounts: string[]) => Promise<string | null>
  scheduleDbRebuild: (deletedPaths: string[]) => void
  sendToRenderer: (channel: string, ...args: unknown[]) => void
  verifyAndHealTracks: (inputs: VerifyTrackInput[], mounts: string[]) => Promise<VerifyTrackUpdate[]>
  walkAudioFilesUnder: (root: string) => Promise<string[]>
}

export function createSyncEngine(host: SyncEngineHost) {
  const {
    LOSSLESS_EXTS, LOSSLESS_CODECS, codecByAbsPath,
    buildAacMirror, buildIpodSafeAlacMirror, candidateMusicMounts, cleanOrphansOnMusicRoot,
    computeAudioFingerprint, getConcertOwnedTrackIds, isStreamedTrackFile,
    materializeLibraryTrack, readIpodDatabase, resolveTrackAbsPath, scheduleDbRebuild,
    sendToRenderer, verifyAndHealTracks, walkAudioFilesUnder,
  } = host

  async function handleSyncIpodFromDevice(existingIds: number[]): Promise<unknown> {
    try {
      const ipodData = await readIpodDatabase()
      const knownIds = new Set(existingIds)
      const newTracks = ipodData.tracks.filter(t => !knownIds.has(t.id as number))
      // Backfill audioFingerprint for the incoming tracks so the
      // post-sync verifier on subsequent flows has something to compare
      // against. Only computes for files that exist; missing files are
      // left alone (the verifier will flag them on next sync if the user
      // actually wants those tracks).
      const LOCAL_MOUNT = host.getMusicDir().replace(/[/\\]iPod_Control[/\\]Music$/, '')
      const mounts = [host.getMount(), LOCAL_MOUNT].filter((m): m is string => !!m)
      for (const t of newTracks) {
        if (typeof t.audioFingerprint === 'string' && t.audioFingerprint) continue
        const colon = String(t.path || '')
        if (!colon) continue
        const abs = await resolveTrackAbsPath(colon, mounts)
        if (!abs) continue
        const fp = await computeAudioFingerprint(abs, Number(t.duration || 0))
        if (fp) t.audioFingerprint = fp
      }
      return { ok: true, newTracks, playlists: ipodData.playlists, totalIpod: ipodData.tracks.length }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed'), newTracks: [], playlists: [], totalIpod: 0 }
    }
  }


  // ── Sync library TO iPod ──
  //
  // Content-safety invariant: this handler will REFUSE to commit the
  // iTunesDB if any library entry's path points at audio whose embedded
  // tags disagree with what the library claims the track is.
  //
  // That used to happen when filename-only smart-matching linked a
  // library entry to the wrong file (e.g. a Beatles entry ended up
  // playing Pink Floyd because both files had the same basename
  // "imported_3713.m4a"). The smart-match step in this handler now
  // tag-verifies, AND the preflight below verifies every remaining
  // track's existing path too, so even a library.json that got
  // corrupted by some OTHER flow can't write incorrect paths into the
  // iPod database.
  // Module-level lock so a second sync-to-ipod invocation can't fire
  // while one is already in flight. Without this, two paths can race:
  // (1) the user clicks Sync, (2) the auto-sync-on-mount listener in
  // App.tsx fires when the iPod momentarily ejects/remounts during the
  // running sync. The race manifests as the preflight progress
  // counter running up to ~1600/4530 then jumping back to 0/4530, plus
  // random write failures from two writers stomping the same iTunesDB.
  // 4.5: also tracks WHEN the sync started so a hung sync auto-clears
  // after SYNC_HANG_TIMEOUT_MS (2 hours). Pre-fix, a sync that hung
  // (network volume gone, disk full, panic) left the flag permanently
  // set; every subsequent Sync click failed with "A sync is already in
  // progress" until the app was relaunched. The watchdog still exists
  // as a last resort — but 5 minutes was too short for a 500-song
  // activity sync and released the lock while the first writer was live.
  let syncInFlight = false
  let syncStartedAt = 0
  // 2 hours, not 5 minutes. A 500-song activity sync (copy + convert + two
  // cold remounts) routinely runs past 5 minutes. The old watchdog released
  // the lock mid-copy, auto-repair started a second writer, and the Mini
  // indexed a random subset (33 / 111 / 340…). Cancel is the user abort.
  const SYNC_HANG_TIMEOUT_MS = 2 * 60 * 60 * 1000
  // 4.5.0-109: cancellation flag. Set by the cancel-sync IPC handler;
  // checked by the copy loop between each file. The renderer's Cancel
  // button calls cancel-sync, which flips this on; runSyncToIpod bails
  // out at the next file-copy boundary and returns ok:false, cancelled:true.
  // Reset to false at the top of every new runSyncToIpod call.
  let syncCancelRequested = false



  async function handleSyncToIpod(tracks: Array<Record<string, unknown>>, playlists: Array<Record<string, unknown>>, convertOptions?: SyncConvertOptions, syncOpts?: IpodSyncOpts): Promise<unknown> {
    // Same guard as save-library: this one writes to the iPod.
    // Full live concerts NEVER sync to the main iPod (Jake keeps a separate iPod
    // for full concerts). Drop the merged concert track AND any of its constituent
    // songs not individually reimported (promoted). A promoted song is a normal
    // library track again and syncs as usual. Enforced main-side so the rule can't
    // be bypassed. ⚠️ mirrors libraryHiddenTrackIds in src/renderer/liveSets.ts.
    // (Shared with the workout-sync picker — getConcertOwnedTrackIds — so the
    // Music Man can't PICK what the sync would drop.)
    try {
      const concertOwned = await getConcertOwnedTrackIds()
      if (concertOwned.size) {
        const before = tracks.length
        tracks = tracks.filter((t) => !concertOwned.has(Number(t.id)))
        if (tracks.length !== before) console.log(`sync-to-ipod: kept ${before - tracks.length} full-concert track(s) OFF the iPod`)
      }
    } catch { /* no live sets → nothing to exclude */ }
    const refused = refuseIpodSyncUnlessUserClick(syncOpts)
    if (refused) {
      console.error(`sync-to-ipod: REFUSED — ${refused.error}`)
      return refused
    }
    if (syncInFlight) {
      const ageMs = Date.now() - syncStartedAt
      if (ageMs > SYNC_HANG_TIMEOUT_MS) {
        console.warn(`[sync] previous syncInFlight has been pending for ${Math.round(ageMs/1000)}s — assuming hung, releasing the lock`)
        syncInFlight = false
      } else {
        // 4.5.0-109: iTunes behavior — clicking Sync while a sync is
        // already running silently no-ops instead of throwing an error
        // toast. The existing sync continues; the user's intent ("I want
        // it to be syncing") is already satisfied. Pre-fix this returned
        // ok:false with an error string, which the renderer surfaced as
        // a "Sync failed" notice — confusing, since nothing actually
        // failed. The renderer's syncing state is already true, so a
        // benign ok:true with a flag is sufficient.
        console.log(`[sync] click suppressed — already running (${Math.round(ageMs/1000)}s in)`)
        return { ok: true, alreadyRunning: true, copied: 0, copyErrors: 0 }
      }
    }
    syncInFlight = true
    syncStartedAt = Date.now()
    // Do not stamp the copy journal until a writer actually mutates the
    // card. A preflight refuse used to leave phase:copy on disk, and the
    // LCD / iPod page kept showing a failed sync that never wrote a byte.
    try {
      const result = await runSyncToIpod(tracks, playlists, convertOptions, syncOpts)
      if ((result as { ok?: boolean })?.ok) await writeSyncJournal(null)
      else {
        const err = String((result as { error?: string }).error || 'Sync failed')
        sendToRenderer('sync-progress', {
          phase: 'error', current: 0, total: 0, title: err,
        })
      }
      return result
    } finally {
      syncInFlight = false
      syncStartedAt = 0
    }
  }

  interface SyncReport {
    syncedAt: string
    target: number
    landed: number
    shortfall: number
    verifyPasses: number
    copied: number
    copyErrors: number
    failed: Array<{ id: number; title: string; artist: string; path: string }>
  }
  /**
   * A durable record of what a sync LOST.
   *
   * The journal next door answers "did the last sync finish"; this answers "what
   * did it drop, and was it the same songs as last time". Keeps the previous
   * report alongside the current one, because the whole diagnostic value is in
   * the comparison: identical failures point at those files, a different set
   * every run points at the card dropping writes.
   */
  const IPOD_SYNC_REPORT_FILE = () => join(app.getPath('userData'), 'last-sync-report.json')
  const IPOD_SYNC_REPORT_PREV = () => join(app.getPath('userData'), 'prev-sync-report.json')
  async function writeSyncReport(r: SyncReport): Promise<void> {
    try {
      await copyFile(IPOD_SYNC_REPORT_FILE(), IPOD_SYNC_REPORT_PREV()).catch(() => {})
      await writeJsonAtomic(IPOD_SYNC_REPORT_FILE(), r)
      if (r.shortfall > 0) {
        console.warn(`sync-to-ipod: SHORT — ${r.shortfall} of ${r.target} never committed. Report: ${IPOD_SYNC_REPORT_FILE()}`)
      }
    } catch { /* diagnostics must never break a sync */ }
  }

  // confirmWriteOnCard / remountVerifyEntries / retireIpodFirmwareScratch live
  // in ipod-sync-card.ts (shared by activity rebuild and full-library sync).

  const IPOD_SYNC_JOURNAL_FILE = () => join(app.getPath('userData'), 'ipod-sync-journal.json')
  const IPOD_TSA_SEAL_FILE = () => join(app.getPath('userData'), 'ipod-activity-tsa-seal.json')

  async function clearTsaSeal(): Promise<void> {
    try { await unlink(IPOD_TSA_SEAL_FILE()) } catch { /* no prior seal */ }
  }

  async function writeTsaSealFile(seal: { version: 1; sealedAt: string; target: number; passengers: unknown[] }): Promise<void> {
    const path = IPOD_TSA_SEAL_FILE()
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(seal, null, 2), 'utf-8')
    await rename(tmp, path)
  }

  async function writeLastSyncManifest(payload: Record<string, unknown>): Promise<void> {
    const manifestPath = join(STATE_DIR, 'last-sync-manifest.json')
    const tmp = `${manifestPath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 1), 'utf-8')
    await rename(tmp, manifestPath)
  }

  async function writeSyncJournal(phase: string | null): Promise<void> {
    try {
      if (phase === null) {
        await unlink(IPOD_SYNC_JOURNAL_FILE()).catch(() => {})
      } else {
        await writeFile(IPOD_SYNC_JOURNAL_FILE(), JSON.stringify({ phase, at: new Date().toISOString() }), 'utf-8')
      }
    } catch { /* best effort — never block a sync on the journal */ }
  }
  // Journal stays on disk for diagnostics. Do not replay it as a Notice
  // on every launch — that banner told Jake to "repair" by syncing, which
  // is how Songs went to 486, and it was still there the next morning.

  async function runSyncToIpod(tracks: Array<Record<string, unknown>>, playlists: Array<Record<string, unknown>>, convertOptions?: SyncConvertOptions, syncOpts?: IpodSyncOpts): Promise<unknown> {
    const refused = refuseIpodSyncUnlessUserClick(syncOpts)
    if (refused) {
      console.error(`sync-to-ipod: REFUSED — ${refused.error}`)
      return refused
    }
    syncCancelRequested = false
    if (syncOpts?.origin === 'activity-click') {
      return runActivitySync({
        pythonCmd: PYTHON_CMD ?? 'python3',
        pythonHint: PYTHON_INSTALL_HINT,
        coreScript: (rel) => join(app.isPackaged ? process.resourcesPath : app.getAppPath(), rel),
        tempDir: app.getPath('temp'),
        stateDir: STATE_DIR,
        pid: process.pid,
        musicDir: host.getMusicDir(),
        pathSep: IS_WINDOWS ? '\\' : '/',
        isMac: IS_MAC,
        sendProgress: (p) => { sendToRenderer('sync-progress', p) },
        isCancelled: () => syncCancelRequested,
        isStreamedTrackFile,
        buildAacMirror,
        buildIpodSafeAlacMirror,
        readIpodDatabase,
        writeJournal: writeSyncJournal,
        writeManifest: writeLastSyncManifest,
        writeSeal: writeTsaSealFile,
        clearSeal: clearTsaSeal,
        writeReport: writeSyncReport,
        getDetectedMount: () => host.getMount(),
        setDetectedMount: (m) => { host.setMount(m) },
        materializeTrack: materializeLibraryTrack,
      }, { tracks, playlists, convertOptions })
    }
    if (syncOpts?.wipeFirst) {
      return { ok: false, copied: 0, error: 'Activity Sync is the dedicated engine, not this copy loop.' }
    }
    // 4.5.0-109: reset cancel flag at the top of every sync.
    syncCancelRequested = false
    // Everything copied/written from here on carries an mtime ≥ this stamp;
    // the orphan cleanup uses it to refuse to delete anything this sync
    // touched (2026-07-21 shrinking-iPod fix).
    const syncRunStartMs = Date.now()
    // A cached device path is not authority. The capacity panel once held the
    // NAS mount while displaying the iPod name (926.3 GiB instead of 119.2 GiB).
    // Re-prove the canonical iPod layout before this path gains write authority.
    if (host.getMount() && !(await isIpodMount(host.getMount()!))) {
      console.error(`sync-to-ipod: refusing stale/non-iPod mount ${host.getMount()}`)
      host.setMount(null)
    }
    if (!host.getMount()) {
      host.setMount(await findIpodMount())
    }
    if (!host.getMount()) return { ok: false, error: 'No verified iPod mount detected', copied: 0 }
    const IPOD_MOUNT = host.getMount()!
    // Strip the trailing "iPod_Control/Music" segment whether it's / or \ delimited.
    const LOCAL_MOUNT = host.getMusicDir().replace(/[/\\]iPod_Control[/\\]Music$/, '')

    // Check iPod is mounted
    try {
      await stat(IPOD_MOUNT)
    } catch {
      return { ok: false, error: 'iPod is not mounted', copied: 0 }
    }

    // ── KNOW EXACTLY WHAT WE SYNC (2026-07-21, Jake: "you need to know what
    // you are syncing at all times... it should always always always get to
    // 1000 songs exactly"). Before a single byte moves: assert every track
    // has a title, an artist, AND a real local file. A blank-metadata or
    // fileless track can NEVER reach the device again. Then write a full
    // manifest (every song + the exact add/remove delta vs the last sync)
    // to disk and the log, so we always have a record of what shipped. ──
    {
      const blanks: string[] = []
      const fileless: string[] = []
      const toPull: Array<{ id: number; path: string; label: string }> = []
      {
        const classified = await classifyActivitySyncTracks(tracks, {
          localMount: LOCAL_MOUNT,
          pathSep: IS_WINDOWS ? '\\' : '/',
          lstat,
        })
        blanks.push(...classified.blanks)
        fileless.push(...classified.fileless)
        toPull.push(...classified.toPull)
      }
      if (blanks.length || fileless.length) {
        const error = formatSyncSetFileRefuse({
          lead: 'Sync refused',
          blanks,
          fileless,
          total: tracks.length,
          nothingVerb: 'sent',
        })
        console.error(`sync-to-ipod: REFUSING — ${tracks.length}-song set has bad tracks`)
        for (const b of [...blanks, ...fileless].slice(0, 20)) console.error('   •', b)
        await writeSyncJournal(null)
        return {
          ok: false,
          copied: 0,
          error,
        }
      }
      if (toPull.length > 0) {
        console.log(`sync-to-ipod: ${toPull.length}/${tracks.length} not on this Mac — pulling from homemini`)
        const pullFail: string[] = []; const unsourceableIds: number[] = []   // ghosts: see activity-boardable.ts
        for (const p of toPull) {
          if (syncCancelRequested) {
            await writeSyncJournal(null)
            return { ok: false, copied: 0, cancelled: true, error: 'Sync cancelled by user' }
          }
          const r = await materializeLibraryTrack(p.path, p.id)
          if (!r.ok) {
            pullFail.push(`${p.label} (${r.error || 'homemini miss'})`); unsourceableIds.push(p.id)
            console.error(`sync-to-ipod: homemini pull failed — ${p.label}: ${r.error}`)
          }
        }
        if (pullFail.length > 0) {
          await writeSyncJournal(null)
          return {
            ok: false, copied: 0, error: formatHomeminiPullRefuse(pullFail, tracks.length),
            verificationUpdates: unsourceableIds.map((id) => ({ id, audioMissing: true })),   // learn-on-refusal
          }
        }
      }

      // Manifest: full-library sync writes the shipped set now. Activity
      // wipe+rebuild writes in-flight here and only stamps sealed:true after
      // TSA — a failed 500 must not look like 500 shipped.
      try {
        const prevIds = new Set<number>()
        try {
          const prev = JSON.parse(await readFile(join(STATE_DIR, 'last-sync-manifest.json'), 'utf-8')) as { tracks?: Array<{ id: number }> }
          for (const x of prev.tracks || []) prevIds.add(x.id)
        } catch { /* first manifest */ }
        const curIds = new Set(tracks.map((t) => Number(t.id)))
        const added = tracks.filter((t) => !prevIds.has(Number(t.id)))
        const removedIds = [...prevIds].filter((id) => !curIds.has(id))
        const base = {
          syncedAt: new Date().toISOString(),
          count: tracks.length,
          added: added.length,
          removed: removedIds.length,
          tracks: tracks.map((t) => ({ id: Number(t.id), title: String(t.title || ''), artist: String(t.artist || ''), album: String(t.album || '') })),
          addedTracks: added.map((t) => `${t.title} — ${t.artist}`),
        }
        if (syncOpts?.wipeFirst) {
          await writeLastSyncManifest({ ...base, status: 'in-flight', sealed: false })
          console.log(`sync-to-ipod: MANIFEST in-flight — ${tracks.length} songs boarded, not sealed`)
        } else {
          await writeLastSyncManifest({ ...base, status: 'shipped', sealed: false })
          console.log(`sync-to-ipod: MANIFEST — ${tracks.length} songs (all named + file-verified), +${added.length} added / -${removedIds.length} removed since last sync`)
        }
      } catch (mErr) {
        console.warn('sync-to-ipod: manifest write failed (non-fatal):', mErr instanceof Error ? mErr.message : mErr)
      }
    }

    // ──────────────── PRE-SYNC SAFETY: LIBRARY DEDUP CHECK ────────────────
    // If two library entries point at the same audio file (same colon
    // path), they're unambiguously duplicates: both will emit separate
    // mhit records into iTunesDB, which the iPod collapses in the
    // "songs" count but keeps as ghost rows. That's how you end up with
    // "library 4395 / iPod 4389" drift. Refuse to sync until the library
    // is clean and tell the user which entries collide so they can pick
    // one to delete in Get Info.
    {
      const pathCounts = new Map<string, number>()
      for (const t of tracks) {
        const p = String(t.path || '')
        if (!p) continue
        pathCounts.set(p, (pathCounts.get(p) || 0) + 1)
      }
      const dupes: Array<{ path: string; n: number; titles: string[] }> = []
      for (const [p, n] of pathCounts) {
        if (n > 1) {
          const titles = tracks
            .filter(t => t.path === p)
            .map(t => `"${t.title}" / ${t.artist}`)
          dupes.push({ path: p, n, titles })
        }
      }
      if (dupes.length > 0) {
        const sample = dupes.slice(0, 3).map(d => `  • ${d.path}\n    → ${d.titles.join(' + ')}`).join('\n')
        const msg = `Sync aborted: ${dupes.length} file${dupes.length === 1 ? '' : 's'} ${dupes.length === 1 ? 'has' : 'have'} multiple library entries pointing at ${dupes.length === 1 ? 'it' : 'them'}. Delete the duplicate library entries and sync again.\n\nExamples:\n${sample}${dupes.length > 3 ? `\n  …and ${dupes.length - 3} more` : ''}`
        console.error('sync-to-ipod: pre-sync dedup check failed:\n' + msg)
        return { ok: false, error: msg, copied: 0, duplicatePaths: dupes.length }
      }
    }

    // Copy audio files that don't exist on the iPod yet.
    //
    // Pass 1: figure out which tracks need copying (so we know the
    // denominator for progress reporting). Pass 2: copy and emit a
    // sync-progress event per file so the renderer can show a real bar
    // instead of a perpetually-indeterminate pulse.
    //
    // Smart-match before copying: library.json paths can drift (a track
    // whose path says F48/NTJL.m4a may already exist at F12/NTJL.m4a).
    // Without smart-match, sync blindly copies hundreds of already-
    // present files. But the old filename-only match was dangerous — it
    // would accept any file that shared a basename, so a re-imported
    // track at "imported_3767.m4a" got silently linked to a DIFFERENT
    // song that happened to own the same filename slot. That's how
    // Beatles tracks ended up playing Pink Floyd.
    //
    // New rule: we only accept a smart-match rewrite if the candidate
    // file's EMBEDDED TAGS (title + artist) actually agree with the
    // library entry's metadata. If tags disagree or are missing, we
    // fall back to copying the real file.
    // ── WIPE-FIRST (2026-07-24, Jake: "just wipe the songs from the iPod each
    // time i do activity sync, then rebuild to whatever number i pick"). Deletes
    // every audio file under iPod_Control/Music/F00–F49 so the set is rebuilt from
    // a clean slate — no leftover files, no stale/duplicate catalog entries piling
    // up across syncs (a prime suspect in the firmware loading fewer songs than
    // the DB holds). The iTunesDB is rewritten fresh from `tracks` below, so after
    // this the device holds EXACTLY the picked set. Only activity sync passes
    // wipeFirst; full-library sync + plug-in auto-repair do not.
    const activityTarget = tracks.length
    const tsaBoarded: TsaPassenger[] = syncOpts?.wipeFirst
      ? tracks.map((t) => tsaBoardPassenger({
        ...t,
        destPath: ipodPlayableDestPath(String(t.path || '')),
      }))
      : []
    if (syncOpts?.wipeFirst) {
      if (activityTarget <= 0 || tsaBoarded.length !== activityTarget) {
        return {
          ok: false,
          copied: 0,
          error: `Activity TSA boarded ${tsaBoarded.length} for a ${activityTarget}-song set. Nothing was wiped.`,
          target: activityTarget,
        }
      }
      const emptyDest = tsaBoarded.filter((p) => !p.destPath)
      if (emptyDest.length > 0) {
        return {
          ok: false,
          copied: 0,
          error: `Activity TSA: ${emptyDest.length} song(s) have no dest path. Nothing was wiped.`,
          target: activityTarget,
        }
      }
      const collisions = tsaDestCollisions(tsaBoarded)
      if (collisions.length > 0) {
        return {
          ok: false,
          copied: 0,
          error: `Activity TSA: ${collisions.length} dest path(s) would collide on the Mini (two songs rewriting to the same file). Nothing was wiped. Examples: ${collisions.slice(0, 3).join(', ')}`,
          target: activityTarget,
          destCollisions: collisions.length,
        }
      }
      await clearTsaSeal()
      sendToRenderer('sync-progress', { phase: 'copy', current: 0, total: 1, title: 'Wiping the iPod for a clean rebuild…' })
      const wipeMusicRoot = join(IPOD_MOUNT, 'iPod_Control', 'Music')
      let wiped = 0
      try {
        const { readdir: rdw } = await import('fs/promises')
        const listMusicFiles = async (): Promise<string[]> => {
          const found: string[] = []
          for (let i = 0; i < 50; i++) {
            const sub = join(wipeMusicRoot, `F${String(i).padStart(2, '0')}`)
            const entries = await rdw(sub).catch(() => [] as string[])
            for (const fn of entries) {
              if (fn === '.' || fn === '..') continue
              found.push(join(sub, fn))
            }
          }
          return found
        }
        // fskit returns PARTIAL directory listings. One pass that deleted
        // "everything it saw" left 153 leftover 4-letter m4a files on the
        // Mini (2026-08-15) while the catalog claimed a clean 500. Require
        // two consecutive empty readdirs before believing the card is empty.
        let emptyStreak = 0
        let remaining = 0
        for (let pass = 0; pass < ACTIVITY_WIPE_MAX_PASSES; pass++) {
          const listed = await listMusicFiles()
          for (const p of listed) {
            try { await unlink(p); wiped++ } catch { /* retry on the next listing */ }
          }
          const after = await listMusicFiles()
          remaining = after.length
          emptyStreak = activityWipeEmptyStreak(remaining, emptyStreak)
          console.log(`sync-to-ipod: WIPE-FIRST pass ${pass + 1}/${ACTIVITY_WIPE_MAX_PASSES} deleted-this-listing=${listed.length} remaining=${remaining} emptyStreak=${emptyStreak}`)
          if (activityWipeProvenEmpty(emptyStreak)) break
          await new Promise(r => setTimeout(r, 250))
        }
        if (!activityWipeProvenEmpty(emptyStreak)) {
          console.error(`sync-to-ipod: WIPE-FIRST could not empty Music (${remaining} file(s) still listed after ${ACTIVITY_WIPE_MAX_PASSES} passes)`)
          return {
            ok: false,
            copied: 0,
            error: `Activity wipe could not empty the iPod (${remaining} leftover file${remaining === 1 ? '' : 's'}). macOS is not listing the card consistently. Reseat the cable and sync again — nothing new was copied.`,
          }
        }
        await retireIpodFirmwareScratch(IPOD_MOUNT)
        console.log(`sync-to-ipod: WIPE-FIRST deleted ${wiped} existing file(s) — rebuilding clean to ${tracks.length}`)
      } catch (e) {
        console.error('sync-to-ipod: wipe-first failed — refusing to copy onto a dirty card:', e)
        return {
          ok: false,
          copied: 0,
          error: `Activity wipe failed (${e instanceof Error ? e.message : String(e)}). Nothing was copied.`,
        }
      }
    }

    await writeSyncJournal('copy')
    let copied = 0
    let copyErrors = 0
    const pathSep = IS_WINDOWS ? '\\' : '/'
    const basenameToIpodPath = new Map<string, string>()
    try {
      const { readdir: rd } = await import('fs/promises')
      for (let i = 0; i < 50; i++) {
        const sub = join(IPOD_MOUNT, 'iPod_Control', 'Music', `F${String(i).padStart(2, '0')}`)
        const entries = await rd(sub).catch(() => [] as string[])
        for (const fn of entries) {
          if (!basenameToIpodPath.has(fn)) {
            basenameToIpodPath.set(fn, join(sub, fn))
          }
        }
      }
    } catch { /* best-effort */ }

    // ⚠️ TWIN: normalize imported from ./normalize.ts — keep in sync with
    // core/repair_mismatches.py::normalize.

    // First pass: determine candidate rewrites. Anything that resolves
    // to a basename match on the iPod is a candidate — we'll verify tags
    // on the batch in one Python call below.
    type Candidate = {
      track: Record<string, unknown>
      colonPath: string
      ipodFile: string
      localFile: string
      baseName: string
      altIpodPath?: string    // candidate for smart-match rewrite
    }
    const candidates: Candidate[] = []
    const playablePathRewrites: Array<{ id: number; oldPath: string; newPath: string }> = []
    const alreadyOnDevice: Array<{ id: number; srcPath: string; dstPath: string; expectedSize: number }> = []
    for (const track of tracks) {
      const rawColon = String(track.path || '')
      if (!rawColon) continue
      // Mini 1.4.1 will not list .flac or FAT temp names (.0i4zLU). Copy
      // to a real audio extension; the DB writer stamps M4A from that path.
      // 2026-08-15: 500 catalog → Songs 497 from three ALAC files named
      // as staging temps and stamped MP3.
      const colonPath = ipodPlayableDestPath(rawColon)
      if (colonPath !== rawColon && typeof track.id === 'number') {
        playablePathRewrites.push({ id: track.id, oldPath: rawColon, newPath: colonPath })
      }
      const rawRel = rawColon.replace(/:/g, pathSep)
      const relPath = colonPath.replace(/:/g, pathSep)
      const ipodFile = join(IPOD_MOUNT, relPath)
      const localFile = join(LOCAL_MOUNT, rawRel)
      const baseName = rawColon.split(':').pop() || ''
      const needsAlac = needsIpodAlacTranscode(rawColon)

      // Does the iPod already have this file? If yes, only skip the
      // copy if the on-disk local file hasn't changed. We compare size —
      // a re-encode (like the 2-step ALAC fix) produces a file with a
      // different byte count, and we want THAT version to land on the
      // iPod instead of the stale one. Without this, sync would see the
      // iPod still has "something" at the path and refuse to overwrite,
      // so fixes made locally never reach the device.
      //
      // Playable-dest rewrite: existence is the NEW .m4a, not the stale
      // .0i4zLU / .flac. A size match on the garbage name must not skip.
      let exists = false
      let ipodSize = 0
      try {
        const s = await stat(ipodFile)
        exists = true
        ipodSize = s.size
      } catch { /* not at expected path */ }
      if (exists) {
        if (needsAlac) {
          // Dest is already .m4a from a prior FLAC→ALAC land. Don't
          // recopy just because the local FLAC is a different size.
          if (typeof track.id === 'number' && ipodSize > 0) {
            alreadyOnDevice.push({ id: track.id, srcPath: ipodFile, dstPath: ipodFile, expectedSize: ipodSize })
          }
          continue
        }
        try {
          const ls = await stat(localFile)
          if (ls.size === ipodSize) {
            // 4.5: byte-identical normally means "already synced, skip".
            // EXCEPTION: if bitrate conversion is enabled AND the source
            // is actually lossless, fall through and requeue — the iPod
            // copy is the FULL-quality file and we want to replace it
            // with an AAC mirror. iTunes-style "convert higher bit rate
            // songs" RETROACTIVELY shrinks lossless tracks synced before
            // the toggle was on.
            //
            // Critical: .m4a/.mp4 alone is NOT a lossless signal — most
            // .m4a in a typical library are already AAC. Treating them
            // as lossless candidates causes thousands of byte-identical
            // re-copies over USB that free zero space (buildAacMirror
            // probes the codec, sees AAC, returns null, then we copy the
            // source over itself). Require either a lossless extension
            // OR a codec hint that explicitly says lossless before
            // requeuing.
            const localExt = localFile.slice(localFile.lastIndexOf('.')).toLowerCase()
            const hint = (codecByAbsPath.get(localFile) || '').toLowerCase()
            const hintSaysLossless = hint === 'alac' || LOSSLESS_CODECS.has(hint)
            const isLossless = LOSSLESS_EXTS.has(localExt) || hintSaysLossless
            if (!(convertOptions?.enabled && isLossless)) {
              if (typeof track.id === 'number' && ipodSize > 0) {
                alreadyOnDevice.push({ id: track.id, srcPath: localFile, dstPath: ipodFile, expectedSize: ipodSize })
              }
              continue   // byte-identical and no re-encode needed
            }
            // fall through — queue this for conversion
          }
          // Size differs → local was re-encoded/updated, queue a re-copy.
          // (We fall through to push this into toCopy below — the copy
          // step overwrites the iPod file when dest already exists.)
        } catch {
          // Local file missing but iPod has one — keep iPod's copy,
          // nothing we can do anyway.
          if (typeof track.id === 'number' && ipodSize > 0) {
            alreadyOnDevice.push({ id: track.id, srcPath: ipodFile, dstPath: ipodFile, expectedSize: ipodSize })
          }
          continue
        }
      }

      const altIpodPath = baseName ? basenameToIpodPath.get(baseName) : undefined
      candidates.push({
        track, colonPath: rawColon, ipodFile, localFile, baseName,
        altIpodPath: altIpodPath && altIpodPath !== ipodFile ? altIpodPath : undefined,
      })
    }

    // Second pass: if we have any alt-path candidates, batch-verify
    // their embedded tags against the library metadata via tag_reader.
    const rewriteCandidatePaths = candidates.map(c => c.altIpodPath).filter((p): p is string => !!p)
    const tagsByPath = new Map<string, { title: string; artist: string; ok: boolean }>()
    if (rewriteCandidatePaths.length > 0) {
      try {
        const tagReaderScript = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/tag_reader.py')
        const read = await new Promise<string>((resolve, reject) => {
          const py = spawn(PYTHON_CMD ?? 'python3', [tagReaderScript])
          let stdout = ''
          let stderr = ''
          py.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
          py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
          py.on('error', reject)
          py.on('close', (code: number) => {
            if (code === 0) resolve(stdout)
            else reject(new Error(`tag_reader exit ${code}: ${stderr}`))
          })
          py.stdin.on('error', reject)  // EPIPE-safe — see scheduleDbRebuild for why
          try {
            py.stdin.write(JSON.stringify(rewriteCandidatePaths))
            py.stdin.end()
          } catch (err) { reject(err) }
        })
        const arr = JSON.parse(read) as Array<{ path: string; title?: string; artist?: string; ok?: boolean }>
        for (const t of arr) {
          tagsByPath.set(t.path, { title: t.title || '', artist: t.artist || '', ok: !!t.ok })
        }
      } catch (err) {
        console.warn('sync-to-ipod: tag verification failed, will fall back to copy:', err)
        // tagsByPath stays empty → no smart-match rewrites will be accepted.
      }
    }

    const toCopy: Array<{ local: string; ipod: string; title: string; trackId: number }> = []
    const pathRewrites: Array<{ id: number; oldPath: string; newPath: string }> = []
    // Exact bytes that landed (or were confirmed already present) per track.
    // Verify/recopy MUST use these — never the library master — or a convert
    // sync compares AAC-on-card to ALAC-in-library, "fails" every song, and
    // recopies full-size masters until the Mini fills (~100 of 500).
    const writtenById = new Map<number, { srcPath: string; dstPath: string; expectedSize: number }>()
    for (const e of alreadyOnDevice) writtenById.set(e.id, e)
    const rememberWritten = async (trackId: number | undefined, srcPath: string, dstPath: string) => {
      if (trackId == null) return
      try {
        const sz = (await stat(srcPath)).size
        writtenById.set(trackId, { srcPath, dstPath, expectedSize: sz })
      } catch { /* non-fatal — verify will treat as missing */ }
    }
    let rewritesVetoed = 0
    for (const c of candidates) {
      if (c.altIpodPath) {
        const t = tagsByPath.get(c.altIpodPath)
        const libTitle  = normalize(c.track.title)
        const libArtist = normalize(c.track.artist)
        const fileTitle  = t ? normalize(t.title)  : ''
        const fileArtist = t ? normalize(t.artist) : ''

        // Accept the rewrite only if the file's tags (or at least one of
        // them) actually identify this as the same song. This is the
        // permanent fix for the Beatles/Pink Floyd cross-linking bug.
        const titleOk  = libTitle  && fileTitle  && (libTitle  === fileTitle  || libTitle.includes(fileTitle)  || fileTitle.includes(libTitle))
        const artistOk = libArtist && fileArtist && (libArtist === fileArtist || libArtist.includes(fileArtist) || fileArtist.includes(libArtist))

        if (titleOk && artistOk) {
          // Don't re-link onto a FAT temp / .flac — Mini 1.4.1 will skip it.
          if (ipodPlayableDestPath(c.altIpodPath) !== c.altIpodPath) {
            rewritesVetoed += 1
          } else {
            const altRel = c.altIpodPath.slice(IPOD_MOUNT.length + 1)
            const altColonPath = ':' + altRel.split(pathSep).join(':')
            pathRewrites.push({
              id: c.track.id as number,
              oldPath: c.colonPath,
              newPath: altColonPath,
            })
            // Already on the device at altIpodPath — record on-card size as the
            // verify target. Recopy source prefers the AAC mirror when convert is
            // on so a recovery pass doesn't shove the ALAC master back onto a Mini.
            try {
              const onCard = (await stat(c.altIpodPath)).size
              let srcPath = c.localFile
              if (convertOptions?.enabled) {
                try {
                  const mirror = await buildAacMirror(c.localFile, convertOptions.targetKbps)
                  if (mirror) srcPath = mirror
                } catch { /* keep library master as recopy source */ }
              }
              writtenById.set(c.track.id as number, {
                srcPath,
                dstPath: c.altIpodPath,
                expectedSize: onCard,
              })
            } catch { /* verify will notice */ }
            continue
          }
        } else {
          // Tags didn't match — don't silently re-link. Copy the real file.
          rewritesVetoed += 1
        }
      }

      toCopy.push({
        local: c.localFile,
        ipod: c.ipodFile,
        title: String(c.track.title || c.baseName),
        trackId: c.track.id as number,
      })
    }
    if (rewritesVetoed > 0) {
      console.log(`sync-to-ipod: vetoed ${rewritesVetoed} filename-only smart-matches (tags disagreed with library)`)
    }

    const totalToCopy = toCopy.length
    // Kick off the progress so the renderer can seed its bar even
    // when nothing needs copying (still-will-write-DB phase coming).
    sendToRenderer('sync-progress', {
      phase: 'copy', current: 0, total: totalToCopy, title: '',
    })
    // 4.5: track-id → newColonPath when bitrate conversion changes
    // the destination extension (FLAC/WAV/AIFF → .m4a). Merged into the
    // existing pathRewrites array before the iTunesDB writer runs so
    // the device sees the converted file at its new path.
    const convertedPathRewrites: Array<{ id: number; oldPath: string; newPath: string }> = []
    // Per-song confirm bookkeeping: fsync per file, /bin/sync every few songs.
    let sinceFlush = 0
    // Map local → trackId so we can look up the right pathRewrite entry
    // during the copy loop without re-walking the tracks array.
    const trackByLocal = new Map<string, Record<string, unknown>>()
    for (const c of candidates) trackByLocal.set(c.localFile, c.track)

    // Do NOT remount per song. Each remount was a chance to `unmount force`
    // (busy volume from the sidebar poll) and discard dirty FAT32 pages for
    // songs already "verified" — that's 500/500 in JakeTunes and 33 on the
    // Mini after eject. Copy + F_FULLFSYNC here; one clean remount-verify of
    // the whole set after the loop is the proof.
    const COPY_VERIFY_CHUNK = 0
    let chunkPending: Array<{ id: number; dstPath: string; localFile: string; expectedSize: number }> = []
    const flushCopyChunk = async (force = false) => {
      if (COPY_VERIFY_CHUNK <= 0) return
      if (!force && chunkPending.length < COPY_VERIFY_CHUNK) return
      if (chunkPending.length === 0) return
      const batch = chunkPending
      chunkPending = []
      sendToRenderer('sync-progress', {
        phase: 'verify', current: copied, total: Math.max(totalToCopy, 1),
        title: `Confirming song ${copied} actually stuck on the card…`,
      })
      await flushCardCaches()
      const r = await remountVerifyEntries(IPOD_MOUNT, batch, {
        maxPasses: 8,
        label: 'chunk',
        isCancelled: () => syncCancelRequested,
      })
      if (r.remountFailed && r.landedIds.size === 0) {
        console.warn('sync-to-ipod: chunk remount failed — continuing; final verify will catch drops')
        return
      }
      // Drop write-records for songs that still didn't stick after chunk retries
      // so the final DB/verify pass cannot treat them as landed.
      for (const e of batch) {
        if (!r.landedIds.has(e.id)) {
          writtenById.delete(e.id)
          console.warn(`sync-to-ipod: chunk verify — track ${e.id} did not stick; will retry in final pass`)
        }
      }
    }

    for (const { local, ipod, title, trackId } of toCopy) {
      // 4.5.0-109: cancellation check at the file boundary. Per-file is the
      // right granularity — fine enough that a Cancel click is felt within
      // seconds, coarse enough that we don't shred a half-written copy
      // (each copyFile is atomic from the FS perspective). Emit a final
      // progress event with phase:'cancelled' so the renderer flips out
      // of the syncing state cleanly.
      if (syncCancelRequested) {
        sendToRenderer('sync-progress', {
          phase: 'cancelled', current: copied + copyErrors, total: totalToCopy, title: '',
        })
        console.log(`sync-to-ipod: cancelled by user after ${copied} of ${totalToCopy} files`)
        return { ok: false, error: 'Sync cancelled by user', copied, copyErrors, cancelled: true }
      }
      let srcToCopy = local
      let dstToCopy = ipod
      // ── Streaming: skip streamed tracks ───────────────────────────
      // A streamed track's local file is a symlink (real bytes on homemini).
      // Copying it to the iPod would push a dangling/0-byte file and could
      // overwrite a good existing device copy. Skip it — to sync a streamed
      // track to the iPod, download (pin) it locally first. Non-destructive:
      // any existing iPod copy is left untouched. Count it as processed so the
      // progress bar still completes (matches the byte-identical skip below).
      if (await isStreamedTrackFile(local)) {
        console.log(`sync-to-ipod: skipping streamed track (not downloaded locally): ${title}`)
        copied++
        sendToRenderer('sync-progress', {
          phase: 'copy', current: copied + copyErrors, total: totalToCopy, title,
        })
        continue
      }
      // ── Bitrate conversion ────────────────────────────────────────
      // When enabled, try to build an AAC mirror of the source. Returns
      // null for non-lossless inputs, in which case we just copy the
      // original. For lossless inputs we substitute the mirror as the
      // copy source — and if the file extension changed (FLAC/WAV/AIFF
      // → .m4a), rewrite the iPod-side destination + the iTunesDB
      // track entry's path so the device knows the new filename.
      if (convertOptions?.enabled) {
        try {
          sendToRenderer('sync-progress', {
            phase: 'copy', current: copied + copyErrors, total: totalToCopy,
            title: `Converting → ${convertOptions.targetKbps}k AAC: ${title}`,
          })
          const mirror = await buildAacMirror(local, convertOptions.targetKbps)
          if (mirror) {
            srcToCopy = mirror
            // If source ext differs from .m4a, rewrite the iPod-side
            // destination filename too. Otherwise (.m4a / .mp4 ALAC)
            // the existing destination is already correct.
            const srcExt = local.slice(local.lastIndexOf('.')).toLowerCase()
            if (srcExt !== '.m4a' && srcExt !== '.mp4') {
              // Replace dest extension with .m4a
              const dotIdx = ipod.lastIndexOf('.')
              dstToCopy = dotIdx > 0 ? ipod.slice(0, dotIdx) + '.m4a' : ipod + '.m4a'
              // Build the equivalent colon-path for the iTunesDB rewrite
              const tr = trackByLocal.get(local)
              if (tr) {
                const newRel = dstToCopy.slice(IPOD_MOUNT.length + 1)
                const newColonPath = ':' + newRel.split(pathSep).join(':')
                const oldColon = String(tr.path || '')
                convertedPathRewrites.push({
                  id: tr.id as number,
                  oldPath: oldColon,
                  newPath: newColonPath,
                })
              }
            }
          }
        } catch (err) {
          // Conversion failed — fall through and copy the original. Worse
          // case: the iPod gets a bigger file than the user expected, but
          // sync still completes.
          console.warn(`[sync-convert] mirror build failed for ${local}, copying original:`, err)
        }
      }
      // Mini cannot index FLAC. If we are still pointing at a .flac (convert
      // off, or AAC mirror failed), transcode to ipod-safe ALAC .m4a. Never
      // copy the FLAC bytes onto the card — that's a Songs skip.
      if (needsIpodAlacTranscode(srcToCopy)) {
        try {
          sendToRenderer('sync-progress', {
            phase: 'copy', current: copied + copyErrors, total: totalToCopy,
            title: `Converting → ALAC: ${title}`,
          })
          const mirror = await buildIpodSafeAlacMirror(local)
          if (!mirror) {
            console.error(`sync-to-ipod: refusing to copy FLAC onto the Mini: ${title}`)
            copyErrors++
            sendToRenderer('sync-progress', {
              phase: 'copy', current: copied + copyErrors, total: totalToCopy, title,
            })
            continue
          }
          srcToCopy = mirror
          dstToCopy = ipodPlayableDestPath(dstToCopy)
          const tr = trackByLocal.get(local)
          if (tr) tr.codec = 'alac'
        } catch (err) {
          console.error(`sync-to-ipod: FLAC→ALAC failed, not copying original: ${title}`, err)
          copyErrors++
          sendToRenderer('sync-progress', {
            phase: 'copy', current: copied + copyErrors, total: totalToCopy, title,
          })
          continue
        }
      }
      dstToCopy = ipodPlayableDestPath(dstToCopy)
      // Last-mile byte-identical skip. When the source was converted to an
      // AAC mirror (or matches the iPod copy for any other reason), check
      // the destination size first — if it already matches the source we
      // are about to write, the copyFile would be a pure USB-bandwidth
      // burn. This is the path that fires for the "library ALAC source
      // vs iPod AAC mirror" case: the planning-phase size compare sees
      // different sizes (ALAC vs AAC) and queues a re-copy, but once
      // buildAacMirror swaps srcToCopy to the cached mirror, the mirror's
      // size matches what's already on the iPod and there's no work to do.
      try {
        const srcStat = await stat(srcToCopy)
        const dstStat = await stat(dstToCopy).catch(() => null)
        if (dstStat && dstStat.size === srcStat.size) {
          const tr = trackByLocal.get(local)
          await rememberWritten(tr?.id as number | undefined, srcToCopy, dstToCopy)
          if (trackId != null && Number.isFinite(trackId)) {
            chunkPending.push({
              id: trackId,
              dstPath: dstToCopy,
              localFile: srcToCopy,
              expectedSize: srcStat.size,
            })
            await flushCopyChunk()
          }
          copied++
          sendToRenderer('sync-progress', {
            phase: 'copy', current: copied + copyErrors, total: totalToCopy, title,
          })
          continue
        }
      } catch { /* fall through to copy — non-fatal */ }
      try {
        const dir = dstToCopy.substring(0, dstToCopy.lastIndexOf(pathSep))
        await mkdir(dir, { recursive: true })
        await copyFile(srcToCopy, dstToCopy)
        // Confirm THIS song is on the card before moving to the next.
        const conf = await confirmWriteOnCard(srcToCopy, dstToCopy)
        if (!conf.ok) {
          console.error(`sync-to-ipod: write NOT confirmed for "${title}" — ${conf.reason}`)
          copyErrors++
          sendToRenderer('sync-progress', {
            phase: 'copy', current: copied + copyErrors, total: totalToCopy,
            title: `✗ did not stick: ${title}`,
          })
          continue
        }
        {
          const tr = trackByLocal.get(local)
          await rememberWritten(tr?.id as number | undefined, srcToCopy, dstToCopy)
          try {
            const sz = (await stat(srcToCopy)).size
            chunkPending.push({
              id: trackId,
              dstPath: dstToCopy,
              localFile: srcToCopy,
              expectedSize: sz,
            })
            await flushCopyChunk()
          } catch { /* final verify still runs */ }
        }
        if (++sinceFlush >= 8) { await flushCardCaches(); sinceFlush = 0 }
        copied++
        // 4.5: orphan cleanup — when a lossless source (.flac/.wav/.aif)
        // is converted, the destination filename changes to .m4a. The
        // OLD file at `ipod` (the original-extension copy from a prior
        // sync) becomes orphaned: iTunesDB no longer references it (we
        // pushed a path rewrite above) but the bytes still sit on the
        // iPod taking space. Delete it now so the conversion actually
        // frees the GB the user expected. Only fires when dst != ipod
        // (i.e. extension changed); same-ext conversion (.m4a→.m4a)
        // overwrites in place via copyFile, no orphan to clean.
        if (dstToCopy !== ipod) {
          try {
            await unlink(ipod)
          } catch { /* old file may have already been moved/missing */ }
        }
      } catch (err) {
        console.error(`Copy failed: ${srcToCopy} → ${dstToCopy}:`, err)
        copyErrors++
      }
      sendToRenderer('sync-progress', {
        phase: 'copy', current: copied + copyErrors, total: totalToCopy, title,
      })
    }
    // Flush any leftover chunk before the final full-set verify.
    await flushCopyChunk(true)
    // One last filesystem-wide flush so the DB write and the eject start from
    // a clean slate — nothing of the audio left in the page cache to lose.
    await flushCardCaches()
    // Merge the convert-driven path rewrites into the existing array
    // so the smart-match block below picks them up alongside its own.
    if (convertedPathRewrites.length > 0) {
      pathRewrites.push(...convertedPathRewrites)
      console.log(`sync-to-ipod: converted ${convertedPathRewrites.length} lossless files to AAC; rewriting their iTunesDB paths`)
    }
    if (playablePathRewrites.length > 0) {
      pathRewrites.push(...playablePathRewrites)
      console.log(`sync-to-ipod: rewrote ${playablePathRewrites.length} dest path(s) to a Mini-listable extension (.m4a)`)
    }
    // Apply smart-match path rewrites to the in-flight tracks array so
    // the Python DB writer (which reads this JSON) gets the correct
    // (already-on-iPod) paths, not the stale ones from library.json.
    if (pathRewrites.length) {
      const rewriteMap = new Map(pathRewrites.map(r => [r.id, r.newPath]))
      for (const t of tracks) {
        const nv = rewriteMap.get(t.id as number)
        if (nv) t.path = nv
      }
      console.log(`sync-to-ipod: smart-match rewrote ${pathRewrites.length} track paths (saved that many redundant copies)`)
    }
    // Drop leftover FAT-temp / .flac names now that the playable dest exists.
    for (const r of playablePathRewrites) {
      const stale = join(IPOD_MOUNT, tsaRelFromColon(r.oldPath, pathSep))
      const fresh = join(IPOD_MOUNT, tsaRelFromColon(r.newPath, pathSep))
      if (stale === fresh) continue
      try {
        await stat(fresh)
        await unlink(stale)
      } catch { /* fresh missing or stale already gone */ }
    }

    // ── VERIFIED-COUNT LOOP (2026-07-24, Jake: "100 means 100, 250 means 250,
    // 500 means 500, 1000 means 1000"). The iFlash/FAT32 iPod on macOS fskit
    // accepts writes into the MOUNT CACHE and reports them present while only a
    // subset physically commits to the card — so copyFile "succeeds", the cache
    // says N, but the device shows a RANDOM count every sync (103 / 421 / 238…).
    // Remount-evict + recopy until the true committed count hits the target, then
    // build the iTunesDB from ONLY what landed. Activity wipe+rebuild refuses to
    // report success on a shortfall — N means N, or the sync failed.
    const syncTarget = syncOpts?.wipeFirst ? activityTarget : tracks.length
    let verifiedLanded = syncTarget
    let verifyAttempts = 0
    let verifyRan = false
    let activityShortfall = false
    let activityTsaScreen: TsaScreen | null = null
    let activityTsaSealed = false
    let failedForReport: SyncReport['failed'] = []
    if (IS_MAC && tracks.length > 0) {
      const verify: Array<{ id: number; dstPath: string; localFile: string; expectedSize: number }> = []
      for (const t of tracks) {
        const id = t.id as number
        const remembered = writtenById.get(id)
        if (remembered) {
          verify.push({
            id,
            dstPath: remembered.dstPath,
            localFile: remembered.srcPath,
            expectedSize: remembered.expectedSize,
          })
          continue
        }
        const colonPath = String(t.path || '')
        if (!colonPath) continue
        const relPath = tsaRelFromColon(colonPath, pathSep)
        const libraryFile = join(LOCAL_MOUNT, relPath)
        try {
          if (await isStreamedTrackFile(libraryFile)) continue
          let srcForVerify = libraryFile
          if (convertOptions?.enabled) {
            const mirror = await buildAacMirror(libraryFile, convertOptions.targetKbps)
            if (mirror) srcForVerify = mirror
          }
          const sz = (await stat(srcForVerify)).size
          verify.push({
            id,
            dstPath: join(IPOD_MOUNT, relPath),
            localFile: srcForVerify,
            expectedSize: sz,
          })
        } catch { /* no local source */ }
      }
      // Activity sync: more passes — random short counts were us giving up too early
      // while the card was still dropping mid-flush writes.
      const MAX_VERIFY_PASSES = syncOpts?.wipeFirst ? 16 : 4
      let landedIds = new Set<number>()
      if (verify.length > 0) {
        sendToRenderer('sync-progress', {
          phase: 'verify', current: 1, total: MAX_VERIFY_PASSES,
          title: `Verifying all ${verify.length} songs actually landed on the iPod…`,
        })
        const r = await remountVerifyEntries(IPOD_MOUNT, verify, {
          maxPasses: MAX_VERIFY_PASSES,
          label: 'final',
          isCancelled: () => syncCancelRequested,
        })
        verifyAttempts = r.attempts
        landedIds = r.landedIds
        if (r.remountFailed && landedIds.size === 0) {
          verifyRan = false
          if (syncOpts?.wipeFirst) {
            // Do NOT fall through and write a catalog from the mount cache — that
            // is exactly how the Mini ends up indexing a random partial Songs list.
            // Leave the journal: only a completed ok:true sync may clear it.
            return {
              ok: false,
              error: `Could not verify the iPod (remount failed after writing). The mount cache lies on this card — sync again without unplugging. Nothing was committed as "done".`,
              copied, copyErrors, landed: 0, target: syncTarget, shortfall: syncTarget, verifyAttempts,
            }
          }
        } else {
          verifyRan = true
        }
      }
      if (verifyRan && landedIds.size === 0 && verify.length > 0) {
        return {
          ok: false,
          error: `Sync failed: none of the ${syncTarget} songs committed to the iPod's card — the card is dropping every write. A reformat is needed.`,
          copied, copyErrors, landed: 0, target: syncTarget, shortfall: syncTarget, attempts: verifyAttempts,
        }
      }
      if (verifyRan) {
        // Gap-fill (2026-08-12): Jake hit 482/500 — remount-verify was honest,
        // but batch recopies of the missing set still dumped into the cache and
        // lost again. For wipe-first activity sync, finish the last few ONE AT A
        // TIME: copy → fsync → remount → size-check, before accepting shortfall.
        const gapFillMissing = async (missing: typeof verify, label: string) => {
          if (missing.length === 0 || syncCancelRequested) return 0
          console.warn(`sync-to-ipod: ${label} — ${missing.length} missing; copy + F_FULLFSYNC + clean remount per song (never force)`)
          sendToRenderer('sync-progress', {
            phase: 'verify', current: landedIds.size, total: syncTarget,
            title: `Finishing the last ${missing.length} song(s) — one at a time…`,
          })
          let recovered = 0
          for (let i = 0; i < missing.length; i++) {
            if (syncCancelRequested) break
            const e = missing[i]
            let stuck = false
            for (let attempt = 1; attempt <= 5 && !stuck; attempt++) {
              if (syncCancelRequested) break
              try {
                const dir = e.dstPath.substring(0, Math.max(e.dstPath.lastIndexOf('/'), e.dstPath.lastIndexOf('\\')))
                if (dir) await mkdir(dir, { recursive: true })
                await copyFile(e.localFile, e.dstPath)
                const conf = await confirmWriteOnCard(e.localFile, e.dstPath)
                if (!conf.ok) {
                  console.warn(`sync-to-ipod: ${label} copy not confirmed for ${e.id} (try ${attempt}): ${conf.reason}`)
                  continue
                }
                await flushCardCaches()
                const rm = await remountVolume(IPOD_MOUNT)
                if (!rm.ok) {
                  console.warn(`sync-to-ipod: ${label} remount failed for ${e.id}: ${rm.error}`)
                  continue
                }
                const sz = (await stat(e.dstPath).catch(() => null))?.size ?? -1
                if (sz === e.expectedSize) {
                  landedIds.add(e.id)
                  writtenById.set(e.id, { srcPath: e.localFile, dstPath: e.dstPath, expectedSize: e.expectedSize })
                  recovered++
                  stuck = true
                  console.log(`sync-to-ipod: ${label} recovered track ${e.id} on try ${attempt} (${landedIds.size}/${syncTarget})`)
                } else {
                  console.warn(`sync-to-ipod: ${label} size mismatch for ${e.id}: got ${sz}, want ${e.expectedSize}`)
                }
              } catch (err) {
                console.warn(`sync-to-ipod: ${label} failed for ${e.id}:`, err)
              }
            }
            sendToRenderer('sync-progress', {
              phase: 'verify', current: landedIds.size, total: syncTarget,
              title: stuck
                ? `Recovered ${recovered} of ${missing.length} missing…`
                : `Still missing after retries (${i + 1}/${missing.length})…`,
            })
          }
          verifyAttempts += missing.length
          return recovered
        }

        if (syncOpts?.wipeFirst && landedIds.size < verify.length) {
          await gapFillMissing(verify.filter((e) => !landedIds.has(e.id)), 'GAP-FILL')
        }

        // ── ROULETTE PROOF (2026-08-12) ────────────────────────────────────
        // Jake: "it jumps to 482 but may drop down to 8 or 108… roulette."
        // One remount can still catch the card mid-flush and report a lucky
        // high count; the next boot shows the real subset. For activity sync,
        // require TWO consecutive cold remounts that agree on the FULL target
        // before we treat the set as landed. If a remount loses songs,
        // gap-fill again and reset the streak — never celebrate a lucky read.
        let consecutiveFull = 0
        if (syncOpts?.wipeFirst && verify.length > 0 && !syncCancelRequested) {
          const PROOF_ROUNDS = 4
          for (let round = 1; round <= PROOF_ROUNDS; round++) {
            if (syncCancelRequested) break
            sendToRenderer('sync-progress', {
              phase: 'verify', current: landedIds.size, total: syncTarget,
              title: `Double-checking the card (proof ${round}/${PROOF_ROUNDS}) — no cache lies…`,
            })
            await flushCardCaches()
            const proof = await remountVerifyEntries(IPOD_MOUNT, verify, {
              maxPasses: 1,
              label: `proof-${round}`,
              isCancelled: () => syncCancelRequested,
            })
            verifyAttempts += proof.attempts
            if (proof.remountFailed) {
              console.warn(`sync-to-ipod: proof ${round} remount failed — treating as not proven (keeping last landed set, not wiping the catalog to 0)`)
              consecutiveFull = 0
              activityShortfall = true
              break
            }
            const lost = [...landedIds].filter((id) => !proof.landedIds.has(id))
            landedIds = proof.landedIds
            if (lost.length > 0) {
              console.error(`sync-to-ipod: ROULETTE — proof ${round} lost ${lost.length} song(s) that a prior remount claimed (now ${landedIds.size}/${syncTarget})`)
            }
            if (landedIds.size >= syncTarget && proof.landedIds.size >= verify.length) {
              consecutiveFull++
              console.log(`sync-to-ipod: proof ${round} full (${consecutiveFull} consecutive) — ${landedIds.size}/${syncTarget}`)
              if (consecutiveFull >= 2) {
                console.log(`sync-to-ipod: ROULETTE PROOF passed — ${landedIds.size}/${syncTarget} held across two remounts`)
                break
              }
              continue
            }
            consecutiveFull = 0
            const stillMissing = verify.filter((e) => !landedIds.has(e.id))
            if (stillMissing.length === 0) break
            await gapFillMissing(stillMissing, `GAP-FILL-proof-${round}`)
          }
        }
        // A single remount that says 500 is the cache lie. Skipping the proof
        // loop (cancel, empty verify) must not green a 500/500 either.
        if (syncOpts?.wipeFirst && !activitySetProven(consecutiveFull, landedIds.size, syncTarget)) {
          activityShortfall = true
          console.error(`sync-to-ipod: ROULETTE — ${landedIds.size}/${syncTarget} after ${consecutiveFull} consecutive full proof(s); refusing success (N means N)`)
        }

        const before = tracks.length
        const failedNow = tracks
          .filter((t) => !landedIds.has(t.id as number))
          .map((t) => ({
            id: t.id as number,
            title: String((t as Record<string, unknown>).title ?? ''),
            artist: String((t as Record<string, unknown>).artist ?? ''),
            path: String((t as Record<string, unknown>).path ?? ''),
          }))
        failedForReport = failedNow
        tracks = tracks.filter((t) => landedIds.has(t.id as number))
        verifiedLanded = tracks.length
        console.log(`sync-to-ipod: VERIFIED ${verifiedLanded}/${syncTarget} landed on the card after ${verifyAttempts} pass(es)${verifiedLanded !== before ? ` (dropped ${before - verifiedLanded} that never committed)` : ''} — DB will be built from the verified set`)
        if (syncOpts?.wipeFirst && verifiedLanded < syncTarget) {
          activityShortfall = true
          console.error(`sync-to-ipod: ACTIVITY SHORTFALL — asked for ${syncTarget}, card kept ${verifiedLanded}. Will write the honest catalog and report failure (N means N).`)
        }
      } else if (syncOpts?.wipeFirst) {
        // Activity sync on Mac MUST remount-verify. A cache-only "all present"
        // read is exactly how 500 → 103 / 421 / 238 happened with a green check.
        // Leave the journal so boot still nags until a proven sync lands.
        return {
          ok: false,
          error: `Could not remount-verify the activity set — refusing to trust the mount cache. Sync again without unplugging.`,
          copied, copyErrors, landed: 0, target: syncTarget, shortfall: syncTarget, verifyAttempts,
        }
      }
    }

    // Belt-and-suspenders (2026-08-11): even when remount-verify couldn't run
    // (or on non-Mac), never write an iTunesDB entry for a file that isn't
    // actually on the card. Activity sync is ALAC on a 120GB Mini — capacity
    // is fine; the lie is claiming 500 songs while the firmware only sees the
    // files that physically committed. Stat each destination; keep only those
    // present with a positive size. Prefer writtenById's expected size when we
    // have one.
    {
      const present: typeof tracks = []
      let sizeRewrites = 0
      for (const t of tracks) {
        const id = t.id as number
        const remembered = writtenById.get(id)
        const colonPath = String(t.path || '')
        if (!colonPath && !remembered) continue
        const dst = remembered?.dstPath
          || join(IPOD_MOUNT, tsaRelFromColon(colonPath, pathSep))
        try {
          const sz = (await stat(dst)).size
          if (sz <= 0) continue
          if (remembered && remembered.expectedSize > 0 && sz !== remembered.expectedSize) continue
          // Mini 1.4.1 indexes by mhit 0x24. library.json fileSize is often a
          // stale ALAC length over an AAC/smart-matched file on the card
          // (Beyond Me 31MB vs 7.5MB → Songs abort / roulette).
          const libSize = Number(t.fileSize) || 0
          t.fileSize = fileSizeForItunesDb(sz)
          if (libSize !== t.fileSize) sizeRewrites++
          t.sampleRate = sampleRateForItunesDb(t.sampleRate as number | undefined)
          present.push(t)
        } catch { /* missing on card */ }
      }
      if (present.length !== tracks.length) {
        console.warn(`sync-to-ipod: on-disk gate — keeping ${present.length}/${tracks.length} with real files on the card before DB write`)
        tracks = present
        verifiedLanded = tracks.length
      }
      if (sizeRewrites > 0) {
        console.log(`sync-to-ipod: stamped ${sizeRewrites} iTunesDB fileSize(s) from the card (not library.json)`)
      }
    }

    // Last word for activity wipe+rebuild: ANY path that ends below the picked
    // count (remount verify, on-disk gate, streamed skips, copy errors) is a
    // failed sync. Without this, the on-disk gate could shrink 500→238 and still
    // return ok:true — which is the "random Songs count every time" Jake sees.
    if (syncOpts?.wipeFirst && verifiedLanded < syncTarget) {
      activityShortfall = true
      console.error(`sync-to-ipod: ACTIVITY SHORTFALL (pre-DB) — asked for ${syncTarget}, have ${verifiedLanded} verified files`)
    }

    // Firmware listability: catalog N with Songs N-3 is the 497 class.
    // Fill empty title/artist so the writer cannot emit blank mhods; then
    // refuse success if any remaining row would not list.
    {
      for (const t of tracks) {
        if (!String(t.title || '').trim()) {
          const base = String(t.path || '').split(':').pop() || 'Unknown'
          t.title = base.replace(/\.[^.]+$/, '') || 'Unknown'
        }
        if (!String(t.artist || '').trim()) {
          t.artist = String(t.albumArtist || t.album || 'Unknown Artist')
        }
      }
      const unlistable = tracks.filter((t) => !ipodFirmwareWillList(t))
      if (unlistable.length > 0) {
        console.error(
          `sync-to-ipod: ${unlistable.length} track(s) Mini 1.4.1 will not list (497-of-500 class):`,
          unlistable.slice(0, 8).map((t) => `${t.artist} — ${t.title} (${t.path})`),
        )
        if (syncOpts?.wipeFirst) {
          activityShortfall = true
          for (const t of unlistable) {
            failedForReport.push({
              id: t.id as number,
              title: String(t.title ?? ''),
              artist: String(t.artist ?? ''),
              path: String(t.path ?? ''),
            })
          }
        }
      }
    }

    // The full-library tag-verification preflight that used to live here
    // was removed in 4.0.5. It read tags off every audio file on the
    // iPod every sync (~5 minutes over USB 2.0 on a 4500-track library)
    // for a safety net the codebase no longer needs:
    //   • smart-match (above) already tag-verifies tracks whose paths got
    //     rewritten to point at existing files on the iPod — that's the
    //     case the preflight was ACTUALLY catching most of the time
    //   • the post-sync fingerprint verifier (below, after the writer)
    //     silently self-heals path drift, fingerprint backfills, and
    //     audioMissing flags
    //   • the round-trip harness in core/tests/test_db_roundtrip.py
    //     guards against writer regressions at dev time
    // For the rare case of a directly-corrupted library.json, the user
    // can run core/tools/refresh_fingerprints.py to recompute every
    // fingerprint from disk on demand.

    // Switch the toolbar status to the writer phase — the
    // preflight is done; from here it's the iTunesDB rebuild + write
    // (sub-second) and then the post-sync verifier (seconds).
    await writeSyncJournal('db')
    sendToRenderer('sync-progress', {
      phase: 'db', current: 0, total: 1, title: 'Writing iTunesDB...',
    })

    // Backup existing iTunesDB on the card (template + recovery).
    const ipodDb = join(IPOD_MOUNT, 'iPod_Control', 'iTunes', 'iTunesDB')
    try {
      await copyFile(ipodDb, ipodDb + '.bak')
    } catch (err) {
      console.error('Backup iTunesDB failed:', err)
    }

    // Build the catalog on the Mac, then copy it to the CF the same way as
    // audio. Writing Python straight onto /Volumes/JAKETUNES is how a
    // "500-row catalog" lived in the mount cache and never on the card
    // (Jake 2026-08-16). Mini Songs was 450.
    const localDb = join(app.getPath('temp'), `jaketunes-itunesdb-${process.pid}`)
    const scriptPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/db_reader.py')
    return await new Promise((resolve) => {
      const input = JSON.stringify({ tracks, playlists })
      const py = spawn(PYTHON_CMD ?? 'python3', [
        scriptPath, '--write', localDb, '--template', ipodDb, '--ipod-root', IPOD_MOUNT,
      ])
      py.on('error', (err: Error) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ ok: false, error: PYTHON_INSTALL_HINT, copied, copyErrors })
        } else {
          resolve({ ok: false, error: safeIpcError(err, 'tool-failed'), copied, copyErrors })
        }
      })
      // EPIPE-safe stdin write. User hit a main-process crash on 4.1.3
      // right after a sync — almost certainly this write or a debounced
      // post-sync child died with no listener on stdin's 'error', so the
      // EPIPE escalated to an Uncaught Exception. Same pattern below.
      py.stdin.on('error', (err) => {
        resolve({ ok: false, error: `stdin write failed: ${safeIpcError(err, 'tool-failed')}`, copied, copyErrors })
      })
      try {
        py.stdin.write(input)
        py.stdin.end()
      } catch (err) {
        resolve({ ok: false, error: `stdin write threw: ${safeIpcError(err, 'tool-failed')}`, copied, copyErrors })
      }

      let stderr = ''
      let stdout = ''
      py.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

      py.on('close', async (code: number) => {
        console.log('sync-to-ipod stderr:', stderr)
        if (code === 0) {
          // ── CATALOG LAYOUT PASS (2026-08-15, the 79-of-500 night) ─────────
          // Every existing gate below verifies the catalog's CONTENT; none of
          // them see its LAYOUT. The writer's output lands in whatever holes
          // the activity churn left in the FAT — measured at NINE fragments —
          // and the Mini's firmware walks the chain, dies partway, and shows
          // a different count each sync (79/12/471). Rewrite the identical
          // bytes as one contiguous run BEFORE the readback gates, so the
          // artifact they verify is the artifact that ships. On verification
          // failure the worker restores the writer's original and the sync
          // FAILS here — a fragmented-but-correct catalog must never be
          // silently replaced by a torn one.
          const contig = await ensureContiguousDb(localDb, PYTHON_CMD ?? 'python3')
          console.log(`sync-to-ipod: ${contig.summary}`)
          if (!contig.ok) {
            await retireIpodFirmwareScratch(IPOD_MOUNT)
            try { await unlink(localDb) } catch { /* temp */ }
            resolve({
              ok: false,
              error: `The catalog was written but could not be laid down as one piece and verified (${contig.error}). The previous catalog is untouched. Sync again.`,
              copied, copyErrors,
            })
            return
          }
          sendToRenderer('sync-progress', {
            phase: 'db', current: 1, total: 1, title: 'iTunesDB written',
          })

          // ──────────── POST-SYNC FINGERPRINT VERIFIER ────────────
          // Quietly verify that the tracks whose paths just changed in
          // this sync still resolve to the audio they're supposed to,
          // and backfill audioFingerprint for any track that doesn't
          // have one yet. Identity-based check (sha1 of first 256KB +
          // duration), no text matching, never deletes — the only
          // outputs are: (a) backfill a fingerprint, (b) silently
          // rewrite a path if the right audio is found elsewhere on the
          // iPod, or (c) flag audioMissing for the UI. Restricted to
          // the tracks we just touched so it stays cheap (a typical
          // sync rewrites <100 paths and copies <100 files).
          const verifyIds = new Set<number>()
          for (const r of pathRewrites) verifyIds.add(r.id)
          // Find the IDs of newly-copied tracks too. We re-derive them
          // from the tracks array by colon path — toCopy didn't carry
          // ids. (toCopy items are in 1:1 order with the candidates
          // pushed earlier, but reconstructing that mapping is more
          // fragile than just scanning here.)
          const ipodColonsCopied = new Set(toCopy.map(c => {
            // ipod path back to colon form
            const rel = c.ipod.slice(IPOD_MOUNT.length + 1)
            return ':' + rel.split(pathSep).join(':')
          }))
          for (const t of tracks) {
            if (ipodColonsCopied.has(String(t.path || ''))) verifyIds.add(t.id as number)
          }
          let verificationUpdates: VerifyTrackUpdate[] = []
          if (verifyIds.size > 0) {
            const inputs: VerifyTrackInput[] = tracks
              .filter(t => verifyIds.has(t.id as number))
              .map(t => ({
                id: t.id as number,
                path: String(t.path || ''),
                duration: Number(t.duration || 0),
                audioFingerprint: typeof t.audioFingerprint === 'string' ? t.audioFingerprint : undefined,
                audioMissing: t.audioMissing === true,
              }))
            try {
              // Every root that can hold audio — including library.streamRoot.
              // This call used to pass only [iPod, local], so a track kept solely
              // on the NAS resolved nowhere and got stamped audioMissing by a
              // routine iPod sync. That is how a clean file ended up wearing a
              // warning badge.
              verificationUpdates = await verifyAndHealTracks(inputs, await candidateMusicMounts())
              const healedPaths = verificationUpdates.filter(u => u.path).length
              const backfilled = verificationUpdates.filter(u => u.audioFingerprint).length
              const flagged = verificationUpdates.filter(u => u.audioMissing).length
              if (healedPaths || backfilled || flagged) {
                console.log(`sync-to-ipod: post-sync verifier — ${healedPaths} path heal${healedPaths === 1 ? '' : 's'}, ${backfilled} fingerprint backfill${backfilled === 1 ? '' : 's'}, ${flagged} flagged audioMissing`)
              }
            } catch (verr) {
              console.warn('sync-to-ipod: post-sync verifier crashed (non-fatal):', verr)
            }
          }

          // Post-sync iPod orphan cleanup — delete audio files on the device
          // whose basename is not referenced by library.json (identity-safe).
          // Activity wipe+rebuild already emptied Music. Deleting more files
          // AFTER the catalog is written is how a sealed 500 becomes 492 on
          // the Mini. TSA holds the set until the next explicit Activity Sync.
          let ipodOrphansDeleted = 0
          if (!syncOpts?.wipeFirst) {
          try {
            const ipodMusicRoot = join(IPOD_MOUNT, 'iPod_Control', 'Music')
            const ipodResult = await cleanOrphansOnMusicRoot(ipodMusicRoot, tracks as Array<{ path?: string }>, syncRunStartMs)
            ipodOrphansDeleted = ipodResult.deleted
            if (ipodOrphansDeleted > 0) {
              console.log(`sync-to-ipod: cleaned ${ipodOrphansDeleted} iPod orphan file(s), freed ${(ipodResult.bytesFreed / 1e9).toFixed(2)} GB`)
            }
            if (ipodResult.protected > 0) {
              console.warn(`sync-to-ipod: orphan cleanup PROTECTED ${ipodResult.protected} freshly-written file(s) from deletion — the shrinking-iPod bug would have eaten these`)
            }
          } catch (ipodOrphErr) {
            console.warn('sync-to-ipod: iPod orphan cleanup failed (non-fatal):', ipodOrphErr)
          }
          } else {
            console.log('sync-to-ipod: TSA — skipping post-catalog orphan deletes on activity rebuild (the wipe was the cleanup)')
          }

          // Copy the local catalog onto the CF and prove it the same way as
          // audio: F_FULLFSYNC + two cold remounts. A parse of 500 from the
          // mount cache is not the Mini.
          sendToRenderer('sync-progress', {
            phase: 'db', current: 1, total: 1,
            title: `Putting the ${syncTarget}-song catalog on the card…`,
          })
          const localMd5 = contig.md5
          const localBytes = contig.bytes
          let catalogConsecutive = 0
          let readback: { tracks: Array<Record<string, unknown>>; playlists?: unknown[] } | null = null
          const CATALOG_PROOF_ROUNDS = syncOpts?.wipeFirst ? 4 : 2
          for (let round = 1; round <= CATALOG_PROOF_ROUNDS; round++) {
            if (catalogConsecutive === 0) {
              try {
                await copyFile(localDb, ipodDb)
                const conf = await confirmWriteOnCard(localDb, ipodDb)
                if (!conf.ok) {
                  console.error(`sync-to-ipod: catalog copy not confirmed (${conf.reason})`)
                  continue
                }
              } catch (copyErr) {
                console.error('sync-to-ipod: catalog copy onto the card failed:', copyErr)
                continue
              }
            }
            await retireIpodFirmwareScratch(IPOD_MOUNT)
            const flush = await remountVolume(IPOD_MOUNT)
            if (!flush.ok) {
              await retireIpodFirmwareScratch(IPOD_MOUNT)
              try { await unlink(localDb) } catch { /* temp */ }
              resolve({
                ok: false,
                error: `The catalog file never made it onto the card — remount failed (${flush.error}). The Mini does not have ${syncTarget} songs. Do not unplug — sync again.`,
                copied, copyErrors, target: syncTarget, landed: 0, shortfall: syncTarget, verifyAttempts,
              })
              return
            }
            await retireIpodFirmwareScratch(IPOD_MOUNT)
            let onCard: Buffer
            try {
              onCard = await readFile(ipodDb)
            } catch {
              catalogConsecutive = 0
              continue
            }
            const cardMd5 = createHash('md5').update(onCard).digest('hex')
            try {
              readback = await readIpodDatabase() as { tracks: Array<Record<string, unknown>>; playlists?: unknown[] }
            } catch {
              catalogConsecutive = 0
              continue
            }
            const match = catalogBytesMatch({
              onCardBytes: onCard.length,
              localBytes,
              onCardMd5: cardMd5,
              localMd5,
              trackCount: readback.tracks.length,
              target: syncTarget,
            })
            console.log(`sync-to-ipod: catalog proof ${round}/${CATALOG_PROOF_ROUNDS} — card ${onCard.length}b md5 ${cardMd5.slice(0, 8)} tracks=${readback.tracks.length} vs local ${localBytes}b md5 ${localMd5.slice(0, 8)} target=${syncTarget} match=${match}`)
            if (match) {
              catalogConsecutive++
              if (catalogOnCardProven(catalogConsecutive, match)) {
                console.log(`sync-to-ipod: catalog ON CARD — ${syncTarget} tracks, ${localBytes} bytes, held across two remounts`)
                break
              }
            } else {
              catalogConsecutive = 0
            }
          }
          try { await unlink(localDb) } catch { /* temp */ }
          if (!readback || !catalogOnCardProven(catalogConsecutive, catalogConsecutive >= 2)) {
            resolve({
              ok: false,
              error: `The ${syncTarget}-song catalog never committed to the card. Mac cache is not the Mini — that is how Songs became 450. Not calling this done. Sync again without unplugging.`,
              copied, copyErrors, target: syncTarget, landed: 0, shortfall: syncTarget, verifyAttempts,
            })
            return
          }

          // ── DEVICE-TRUTH READBACK — catalog bytes already proven on the CF.
          try {
            const onDevice = readback.tracks.length
            if (onDevice !== tracks.length) {
              console.error(`sync-to-ipod: READBACK MISMATCH — wrote ${tracks.length} tracks, device catalog answers ${onDevice}`)
              resolve({
                ok: false,
                error: `Your songs are fine — ${verifiedLanded || copied} of ${tracks.length} are verified on the iPod. What failed is the CATALOG (the iPod's table of contents): it lists ${onDevice}. Sync again to rewrite it — no music needs re-copying.`,
                copied, copyErrors,
              })
              return
            }
            // 2026-07-21: the catalog is NOT enough — Jake's device kept
            // showing fewer songs than a 1000-record catalog because the
            // FILES were being deleted out from under it.
            // 2026-08-16: do NOT prove existence with readdir. fskit returns
            // partial listings; 4 hidden names became "device will show 496",
            // then Mini Songs was 450 because firmware aborts the index on
            // ghosts + leftover Play Counts — it does not subtract 4.
            // Stat each catalog dest the way copy-verify does.
            const missingRows: Array<{ title: string; artist: string; path: string }> = []
            for (const t of readback.tracks as Array<{ path?: string; title?: string; artist?: string }>) {
              const colon = String(t.path || '')
              const abs = colon ? join(IPOD_MOUNT, tsaRelFromColon(colon, pathSep)) : ''
              try {
                if (!colon) throw new Error('no-path')
                const sz = (await stat(abs)).size
                if (sz <= 0) throw new Error('empty')
              } catch {
                missingRows.push({
                  title: String(t.title || ''),
                  artist: String(t.artist || ''),
                  path: colon,
                })
              }
            }
            if (missingRows.length > 0) {
              const sample = missingRows.slice(0, 8)
                .map((r) => `${r.artist} — ${r.title} (${r.path})`)
                .join('; ')
              console.error(`sync-to-ipod: FILE READBACK — ${missingRows.length}/${onDevice} catalog dests failed stat: ${sample}`)
              await writeSyncReport({
                syncedAt: new Date().toISOString(), target: syncTarget,
                landed: onDevice - missingRows.length, shortfall: missingRows.length,
                verifyPasses: verifyAttempts, copied, copyErrors,
                failed: missingRows.slice(0, 40).map((r, i) => ({
                  id: i, title: r.title, artist: r.artist, path: r.path,
                })),
              })
              resolve({
                ok: false,
                error: `Sync verify failed: ${missingRows.length} of ${onDevice} catalog songs are not on the card at the path the Mini will open. Firmware 1.4.1 aborts Songs (450 of 500), it does not skip ${missingRows.length}. ${sample}`,
                copied, copyErrors, target: syncTarget,
                landed: onDevice - missingRows.length,
                shortfall: missingRows.length, verifyAttempts,
              })
              return
            }
            const musicRoot = join(IPOD_MOUNT, 'iPod_Control', 'Music')
            const onDiskFiles = await walkAudioFilesUnder(musicRoot)

            // ── FIRMWARE-SEMANTIC GATE ─────────────────────────────────────
            // Counts + paths + byte sizes do NOT prove the Mini will expose a
            // song. Firmware 1.4.1 silently filters mhit rows with invalid audio
            // facts (observed live: 500 rows/files, but four rows carried
            // bitrate=0, sampleRate=0, mediatype=0 and only 496 appeared).
            // Run the independent validator against the cold-remounted DB before
            // success. This checker deliberately shares no parser code with the
            // writer, so a writer regression cannot validate itself.
            const semanticScript = join(
              app.isPackaged ? process.resourcesPath : app.getAppPath(),
              'core/tools/itdb_verify.py',
            )
            const semantic = await new Promise<{ ok: boolean; output: string }>((done) => {
              const check = spawn(PYTHON_CMD ?? 'python3', [
                semanticScript,
                ipodDb,
                '--root', IPOD_MOUNT,
                '--expect', String(syncTarget),
              ])
              let output = ''
              check.stdout.on('data', (d: Buffer) => { output += d.toString() })
              check.stderr.on('data', (d: Buffer) => { output += d.toString() })
              check.on('error', (err: Error) => done({ ok: false, output: safeIpcError(err, 'tool-failed') }))
              check.on('close', (checkCode: number) => done({ ok: checkCode === 0, output }))
            })
            if (!semantic.ok) {
              console.error(`sync-to-ipod: FIRMWARE SEMANTIC VALIDATION FAILED:\n${semantic.output}`)
              await writeSyncReport({
                syncedAt: new Date().toISOString(), target: syncTarget,
                landed: 0, shortfall: syncTarget, verifyPasses: verifyAttempts,
                copied, copyErrors,
                failed: [{ id: 0, title: 'iTunesDB semantic validation failed', artist: '', path: '' }],
              })
              resolve({
                ok: false,
                error: `The ${syncTarget} files are safely on the iPod, but its catalog contains firmware-invalid song records. JakeTunes refused to claim success. Sync again to rebuild the catalog; restarting the iPod cannot repair this.`,
                copied, copyErrors, target: syncTarget, landed: 0,
                shortfall: syncTarget, verifyAttempts,
              })
              return
            }
            console.log(`sync-to-ipod: firmware-semantic validation GREEN for all ${syncTarget} tracks`)
            console.log(`sync-to-ipod: readback verified — ${onDevice} catalog records, all ${onDiskFiles.length} files present on disk`)

            // ── TSA (2026-08-15) — every boarded identity on the card, in the
            // catalog, and listable. 492/497/79 after a green N/N is a hold,
            // not a near-miss. Plug-in must not auto-repair; this seal is the
            // set that has to stay until the next explicit Activity Sync.
            // Screen here; write the seal only after the on-device count check
            // so a short catalog cannot leave a lying seal on disk.
            if (syncOpts?.wipeFirst) {
              sendToRenderer('sync-progress', {
                phase: 'verify', current: 1, total: 1,
                title: `TSA — inspecting all ${syncTarget} songs by identity…`,
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
                const dest = remembered?.dstPath
                  || join(IPOD_MOUNT, tsaRelFromColon(p.destPath, pathSep))
                try {
                  onCard.set(p.destPath, (await stat(dest)).size)
                } catch { /* missing — TSA holds */ }
              }
              const catalogPaths = new Set(
                (readback.tracks as Array<{ path?: string }>).map((t) => tsaNormalizeColonPath(String(t.path || ''))),
              )
              const screen = tsaScreen({ boarded: tsaBoarded, onCard, catalogPaths })
              activityTsaScreen = screen
              if (!tsaAllClear(tsaBoarded.length, screen.cleared.length, screen.held.length) || tsaBoarded.length !== syncTarget) {
                const sample = screen.held.slice(0, 8)
                  .map((h) => `${h.artist} — ${h.title} (${h.reason})`)
                  .join('; ')
                console.error(`sync-to-ipod: TSA HELD ${screen.held.length}/${tsaBoarded.length} (target ${syncTarget}): ${sample}`)
                await writeSyncReport({
                  syncedAt: new Date().toISOString(), target: syncTarget,
                  landed: screen.cleared.length, shortfall: Math.max(screen.held.length, syncTarget - screen.cleared.length),
                  verifyPasses: verifyAttempts, copied, copyErrors,
                  failed: screen.held.slice(0, 40).map((h) => ({
                    id: h.id, title: h.title, artist: h.artist, path: h.destPath,
                  })),
                })
                resolve({
                  ok: false,
                  error: `TSA held ${Math.max(screen.held.length, syncTarget - screen.cleared.length)} of ${syncTarget} songs — the Mini would not show ${syncTarget}. ${sample}`,
                  copied, copyErrors, target: syncTarget,
                  landed: screen.cleared.length,
                  shortfall: Math.max(screen.held.length, syncTarget - screen.cleared.length), verifyAttempts,
                })
                return
              }
            }

            // ── DEBRIS REPORT (2026-08-15) — report-only, deletes NOTHING ──
            // The raw FAT walk that night found ~431 unreferenced audio files
            // plus .XXXXXX staging temps and a stray .flac accumulated on the
            // card. That churn is what shreds free space, and shredded free
            // space is where the next catalog gets fragmented. Deletion stays
            // a deliberate act (per the destructive-ops rule) — this makes the
            // pile VISIBLE on every sync instead of discoverable only by
            // forensics at 3am. Identity source: the catalog just verified.
            {
              const referenced = new Set<string>()
              for (const t of readback.tracks as Array<{ path?: string }>) {
                const bn = (t.path || '').split(/[/:\\]/).pop() || ''
                if (bn) referenced.add(bn.toLowerCase())
              }
              const debris = onDiskFiles.filter((f) => {
                const bn = (f.split(/[/\\]/).pop() || '').toLowerCase()
                return bn && !referenced.has(bn)
              })
              // Staging temps (.name.XXXXXX) are dotfiles with a non-audio
              // final extension, so walkAudioFilesUnder never sees them —
              // they need their own sweep or this count reads 0 forever.
              let staging = 0
              try {
                const { readdir } = await import('fs/promises')
                for (const fdir of await readdir(musicRoot, { withFileTypes: true })) {
                  if (!fdir.isDirectory()) continue
                  for (const name of await readdir(join(musicRoot, fdir.name))) {
                    if (/^\..+\.[A-Za-z0-9]{6}$/.test(name)) staging++
                  }
                }
              } catch { /* report-only — never fail a sync over a count */ }
              if (debris.length > 0 || staging > 0) {
                console.warn(`sync-to-ipod: DEBRIS — ${debris.length} unreferenced audio file(s) + ${staging} staging temp(s) on the card. Examples: ${debris.slice(0, 3).map((f) => f.split('/').pop()).join(', ') || '(temps only)'}`)
              } else {
                console.log('sync-to-ipod: no debris — every file on the card is referenced by the catalog')
              }
            }
            // Activity wipe+rebuild: catalog matching the partial landed set is
            // still a FAILED sync if it's under the pick (489 of 500).
            if (syncOpts?.wipeFirst && onDevice < syncTarget) {
              resolve({
                ok: false,
                error: `Only ${onDevice} of ${syncTarget} songs stuck on the iPod — the card is still dropping writes (roulette). Catalog matches what landed. Sync again, or reformat the card if this keeps happening.`,
                copied, copyErrors,
                target: syncTarget,
                landed: onDevice,
                shortfall: syncTarget - onDevice,
                verifyAttempts,
              })
              return
            }
            // Seal only after the on-device count is the boarded N. A seal
            // written earlier is how a short catalog could look "done."
            if (syncOpts?.wipeFirst) {
              const screen = activityTsaScreen
              if (
                activityShortfall
                || !screen
                || tsaBoarded.length !== syncTarget
                || !tsaAllClear(tsaBoarded.length, screen.cleared.length, screen.held.length)
              ) {
                resolve({
                  ok: false,
                  error: `Activity set of ${syncTarget} did not clear TSA (${screen?.cleared.length ?? 0} cleared). Not calling this a success.`,
                  copied, copyErrors, target: syncTarget,
                  landed: screen?.cleared.length ?? verifiedLanded,
                  shortfall: syncTarget - (screen?.cleared.length ?? verifiedLanded),
                  verifyAttempts,
                })
                return
              }
              const seal = tsaSealFromScreen(screen, new Date().toISOString())
              if (!seal || seal.target !== syncTarget) {
                resolve({
                  ok: false,
                  error: `Activity set of ${syncTarget} cleared the lane but TSA could not build a seal. Sync again.`,
                  copied, copyErrors, target: syncTarget, landed: screen.cleared.length,
                  shortfall: 0, verifyAttempts,
                })
                return
              }
              try {
                await writeTsaSealFile(seal)
                activityTsaSealed = true
                console.log(`sync-to-ipod: TSA sealed ${seal.target} songs — plug-in will inspect, not auto-sync`)
                try {
                  await writeLastSyncManifest({
                    syncedAt: seal.sealedAt,
                    status: 'sealed',
                    sealed: true,
                    count: seal.target,
                    tracks: seal.passengers.map((p) => ({ id: p.id, destPath: p.destPath, identity: p.identity })),
                  })
                } catch (mErr) {
                  console.warn('sync-to-ipod: sealed, but last-sync-manifest update failed:', mErr)
                }
              } catch (sealErr) {
                console.error('sync-to-ipod: TSA seal write failed — refusing success:', sealErr)
                resolve({
                  ok: false,
                  error: `The ${syncTarget} songs are on the card but TSA could not seal the set (${sealErr instanceof Error ? sealErr.message : String(sealErr)}). Sync again without unplugging.`,
                  copied, copyErrors, target: syncTarget, landed: screen.cleared.length,
                  shortfall: 0, verifyAttempts,
                })
                return
              }
            }
            // Third pass: Mini may have rewritten Play Counts during this
            // readback window. iTunes deletes these every sync.
            await retireIpodFirmwareScratch(IPOD_MOUNT)
          } catch (rbErr) {
            console.warn('sync-to-ipod: readback failed (treating as sync failure):', rbErr)
            await retireIpodFirmwareScratch(IPOD_MOUNT)
            resolve({
              ok: false,
              error: `Sync verify failed: could not read the iPod's catalog back (${rbErr instanceof Error ? rbErr.message : String(rbErr)}). Sync again before unplugging.`,
              copied, copyErrors,
            })
            return
          }

          const finalShortfall = Math.max(0, syncTarget - verifiedLanded)
          await writeSyncReport({
            syncedAt: new Date().toISOString(),
            target: syncTarget,
            landed: activityShortfall ? verifiedLanded : syncTarget,
            shortfall: activityShortfall ? finalShortfall : 0,
            verifyPasses: verifyAttempts,
            copied,
            copyErrors,
            failed: activityShortfall ? failedForReport : [],
          })
          resolve({
            ok: syncOpts?.wipeFirst
              ? tsaActivityOk({
                target: syncTarget,
                boarded: tsaBoarded.length,
                cleared: activityTsaScreen?.cleared.length ?? 0,
                held: activityTsaScreen?.held.length ?? 0,
                sealed: activityTsaSealed,
                shortfall: activityShortfall,
              })
              : !activityShortfall,
            copied, copyErrors,
            totalTracks: tracks.length,
            // Verified-count truth (2026-07-24): what the user picked vs what
            // actually committed to the card. shortfall>0 → the renderer shows an
            // honest banner instead of a false success. Activity wipe+rebuild
            // sets ok:false on shortfall so we never commit "N on the iPod"
            // when the card kept a random subset (103 / 421 / 238…).
            target: syncTarget,
            landed: verifiedLanded,
            shortfall: finalShortfall,
            verifyAttempts,
            error: (syncOpts?.wipeFirst
              ? !tsaActivityOk({
                target: syncTarget,
                boarded: tsaBoarded.length,
                cleared: activityTsaScreen?.cleared.length ?? 0,
                held: activityTsaScreen?.held.length ?? 0,
                sealed: activityTsaSealed,
                shortfall: activityShortfall,
              })
              : activityShortfall)
              ? (verifiedLanded < syncTarget
                ? `Only ${verifiedLanded} of ${syncTarget} songs actually stuck on the iPod after ${verifyAttempts} tries — the card keeps dropping writes. The catalog matches what landed; sync again (or reformat the card) to reach ${syncTarget}.`
                : `${verifiedLanded} files looked present but did not hold across two remounts — that is the N/N → 33 roulette. Not calling this a success. Sync again without unplugging.`)
              : undefined,
            ipodOrphansDeleted,
            // Return the path rewrites so the renderer can update
            // library.json to match what actually ended up on the iPod.
            pathRewrites: pathRewrites.map(r => ({ id: r.id, newPath: r.newPath })),
            // Fingerprint backfills, silent path heals, and audioMissing
            // flags from the post-sync verifier. Renderer applies these
            // as UPDATE_TRACKS so library.json reflects the verified
            // state on the next save.
            verificationUpdates,
          })
        } else {
          resolve({ ok: false, error: safeIpcError(`DB write failed (code ${code}): ${stderr}`, 'tool-failed'), copied, copyErrors })
        }
      })
      py.on('error', (err: Error) => {
        resolve({ ok: false, error: safeIpcError(err, 'tool-failed'), copied, copyErrors })
      })
    })
  }

  return {
    handleSyncToIpod,
    handleSyncIpodFromDevice,
    isSyncInFlight: () => syncInFlight,
    requestSyncCancel: (): { wasRunning: boolean } => {
      if (!syncInFlight) return { wasRunning: false }
      syncCancelRequested = true
      return { wasRunning: true }
    },
  }
}
