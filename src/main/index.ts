// ── libuv threadpool ──────────────────────────────────────────────────
// MUST be set before anything touches fs/dns: libuv reads it when the pool is
// first used, and the default is FOUR threads.
//
// Jake, 2026-08-10: "you restart the app every time it works, then after
// that, doesn't work. that's the issue." That is this. Background work —
// artwork, art-thumbs, the Cynthia sweep, discovery — walks the music tree,
// and on a streaming host those paths are symlinks into an SMB mount that
// wedges. A hung readdir occupies a pool thread and never returns. Four of
// them and EVERY later async fs call queues forever, including serving audio.
// Playback then dies and stays dead until relaunch, which is exactly the
// pattern: fine right after a restart, dead a while later.
//
// The homemini engine hit the same wall and was fixed the same way.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '64'


import { getVenueShows, type VenueShow } from './venues.js'
// The four persona system prompts — 268 lines of prose, lifted out 2026-08-10.
import {
  MUSIC_MAN_CORE, MEGAN_CORE, DJ_HANDS_CORE,
  initPersonaPrompts, withLibraryDigest, buildMusicManPrompt,
} from './personas.ts'
import {
  initPersonaMemory,
  loadMusicManMemory, noteMusicManUtterance, recentUtterancesBlock,
  loadCynthiaMemory, recentCynthiaBlock,
} from './persona-memory.ts'
import {
  initLibraryDigest, type DigestTrack,
  refreshLibraryDigest, getLibraryDigest, scheduleLibraryDigestRefresh,
} from './library-digest.ts'
import {
  initListenerProfile, loadListenerProfile, saveListenerProfile, appendListeningEvent,
  addObservation, getListenerProfile, buildTasteProfile, type ListenerProfile,
} from './listener-profile.ts'
import { app, BrowserWindow, Menu, ipcMain, protocol, dialog, powerSaveBlocker, shell, globalShortcut, nativeImage, systemPreferences } from 'electron'
import { writeJsonAtomic } from './atomic-write'
import { resolveContainedPath, isSafeCacheKey, isPathInside } from './path-safety'
import { isHomeminiPlaybackClient, mayFollowPlaybackSymlink } from './stream-playback'
import {
  phonePlaylistSidecarsNeverPushFromDesktop,
  assertNoDesktopBluntPush,
} from './sidecar-contracts.ts'
import { fetchHeadersWithin } from './fetch-headers'; import { spoolAwareServe } from './stream-spool.ts'; import { refreshPhoneMirrors, ensureMobileImportAudio } from './phone-mirrors.ts'; import { safeIpcError } from './safe-ipc-error.ts'
import { computeDeletedPaths } from './library-deletions'
import { pathHashFor, playCacheName, isEntryFor, legacyPlayCacheName } from './play-cache-name'
import { createPlayCache } from './play-cache.ts'
import { createServePin } from './play-cache-serve-pin.ts'
import { createIpcRegistrar, REFUSED_SENDER } from './ipc-register.ts'
import { registerUiStateIpc } from './ipc/ui-state-ipc.ts'
import { registerBackupIpc } from './ipc/backup-ipc.ts'
import { registerSettingsIpc } from './ipc/settings-ipc.ts'
import { registerImportIpc, resolveAudioPaths } from './ipc/import-ipc.ts'
import { registerLibraryIpc } from './ipc/library-ipc.ts'
import { registerCdIpc } from './ipc/cd-ipc.ts'
import { registerAudioOutputIpc } from './ipc/audio-output-ipc.ts'
import { registerLiveSetsIpc } from './ipc/live-sets-ipc.ts'
import { registerMobileReadsIpc } from './ipc/mobile-reads-ipc.ts'
import { registerArtworkIpc } from './ipc/artwork-ipc.ts'
import { registerRecommendations, MOBILE_BACKEND_URL, type RecoSource, type RecommendationRecord } from './ipc/recommendations-ipc.ts'
import { registerTasteIpc, TASTE_LEDGER_PATH } from './ipc/taste-ipc.ts'
import { registerPreviewRefreshIpc } from './ipc/preview-refresh-ipc.ts'
import { registerSyncHistoryIpc } from './ipc/sync-history-ipc.ts'
import { registerActivityPoolIpc } from './ipc/activity-pool-ipc.ts'
import { registerAlbumInfoIpc } from './ipc/album-info-ipc.ts'
import {
  initRagRetrieval, ragIndexedCountForTracks, ragLibraryArtistSet, pickRetrievalIndex,
  ragTrackYearMap, ragRetrieveByQuery, buildRagPoolForPicks, buildRetrievalBlockForQuery,
} from './ai/rag-retrieval.ts'
import {
  getArtworkDir, artworkHash, invalidateArtBytes, getCachedArtBytes, putArtBytes,
  loadArtworkIndex, mergeArtworkSidecarsIntoIndex, saveArtworkIndex, loadArtworkLocks,
  selfHealUserLockedArtwork, setArtworkLock, extractAndSaveEmbeddedArtwork,
  scheduleArtworkLookupRebuild, normalizeArtworkPartServer, resolveArtworkCache,
  pendingArtworkMigrations, bareArtHash, getArtworkLockedBackupDir,
  artworkLookupRebuildPromise, artworkNormIndexMem, artworkSidecarNormMem,
  setArtworkIndexMem, type ParsedPicture, searchDeezerArt,
} from './artwork-engine.ts'
import { registerIpodIpc } from './ipc/ipod-ipc.ts'
import { registerSyncIpc, type SyncConvertOptions } from './ipc/sync-ipc.ts'
import { createSyncEngine, type VerifyTrackInput, type VerifyTrackUpdate } from './sync-engine/index.ts'
import { ingestIpodRoundTrip } from './sync-engine/roundtrip.ts'
import { registerAiIpc } from './ipc/ai-ipc.ts'
import {
  registerCynthiaIpc,
  runCynthiaInvestigation,
  type CynthiaTrackInScope,
  type CynthiaIpcHost,
} from './ipc/cynthia-ipc.ts'
import { allowImportPaths, isImportPathAllowed } from './import-allowlist.ts'
import { isAllowedCaptureUrl, isPrivateOrLocalHostname } from './url-safety'
import {
  getBrooklynWeather, formatWeatherForPrompt,
  getLastFmNyChart, getLastFmSimilarArtists, formatLastFmChartForPrompt,
  getRecentReviews, formatReviewsForPrompt,
  getDiscogsReleaseInfo, formatDiscogsForPrompt,
  getWikidataArtist, formatWikidataForPrompt,
  getMusicBrainzReleaseMbid, getCoverArtUrlByMbid,
  getMusicNews, getNotableReleases, type MusicNewsItem,
  getTourDatesForArtists, type TourDate,
  getUpcomingReleasesForArtists, type UpcomingRelease,
} from './external'
import {
  appendMemory, formatMemoryForPrompt, extractCallbacks,
  setHotTake, getHotTake,
} from './radio-memory'
import { buildCallerSegmentMode } from './cast'
import { startImessageCapture } from './imessage-capture'
import { decodeHtmlEntities } from './imessage-capture-core'
import { sweepFriendImports as moduleSweepFriendImports, noteAttribution } from './friend-credit-sweep.ts'
import { initPlaylistHubSync, schedulePlaylistHubConverge, type HubPlaylistLike } from './playlist-hub-sync.ts'
import { initMixtapeHubSync, scheduleMixtapeHubConverge } from './mixtape-hub-sync.ts'
import { registerSpotifyIpc } from './spotify-ipc.ts'
import { loadSpotifyTasteAnchors } from './spotify-taste.ts'
import { readMixtapesForHub, writeMixtapesFromHub, mixtapeTombstonesFile, mixtapeIntrosDir } from './mixtapes.ts'
import { tombstonesPath as playlistTombstonesPath, loadTombstones as loadPlaylistTombstones } from './playlist-tombstones.ts'
import { pinsPath as playlistPinsPath } from './playlist-pins.ts'
import { hostname as osHostname } from 'os'
import { computeStandings, computeAlbumCredits, creditKindOf, albumKeyOfStrings, type CreditRecord } from './friend-standings-core'
import { scorePlaylistCandidates } from './playlist-vibes'
import { ARCHETYPES, buildArchetypeBlock, type ArchetypeId } from './archetypes'
import { join, relative } from 'path'
import { STATE_DIR, STATE_IS_NAS, NAS_STATE_DIR_PATH, isNasMounted, nasAvailable, isSaveLocked, startNasReconnectWatcher } from './state-dir'
import { snapshotLibrary, maybeAutoSnapshot } from './backup'
import { shouldRefuseSave, mayUnlinkDeletions, UNLINK_CAP } from './save-guards'
import { computeTasteFingerprint, getTasteAnchors } from './taste-model'
import type { TrackLike } from './taste-model'
import { parseCandidates, rankCandidates } from './radar-core'
import type { RankedCandidate } from './radar-core'
import { mergeStarIds } from './mobile-stars-merge'
import { parseRelatedArtists } from './artist-groups-core'
// Cynthia overhaul — deterministic scanner types + background sweep.
import { type CynthiaFinding, type CynthiaScanTrack } from './cynthia-scan'
import {
  startCynthiaSweep, enqueueAlbumsForSweep,
  revertLedgerEntry, albumKeyOfMain,
} from './cynthia-sweep'
import type { RelatedArtist } from './artist-groups-core'
import { normalize } from './normalize'
import { assessDeadTrackRemoval } from './reconcile-guard'
import {
  recoNorm,
  recoTitleMatches,
  recoArtistMatches,
  evaluateMusicManVerification,
  recordIdentityKeys,
  recoDedupeKey,
  pickBetterReco,
  isTombstonedRecord,
} from './reco-match'
import {
  type RecoOutboxOp,
  parseOutbox,
  scrubOutboxForDelete,
  scrubOutboxAgainstBackend,
  pendingAddLocalIds,
} from './reco-outbox'
import { computeMirror, computeNasFallback, identitiesForDelete } from './reco-sync'
import { parseLogLines, computeListeningMemory, type PlayEvent } from './listening-memory'
import { computeRediscovery, type RediscoveryPick, type RediscoveryTrack } from './rediscovery'
import {
  pickAlbumReleaseDate,
  sanitizeAlbumCredits,
  tagYearStr,
} from '../common/albumReleaseDate'
import { foldAccents } from '../common/fold-text.ts'
import { explicitWins } from '../common/explicit.ts'
import { summariseLearning, discoverVerdicts, type LedgerRow } from './discovery-learned.ts'
import { readLedgerRows } from './taste-ledger-io.ts'
import { JsonFileCache } from './state-cache'
import { initFlightRecorder, sanitizeCrashPayload, quietWarn } from './flight-recorder'
import { spawn } from 'child_process'
import { stat, lstat, open, readFile, writeFile, mkdir, copyFile, unlink, readlink, symlink, rename, appendFile, readdir } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { config } from 'dotenv'
import { autoUpdater } from 'electron-updater'
import {
  IS_MAC,
  IS_WINDOWS,
  PYTHON_CMD,
  PYTHON_INSTALL_HINT,
  listMountPoints,
  volumeNameFromMount,
  findIpodMount,
  isIpodMount,
  ejectVolume,
  remountVolume,
  hasOpticalMedia,
  ejectOpticalMedia,
  audioHelperRelPath,
  convertAudio,
  ensureFaststart,
  extensionForFormat,
  resolveImportFormat,
  type AudioFormat,
} from './platform'
import {
  partitionLanded,
  activitySetProven,
  catalogBytesMatch,
  catalogOnCardProven,
  fileSizeForItunesDb,
  sampleRateForItunesDb,
  activityWipeEmptyStreak,
  activityWipeProvenEmpty,
  ACTIVITY_WIPE_MAX_PASSES,
  ipodPlayableDestPath,
  ipodFirmwareWillList,
  needsIpodAlacTranscode,
  isIpodFirmwareScratchName,
  IPOD_FIRMWARE_SCRATCH_NAMES,
  type IntendedTrack,
} from './ipod-reconcile'
import {
  tsaBoardPassenger,
  tsaScreen,
  tsaAllClear,
  tsaActivityOk,
  tsaSealFromScreen,
  tsaDestCollisions,
  tsaNormalizeColonPath,
  tsaRelFromColon,
  type TsaPassenger,
  type TsaScreen,
} from './ipod-sync-tsa'
import { ensureContiguousDb } from './ipod-db-contiguity'
import { refuseIpodSyncUnlessUserClick, type IpodSyncOpts } from './ipod-sync-origin'
import { runActivitySync } from './ipod-activity-engine'
import {
  classifyActivitySyncTracks,
  formatHomeminiPullRefuse,
  formatSyncSetFileRefuse,
} from './activity-boardable'
import { materializeTrackFromHomemini } from './ipod-sync-materialize'
import {
  confirmWriteOnCard,
  flushCardCaches,
  remountVerifyEntries,
  retireIpodFirmwareScratch,
} from './ipod-sync-card'
import { sweepOnce, type SweepResult } from './library-eviction'
import { serveEvictedFromHomemini } from './evicted-playback.ts'
import {
  initImportPipeline,
  importOneFile,
  importDownloadedFiles,
  fingerprintTrack,
  loadDupeFingerprintsFromLibrary,
  findFreeImportedId,
  addSessionImportedFingerprint,
  clearSessionImportedFingerprints,
  type SingleImportResult,
} from './import-pipeline'
import { searchItunesSuggestions, itunesAlbumTracks } from './download-search'
import { registerBandcampIntegration } from './bandcamp-integration'
import { registerStreamripStore } from './streamrip-store'
import { registerGaplessTrimIpc } from './gapless-trim'
import { registerPlaylistCoverIpc, registerPlaylistCoverProtocol } from './playlist-covers'
import { registerScotusArchive } from './scotus-archive'
import { registerRecordStoreIntegration } from './record-store'
import { parsePlayEvents } from './record-store/shelf-generator'
import type { CandTrack } from './record-store/candidate-pool'
import { registerWorkoutSyncIpc } from './workout-sync-ipc'
import { registerMixtapesIpc } from './mixtapes'
import {
  getActivityPromptBlockSync,
  getActivityBrainContextSync,
  loadActivityBrainContext,
} from './activity-context'
import {
  configureInboxWatcher,
  startOrReconfigureInboxWatcher,
  stopInboxWatcher,
  type InboxConfig,
} from './inbox-watcher'
import {
  startSyncOrchestrator,
  triggerSync,
} from './sync-orchestrator'
// Brief 023: removed imports from ./library-snapshot and
// ./library-overrides — both modules are deleted along with this
// commit. They were the backing for the vestigial mobile-sync feature
// that never shipped. Plex (via Brief 020 tag write-back) is the
// mobile path now.
//
// Brief 020: tag write-back (overrides → embedded file tags so Plex
// sees user edits). Pairs with metadata-overrides.json — overrides
// remain the authoritative source; this module pushes them downstream.
import {
  WRITABLE_FIELDS,
  writeTagsToFile,
  writeTagsBatch,
  colonPathToAbsolute,
  augmentPairFields,
  type TagWriteRequest,
} from './tag-writer'

const isDev = !app.isPackaged

if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// macOS overlay scrollbars ignore ::-webkit-scrollbar styling and feel
// broken (tiny pill, no drag). Force classic always-visible scrollbars
// so our iTunes-style CSS actually applies.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('disable-features', 'OverlayScrollbars')
}

// macOS GUI apps launched from Finder inherit only the system PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), NOT the user's shell PATH. Tools
// installed via Homebrew (ffmpeg, ffprobe, python3 on some setups) live
// in /opt/homebrew/bin or /usr/local/bin and become invisible to
// spawn/execFile calls. Prepend the common locations so native
// subprocess invocations just work.
if (process.platform === 'darwin') {
  const extras = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',  // Apple Silicon homebrew
    '/usr/local/bin', '/usr/local/sbin',         // Intel / older homebrew
  ]
  const current = (process.env.PATH || '').split(':').filter(Boolean)
  const seen = new Set(current)
  const merged = [...current]
  for (const p of extras) {
    if (!seen.has(p)) {
      merged.unshift(p)
      seen.add(p)
    }
  }
  process.env.PATH = merged.join(':')
}

// Load .env from multiple possible locations.
//
// Order matters — dotenv uses `override: false`, so the FIRST path that
// defines a variable wins. userData goes first so a user's personal
// overrides (like a custom ELEVENLABS_VOICE_ID) aren't silently replaced
// by whatever default .env happens to be bundled into the .app.
const envPaths = [
  join(app.getPath('userData'), '.env'),             // user overrides (highest priority)
  join(__dirname, '../../.env'),                    // dev mode
  join(app.getAppPath(), '.env'),                   // packaged root
  join(app.isPackaged ? process.resourcesPath : app.getAppPath(), '.env'), // bundled defaults
]
for (const p of envPaths) {
  config({ path: p, override: false })
}

// Fallback: read API keys directly from userData .env if dotenv missed them
if (!process.env.ANTHROPIC_API_KEY || !process.env.DISCOGS_API_TOKEN || !process.env.ELEVENLABS_API_KEY || !process.env.EXA_API_KEY) {
  try {
    const fs = require('fs')
    const envFile = fs.readFileSync(join(app.getPath('userData'), '.env'), 'utf8')
    // 4.5: EXA_API_KEY added. Powers the artist-facts augmentation in
    // searchWeb — Exa returns richer/more-current music journalism than
    // Wikipedia + MusicBrainz alone, giving Music Man / Megan / Stephen
    // sharper context to draw from. Optional — searchWeb skips Exa
    // silently if the key is missing.
    for (const key of ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'DISCOGS_API_TOKEN', 'EXA_API_KEY']) {
      if (!process.env[key]) {
        const match = envFile.match(new RegExp(`${key}=(.+)`))
        if (match) process.env[key] = match[1].trim()
      }
    }
  } catch { /* no .env file */ }
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })

// ── Claude API rate-limit, cost ceiling, and graceful-fallback layer (4.0 §2.3) ──
//
// All anthropic.messages.create calls go through claudeCall(). It:
//   1. Bumps in-memory session counter and persisted day counter.
//   2. Resets the day counter when the local date rolls over.
//   3. Aborts (no API call) when callsToday >= dailyCeiling.
//   4. On API success, caches the response keyed by callKey for fallback use.
//   5. On API failure OR ceiling-hit, returns the cached fallback if available;
//      else throws so the caller can construct its own error response.
//
// User-tunable: edit `claude-stats.json` in userData and restart. Default
// ceiling of 200/day = roughly 10x typical session usage based on the §2.3
// audit (10–20 calls/active session).
//
// Fallback responses are stored as the raw MessageReply object — callers parse
// them identically to a fresh response, so swapping a stale cache for a new
// reply is transparent at the call site.

// Use the non-streaming-only types so response.content / response.stop_reason
// are accessible at call sites. anthropic.messages.create() is overloaded —
// using Awaited<ReturnType<...>> collapses to (Message | Stream) which
// loses the Message-specific properties.
type ClaudeMessageReply = Anthropic.Messages.Message
type ClaudeMessageParams = Anthropic.Messages.MessageCreateParamsNonStreaming

interface ClaudeStats {
  dailyCeiling: number
  lastResetDate: string  // YYYY-MM-DD local
  callsToday: number
  lastResponses: Record<string, { reply: ClaudeMessageReply; ts: number }>
}

const CLAUDE_STATS_DEFAULT: ClaudeStats = {
  dailyCeiling: 200,
  lastResetDate: '',
  callsToday: 0,
  lastResponses: {},
}

function claudeStatsPath(): string {
  return join(app.getPath('userData'), 'claude-stats.json')
}

function todayLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

let claudeStats: ClaudeStats = { ...CLAUDE_STATS_DEFAULT }
let claudeStatsLoaded = false
let sessionCallCount = 0

async function loadClaudeStats(): Promise<void> {
  if (claudeStatsLoaded) return
  try {
    const raw = await readFile(claudeStatsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClaudeStats>
    claudeStats = {
      dailyCeiling: typeof parsed.dailyCeiling === 'number' ? parsed.dailyCeiling : CLAUDE_STATS_DEFAULT.dailyCeiling,
      lastResetDate: typeof parsed.lastResetDate === 'string' ? parsed.lastResetDate : '',
      callsToday: typeof parsed.callsToday === 'number' ? parsed.callsToday : 0,
      lastResponses: (parsed.lastResponses && typeof parsed.lastResponses === 'object') ? parsed.lastResponses : {},
    }
  } catch {
    claudeStats = { ...CLAUDE_STATS_DEFAULT }
  }
  claudeStatsLoaded = true
}

async function saveClaudeStats(): Promise<void> {
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(claudeStatsPath(), JSON.stringify(claudeStats, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[claude] failed to persist stats:', err)
  }
}

function rolloverIfNewDay(): void {
  const today = todayLocal()
  if (claudeStats.lastResetDate !== today) {
    claudeStats.lastResetDate = today
    claudeStats.callsToday = 0
  }
}

async function claudeCall(
  callKey: string,
  params: ClaudeMessageParams
): Promise<ClaudeMessageReply> {
  await loadClaudeStats()
  rolloverIfNewDay()

  if (claudeStats.callsToday >= claudeStats.dailyCeiling) {
    const cached = claudeStats.lastResponses[callKey]?.reply
    console.warn(`[claude] daily ceiling ${claudeStats.dailyCeiling} reached for "${callKey}" — ${cached ? 'returning cached fallback' : 'no cache available'}`)
    if (cached) return cached
    throw new Error(`Claude daily ceiling reached (${claudeStats.dailyCeiling}). No cached fallback for "${callKey}".`)
  }

  sessionCallCount++
  claudeStats.callsToday++
  console.log(`[claude] ${callKey} — session=${sessionCallCount} today=${claudeStats.callsToday}/${claudeStats.dailyCeiling}`)

  try {
    const reply = await anthropic.messages.create(params)
    claudeStats.lastResponses[callKey] = { reply, ts: Date.now() }
    void saveClaudeStats()
    return reply
  } catch (err) {
    void saveClaudeStats()
    const cached = claudeStats.lastResponses[callKey]?.reply
    if (cached) {
      console.warn(`[claude] "${callKey}" API error, returning cached fallback:`, err instanceof Error ? err.message : err)
      return cached
    }
    throw err
  }
}

// ── Audio analysis queue (4.0 §2.4a) ──
//
// Per-track BPM, musical key, mode, and Camelot wheel position. Computed
// by core/audio_analysis.py (aubio + librosa) one-shot per track and
// persisted via metadata-overrides.json. This is the data source for
// future DJ-grade transitions (Music Man v2), harmonically-compatible
// playlists, and BPM-bounded smart playlists.
//
// Background-only — never blocks an import or any user-visible action.
// Failures are recorded with an audioAnalysisAt sentinel so we don't
// retry every session; consumers can choose to ignore stale results.
//
// Worker is single-threaded by design: librosa pulls in numpy/scipy
// which can pin all cores via BLAS. One track at a time = predictable
// load on the user's machine.

interface AudioAnalysisResult {
  ok: boolean
  bpm?: number
  keyRoot?: string
  keyMode?: 'major' | 'minor' | ''
  camelotKey?: string
  /** 0..1 — how much the three Essentia key profiles agreed, scaled by their
   *  strength. They are unanimous on only ~58% of this library, so a key
   *  without this number is an assertion the data does not support. */
  keyConfidence?: number
  error?: string
}

interface AudioAnalysisJob {
  trackId: number
  path: string         // absolute filesystem path (already resolved from iPod colon-format)
  fingerprint: string  // metadata fingerprint used by the override v2 entry format
}

const audioAnalysisQueue: AudioAnalysisJob[] = []
let audioAnalysisRunning = false

// Brief 010 Phase 2: queue persistence. Survives app restart so a
// 6000+ track backfill doesn't lose progress when the user quits.
// Atomic write (tmp + rename) on every queue mutation; the in-memory
// queue is canonical, disk is a recovery backstop.
const audioAnalysisQueuePath = (): string =>
  join(app.getPath('userData'), 'audio-analysis-queue.json')

async function persistQueue(): Promise<void> {
  try {
    const path = audioAnalysisQueuePath()
    await mkdir(app.getPath('userData'), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(audioAnalysisQueue, null, 2), 'utf-8')
    const { rename } = await import('fs/promises')
    await rename(tmp, path)
  } catch (err) {
    console.warn('[audio-analysis] queue persist failed:', err instanceof Error ? err.message : err)
  }
}

async function loadQueueFromDisk(): Promise<void> {
  try {
    const data = await readFile(audioAnalysisQueuePath(), 'utf-8')
    const parsed = JSON.parse(data)
    if (Array.isArray(parsed)) {
      audioAnalysisQueue.length = 0
      for (const j of parsed) {
        if (j && typeof j.trackId === 'number' && typeof j.path === 'string' && typeof j.fingerprint === 'string') {
          audioAnalysisQueue.push(j as AudioAnalysisJob)
        }
      }
      if (audioAnalysisQueue.length > 0) {
        console.log(`[audio-analysis] restored ${audioAnalysisQueue.length} queued jobs from disk`)
      }
    }
  } catch (err) {
    // File may not exist (first run) or be corrupt — start empty.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[audio-analysis] queue load failed:', err instanceof Error ? err.message : err)
    }
  }
}

// Renderer pings this when isPlaying changes so background workers
// (audio analysis, ALAC prewarm) can yield while playback is live.
// Files live on the iPod (USB-mounted), so a librosa scan or ffmpeg
// transcode reading from /Volumes/JakeTunes saturates the same USB
// bus that's feeding the audio decoder — buffer underruns surface as
// a "broken record" stutter on output. Defer everything heavy until
// playback stops.
let playbackActive = false
// 4.2.13: powerSaveBlocker to defeat macOS App Nap during playback.
// HTMLAudio buffers ~30 seconds ahead via Range requests against our
// `ipod-audio://` protocol handler. Once that initial buffer is filled
// the main process goes idle from the OS's perspective — no
// foreground UI activity, no recent user input, no perceived "work."
// macOS App Nap kicks in around 30 seconds of detected idleness and
// throttles the napped process's CPU dramatically. When HTMLAudio
// later asks for the next chunk of bytes, the main process is too
// slow / unresponsive to serve them in time and audio dies mid-track.
// `prevent-app-suspension` keeps the app marked as "doing meaningful
// work" so App Nap can't grab it. Started on first play, stopped only
// when the renderer reports playbackActive=false for a sustained
// stretch (so brief track-change false flips don't drop the blocker).
let powerSaveBlockerId: number | null = null
let powerSaveStopTimer: ReturnType<typeof setTimeout> | null = null
function startPowerSaveBlocker() {
  if (powerSaveStopTimer) {
    clearTimeout(powerSaveStopTimer)
    powerSaveStopTimer = null
  }
  if (powerSaveBlockerId !== null) return
  try {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    console.log('[powerSave] blocker started id=', powerSaveBlockerId)
  } catch (err) {
    console.warn('[powerSave] start failed:', err)
  }
}
function stopPowerSaveBlocker() {
  if (powerSaveBlockerId === null) return
  try {
    powerSaveBlocker.stop(powerSaveBlockerId)
    console.log('[powerSave] blocker stopped id=', powerSaveBlockerId)
  } catch (err) {
    console.warn('[powerSave] stop failed:', err)
  }
  powerSaveBlockerId = null
}
// ── app-lifetime suspension blocker, released only when truly idle ────────
// Its own id, separate from the playback blocker above: the two have different
// lifetimes, and sharing a counter would let whichever stopped first silently
// release the other.
let lifetimeBlockerId: number | null = null
// Set once the main window has actually been created. Guards the release below
// against startup: BrowserWindow count dips to zero transiently while the app
// is still coming up, and 'window-all-closed' fires on that dip.
let mainWindowEverCreated = false
function startLifetimeSuspensionBlocker(): void {
  if (lifetimeBlockerId !== null) return
  try {
    lifetimeBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    console.log('[powerSave] lifetime suspension blocker started id=', lifetimeBlockerId)
  } catch (err) {
    console.warn('[powerSave] lifetime blocker failed:', err)
  }
}
function stopLifetimeSuspensionBlocker(): void {
  if (lifetimeBlockerId === null) return
  try {
    powerSaveBlocker.stop(lifetimeBlockerId)
    console.log('[powerSave] lifetime suspension blocker stopped id=', lifetimeBlockerId)
  } catch (err) {
    console.warn('[powerSave] lifetime stop failed:', err)
  }
  lifetimeBlockerId = null
}

ipcMain.on('set-playback-active', (_e, active: boolean) => {
  playbackActive = !!active
  if (active) {
    startPowerSaveBlocker()
  } else {
    // Don't drop the blocker on transient false flips (track changes
    // briefly toggle isPlaying off). Wait 10s of sustained inactivity.
    if (powerSaveStopTimer) clearTimeout(powerSaveStopTimer)
    powerSaveStopTimer = setTimeout(() => {
      if (!playbackActive) stopPowerSaveBlocker()
    }, 10000)
  }
})

function getAudioAnalysisScriptPath(): string {
  return join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/audio_analysis.py')
}

function runAudioAnalysisScript(absPath: string): Promise<AudioAnalysisResult> {
  return new Promise((resolve) => {
    const scriptPath = getAudioAnalysisScriptPath()
    // Explicit stdio: never inherit the parent's stdin (we don't write
    // to the python process; closing its stdin frees us from having to
    // think about backpressure). stdout + stderr are piped to in-memory
    // buffers we read after close — never piped to anything that
    // requires the Electron main thread to drain, so an event-loop
    // stall in main can't backpressure librosa.
    const py = spawn(PYTHON_CMD ?? 'python3', [scriptPath, absPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    // Brief 010 Phase 1: 90s hard timeout. librosa shouldn't exceed
    // ~60s on any reasonable file; 90s leaves headroom for slow disk
    // reads (iPod-USB) but bounds runaways so one hung file can't
    // jam the queue indefinitely. SIGKILL because a hung librosa is
    // already lost — graceful shutdown is not a thing for analysis.
    const timeoutMs = 90_000
    const killTimer = setTimeout(() => {
      killed = true
      try { py.kill('SIGKILL') } catch { /* already exited */ }
    }, timeoutMs)
    py.stdout.on('data', (chunk) => { stdout += String(chunk) })
    py.stderr.on('data', (chunk) => { stderr += String(chunk) })
    py.on('error', (err) => {
      clearTimeout(killTimer)
      resolve({ ok: false, error: `spawn failed: ${err.message}` })
    })
    py.on('close', () => {
      clearTimeout(killTimer)
      if (killed) {
        resolve({ ok: false, error: `analysis timed out after ${timeoutMs / 1000}s` })
        return
      }
      const trimmed = stdout.trim()
      if (!trimmed) {
        resolve({ ok: false, error: safeIpcError(stderr.trim().split('\n').pop() || 'no output from audio_analysis.py', 'tool-failed') })
        return
      }
      try {
        resolve(JSON.parse(trimmed) as AudioAnalysisResult)
      } catch (parseErr) {
        resolve({ ok: false, error: `JSON parse failed: ${parseErr instanceof Error ? parseErr.message : parseErr}` })
      }
    })
  })
}

// 4.5: batch variant — analyze MANY paths in ONE python process. librosa's
// numba-JIT + scipy warmup (~1.7s) is paid once per PROCESS, so a fresh
// process per track (runAudioAnalysisScript) wasted that ~1.7s on EVERY track.
// Passing N paths amortizes it: ~0.56s/track in a 12-batch vs 2.95s solo (~5x,
// validated 2026-06-26). core/audio_analysis.py emits one JSON line per path
// (JSONL, flushed per track), so we map results back by path and a mid-batch
// timeout still keeps the tracks finished before the kill.
function runAudioAnalysisBatch(paths: string[]): Promise<Map<string, AudioAnalysisResult>> {
  return new Promise((resolve) => {
    const out = new Map<string, AudioAnalysisResult>()
    if (paths.length === 0) { resolve(out); return }
    const scriptPath = getAudioAnalysisScriptPath()
    const py = spawn(PYTHON_CMD ?? 'python3', [scriptPath, ...paths], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    // Scale the ceiling with batch size: ~1.7s warmup + generous 20s/track of
    // headroom for slow iPod-USB reads. Bounds a runaway without jamming the queue.
    const timeoutMs = 30_000 + paths.length * 20_000
    const killTimer = setTimeout(() => { killed = true; try { py.kill('SIGKILL') } catch { /* already exited */ } }, timeoutMs)
    py.stdout.on('data', (chunk) => { stdout += String(chunk) })
    py.stderr.on('data', (chunk) => { stderr += String(chunk) })
    py.on('error', (err) => {
      clearTimeout(killTimer)
      console.warn(`[audio-analysis] batch spawn failed: ${err.message}`)
      resolve(out)  // empty → each job is treated as a miss by the caller
    })
    py.on('close', () => {
      clearTimeout(killTimer)
      for (const line of stdout.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const r = JSON.parse(t) as AudioAnalysisResult & { path?: string }
          if (r.path) out.set(r.path, r)
        } catch { /* skip a torn/partial line */ }
      }
      if (killed) console.warn(`[audio-analysis] batch timed out after ${timeoutMs / 1000}s (${out.size}/${paths.length} done before kill)`)
      else if (out.size < paths.length && stderr.trim()) console.warn(`[audio-analysis] batch stderr: ${stderr.trim().split('\n').pop()}`)
      resolve(out)
    })
  })
}

// 4.1.1: Serialized read-modify-write through a single Promise chain.
// Without this, the analysis worker writing a BPM and a record-play IPC
// firing at the same time (which happens whenever the user is listening
// to music while analysis runs) BOTH:
//   • opened the same overridesPath+'.tmp' file simultaneously, writing
//     interleaved bytes → corrupt tmp → atomic rename publishes corrupt
//     overrides → JSON.parse fails → JakeTunes treats overrides as
//     empty → the user's hours of bpm data look "reset"
//   • read overridesPath at the same time → both compute their next
//     state from the same input → whichever writes second clobbers the
//     other's change → silent data loss
// Fix: chain every write off the previous one. Only one read-modify-
// write operation is in flight at a time. Serial throughput is fine
// (each op is sub-millisecond on local SSD) — well under the rate at
// which the worker + ipc handlers can produce updates.
// 4.5.0-106 Phase 2.5: now thin wrapper over the overridesCache. Pre-fix
// every call re-read metadata-overrides.json from NAS (50-500ms SMB hit),
// mutated, then re-wrote — the IPC handler that awaited this blocked the
// renderer AND occasionally hitched the audio thread. The cache makes the
// read free, the synchronous mutate finishes in microseconds, and the
// NAS flush runs in the background. Order across rapid writes is still
// preserved by the per-file write chain inside the cache.
function writeOverridesSerialized(mutate: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  return overridesCache.update((current) => {
    const safe = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {}
    return mutate(safe) || safe
  })
}

// Write multiple override fields in a single file write. Used by the
// analysis worker. Goes through writeOverridesSerialized so it can't
// race with save-metadata-override or another concurrent analysis job.
async function persistOverrideFields(
  trackId: number,
  fields: Record<string, string>,
  fingerprint: string,
): Promise<void> {
  await writeOverridesSerialized((overrides) => {
    const key = String(trackId)
    const existing = overrides[key] as { fp?: string; fields?: Record<string, string> } | undefined
    const isV2 = existing && typeof existing === 'object' && 'fields' in existing
    if (isV2 && existing!.fp && existing!.fp === fingerprint) {
      overrides[key] = { fp: existing!.fp, fields: { ...(existing!.fields || {}), ...fields } }
    } else {
      overrides[key] = { fp: fingerprint || '', fields: { ...fields } }
    }
    return overrides
  })
}

// Brief 014a: per-track payload propagated up to the worker so the
// audio-analysis:progress event can carry full result data to the
// renderer. null means "skipped" (no librosa) — caller emits only
// `remaining` in that case.
interface AudioAnalysisDispatch {
  trackId: number
  audioAnalysisAt: number
  bpm: number | null
  keyRoot: string | null
  keyMode: 'major' | 'minor' | '' | null
  camelotKey: string | null
  keyConfidence: number | null
  ok: boolean
}

// Turn one analysis result into persisted override fields + a renderer
// dispatch. Split out of the (now batched) runner so the run and the result-
// handling are independent — the batch path reuses this verbatim per track.
async function processAudioResult(job: AudioAnalysisJob, result: AudioAnalysisResult): Promise<AudioAnalysisDispatch> {
  const audioAnalysisAt = Date.now()
  const fields: Record<string, string> = {
    audioAnalysisAt: String(audioAnalysisAt),
  }
  if (result.ok) {
    if (typeof result.bpm === 'number' && result.bpm > 0) fields.bpm = String(result.bpm)
    if (result.keyRoot) fields.keyRoot = result.keyRoot
    if (result.keyMode) fields.keyMode = result.keyMode
    if (result.camelotKey) fields.camelotKey = result.camelotKey
    if (typeof result.keyConfidence === 'number') fields.keyConfidence = String(result.keyConfidence)
    console.log(`[audio-analysis] ${job.trackId}: bpm=${result.bpm ?? '—'} key=${result.keyRoot || '—'}${result.keyMode ? ' ' + result.keyMode : ''} camelot=${result.camelotKey || '—'}`)
  } else {
    console.warn(`[audio-analysis] ${job.trackId} failed: ${result.error || 'unknown error'}`)
  }
  try {
    await persistOverrideFields(job.trackId, fields, job.fingerprint)
  } catch (err) {
    console.warn(`[audio-analysis] persist failed for ${job.trackId}:`, err instanceof Error ? err.message : err)
  }
  return {
    trackId: job.trackId,
    audioAnalysisAt,
    bpm: result.ok && typeof result.bpm === 'number' && result.bpm > 0 ? result.bpm : null,
    keyConfidence: result.ok && typeof result.keyConfidence === 'number' ? result.keyConfidence : null,
    keyRoot: result.ok ? (result.keyRoot ?? null) : null,
    keyMode: result.ok ? (result.keyMode ?? null) : null,
    camelotKey: result.ok ? (result.camelotKey ?? null) : null,
    ok: result.ok,
  }
}

// 4.5: analyze a whole batch in ONE python process (amortizes librosa warmup).
// Brief 010b null-guard preserved — skip entirely when no librosa Python was
// found, so the tracks stay unanalyzed for a later backfill rather than being
// falsely sentinel-marked. Returns one dispatch (or null when skipped) per job,
// aligned to the input order.
async function processAudioAnalysisBatch(jobs: AudioAnalysisJob[]): Promise<(AudioAnalysisDispatch | null)[]> {
  if (!PYTHON_CMD) {
    for (const j of jobs) console.warn(`[audio-analysis] ${j.trackId} skipped — no Python with librosa available (see [python] log on startup)`)
    return jobs.map(() => null)
  }
  const results = await runAudioAnalysisBatch(jobs.map((j) => j.path))
  const out: (AudioAnalysisDispatch | null)[] = []
  for (const job of jobs) {
    const result = results.get(job.path) ?? { ok: false, error: 'no result line from audio_analysis.py (batch)' }
    out.push(await processAudioResult(job, result))
  }
  return out
}

async function audioAnalysisWorker(): Promise<void> {
  if (audioAnalysisRunning) return
  audioAnalysisRunning = true
  try {
    while (audioAnalysisQueue.length > 0) {
      // Yield to playback with a 5-second debounce. The brief false flip
      // when `handleRadioToggle` calls stopPlayback() during opener
      // generation, OR the track-change transition window, would
      // otherwise un-pause the worker → librosa runs concurrently with
      // music playback → audio decoder starves → music stops mid-track.
      // (User reproduced this stopping at ~29s into two different songs;
      // ~29s lined up with the tail of a librosa job that started during
      // the brief gate-open.) The debounce requires 5 continuous seconds
      // of playbackActive=false before pulling a new job. Real "user
      // stopped listening" cases easily clear the bar; transient flips
      // don't.
      let inactiveSince = 0
      while (true) {
        if (playbackActive) {
          inactiveSince = 0
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        if (inactiveSince === 0) inactiveSince = Date.now()
        if (Date.now() - inactiveSince < 5000) {
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
        break
      }
      // 4.5: pull a BATCH and analyze it in ONE python process. librosa's
      // ~1.7s numba/scipy warmup was paid per track when each was its own
      // process; batching amortizes it to ~0.56s/track (~5x). The playback
      // debounce above still gates the START of each batch (5s of silence),
      // so a batch of 12 is a ~7s uninterrupted run only after the user stops.
      const AUDIO_BATCH = 12
      const batch = audioAnalysisQueue.splice(0, AUDIO_BATCH)
      let dispatches: (AudioAnalysisDispatch | null)[] = []
      try {
        dispatches = await processAudioAnalysisBatch(batch)
      } catch (err) {
        console.warn(`[audio-analysis] batch error (${batch.length} tracks):`, err instanceof Error ? err.message : err)
      }
      // Brief 010: persist after the batch so a restart doesn't re-run
      // completed jobs (each result already wrote its audioAnalysisAt
      // sentinel via persistOverrideFields); this trims the queue file to match.
      void persistQueue()
      // Brief 010 Phase 3 + Brief 014a: notify the renderer per track so the
      // MusicManView backfill counter + libState.tracks analysis fields update.
      // `remaining` counts down across the batch so the UI ticks smoothly; a
      // null dispatch (skipped — no librosa) still advances the counter.
      dispatches.forEach((dispatch, idx) => {
        sendToRenderer('audio-analysis:progress', {
          remaining: audioAnalysisQueue.length + (dispatches.length - 1 - idx),
          ...(dispatch ? {
            trackId: dispatch.trackId,
            audioAnalysisAt: dispatch.audioAnalysisAt,
            bpm: dispatch.bpm,
            keyRoot: dispatch.keyRoot,
            keyMode: dispatch.keyMode,
            camelotKey: dispatch.camelotKey,
            keyConfidence: dispatch.keyConfidence,
            ok: dispatch.ok,
          } : {}),
        })
      })
      // Push measured BPM/key into the brain NOW — don't wait for nightly
      // teb catch-up. Import auto-index often embeds before analysis finishes,
      // so without this the vectors lack tempo until the next trainer run.
      const analyzed = dispatches.filter((d): d is AudioAnalysisDispatch => !!d && d.ok && typeof d.bpm === 'number' && d.bpm > 0)
      if (analyzed.length) void reembedTracksAfterAnalysis(analyzed)
    }
  } finally {
    audioAnalysisRunning = false
  }
}

/**
 * Enqueue BPM/key analysis for a freshly-imported track — the one call every
 * import road must make (Jake, 2026-08-05: "analyzing key and bpm should
 * happen right after the song is imported automatically, i should not have to
 * press a button").
 *
 * It existed on the drag-drop road only; CD rips and store downloads — the
 * road Jake actually uses — skipped it, so every downloaded song sat
 * unanalyzed until the Music Man backfill button was pressed. One helper, all
 * roads, no drift.
 */
function enqueueAnalysisForImportedTrack(t: Record<string, unknown>): void {
  const colon = String(t.path || '')
  const trackId = Number(t.id) || 0
  if (!colon || trackId <= 0) return
  const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  const pathSep = IS_WINDOWS ? '\\' : '/'
  const abs = join(LOCAL_MOUNT, colon.replace(/:/g, pathSep))
  const title = String(t.title || '').toLowerCase().trim()
  const artist = String(t.artist || '').toLowerCase().trim()
  const duration = Number(t.duration) || 0
  enqueueAudioAnalysis({ trackId, path: abs, fingerprint: `${title}|${artist}|${duration}` })
}

function enqueueAudioAnalysis(job: AudioAnalysisJob, opts?: { batch?: boolean }): void {
  // Brief 010: re-enabled with subprocess hardening (Phase 1) and
  // queue persistence (Phase 2). The 4.2.12 disable predated proper
  // isolation — librosa now runs in its own subprocess via spawn()
  // with explicit stdio + a 90s timeout, and audioAnalysisWorker's
  // 5-second playback debounce prevents starting a new job inside
  // a brief gate-open window. De-dupe by trackId so re-queueing on
  // app restart (or a backfill click on an already-queued track) is
  // a no-op.
  //
  // `batch` (2026-08-02): the caller owns dedupe, persist and kick for the
  // whole set. Without it, enqueuing a full-library backfill SIGABRTs the app:
  // per-job persist meant 8,812 concurrent atomic writes, each stringifying
  // the entire growing queue (~1 MB by the midpoint) — thousands of live file
  // descriptors and multi-GB of allocation in one tick. The per-job `.some()`
  // scan is quadratic at that size too. This is not hypothetical: the
  // MusicMan backfill button takes exactly this path, and its own comment
  // promises "a 6000+ track backfill" — it has simply never been handed one,
  // because the library was already analyzed.
  if (!opts?.batch && audioAnalysisQueue.some(j => j.trackId === job.trackId)) return
  audioAnalysisQueue.push(job)
  if (opts?.batch) return
  void persistQueue()
  kickAudioAnalysisWorker()
}

// Brief 010: kicker is a thin wrapper — the worker itself guards
// re-entry via audioAnalysisRunning, so kicker just fires void without
// any extra checks. Same shape every callsite uses.
function kickAudioAnalysisWorker(): void {
  void audioAnalysisWorker()
}

let mainWindow: BrowserWindow | null = null

// Renderer sends must survive window teardown — `?.` guards null but a
// destroyed window still throws ("Object has been destroyed", seen ×2 in
// the flight recorder from mid-sync progress events).
const sendToRenderer = (channel: string, ...args: unknown[]): void => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

// AI host preference — written by settings IPC, read by prompt builders.
// Declared above registerSettingsIpc so the setter closure is valid.
let cachedActiveHost: 'mm' | 'megan' = 'mm'

// IPC registration helper — defaults to refuseIfNotMainWindow. Domain
// modules (ipc/*.ts) register through this; opt out with { public: true }
// only for intentionally public / read-only channels.
const ipc = createIpcRegistrar(() => mainWindow)
registerUiStateIpc(ipc)
// Spotify connect + weekly Discover Weekly → brain-gated onto the list
// ("get Discover Weekly into the brain", greenlit 2026-07-14).
registerSpotifyIpc(ipc, {
  authFile: join(STATE_DIR, 'spotify-auth.json'),
  tasteFile: join(STATE_DIR, 'spotify-taste.json'),
  curatorsFile: join(STATE_DIR, 'spotify-curators.json'),
  curatorPoolFile: join(STATE_DIR, 'spotify-curator-pool.json'),
  openExternal: (url) => { void shell.openExternal(url) },
})
registerBackupIpc(ipc, { getMainWindow: () => mainWindow })
registerSettingsIpc(ipc, {
  setCachedActiveHost: (host) => { cachedActiveHost = host },
})
registerImportIpc(ipc)
registerLibraryIpc(ipc, {
  getLibraryTracks: async () => {
    const lib = (await libraryCache.get()) as { tracks?: TrackLike[] }
    return Array.isArray(lib.tracks) ? lib.tracks : []
  },
  claudeCall,
  getPlaylists: () => playlistsCache.get(),
  setPlaylists: (playlists) => { playlistsCache.set(playlists) },
  isSaveLocked,
  triggerSync,
  scanLibraryOrphans: () => scanLibraryOrphans(),
  purgeLibraryOrphans: () => purgeLibraryOrphans(),
})
registerIpodIpc(ipc, {
  getMount: () => ({ mount: detectedIpodMount, volume: detectedIpodVolume, missStreak: ipodMissStreak }),
  setMount: (next) => {
    if ('mount' in next) detectedIpodMount = next.mount ?? null
    if ('volume' in next) detectedIpodVolume = next.volume ?? null
    if ('missStreak' in next && typeof next.missStreak === 'number') ipodMissStreak = next.missStreak
  },
  runPythonRestore: (args, stdinData) => runPythonRestore(args, stdinData),
  isSyncInFlight: () => syncEngine.isSyncInFlight(),
  onMountDetected: (mount) => {
    void ingestIpodRoundTrip(mount, {
      stateDir: STATE_DIR,
      getLibraryTracks: async () =>
        (((await libraryCache.get()) as { tracks?: Array<{ id: number; playCount?: number; lastPlayedAt?: number }> }).tracks) || [],
      appendPlayEvents: async (trackId, count, tsMs) => {
        for (let i = 0; i < count; i++) await appendPlayEvent(trackId, tsMs)
      },
      sendToRenderer,
      isSyncInFlight: () => syncEngine.isSyncInFlight(),
    })
  },
})
registerSyncIpc(ipc, {
  requestSyncCancel: () => syncEngine.requestSyncCancel(),
  syncToIpod: (tracks, playlists, convertOptions, syncOpts) =>
    handleSyncToIpod(tracks, playlists, convertOptions, syncOpts),
  syncIpodFromDevice: (existingIds) => handleSyncIpodFromDevice(existingIds),
  readIpodDatabase: () => readIpodDatabase(),
  getStateConflicts: () => stateConflicts,
  reconcileStateConflicts: (event) => handleReconcileStateConflicts(event),
  getIpodMount: () => detectedIpodMount,
  getLocalLibraryRoot: () => MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, ''),
  getPathSep: () => (IS_WINDOWS ? '\\' : '/'),
  getCodecHint: (absPath) => codecByAbsPath.get(absPath) || '',
})
registerAiIpc(ipc, {
  setClaudeDailyCeiling: async (ceiling) => {
    await loadClaudeStats()
    const safe = Math.max(1, Math.min(2000, Number(ceiling) || 200))
    claudeStats.dailyCeiling = safe
    await saveClaudeStats()
    return { ok: true, dailyCeiling: safe }
  },
  getClaudeStats: async () => {
    await loadClaudeStats()
    rolloverIfNewDay()
    return {
      ok: true,
      sessionCallCount,
      callsToday: claudeStats.callsToday,
      dailyCeiling: claudeStats.dailyCeiling,
      lastResetDate: claudeStats.lastResetDate,
      cachedKeys: Object.keys(claudeStats.lastResponses),
    }
  },
  revertCynthiaLedgerEntry: async (id) => {
    const hooks = buildCynthiaSweepHooks()
    const albums = cynthiaGetAlbumsSnapshot()
    const byId = new Map<number, CynthiaScanTrack>()
    for (const { tracks } of albums.values()) for (const t of tracks) byId.set(t.id, t)
    return revertLedgerEntry(id, hooks.applyOverride, (trackId) => byId.get(trackId))
  },
  readAppSettings: () => readAppSettingsAsync(),
  readActiveHost: () => readActiveHostSync(),
  getMainWindow: () => mainWindow,
  claudeCall,
  searchWebCached,
})
const cynthiaIpcHost: CynthiaIpcHost = {
  claudeCall,
  fetchMbRelease: (artist, album) => musicBrainzAlbumLookup(artist, album),
  readEmbeddedTags: (trackIds) => readEmbeddedTagsForCynthia(trackIds),
}
registerCynthiaIpc(ipc, cynthiaIpcHost)

// 4.4.85: codec hint for the ipod-audio:// protocol handler so it can
// skip the ~200-500 ms ffprobe call on every first-play. Populated from
// library.json at app startup (loadCodecMapFromLibrary) and updated
// inline by importOneFile on each new import. Keyed by absolute path —
// the same form the protocol handler decodes the URL into. Missing
// entry => legacy track (pre-4.4.85), handler falls through to ffprobe.
const codecByAbsPath = new Map<string, string>()

function sendMenuAction(action: string) {
  sendToRenderer('menu-action', action)
}

// Hardware media keys (keyboard play/pause/next/prev). Menu F7/F8/F9
// accelerators only fire for function-key layouts; dedicated media keys
// need globalShortcut + before-input-event. Debounce so a key that
// registers in both paths doesn't double-skip or double-toggle.
let lastMediaKeyAt = 0
let lastMediaKeyAction = ''

function sendMediaKeyAction(action: string): void {
  const now = Date.now()
  if (action === lastMediaKeyAction && now - lastMediaKeyAt < 250) return
  lastMediaKeyAction = action
  lastMediaKeyAt = now
  // Flight-recorder sensor (2026-08-22): the one unproven link in the
  // media-key chain is macOS delivering the hardware key to globalShortcut
  // (synthetic NX posts can bypass the media-remote daemon, so they can't
  // test it). A physical press now leaves proof; menu/registration/renderer
  // legs are already verified working.
  flightRecorder.record('info', 'media-key', { action })
  sendMenuAction(action)
}

const MEDIA_KEY_ACCELERATORS = ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack'] as const
const MEDIA_KEY_ACTIONS: Record<(typeof MEDIA_KEY_ACCELERATORS)[number], string> = {
  MediaPlayPause: 'play-pause',
  MediaNextTrack: 'next-track',
  MediaPreviousTrack: 'prev-track',
}

function registerMediaKeyShortcuts(): void {
  // Flight-recorder catch #1 (2026-08-21): these three warns fired on every
  // boot since forever. Root cause on macOS: capturing hardware media keys
  // via globalShortcut requires the app to be a TRUSTED ACCESSIBILITY
  // client; untrusted, register() can only return false. Say the real
  // cause once, with the remedy, instead of three blind warns — and keep
  // per-key warns only for the trusted-but-conflicting case (another app
  // owns the keys). Focused-window media keys work regardless via the
  // before-input-event path (mediaKeyActionFromInput below).
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
    console.warn('[media-keys] global media keys inactive: JakeTunes is not a trusted Accessibility client. Enable in System Settings → Privacy & Security → Accessibility to control playback while unfocused; focused-window keys work regardless.')
    return
  }
  for (const accel of MEDIA_KEY_ACCELERATORS) {
    try {
      const ok = globalShortcut.register(accel, () => sendMediaKeyAction(MEDIA_KEY_ACTIONS[accel]))
      if (!ok) console.warn(`[media-keys] could not register global ${accel} — another app likely owns it`)
    } catch (err) {
      console.warn(`[media-keys] register ${accel} threw:`, err)
    }
  }
}

function unregisterMediaKeyShortcuts(): void {
  for (const accel of MEDIA_KEY_ACCELERATORS) {
    try { globalShortcut.unregister(accel) } catch { /* ignore */ }
  }
}

function mediaKeyActionFromInput(input: Electron.Input): string | null {
  if (input.type !== 'keyDown') return null
  const k = input.key
  const c = input.code
  if (k === 'MediaPlayPause' || c === 'MediaPlayPause') return 'play-pause'
  if (k === 'MediaTrackNext' || c === 'MediaTrackNext' || k === 'MediaNextTrack' || c === 'MediaNextTrack') return 'next-track'
  if (k === 'MediaTrackPrevious' || c === 'MediaTrackPrevious' || k === 'MediaPreviousTrack' || c === 'MediaPreviousTrack') return 'prev-track'
  return null
}

// ── Window state persistence ──
interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized?: boolean
}

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

async function loadWindowState(): Promise<WindowState | null> {
  try {
    const data = await readFile(windowStatePath(), 'utf-8')
    return JSON.parse(data) as WindowState
  } catch {
    return null
  }
}

async function saveWindowState(win: BrowserWindow): Promise<void> {
  const bounds = win.getBounds()
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  }
  await writeFile(windowStatePath(), JSON.stringify(state), 'utf-8')
}

// ── UI state + backup + app-settings + domain IPC ─────────────────────
// Registered via createIpcRegistrar (default-deny). Domain modules:
//   ipc/ui-state-ipc.ts, ipc/backup-ipc.ts, ipc/settings-ipc.ts,
//   ipc/import-ipc.ts, ipc/library-ipc.ts, ipc/ipod-ipc.ts,
//   ipc/sync-ipc.ts, ipc/ai-ipc.ts, ipc/cynthia-ipc.ts
// Remaining index.ts channels, record-store, imessage-capture, and
// gapless-trim also register through `ipc` — no raw ipcMain.handle.

// User-preference settings path (4.0 §6.7). Distinct from ui-state.json.
// Still used by readAppSettingsAsync and other main-process readers;
// the load/save IPC handlers live in ipc/settings-ipc.ts.
function appSettingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

// Metadata hierarchy — related-artists graph (associate, don't merge). On-demand
// per artist page, cached a day (band lineups don't change). Claude (Haiku —
// factual + cheap) names the band(s), bandmates, side projects + key collabs;
// the renderer cross-references which are in the library.
const relatedArtistsCache = new Map<string, { related: RelatedArtist[]; at: number }>()
const RELATED_TTL_MS = 24 * 60 * 60 * 1000
ipc.handle('get-related-artists', async (_e, artist: string): Promise<{ ok: boolean; related?: RelatedArtist[]; error?: string }> => {
  const name = String(artist || '').trim()
  if (!name) return { ok: true, related: [] }
  const key = name.toLowerCase()
  const cached = relatedArtistsCache.get(key)
  if (cached && Date.now() - cached.at < RELATED_TTL_MS) return { ok: true, related: cached.related }
  try {
    const reply = await claudeCall('related-artists', {
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system: 'You are a precise music encyclopedia listing artists a fan should explore. Return only real, well-established MUSICAL artists related to the subject — bands, their NOTABLE members (ones with real recording careers of their own), those members\' own bands/side projects, and a few genuinely similar or closely-allied recording artists. NEVER include producers, engineers, managers, songwriters-for-hire, or minor/early former members who left before the act\'s success or had no recording career of their own (e.g. for the Beatles: exclude George Martin, Pete Best, Stuart Sutcliffe). Never invent a relationship.',
      messages: [{ role: 'user', content: `List the recording artists most directly related to "${name}" — for a fan who likes them and wants similar or adjacent artists to explore. Include: the band(s) they are/were in, that band's NOTABLE members (the ones with real careers of their own), those members' side projects/aliases/other bands, and a few genuinely similar artists. EXCLUDE producers, engineers, managers, and minor/early members. Return ONLY JSON — an array of {"name","relation"} where relation is one of "band","member","sideProject","similar" (use "similar" for similar/adjacent artists). 6–12 entries, most relevant first. No prose, no code fence.` }],
    })
    const block = reply.content[0]
    const text = block && block.type === 'text' ? block.text : ''
    const related = parseRelatedArtists(text).slice(0, 16)
    relatedArtistsCache.set(key, { related, at: Date.now() })
    return { ok: true, related }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}, { refuse: REFUSED_SENDER })

// 4.5.0-118 — Discovery Brain Phase 1: the taste fingerprint (taste-model.ts).
// Pure compute over the current library; Phase 2's radar grounds + ranks with it.
ipc.handle('get-taste-fingerprint', async () => {
  try {
    const lib = (await libraryCache.get()) as { tracks?: TrackLike[] }
    return { ok: true, fingerprint: computeTasteFingerprint(Array.isArray(lib.tracks) ? lib.tracks : []) }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}, { public: true })

// 4.5.0-118 — Discovery Brain Phase 2: the new-music radar. Taste fingerprint
// → live Exa search per top spine → Music Man extracts named releases from the
// journalism → rank/filter against taste (drop owned). Cached 6h; force=true
// from the refresh button. Honest fail-soft (ok:false → UI shows the reason).
let radarCache: { candidates: RankedCandidate[]; generatedAt: number; fingerprintSummary?: string; anchors?: ReturnType<typeof getTasteAnchors> } | null = null
const RADAR_TTL_MS = 6 * 60 * 60 * 1000
const RADAR_SCENES: Record<string, string> = {
  'Rock & Alternative': 'indie rock, alternative, and punk',
  'Hip-Hop & Rap': 'hip-hop and rap',
  'Electronic & Dance': 'electronic, house, and dance',
  'Soul, Funk & R&B': 'soul, funk, and R&B',
  'Pop': 'pop',
  'Jazz, Blues & Classical': 'jazz and experimental',
}
// Normalized key for discovery feedback (artist- and title-level).
function normArtistKey(sname: string): string {
  return String(sname || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
}

// ── Listen to the List v2: friends ledger + capture-anything resolver ──
ipc.handle('get-friends', async () => {
  const f = await friendsCache.get()
  // Rank by what Jake actually IMPORTED (2026-07-19: "just because they
  // send me a song doesnt mean ill like it"), then hit-rate, then volume.
  const friends = Object.values(f).map((x) => ({ ...x, imported: x.imported || 0 }))
  friends.sort((a, b) =>
    b.imported - a.imported ||
    (b.got / Math.max(1, b.got + b.tossed)) - (a.got / Math.max(1, a.got + a.tossed)) ||
    b.adds - a.adds)
  return { ok: true, friends }
}, { public: true })
ipc.handle('friend-event', async (_e, name: string, ev: 'add' | 'got' | 'tossed') => {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return { ok: false }
  await friendsCache.update((cur) => {
    const f = cur[key] || { name: String(name).trim(), adds: 0, got: 0, tossed: 0, lastAt: 0 }
    if (ev === 'add') f.adds += 1
    if (ev === 'got') f.got += 1
    if (ev === 'tossed') f.tossed += 1
    f.lastAt = Date.now()
    cur[key] = f
    return cur
  })
  return { ok: true }
}, { refuse: REFUSED_SENDER })

// macOS Contacts names for the "From" typeahead. One osascript JXA call
// (triggers the system's one-time Automation permission prompt for Contacts);
// cached for the session. Denied/unavailable -> ok:false, the field still
// accepts free-typed names. Names only — no numbers/emails ever leave Contacts.
let contactsCache: { at: number; names: string[] } | null = null
ipc.handle('get-contacts', async (): Promise<{ ok: boolean; names: string[] }> => {
  if (contactsCache && Date.now() - contactsCache.at < 3600_000) return { ok: true, names: contactsCache.names }
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const { stdout } = await promisify(execFile)('osascript', ['-l', 'JavaScript', '-e', 'JSON.stringify(Application("Contacts").people.name())'], { timeout: 30000 })
    const names = (JSON.parse(stdout.trim()) as string[]).filter((n) => typeof n === 'string' && n.trim()).sort()
    contactsCache = { at: Date.now(), names }
    return { ok: true, names }
  } catch {
    return { ok: false, names: [] }
  }
}, { refuse: { ok: false, names: [] as string[] } })

// Resolve a pasted link (Spotify / YouTube / TikTok) into a best-guess
// song + artist. GROUNDED: this only extracts what the page itself says —
// the renderer always verifies against iTunes Search and the USER picks
// the candidate; nothing is auto-added from a guess.
// Host allowlist + private-IP deny: a compromised renderer must not turn
// this into LAN SSRF (homemini, routers, metadata services).
ipc.handle('capture-resolve-link', async (_e, rawUrl: string): Promise<{ ok: boolean; kind?: string; title?: string; artist?: string; raw?: string }> => {
  const u = String(rawUrl || '').trim()
  if (!isAllowedCaptureUrl(u)) return { ok: false }
  const get = async (url: string): Promise<string | null> => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) JakeTunes/1.0' }, signal: AbortSignal.timeout(8000) })
      return r.ok ? await r.text() : null
    } catch { return null }
  }
  try {
    if (/open\.spotify\.com\/(track|album)\//i.test(u)) {
      // Spotify page <title>: "Song - song and lyrics by Artist | Spotify"
      // (entity-escaped in raw HTML — "weren&#x27;t" — decode before parsing)
      const html = await get(u)
      const t = decodeHtmlEntities(html?.match(/<title>([^<]+)<\/title>/i)?.[1] || '')
      const m = t.match(/^(.*?)\s*[-–]\s*(?:song(?: and lyrics)? by\s*)?(.*?)\s*\|\s*Spotify/i)
      if (m) return { ok: true, kind: 'spotify', title: m[1].trim(), artist: m[2].trim() }
      const oe = await get(`https://open.spotify.com/oembed?url=${encodeURIComponent(u)}`)
      const title = oe ? (JSON.parse(oe).title as string) : ''
      return { ok: true, kind: 'spotify', title: title || undefined, raw: t || undefined }
    }
    if (/youtube\.com|youtu\.be/i.test(u)) {
      const oe = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`)
      if (oe) {
        const j = JSON.parse(oe) as { title?: string; author_name?: string }
        const t = String(j.title || '')
        const m = t.match(/^(.*?)\s*[-–]\s*(.*)$/)
        const artist = (j.author_name || '').replace(/\s*-\s*Topic$/i, '')
        if (m) return { ok: true, kind: 'youtube', title: m[2].trim(), artist: m[1].trim(), raw: t }
        return { ok: true, kind: 'youtube', title: t || undefined, artist: artist || undefined }
      }
      return { ok: false }
    }
    if (/tiktok\.com/i.test(u)) {
      const oe = await get(`https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`)
      const j = oe ? JSON.parse(oe) as { title?: string } : {}
      // TikTok captions rarely name the song cleanly — hand the caption back
      // as raw context; the user types/edits what they hear.
      return { ok: true, kind: 'tiktok', raw: j.title || undefined }
    }
    // Unknown host that somehow passed the allowlist — refuse rather than
    // fetch arbitrary OG tags (that was the SSRF footgun).
    return { ok: false }
  } catch {
    return { ok: false }
  }
}, { refuse: REFUSED_SENDER })

// Jake's thumbs-down: suppress this artist from Discovery permanently and
// drop them from the current cache so the card vanishes on next read.
/**
 * What the brain has actually learned — read from the ledger it already keeps,
 * so the panel can never disagree with the data. Jake: "hard to know if you
 * are actually learning my tastes or not based on what is recommended."
 * Answering that honestly needs the volume, not just the conclusions.
 */
ipc.handle('discovery-learned', async () => {
  try {
    const rows: LedgerRow[] = await readLedgerRows(TASTE_LEDGER_PATH())

    let notForMe: Record<string, { artist?: string; at?: number }> = {}
    try { notForMe = (await discoveryFeedbackCache.get())?.notForMe ?? {} } catch { /* none */ }

    let weightsAt: string | undefined
    try {
      const w = JSON.parse(await readFile(join(app.getPath('userData'), 'taste-weights.json'), 'utf-8')) as { updatedAt?: string }
      weightsAt = w?.updatedAt
    } catch { /* learner hasn't run */ }

    return { ok: true, summary: summariseLearning(rows, notForMe, weightsAt, Date.now()) }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}, { public: true })

/**
 * "Not for me" — and what that actually means.
 *
 * It used to mean ONE thing: ban the artist from Discovery permanently, no
 * undo, nothing visible. Reading Jake's data, 13 artists were suppressed that
 * way — including The Beatles (398 tracks, 386 plays), Daft Punk (135/312) and
 * Guided By Voices (28/30). He was clicking X on a CARD, meaning "not this,
 * I've got it"; the system heard "never this artist again".
 *
 * That is the worst possible misreading, because filterFeed already hides
 * ARTIST cards for anyone you own — so an artist ban only ever killed the
 * album and song cards, i.e. "a new record by someone you love", which is the
 * single most valuable thing this feed can produce.
 *
 * So the verdict now depends on whether the artist is already yours:
 *   · you own them  -> rest THIS CARD (the `served` rotation that already
 *     exists). "Not this one" is what the click meant.
 *   · you don't     -> the old behaviour, a real artist-level no.
 *
 * The renderer passes the card key so the rest can be precise; without one it
 * falls back to resting nothing rather than banning an artist you own.
 */
ipc.handle('discovery-not-for-me', async (_e, artist: string, cardKey?: string) => {
  const key = normArtistKey(artist)
  if (!key) return { ok: false }

  let owned = false
  try {
    const lib = (await libraryCache.get()) as { tracks?: Array<{ artist?: string; albumArtist?: string }> }
    for (const t of lib?.tracks || []) {
      if (normArtistKey(String(t.artist || '')) === key || normArtistKey(String(t.albumArtist || '')) === key) { owned = true; break }
    }
  } catch { /* can't read the library: fall through to the old behaviour */ }

  await discoveryFeedbackCache.update((cur) => {
    if (owned) {
      // Rest this card hard rather than blacklisting a artist Jake plays.
      if (cardKey) cur.served[String(cardKey)] = { first: Date.now(), last: Date.now(), views: 99 }
    } else {
      cur.notForMe[key] = { artist: String(artist), at: Date.now() }
    }
    return cur
  })
  if (!owned && radarCache) {
    radarCache.candidates = radarCache.candidates.filter((c: { artist: string }) => normArtistKey(c.artist) !== key)
  }
  return { ok: true, scope: owned ? 'card' : 'artist' }
}, { refuse: REFUSED_SENDER })

/** Un-suppress an artist — the undo that never existed. */
ipc.handle('discovery-allow-again', async (_e, artist: string) => {
  const key = normArtistKey(artist)
  if (!key) return { ok: false }
  await discoveryFeedbackCache.update((cur) => { delete cur.notForMe[key]; return cur })
  return { ok: true }
}, { refuse: REFUSED_SENDER })

// ── Discover feed v2 — typed, multi-lane (song/album/artist × new/old). ──
// See src/main/discover-feed.ts for the grounding rules. Replaces the
// single-lane "new releases only" radar as Discovery's engine (the radar
// handler stays for back-compat until mobile migrates).
// Feed generation version — BUMP whenever the generation logic changes (new
// lanes, scoring, or — 2026-07-23 — the artwork match-validation). Any cached
// feed with an older ver is discarded on load so a fix never leaves a stale,
// wrong-art batch on screen ("you shouldn't have to know to hit refresh").
// v3 (2026-08-07): pseudo-artist anchors ("Various Artists") purged — a
// feed built by v2 carries VA-compilation junk cards and must regenerate.
// v4 (2026-08-07): "From the Scene" lane (human-graph reach — the
// Ceremony problem); regenerate so the lane appears.
const FEED_GEN_VERSION = 8  // 8: curator lane — Spotify curator picks seat New Songs slots (2026-09-01); 7: supply edition gate; 6: 25/25 supply lanes; 5: bins + hooks + pitches
type FeedCacheShape = { at: number; ver?: number; lanes: Array<{ id: string; title: string; cards: unknown[] }> }
let discoverFeedMem: FeedCacheShape | null = null
const DISCOVER_TTL_MS = 3 * 60 * 60 * 1000
// Jake (2026-07-14): "can it not look like this every time the app opens. it
// should be there already... if it needs to update it will update." The feed
// persists to disk and serves INSTANTLY on open; a stale feed refreshes in
// the background and pushes the update to the renderer when ready.
const discoverFeedDisk = new JsonFileCache<FeedCacheShape>(
  () => join(STATE_DIR, 'discover-feed.json'),
  () => ({ at: 0, ver: 0, lanes: [] }),
  'discover-feed',
)
let discoverGenInFlight = false

async function generateDiscoverFeed(): Promise<{ ok: boolean; lanes?: Array<{ id: string; title: string; cards: unknown[] }>; generatedAt?: number; error?: string }> {
  if (discoverGenInFlight) return { ok: false, error: 'already generating' }
  discoverGenInFlight = true
  try {
    const df = await import('./discover-feed.ts')
    const lib = (await libraryCache.get()) as { tracks?: TrackLike[] }
    const tracks = Array.isArray(lib.tracks) ? lib.tracks : []
    const fp = computeTasteFingerprint(tracks)
    if (fp.totalTracks === 0) return { ok: false, error: 'Library is empty — nothing to base discovery on yet.' }
    // 16 anchors: 8 speak in prompts; the deeper bench widens the
    // MusicBrainz gap-lane and the because-validation map (2026-08-21, the
    // starving-shelves fix — one lane had a single card).
    const anchors = getTasteAnchors(tracks, 16)
    // Anchor rotation (the daily-mixes lesson, applied to generation): the
    // top 3 always speak — they ARE the taste — while the other five prompt
    // seats rotate daily through the bench, so each day's regeneration
    // bridges from different corners of the library instead of asking the
    // same eight names for the same adjacents forever. Stride 5 through a
    // 13-artist bench is coprime, so every bench artist gets days at the mic.
    const dayN = Math.floor(Date.now() / 86_400_000)
    const bench = anchors.slice(3)
    const speaking = [...anchors.slice(0, 3)]
    for (let i = 0; i < Math.min(5, bench.length); i++) speaking.push(bench[(dayN * 5 + i) % bench.length])
    const anchorNames = speaking.map((a) => a.artist).join(', ')
    const nk = (x: string) => String(x || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
    const ownedArtists = new Set(tracks.map((t) => nk(String((t as { artist?: string }).artist || ''))).filter(Boolean))
    // Contributor-expanded (2026-08-28, the FourFiveSeconds catch): a
    // collab tag indexes under every credited artist. Logic + tests in
    // discover-feed.ownedPairKeys.
    const ownedAlbumKeys = new Set(df.ownedPairKeys(tracks as Array<{ artist?: string; albumArtist?: string; album?: string; title?: string }>))
    // Recording-identity keys: owning "Undone - The Sweater Song" must also
    // block "Undone -- The Sweater Song (Kitchen Tape Demo)" — Jake rejected
    // exactly that card the day this shipped.
    const ownedBaseKeys = new Set<string>()
    for (const t of tracks as Array<{ artist?: string; album?: string; title?: string }>) {
      const a = nk(String(t.artist || ''))
      if (!a) continue
      for (const raw of [t.title, t.album]) {
        const b = df.baseTitleKey(String(raw || ''))
        if (b && b !== a) ownedBaseKeys.add(`${a}|${b}`)
      }
    }

    const tasteLine = `Taste: ${fp.summary} Top genres: ${fp.topGenres.slice(0, 6).map((g) => g.genre).join(', ')}. Plays most: ${anchorNames}.`
    const cards: import('./discover-feed.ts').FeedCard[] = []

    // L1 · Brand new — the proven radar pipeline (journalism-grounded).
    const radarPromise = (async () => {
      try {
        const year = String(new Date().getFullYear())
        // 2026-08-25: 3 scenes -> 6. Only 9% of the feed was from the last two
        // years because this, the only new-release lane, was also the smallest.
        const scenes = fp.spines.slice(0, 6).map((sp) => RADAR_SCENES[sp.name] || sp.name.toLowerCase())
        const { exaNewMusic } = await import('./exa')
        const blocks = await Promise.all(scenes.map((sc) => exaNewMusic(sc, year)))
        const journalism = blocks.filter(Boolean).join('\n\n')
        if (!journalism) return
        const reply = await claudeCall('discover-brand-new', {
          model: 'claude-sonnet-4-6', max_tokens: 8000, system: MUSIC_MAN_CORE,
          messages: [{ role: 'user', content: `${tasteLine}\n\nCurrent music journalism:\n${journalism}\n\nFrom ONLY the releases named above, pick up to 40 this listener would love. Canonical studio releases only — never demos, live albums, remasters, deluxe/expanded reissues, tributes, or covers. Return ONLY JSON: [{"artist","title","year","why"}] — "why" MUST be 8 words or fewer, punchy, no filler. No prose.` }],
        })
        const block = reply.content[0]; console.warn(`[dx.brandnew] scenes=${scenes.length} journalism=${journalism.length}ch`)
        const text = block && block.type === 'text' ? block.text : ''; console.warn(`[dx.brandnew] replyChars=${text.length} stop=${reply.stop_reason} picks=${df.parseFeedJson(text).length}`)
        for (const r of df.parseFeedJson<{ artist?: string; title?: string; year?: string; why?: string }>(text)) {
          const card = await df.dressJournalismPick(r, { verify: df.itunesVerify as never, caa: fetchCaaArtwork, clipWhy: df.clipWhy })  // existence gate
          if (card) cards.push(card); else console.warn(`[dx.brandnew] REJECTED ${r.artist} — ${r.title}`)
        }
      } catch (err) { console.warn('[discover] brand-new lane failed:', err) }
    })()

    // L2 · You're missing — MusicBrainz discography minus owned (pure grounding).
    const missingPromise = (async () => {
      try {
        // 2026-08-25: completion WAS the page. Now a small shelf — buildGapCards.
        const discos = await Promise.all(anchors.slice(0, 8).map(async (a) => ({
          artist: a.artist, tracks: a.tracks,
          albums: (await fetchArtistDiscography(a.artist).catch(() => null))?.albums || [],
        })))
        for (const c of df.buildGapCards(discos, ownedAlbumKeys)) cards.push(c)
      } catch (err) { console.warn('[discover] missing lane failed:', err) }
    })()

    // L2.5 · From the Scene — the record-store-clerk lane (2026-08-07,
    // the Ceremony problem: a store manager's pick beat every algorithm).
    // Human-graph neighbors — bandmates, collaborators, independent-label
    // ROSTERS — one hop past the library's edge. Punk-family anchors lead
    // (his most-traveled crossroads per co-listening). Sonic similarity
    // deliberately plays no part: this lane is labels and scenes, the
    // connective tissue anti-algorithm bands still live inside.
    const scenePromise = (async () => {
      try {
        const ov = await overridesCache.get() as Record<string, { fields?: Record<string, string> }>
        const famOf = (artistName: string): string => {
          const nkA = nk(artistName)
          for (const t of tracks as Array<{ id?: number; artist?: string; albumArtist?: string }>) {
            if (nk(String(t.albumArtist || t.artist || '')) !== nkA) continue
            const p = ov[String(t.id)]?.fields?.subgenrePath
            if (p) return p.toLowerCase()
          }
          return ''
        }
        const ranked = [...anchors].sort((a, b) => {
          const ap = famOf(a.artist).includes('punk') ? 1 : 0
          const bp = famOf(b.artist).includes('punk') ? 1 : 0
          return bp - ap || b.score - a.score
        }).slice(0, 4)
        const seen = new Set<string>()
        const perAnchor: Array<Array<{ name: string; connection: string; anchor: string; sampleTitle?: string }>> = []
        for (const a of ranked) {
          const neighbors = await fetchSceneNeighbors(a.artist)
          const mine: typeof perAnchor[number] = []
          for (const nb of neighbors) {
            const key = nk(nb.name)
            if (!key || seen.has(key) || ownedArtists.has(key)) continue
            seen.add(key)
            mine.push({ name: nb.name, connection: nb.connection, anchor: a.artist, sampleTitle: nb.sampleTitle })
          }
          // The scene SHELF (label-mates) is the point; ex-member and
          // side-project trivia rides behind it, not ahead of it.
          mine.sort((x, y) => Number(y.connection.startsWith('label-mates')) - Number(x.connection.startsWith('label-mates')))
          perAnchor.push(mine)
        }
        // Round-robin the anchors so one band's orbit can't flood the
        // lane (v1 shipped 10/10 blink-182 cards).
        const picks: typeof perAnchor[number] = []
        for (let rank = 0; picks.length < 60; rank++) {
          let any = false
          for (const mine of perAnchor) {
            const p = mine[rank]
            if (!p) continue
            any = true
            picks.push(p)
          }
          if (!any) break
        }
        // WILDCARD HOPS (2026-08-07, Jake: "i need more scene
        // recommendations… thats the shit i love to find"): the clerk
        // follows two first-hop neighbors DEEPER into their own label
        // orbits — hop two is where the underground lives (Ceremony sat
        // exactly one label-orbit past the library's edge).
        const wildcards = picks.filter((p) => p.connection.startsWith('label-mates')).slice(0, 2)
        for (const w of wildcards) {
          const deeper = await fetchSceneNeighbors(w.name)
          for (const nb of deeper) {
            const key = nk(nb.name)
            if (!key || seen.has(key) || ownedArtists.has(key)) continue
            seen.add(key)
            picks.push({ name: nb.name, connection: `deep cut · ${nb.connection}`, anchor: w.anchor, sampleTitle: nb.sampleTitle })
          }
        }
        // Existence gate: iTunes first, but the UNDERGROUND lives off
        // Apple's map — on an iTunes miss, verify through MusicBrainz +
        // Cover Art Archive using the release we saw on the label roster.
        // A Bandcamp-only band with a real record still becomes a card.
        let made = 0
        let tried = 0
        for (const p of picks) {
          // 2026-08-25: the "never heard of them" lane (already refuses owned
          // artists). The throttle, not the supply, kept it at 7 cards.
          if (made >= 26 || tried >= 80) break
          tried++
          const v = await df.itunesVerify(p.name, 'album', { artist: p.name }).catch(() => null)
          await new Promise((r) => setTimeout(r, 250))
          if (v?.artUrl) {
            cards.push({ lane: 'scene', type: 'album', artist: v.artist, title: v.title, year: v.year, why: df.clipWhy(p.connection), artUrl: v.artUrl, because: p.anchor, genre: v.genre, collectionId: v.collectionId, desc: df.clipWhy(p.connection) })
            made++
            continue
          }
          if (p.sampleTitle) {
            const caa = await fetchCaaArtwork(p.name, p.sampleTitle).catch(() => null)
            if (caa) {
              cards.push({ lane: 'scene', type: 'album', artist: p.name, title: p.sampleTitle, why: df.clipWhy(p.connection), artUrl: caa, because: p.anchor, desc: df.clipWhy(p.connection) })
              made++
            }
          }
        }
        console.log(`[discover] scene lane: ${made} cards from ${picks.length} neighbors (${ranked.map((a) => a.artist).join(', ')})`)
      } catch (err) { console.warn('[discover] scene lane failed:', err) }
    })()

    // L3 · Time machine — any-era albums/artists, iTunes-verified before display.
    // L4 · Songs to try — individual tracks, iTunes-verified (gives previews).
    const llmLanes = (async () => {
      try {
        const reply = await claudeCall('discover-time-machine', {
          model: 'claude-sonnet-4-6', max_tokens: 3800, system: MUSIC_MAN_CORE,
          messages: [{ role: 'user', content: `${tasteLine}\n\nArtists this listener actually plays (pick "because" ONLY from this list, spelled exactly):\n${anchorNames}\n\nRecommend music from ANY era (1960s to last year — deliberately NOT this year's releases) adjacent to this taste that the listener plausibly does NOT own. Mix eras widely AND spread across the listener's genre range — punk, rock, hip-hop, electronic, soul, and beyond — rather than clustering in one lane; go deep and surprising, not just the obvious canon. Canonical studio recordings only — never demos, live versions, remasters, deluxe/expanded reissues, tributes, or covers.\n\nEVERY pick must name the ONE artist above it bridges from, in "because". Do not invent an artist that is not on that list. The "why" must say what carries over from that artist — the specific sonic link, not praise.\n\nReturn ONLY JSON with two arrays:\n{"classics":[{"type":"album"|"artist","artist","title","year","because","why"}] (24 items), "songs":[{"artist","title","year","because","why"}] (24 items)}\nEvery "why" MUST be 8 words or fewer. No prose, no code fence.` }],
        })
        const block = reply.content[0]
        const text = block && block.type === 'text' ? block.text : ''
        const m = text.match(/\{[\s\S]*\}/)
        const parsed = m ? JSON.parse(m[0]) as { classics?: Array<{ type?: string; artist?: string; title?: string; year?: string; why?: string; because?: string }>; songs?: Array<{ artist?: string; title?: string; year?: string; why?: string; because?: string }> } : {}
        // Ground the bridge. The model is told to pick only from the anchor
        // list, but "told to" is not "did" — an invented "because you like X"
        // claims to know Jake and gets it wrong, which is worse than silence.
        // Match against the real anchors; anything else is dropped.
        const anchorByKey = new Map(anchors.map((a) => [a.artist.toLowerCase().trim(), a.artist]))
        const validBecause = (raw: unknown): string | undefined => {
          const k = String(raw || '').toLowerCase().trim()
          return k ? anchorByKey.get(k) : undefined
        }
        // Verify each against iTunes — canonical name/art/year or it doesn't exist.
        for (const c of (parsed.classics || []).slice(0, 24)) {
          if (!c.artist) continue
          const entity = c.type === 'artist' ? 'musicArtist' : 'album'
          const v = await df.catalogVerify(c.type === 'artist' ? c.artist : `${c.artist} ${c.title || ''}`, entity as 'album' | 'musicArtist', { artist: c.artist, title: c.type === 'artist' ? undefined : c.title }, df.itunesVerify as never)
          if (v) cards.push({ lane: 'time-machine', type: (c.type === 'artist' ? 'artist' : 'album'), artist: v.artist, title: v.title, year: v.year || String(c.year || ''), why: df.clipWhy(String(c.why || '')), artUrl: v.artUrl, because: validBecause(c.because), genre: v.genre, collectionId: v.collectionId, desc: df.clipWhy(String(c.why || '')) })
          await new Promise((r) => setTimeout(r, 250))   // stay polite with Apple
        }
        for (const sng of (parsed.songs || []).slice(0, 24)) {
          if (!sng.artist || !sng.title) continue
          const v = await df.catalogVerify(`${sng.artist} ${sng.title}`, 'song', { artist: sng.artist, title: sng.title }, df.itunesVerify as never)
          if (v) cards.push({ lane: 'songs', type: 'song', artist: v.artist, title: v.title, year: v.year || String(sng.year || ''), why: df.clipWhy(String(sng.why || '')), artUrl: v.artUrl, previewUrl: v.previewUrl, because: validBecause(sng.because), genre: v.genre, desc: df.clipWhy(String(sng.why || '')) })
          await new Promise((r) => setTimeout(r, 250))
        }
      } catch (err) { console.warn('[discover] llm lanes failed:', err) }
    })()

    // L0 · Bulk supply — the 25/25 quota lanes (Jake: "NO LESS"). Deezer graph, module-side; all 16
    // anchors feed the pool, plus his top SPOTIFY artists ("wire in the taste signal they use").
    const spotifyAnchors = await loadSpotifyTasteAnchors(join(STATE_DIR, 'spotify-taste.json'), 4)
    const supplyPromise = df.supplyLanes([...anchors.map((a) => a.artist), ...spotifyAnchors], dayN, { artists: ownedArtists, albumKeys: ownedAlbumKeys, baseKeys: ownedBaseKeys }).then((cs) => { cards.push(...cs) }).catch((err) => console.warn('[discover] supply lanes failed:', err))

    await Promise.all([radarPromise, missingPromise, scenePromise, llmLanes, supplyPromise])

    // Clerk pitches (module pass — Jake: "need you to get deeper than
    // label-mates"): runs before scoring so the pitch feeds the embedding.
    await df.applyScenePitches(cards, {
      pitchCall: async (prompt) => {
        const reply = await claudeCall('discover-scene-pitch', {
          model: 'claude-sonnet-4-6', max_tokens: 1400, system: MUSIC_MAN_CORE,
          messages: [{ role: 'user', content: prompt }],
        })
        const b = reply.content[0]
        return b && b.type === 'text' ? b.text : ''
      },
    })

    // Artwork pass (module): dress artless journalism/MB cards from iTunes.
    await df.dressArtlessCards(cards)

    // The verdict stream: accepts retire their cards from circulation (a yes
    // is already on the list — "existence is not memory", the tombstone is
    // the ledger row) and both sides teach the score below.
    const verdicts = discoverVerdicts(await readLedgerRows(TASTE_LEDGER_PATH()))
    for (const a of verdicts.accepts) ownedAlbumKeys.add(`${nk(a.artist)}|${nk(a.title)}`)

    // Jake's verdicts + rotation + ownership + cross-lane dedupe.
    const fb = await discoveryFeedbackCache.get()
    const nowMs = Date.now()
    const visible = df.filterFeed(cards, { ownedArtists, ownedAlbumKeys, ownedBaseKeys, notForMe: fb.notForMe, served: fb.served, now: nowMs })

    // The brain scores EVERYTHING in the feed — one embed batch — then the
    // quality floor decides what earns a shelf spot. The brain PICKS now; it
    // no longer just stickers whatever the generators produced.
    const { brainMatchCandidates } = await import('./discovery-brain.ts')
    const pcts = await brainMatchCandidates(
      visible.map((c) => ({ artist: c.artist, title: c.title, genre: c.genre || '', year: c.year, type: c.type, desc: c.desc })),
      tracks as Array<{ id?: number; rating?: number; playCount?: number }>,
      5,
      verdicts,
    )
    if (pcts) visible.forEach((c, i) => { c.brainPct = pcts[i] })
    const shelved = pcts ? df.applyQualityFloor(visible) : visible

    // Shop passes (module): genre dividers + the one 30s hook sample per
    // album — floor first, so only shelf-worthy albums earn the lookups.
    df.stampBins(shelved)
    await df.applyAlbumHooks(shelved, {
      albumTracks: (id) => itunesAlbumTracks(id),
      scoreCandidates: (cands) => brainMatchCandidates(cands, tracks as Array<{ id?: number; rating?: number; playCount?: number }>, 5),
    })

    // Lane seating moved to df.assembleLanes (2026-08-27, the line-ratchet
    // extraction) — quota lanes seat 25, narrative lanes 24, scene keeps
    // its orbit cap.
    const lanes = df.assembleLanes(shelved)

    // 2026-08-24 — the serve-count MOVED OUT of generation (Jake: "not enough
    // new music recommendations where did that go????"). Counting a "view"
    // here counted the MACHINE's work, not Jake's attention: every background
    // refresh, every boot warm and every regeneration I ran while rebuilding
    // the shop burned a view on all ~24 cards per lane. Rotation hides a card
    // at 4 views for 14 days, so a handful of regenerations silently retired
    // the whole pool — 127 candidates were hidden with Jake never having seen
    // them. It is now counted where a human actually looks: the
    // get-discover-feed handler, whose only caller is the Record Shop view.

    // Never cache an empty feed — a transient failure (Apple 403, Exa down)
    // must not stick; the next open retries.
    if (lanes.length > 0) {
      discoverFeedMem = { at: nowMs, ver: FEED_GEN_VERSION, lanes }
      await discoverFeedDisk.update(() => ({ at: nowMs, ver: FEED_GEN_VERSION, lanes }))
      sendToRenderer('discover-feed-updated', { lanes, generatedAt: nowMs })
      // If Apple rate-limited during THIS build, cards persisted artless —
      // re-dress them instead of serving gray placeholders until the TTL.
      void backfillDiscoverArt()
    }
    return { ok: true, lanes, generatedAt: nowMs }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  } finally {
    discoverGenInFlight = false
  }
}

// ── Discover art backfill ───────────────────────────────────────────
// 2026-08-07 (Jake: "WHY IS SO MUCH ALBUM ART MISSING OMG"): a feed built
// while Apple was 403-ing this IP persisted with EVERY card artless, and
// nothing ever retried — the TTL happily served gray placeholders for days.
// This re-dresses artless cards in the SERVED feed in place (iTunes verified
// lookup, then Cover Art Archive for releases iTunes doesn't know yet),
// persists, and pushes the same discover-feed-updated event the background
// regen uses so an open page fills in live. Never regenerates cards — Jake's
// current picks keep their spots and just gain covers.
let discoverArtBackfillRunning = false
let discoverArtBackfillLastTry = 0
async function backfillDiscoverArt(): Promise<void> {
  if (discoverArtBackfillRunning) return
  const mem = discoverFeedMem
  if (!mem?.lanes?.length) return
  type CardLike = import('./discover-feed.ts').FeedCard
  // Artist cards are dressed by the portrait system, not album covers.
  const artless = mem.lanes.flatMap((l) => l.cards as CardLike[]).filter((c) => !c.artUrl && c.type !== 'artist')
  if (artless.length === 0) return
  // A whole-pass failure usually means Apple is 403-ing right now — back off
  // instead of hammering; the next serve after the window retries.
  if (Date.now() - discoverArtBackfillLastTry < 10 * 60_000) return
  discoverArtBackfillRunning = true
  discoverArtBackfillLastTry = Date.now()
  try {
    const df = await import('./discover-feed.ts')
    let fixed = 0
    for (const c of artless) {
      const entity = c.type === 'song' ? 'song' as const : 'album' as const
      const v = await df.itunesVerify(`${c.artist} ${c.title}`, entity, { artist: c.artist, title: c.title }).catch(() => null)
      if (v?.artUrl) {
        c.artUrl = v.artUrl
        if (!c.year && v.year) c.year = v.year
        if (c.type === 'song' && !c.previewUrl && v.previewUrl) c.previewUrl = v.previewUrl
        fixed++
      } else {
        const caa = await fetchCaaArtwork(c.artist, c.title).catch(() => null)
        if (caa) { c.artUrl = caa; fixed++ }
      }
      await new Promise((r) => setTimeout(r, 350))   // stay polite with Apple
    }
    if (fixed > 0) {
      await discoverFeedDisk.update(() => ({ at: mem.at, ver: mem.ver ?? FEED_GEN_VERSION, lanes: mem.lanes }))
      sendToRenderer('discover-feed-updated', { lanes: mem.lanes, generatedAt: mem.at })
      // Progress was made — let the next serve finish the stragglers without
      // waiting out the backoff window.
      discoverArtBackfillLastTry = 0
      console.log(`[discover] art backfill dressed ${fixed}/${artless.length} card(s)`)
    } else {
      console.log(`[discover] art backfill could not dress any of ${artless.length} card(s) — likely rate-limited, retrying after backoff`)
    }
  } finally {
    discoverArtBackfillRunning = false
  }
}

/** Rotation bookkeeping — called ONLY when the shop page is actually served
 *  a feed, never on generation. See the note in generateDiscoverFeed. */
async function countFeedServed(lanes: Array<{ id: string; title: string; cards: unknown[] }>): Promise<void> {
  try {
    const df = await import('./discover-feed.ts')
    const nowMs = Date.now()
    await discoveryFeedbackCache.update((cur) => {
      for (const l of lanes) for (const c of l.cards as import('./discover-feed.ts').FeedCard[]) {
        const k = df.cardKey(c)
        const sv = cur.served[k]
        if (sv) { sv.views += 1; sv.last = nowMs } else cur.served[k] = { first: nowMs, last: nowMs, views: 1 }
      }
      return cur
    })
  } catch (err) { console.warn('[discover] serve-count failed (rotation may repeat a card):', err) }
}

ipc.handle('get-discover-feed', async (_e, force?: boolean) => {
  const isFresh = (at: number) => Date.now() - at < DISCOVER_TTL_MS
  const currentVer = (c: FeedCacheShape | null) => (c?.ver ?? 0) === FEED_GEN_VERSION
  if (!discoverFeedMem) {
    const disk = await discoverFeedDisk.get()
    // Only adopt a cached feed built by the CURRENT generation logic — an
    // older-version cache (e.g. pre artwork-validation) is discarded so its
    // wrong covers never render; the regen path below rebuilds it fresh.
    if (disk.lanes.length && currentVer(disk)) discoverFeedMem = disk
  }
  if (!force && discoverFeedMem?.lanes.length && currentVer(discoverFeedMem)) {
    // Serve what we have INSTANTLY; refresh behind the scenes if stale, and
    // re-dress any artless cards (see backfillDiscoverArt above).
    if (!isFresh(discoverFeedMem.at)) void generateDiscoverFeed()
    void backfillDiscoverArt()
    void countFeedServed(discoverFeedMem.lanes)
    return { ok: true, lanes: discoverFeedMem.lanes, generatedAt: discoverFeedMem.at, cached: true, stale: !isFresh(discoverFeedMem.at) }
  }
  const gen = await generateDiscoverFeed()
  if (gen.ok && gen.lanes) void countFeedServed(gen.lanes)
  return gen
}, { refuse: REFUSED_SENDER })

// Boot warmer: if the persisted feed is stale/empty, regenerate quietly ~25s
// after launch so the tab is ready before Jake ever opens it.
app.whenReady().then(() => {
  setTimeout(() => {
    void (async () => {
      const disk = await discoverFeedDisk.get()
      if (!disk.lanes.length || (disk.ver ?? 0) !== FEED_GEN_VERSION || Date.now() - disk.at >= DISCOVER_TTL_MS) {
        void generateDiscoverFeed()
      } else {
        // Feed is fresh — but if it carries artless cards (built during an
        // Apple 403 window), dress them before Jake ever opens the tab.
        if (!discoverFeedMem) discoverFeedMem = disk
        void backfillDiscoverArt()
      }
    })()
  }, 25000)
})

ipc.handle('get-new-music-radar', async (_e, force?: boolean) => {
  if (!force && radarCache && Date.now() - radarCache.generatedAt < RADAR_TTL_MS) {
    return { ok: true, candidates: radarCache.candidates, generatedAt: radarCache.generatedAt, cached: true, fingerprintSummary: radarCache.fingerprintSummary, anchors: radarCache.anchors }
  }
  try {
    const lib = (await libraryCache.get()) as { tracks?: TrackLike[] }
    const fp = computeTasteFingerprint(Array.isArray(lib.tracks) ? lib.tracks : [])
    if (fp.totalTracks === 0) return { ok: false, error: 'Your library is empty — nothing to base discovery on yet.' }
    const year = String(new Date().getFullYear())
    const scenes = fp.spines.slice(0, 3).map((s) => RADAR_SCENES[s.name] || s.name.toLowerCase())
    const { exaNewMusic } = await import('./exa')
    const blocks = await Promise.all(scenes.map((s) => exaNewMusic(s, year)))
    const journalism = blocks.filter(Boolean).join('\n\n')
    if (!journalism) return { ok: false, error: 'New for You needs web search for fresh releases. Add your Exa key in Settings → AI to activate live picks (no made-up recommendations without it).' }
    // Taste anchors — top artists the listener actually engages with (plays
    // weighted, skips penalized). Surfaced in the UI as "Seeded from" chips and
    // used below to ask the brain for explicit "because you play X" picks.
    const anchors = getTasteAnchors(Array.isArray(lib.tracks) ? lib.tracks : [], 6)
    const anchorNames = anchors.map((a) => a.artist).join(', ')
    const user = [
      `This listener's taste: ${fp.summary}`,
      `Top genres: ${fp.topGenres.slice(0, 8).map((g) => g.genre).join(', ')}.`,
      anchorNames ? `Artists they actually play most: ${anchorNames}.` : '',
      '',
      'Below is CURRENT music journalism about new releases:',
      journalism,
      '',
      `From ONLY the releases named above, pick up to 15 NEW releases (${Number(year) - 1}–${year}) this listener would most likely love given their taste. For each give: artist, release title, its genre, the year, and a one-sentence "why" in your voice tying it to their taste. If a pick is genuinely comparable to one of the artists they actually play most (named above), set "anchor" to that artist's name — omit it otherwise (don't force a connection that isn't real). Do NOT invent releases that aren't named above. Return ONLY JSON — an array of objects [{"artist","title","genre","year","why","anchor"}] ("anchor" optional), no prose, no code fence.`,
    ].filter(Boolean).join('\n')
    const reply = await claudeCall('new-music-radar', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: MUSIC_MAN_CORE,
      messages: [{ role: 'user', content: user }],
    })
    const block = reply.content[0]
    const text = block && block.type === 'text' ? block.text : ''
    // Don't surface anything already on the user's list (hand-jots + prior
    // picks) — radar is for NEW discovery. Same recoNorm identity the add
    // handler + MM verify use, so the three surfaces agree on "same song".
    const listKeys = new Set<string>()
    try {
      // Local rows are all live (mirror + outbox, Brief 125) — no tombstone filter.
      const recos = await readRecommendationsFile()
      for (const r of recos) {
        const k = recoRecordIdentityKey(r)
        if (k) listKeys.add(k)
      }
    } catch { /* list unavailable — show all candidates */ }
    const isOnList = (a: string, t: string): boolean => {
      const k = recoIdentityKey(a, t)
      return k != null && listKeys.has(k)
    }
    // Rank generously (24), then let the BRAIN and Jake's verdicts cut it down.
    const ranked = rankCandidates(fp, parseCandidates(text), 24, isOnList, anchors)

    // Jake's verdicts: "not for me" artists never come back; cards served 4+
    // times without a bite rotate out for two weeks (no more month-long squatters).
    const fb = await discoveryFeedbackCache.get()
    const nowMs = Date.now()
    const ROTATE_VIEWS = 4, ROTATE_REST_MS = 14 * 24 * 3600 * 1000
    const visible = ranked.filter((c) => {
      if (fb.notForMe[normArtistKey(c.artist)]) return false
      const sv = fb.served[`${normArtistKey(c.artist)}|${normArtistKey(c.title)}`]
      if (sv && sv.views >= ROTATE_VIEWS && nowMs - sv.last < ROTATE_REST_MS) return false
      return true
    })

    // The real match %: candidates embedded into the library's own vector
    // space, scored against Jake's starred/heavy-rotation exemplars. Falls
    // back to the genre heuristic only if the brain is unavailable.
    const { brainMatchCandidates } = await import('./discovery-brain.ts')
    const brainPcts = await brainMatchCandidates(
      visible.map((c) => ({ artist: c.artist, title: c.title, genre: c.genre, year: c.year })),
      Array.isArray(lib.tracks) ? (lib.tracks as Array<{ id?: number; rating?: number; playCount?: number }>) : [],
    )
    const withBrain = visible.map((c, i) => ({ ...c, brainPct: brainPcts ? brainPcts[i] : undefined }))
    if (brainPcts) withBrain.sort((a, b) => (b.brainPct ?? 0) - (a.brainPct ?? 0))
    const candidates = withBrain.slice(0, 12)

    // Count this serving toward rotation.
    await discoveryFeedbackCache.update((cur) => {
      for (const c of candidates) {
        const k = `${normArtistKey(c.artist)}|${normArtistKey(c.title)}`
        const sv = cur.served[k]
        if (sv) { sv.views += 1; sv.last = nowMs } else cur.served[k] = { first: nowMs, last: nowMs, views: 1 }
      }
      return cur
    })
    radarCache = { candidates, generatedAt: Date.now(), fingerprintSummary: fp.summary, anchors }
    return { ok: true, candidates, generatedAt: radarCache.generatedAt, fingerprintSummary: fp.summary, anchors }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}, { refuse: REFUSED_SENDER })

// ── Rediscover (Brain) — owned-but-overlooked library picks + Music Man's pitch.
// Where the radar finds NEW external music, this mines what Jake already OWNS but
// has overlooked in JakeTunes (his Spotify-shaped blind spot). ──
let rediscoveryCache: { at: number; picks: RediscoveryPick[] } | null = null
const REDISCOVERY_TTL_MS = 6 * 60 * 60 * 1000

async function addMusicManRediscoveryPitches(picks: RediscoveryPick[]): Promise<RediscoveryPick[]> {
  const list = picks.map((p, i) =>
    `${i + 1}. ${p.artist}${p.album ? ` — "${p.album}"` : ''} (${p.genre || 'genre?'}; owns ${p.ownedTracks} track${p.ownedTracks === 1 ? '' : 's'}, played ${p.plays}× in JakeTunes${p.rating >= 4 ? ', starred' : ''})`,
  ).join('\n')
  const user = [
    `These are artists in the listener's OWN library that they clearly bought into but have barely or never played INSIDE JakeTunes. Critical context: their real listening lives partly on Spotify, so "0 plays here" almost always means "loved elsewhere, just never spun in this app yet" — NOT "never heard" or "disliked".`,
    ``,
    `Write a ONE-sentence rediscovery nudge for EACH, in your voice — confident, opinionated, specific. Frame it as "you've been sleeping on this / it's sitting right here" — NEVER "you've never heard this". Lean on the facts (how much they own, the genre, that it's starred or freshly added) when it lands. Keep each under ~22 words.`,
    ``,
    list,
    ``,
    `Return ONLY a JSON array of strings — one per item, in order. No numbering, no prose, no code fence.`,
  ].join('\n')
  const reply = await claudeCall('rediscovery', {
    model: 'claude-sonnet-4-6',
    max_tokens: 1400,
    system: MUSIC_MAN_CORE,
    messages: [{ role: 'user', content: user }],
  })
  const block = reply.content[0]
  const text = block && block.type === 'text' ? block.text : ''
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const arr = JSON.parse(cleaned) as unknown[]
  return picks.map((p, i) => {
    const line = arr[i]
    return typeof line === 'string' && line.trim() ? { ...p, reason: line.trim() } : p
  })
}

ipc.handle('get-rediscovery', async (_e, force?: boolean) => {
  if (!force && rediscoveryCache && Date.now() - rediscoveryCache.at < REDISCOVERY_TTL_MS) {
    return { ok: true, picks: rediscoveryCache.picks }
  }
  try {
    const lib = (await libraryCache.get()) as { tracks?: RediscoveryTrack[] }
    const picks = computeRediscovery(Array.isArray(lib.tracks) ? lib.tracks : [], new Date(), 9)
    if (picks.length === 0) return { ok: true, picks: [] }
    // Music Man's pitch is the magic; if the API is capped/down, picks still
    // show with their heuristic reason (graceful).
    const pitched = await addMusicManRediscoveryPitches(picks).catch((err) => {
      console.warn('[rediscovery] Music Man pitch failed, using heuristic reasons:', err instanceof Error ? err.message : err)
      return picks
    })
    rediscoveryCache = { at: Date.now(), picks: pitched }
    return { ok: true, picks: pitched }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}, { refuse: REFUSED_SENDER })

// App-settings + inbox IPC registered in ipc/settings-ipc.ts

// 4.4.32 — Tour dates per Bandsintown for the user's top library
// artists. Picks top 60 artists by aggregate playCount (with a +1
// baseline so library artists with no play count still register),
// throttles to 8 concurrent Bandsintown requests in `external.ts`,
// caches results 24h. Returns up to 60 upcoming events sorted by
// date ascending. Cold-cache call may take ~3-8 sec for a fresh
// library; warm cache is instant.
// 4.4.34 — Upcoming releases that haven't come out yet. Same top-60
// library artists as the tour-dates query. MusicBrainz batched-OR
// queries (3 reqs total for 60 artists) so this resolves in a few
// seconds even on cold cache; aggregate result cached 24h.
ipc.handle('get-upcoming-releases-personal', async (): Promise<{ ok: boolean; items: UpcomingRelease[] }> => {
  try {
    const raw = await readFile(LIBRARY_PATH, 'utf-8').catch(() => null)
    if (!raw) return { ok: true, items: [] }
    const lib = JSON.parse(raw) as { tracks?: Array<{ artist?: string; albumArtist?: string; playCount?: number }> }
    const tracks = lib.tracks || []
    const byArtist = new Map<string, number>()
    for (const t of tracks) {
      const a = (t.albumArtist || t.artist || '').trim()
      if (!a || a.toLowerCase() === 'unknown artist') continue
      byArtist.set(a, (byArtist.get(a) || 0) + (Number(t.playCount) || 0) + 1)
    }
    const topArtists = Array.from(byArtist.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([a]) => a)
    const items = await getUpcomingReleasesForArtists(topArtists)
    return { ok: true, items: items.slice(0, 20) }
  } catch (err) {
    console.warn('[get-upcoming-releases-personal] failed:', err)
    return { ok: true, items: [] }
  }
}, { refuse: { ok: false, items: [] } })

ipc.handle('get-tour-dates', async (): Promise<{ ok: boolean; dates: TourDate[] }> => {
  try {
    const raw = await readFile(LIBRARY_PATH, 'utf-8').catch(() => null)
    if (!raw) return { ok: true, dates: [] }
    const lib = JSON.parse(raw) as { tracks?: Array<{ artist?: string; albumArtist?: string; playCount?: number }> }
    const tracks = lib.tracks || []
    const byArtist = new Map<string, number>()
    for (const t of tracks) {
      const a = (t.albumArtist || t.artist || '').trim()
      if (!a || a.toLowerCase() === 'unknown artist') continue
      byArtist.set(a, (byArtist.get(a) || 0) + (Number(t.playCount) || 0) + 1)
    }
    const topArtists = Array.from(byArtist.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([a]) => a)
    const dates = await getTourDatesForArtists(topArtists)
    return { ok: true, dates: dates.slice(0, 60) }
  } catch (err) {
    console.warn('[get-tour-dates] failed:', err)
    return { ok: true, dates: [] }
  }
}, { refuse: { ok: false, dates: [] } })

// 2026-08-08 — "At Your Venues": what's coming to Jake's Brooklyn rooms
// REGARDLESS of whether the artist is in his library. Bandsintown's free tier
// can't answer that question (artist-scoped only), so venues.ts asks the rooms
// directly. Shows whose artist IS in the library are flagged `known` so the
// renderer can mark them; the rest is the discovery half Jake asked for.
ipc.handle('get-venue-shows', async (): Promise<{ ok: boolean; shows: VenueShow[] }> => {
  try {
    const shows = await getVenueShows()
    const raw = await readFile(LIBRARY_PATH, 'utf-8').catch(() => null)
    const lib = raw ? JSON.parse(raw) as { tracks?: Array<{ artist?: string; albumArtist?: string }> } : { tracks: [] }
    const norm = (s: string): string => foldAccents(s).replace(/[^a-z0-9]/g, '')
    const owned = new Set<string>()
    for (const t of lib.tracks || []) {
      const a = norm(t.albumArtist || t.artist || '')
      if (a) owned.add(a)
    }
    const marked = shows.map((s) => ({ ...s, known: owned.has(norm(s.artist)) }))
    return { ok: true, shows: marked.slice(0, 120) }
  } catch (err) {
    console.warn('[get-venue-shows] failed:', err)
    return { ok: true, shows: [] }
  }
}, { refuse: { ok: false, shows: [] } })

// 4.4.40 — Per-artist photo fetch for the Artists view. Single artist
// per call; the renderer batches at 6 concurrent. Disk cache is 30 days
// (hit + miss tombstone), single-flight per slug, all handled inside
// getArtistImage. Always succeeds (returns slug: null on failure) so the
// renderer doesn't need try/catch on every call.
ipc.handle('get-artist-image', async (_event, artist: string): Promise<{ ok: boolean; slug: string | null }> => {
  try {
    const slug = await getArtistImage(artist)
    return { ok: true, slug }
  } catch (err) {
    console.warn('[get-artist-image] failed for', artist, err)
    return { ok: true, slug: null }
  }
}, { refuse: { ok: false, slug: null } })

// 4.5: Wikipedia summary for the artist detail page. Hits the public
// REST summary endpoint (en.wikipedia.org/api/rest_v1/page/summary/<title>),
// caches the parsed extract on disk for 24h. Returns { ok, extract,
// pageUrl } — extract is the short ~250-word summary the page renders;
// pageUrl is the canonical wiki URL for a "read more" link. Both null
// on no-result so the UI can degrade gracefully (just the photo + name).
const WIKI_CACHE_DIR = join(app.getPath('userData'), 'wiki-cache')
const WIKI_TTL_MS = 24 * 60 * 60 * 1000
// 4.5.0-72 — misses get a MUCH shorter TTL than hits. A real artist-
// has-no-wiki result is rare; a transient miss (network glitch, MB
// throttle queue overflow, fetch threw mid-flight) is what we've seen
// in the wild (The Beatles cached as null after a -66 lookup that
// silently failed, then served null for 24 hours). 1-hour miss TTL
// means transient failures self-heal within the same listening
// session.
const WIKI_MISS_TTL_MS = 60 * 60 * 1000  // 1 hour
// Try one specific Wikipedia title — REST summary endpoint. Returns
// { extract, pageUrl, isDisambig } where isDisambig signals the caller
// to try a different title rather than render the "X may refer to:"
// text as a bio.
async function tryWikiTitle(title: string): Promise<{ extract: string | null; pageUrl: string | null; isDisambig: boolean }> {
  const encoded = encodeURIComponent(title.replace(/ /g, '_'))
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}?redirect=true`
  const res = await fetch(url, {
    headers: { 'User-Agent': `JakeTunes/${app.getVersion()} (jakerosenbaum30@gmail.com)` },
  })
  if (!res.ok) return { extract: null, pageUrl: null, isDisambig: false }
  const data = await res.json() as { extract?: string; type?: string; content_urls?: { desktop?: { page?: string } } }
  const isDisambig = data.type === 'disambiguation'
  return {
    extract: !isDisambig && typeof data.extract === 'string' ? data.extract : null,
    pageUrl: data.content_urls?.desktop?.page || null,
    isDisambig,
  }
}
async function fetchWikiSummary(artist: string): Promise<{ extract: string | null; pageUrl: string | null }> {
  await mkdir(WIKI_CACHE_DIR, { recursive: true }).catch(() => {})
  const key = createHash('md5').update(artist.toLowerCase().trim()).digest('hex')
  const cachePath = join(WIKI_CACHE_DIR, `${key}.json`)
  // Disk cache first — survives app restarts.
  try {
    const stat0 = await stat(cachePath)
    const raw = await readFile(cachePath, 'utf-8')
    const cached = JSON.parse(raw) as { extract: string | null; pageUrl: string | null }
    // 4.5.0-72 — separate TTLs for hits and misses. A real hit lives
    // 24 h (cheap to keep, expensive to refetch). A miss lives 1 h so
    // transient failures (network, MB throttle, fetch threw mid-flight)
    // self-heal in the same listening session instead of poisoning the
    // bio for a full day.
    const ttl = cached.extract ? WIKI_TTL_MS : WIKI_MISS_TTL_MS
    if (Date.now() - stat0.mtimeMs < ttl) return cached
  } catch { /* miss */ }
  // 4.5.0-66 — disambiguation-aware lookup. Old behavior took the raw
  // artist string and trusted Wikipedia's extract verbatim, leaking
  // "Drake may refer to:" disambiguation pages into the bio UI for any
  // artist whose name is shared with non-music entities. New strategy:
  //
  //   1. Ask MusicBrainz which entity this artist actually is (with
  //      library-genre context so the right one wins for common names).
  //      If MB knows the canonical Wikipedia article title (via its
  //      url-relations), USE THAT title — it's authoritative.
  //   2. If MB didn't know the wiki title, try the raw name. If the
  //      response is a disambiguation page, try qualifier suffixes
  //      based on the MB type/tags: "(rapper)" for hip-hop, "(band)"
  //      for groups, "(singer)" for vocalists, "(musician)" generic.
  //   3. If everything misses, return null extract — UI shows clean
  //      empty state, not the disambiguation list verbatim.
  let extract: string | null = null
  let pageUrl: string | null = null
  try {
    const genres = await getLibraryGenresForArtist(artist)
    const canon = await resolveCanonicalArtist(artist, { libraryGenres: genres })
    const titlesToTry: string[] = []
    if (canon?.wikiTitle) titlesToTry.push(canon.wikiTitle)
    titlesToTry.push(artist.trim())
    if (canon) {
      const tagText = canon.tags.join(' ')
      const isGroup = canon.type === 'Group'
      const isRap = /\brap|hip[- ]?hop|trap\b/.test(tagText)
      const isElectronic = /\belectronic|techno|house|dance|edm\b/.test(tagText)
      const isClassical = /\bclassical|opera|orchestra\b/.test(tagText)
      // Order matters — most specific first.
      if (isRap) titlesToTry.push(`${artist.trim()} (rapper)`)
      if (isGroup) titlesToTry.push(`${artist.trim()} (band)`)
      if (isElectronic) titlesToTry.push(`${artist.trim()} (DJ)`)
      if (isClassical) titlesToTry.push(`${artist.trim()} (composer)`)
      titlesToTry.push(`${artist.trim()} (musician)`)
      titlesToTry.push(`${artist.trim()} (singer)`)
    } else {
      titlesToTry.push(`${artist.trim()} (musician)`, `${artist.trim()} (band)`)
    }
    // De-dupe while preserving order.
    const seen = new Set<string>()
    const ordered = titlesToTry.filter(t => {
      const k = t.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    for (const t of ordered) {
      try {
        const r = await tryWikiTitle(t)
        if (r.extract) {
          extract = r.extract
          pageUrl = r.pageUrl
          break
        }
        // First-try pageUrl is the best we'll get if every subsequent
        // try misses — keep it as a "read on wiki" target for the UI
        // even if no clean summary exists.
        if (!pageUrl && r.pageUrl && !r.isDisambig) pageUrl = r.pageUrl
      } catch { /* try next title */ }
    }
  } catch (err) {
    console.warn('[wiki] resolver failed for', artist, err)
  }
  const out = { extract, pageUrl }
  await writeFile(cachePath, JSON.stringify(out)).catch((err) => console.warn('[wiki] summary cache write failed:', err?.message ?? err))
  return out
}
ipc.handle('get-artist-wiki', async (_event, artist: string): Promise<{ ok: boolean; extract: string | null; pageUrl: string | null }> => {
  if (!artist || typeof artist !== 'string') return { ok: false, extract: null, pageUrl: null }
  const r = await fetchWikiSummary(artist)
  return { ok: true, ...r }
}, { refuse: { ok: false, extract: null, pageUrl: null } })

// 4.4.29 — Brooklyn weather for the Home header greeting. Cached
// 10 min in external.ts (already there for the Music Man prompt).
// Returns null if no API key is set; renderer should render the
// header without weather in that case.
ipc.handle('get-brooklyn-weather', async (): Promise<{ ok: boolean; weather: { tempF: number; condition: string; description: string } | null }> => {
  try {
    const w = await getBrooklynWeather()
    return { ok: true, weather: w }
  } catch (err) {
    console.warn('[get-brooklyn-weather] failed:', err)
    return { ok: true, weather: null }
  }
}, { refuse: { ok: false, weather: null } })

// 4.4.28 — Home view: music news + notable releases.
// Both back-ends are in src/main/external.ts and share a single
// one-hour parsed cache across all 5 RSS feeds (4.4.29 swap), so
// even though HomeView calls both handlers, there's only ONE
// network round-trip per hour.
ipc.handle('get-music-news', async (): Promise<{ ok: boolean; items: MusicNewsItem[] }> => {
  try {
    const items = await getMusicNews()
    return { ok: true, items }
  } catch (err) {
    console.warn('[get-music-news] failed:', err)
    return { ok: true, items: [] }
  }
}, { refuse: { ok: false, items: [] } })
ipc.handle('get-notable-releases', async (): Promise<{ ok: boolean; items: MusicNewsItem[] }> => {
  try {
    const items = await getNotableReleases()
    return { ok: true, items }
  } catch (err) {
    console.warn('[get-notable-releases] failed:', err)
    return { ok: true, items: [] }
  }
}, { refuse: { ok: false, items: [] } })

// 4.4.28 — Open an http(s) URL in the user's default browser.
// Required because <a target="_blank"> inside Electron renders inside
// the same window otherwise. Allowlisted to http/https schemes so a
// corrupted renderer can't ask main to `open` arbitrary file:// or
// custom-scheme URLs.
ipc.handle('open-external-url', async (_e, url: string): Promise<{ ok: boolean; error?: string }> => {
  if (typeof url !== 'string') return { ok: false, error: 'invalid url' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) urls allowed' }
  try {
    const parsed = new URL(url)
    // Soft SSRF guard: don't open LAN / loopback from the privileged process.
    if (isPrivateOrLocalHostname(parsed.hostname)) {
      return { ok: false, error: 'local network urls are not allowed' }
    }
  } catch {
    return { ok: false, error: 'invalid url' }
  }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch {
    return { ok: false, error: 'failed to open url' }
  }
}, { refuse: REFUSED_SENDER })

// The iMessage-capture setup chip's button. Fixed target, zero renderer
// input — the http(s)-only rule above stays intact for everything else.
ipc.handle('open-full-disk-access-settings', async (): Promise<{ ok: boolean }> => {
  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    return { ok: true }
  } catch {
    return { ok: false }
  }
}, { refuse: { ok: false } })

// Async read used by handlers that need to gate behavior on a setting
// (musicman-speak, sync-to-ipod, import-track, etc.). Returns null on
// any failure; callers fall back to safe defaults.
async function readAppSettingsAsync(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(appSettingsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch { return null }
}

// 4.2.5: cached host preference for sync access from buildMusicManPrompt
// (which is called inside synchronous prompt-building paths). Refreshed
// when settings are saved via the save-app-settings IPC, and bootstrapped
// from disk on app whenReady. Default 'mm' until the first read lands.
// (Binding declared near mainWindow + settings IPC registration above.)
async function refreshActiveHostFromSettings(): Promise<void> {
  const s = await readAppSettingsAsync()
  const ai = (s?.ai as { aiHost?: 'mm' | 'megan' } | undefined)
  cachedActiveHost = ai?.aiHost === 'megan' ? 'megan' : 'mm'
}
function readActiveHostSync(): 'mm' | 'megan' {
  return cachedActiveHost
}

// 4.4.52: expose the active host to the renderer so the toolbar speech
// bubble can attribute a mic-button comment to the RIGHT persona — the
// mic button routes through buildMusicManPrompt(), which swaps to
// Megan when she's the chosen host, so the bubble must follow.
ipc.handle('get-active-host', () => readActiveHostSync(), { public: true })

// ── Persistent audio log ──────────────────────────────────────────────
// Every diagnosis of the "it just sits at 0:00" failure needed a debugger
// attached, and attaching one means relaunching, which resets the very state
// that produces the bug. Jake spotted that before I did: "you restart the app
// every time it works, then after that it doesn't."
//
// So the app records it instead. Append-only, capped, on the LOCAL disk. When
// it next fails, the answer is in a file — no restart, no debugger, no asking
// Jake to describe what he sees.
// ── Flight recorder (2026-08-21, reliability program P0) ─────────────
// The app's durable memory of its own failures. mirrorConsole makes every
// existing console.warn/error in main flow into main.log without touching
// a single call site; the 'flight-record' channel below is the renderer's
// crash confession line. LOCAL userData path on purpose — never STATE_DIR,
// which can resolve to the NAS and hang appends when the mount wedges.
const flightRecorder = initFlightRecorder({
  logPath: () => join(app.getPath('userData'), 'main.log'),
  ready: app.whenReady(),
})
flightRecorder.mirrorConsole()
flightRecorder.record('info', 'boot.main-start')
app.whenReady().then(() => flightRecorder.record('info', 'boot.ready'))
ipcMain.on('flight-record', (_e, payload: unknown) => {
  const p = sanitizeCrashPayload(payload)
  flightRecorder.record(p.kind.startsWith('boot.') ? 'info' : 'error', `renderer.${p.kind}`, p)
})
// dx rows from the renderer (queue honesty probe etc.) — info level, bounded.
ipcMain.on('dx-record', (_e, payload: unknown) => {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { tag?: unknown; detail?: unknown }
  const tag = String(p.tag || 'unknown').replace(/[^a-z0-9._-]/gi, '').slice(0, 60)
  let detail = p.detail
  try { if (JSON.stringify(detail ?? null).length > 2000) detail = { truncated: true } } catch { detail = { unserializable: true } }
  flightRecorder.record('info', `dx.${tag}`, detail)
})
// Warn-once state for persisting conditions (flight-log stomp 2026-08-22:
// one orphaned-edits condition = 23 identical lines; nine propagating
// imports = 36 stream-404 lines). First occurrence is the signal.
let lastOrphanWarnKey = ''
const streamWarnedOnce = new Set<string>()

let audioLogWarned = false
const AUDIO_LOG_PATH = () => join(app.getPath('userData'), 'audio-events.log')
// The comment above has said "capped" since the night this shipped; the cap
// itself was never written, and the file was at 1.5MB within days
// (2026-08-15). Rotate at 2MB into a single .1 generation — worst case
// ~4MB on disk, and the crash-forensics window (the recent past) is always
// intact across the rotation boundary. Size is checked every 50th append so
// the hot path stays one syscall; logging still must never break playback.
const AUDIO_LOG_MAX_BYTES = 2 * 1024 * 1024
let audioLogAppendsSinceCheck = 0
ipcMain.on('audio-log', (_e, line: string) => {
  try {
    void (async () => {
      if (++audioLogAppendsSinceCheck >= 50) {
        audioLogAppendsSinceCheck = 0
        try {
          const { size } = await stat(AUDIO_LOG_PATH())
          if (size > AUDIO_LOG_MAX_BYTES) {
            await rename(AUDIO_LOG_PATH(), AUDIO_LOG_PATH() + '.1')
          }
        } catch { /* absent file or busy rename — next check catches it */ }
      }
      await appendFile(AUDIO_LOG_PATH(), line + '\n', 'utf-8')
    })().catch((err) => {
      // Once per run: audio forensics silently dropping is exactly the kind
      // of invisible failure the flight recorder exists to catch.
      if (!audioLogWarned) { audioLogWarned = true; console.warn('[audio-log] append failed (audio forensics dropping):', err?.message ?? err) }
    })
  } catch { /* logging must never break playback */ }
})

// Suppliers, not values: activeHost changes when Jake switches host, and the
// taste profile changes as he listens. Reading them at call time keeps both live.
initPersonaPrompts({ activeHost: readActiveHostSync, tasteProfile: () => buildTasteProfile() })

async function createWindow(): Promise<void> {
  const saved = await loadWindowState()
  mainWindowEverCreated = true

  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1200,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 600,
    // `hiddenInset` + custom traffic-light position is macOS-only.
    // On Windows the native title bar stays (for now — Phase 2 could add
    // a custom-drawn title bar to match the iTunes look).
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } }
      : {}),
    // Pre-paint color = the splash's cream mid-tone, so the first frame
    // before the renderer mounts doesn't flash a foreign gray.
    backgroundColor: '#f4f0e4',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Explicit Electron secure defaults. webSecurity was historically
      // false (custom-protocol CORS workaround); privileged schemes now
      // cover ipod-audio / album-art / etc., so SOP stays on.
      nodeIntegration: false,
      contextIsolation: true,
      // Preload only imports electron APIs (contextBridge, ipcRenderer,
      // webUtils) — all available under Chromium sandbox. Verified against
      // Electron 30 sandbox docs + this preload's import surface; no bare
      // Node builtins (fs/path/child_process) in preload.
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Don't throttle the renderer when JakeTunes loses focus or the
      // window is hidden. Without this, Chromium's tab-throttling caps
      // JS execution at ~once/second when backgrounded, which crawls
      // the §2.4 audio-analysis backfill loop and any other long-running
      // sequential renderer work to a halt.
      backgroundThrottling: false,
    }
  })

  if (saved?.isMaximized) mainWindow.maximize()

  // Privileged window: never navigate to remote content or spawn child
  // windows with the preload API. Dev Vite URL is the only non-file allow.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = isDev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    const allowed =
      (devUrl && url.startsWith(devUrl)) ||
      url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  // Save window state on move/resize (debounced)
  let saveTimeout: ReturnType<typeof setTimeout> | null = null
  const debouncedSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow)
    }, 500)
  }
  mainWindow.on('resize', debouncedSave)
  mainWindow.on('move', debouncedSave)
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow)
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const action = mediaKeyActionFromInput(input)
    if (!action) return
    event.preventDefault()
    sendMediaKeyAction(action)
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const menuTemplate: Electron.MenuItemConstructorOptions[] = [
  {
    label: 'JakeTunes',
    submenu: [
      {
        label: 'About JakeTunes',
        click: async () => {
          // Resolve the logo path. Dev = unhashed source PNG; production
          // = hashed file in out/renderer/assets (vite asset pipeline).
          // We copy the resolved PNG to OS temp so the About HTML (also
          // written to temp) can reference it via a sibling file:// path
          // — large logos blow past Chromium's data-URL limit (~2MB)
          // and silently render a blank window if inlined.
          const { tmpdir } = await import('os')
          const { readdir } = await import('fs/promises')
          const tmpDir = join(tmpdir(), 'jaketunes-about')
          await mkdir(tmpDir, { recursive: true }).catch(() => {})
          let logoFilename = ''
          try {
            let logoPath = ''
            if (isDev) {
              logoPath = join(app.getAppPath(), 'src/renderer/assets/jaketunes-logo.png')
            } else {
              const assetsDir = join(__dirname, '../renderer/assets')
              const entries = await readdir(assetsDir).catch(() => [] as string[])
              const match = entries.find(n => /^jaketunes-logo.*\.png$/i.test(n))
              if (match) logoPath = join(assetsDir, match)
            }
            if (logoPath) {
              logoFilename = 'jaketunes-logo.png'
              await copyFile(logoPath, join(tmpDir, logoFilename))
            }
          } catch { /* logo absent → text-only About */ }

          const about = new BrowserWindow({
            width: 460,
            height: 540,
            resizable: false,
            minimizable: false,
            maximizable: false,
            ...(IS_MAC ? { titleBarStyle: 'hiddenInset' as const } : {}),
            backgroundColor: '#1a1410',
            webPreferences: { nodeIntegration: false, contextIsolation: true },
          })
          about.setMenu(null)
          const ver = app.getVersion()
          const year = new Date().getFullYear()
          const htmlPath = join(tmpDir, 'about.html')
          const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  :root {
    --orange: #d6691a;
    --orange-hot: #f08531;
    --cream: #f3ead4;
    --cream-dim: #c9bf9d;
    --ink: #14100c;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, "Lucida Grande", sans-serif;
    background:
      radial-gradient(120% 80% at 50% 0%, rgba(214,105,26,0.35) 0%, rgba(214,105,26,0) 55%),
      radial-gradient(80% 60% at 50% 100%, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0) 60%),
      linear-gradient(180deg, #2a1d12 0%, #14100c 65%, #0c0907 100%);
    color: var(--cream);
    text-align: center;
    user-select: none; -webkit-user-select: none;
    -webkit-app-region: drag;
    overflow: hidden;
    display: flex; flex-direction: column;
    padding: 56px 24px 22px;
  }
  .glow {
    position: absolute; inset: 0;
    background: radial-gradient(40% 28% at 50% 32%, rgba(240,133,49,0.22), transparent 70%);
    pointer-events: none;
  }
  .logo-wrap {
    position: relative;
    width: 156px; height: 156px;
    margin: 0 auto 18px;
    display: flex; align-items: center; justify-content: center;
  }
  .logo-wrap::before {
    content: '';
    position: absolute; inset: -22px;
    background: radial-gradient(closest-side, rgba(240,133,49,0.42), rgba(240,133,49,0) 72%);
    filter: blur(6px);
    z-index: 0;
  }
  .logo {
    position: relative; z-index: 1;
    width: 156px; height: 156px;
    object-fit: contain;
    filter: drop-shadow(0 6px 18px rgba(0,0,0,0.55));
  }
  .logo-fallback {
    position: relative; z-index: 1;
    width: 140px; height: 140px; border-radius: 32px;
    background: linear-gradient(180deg, #f08531, #b14d10);
    box-shadow: 0 6px 18px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.35);
    display: flex; align-items: center; justify-content: center;
    font-size: 72px; font-weight: 800; color: #fff;
    font-family: "Helvetica Neue", -apple-system, sans-serif;
  }
  .wordmark {
    font-family: "Helvetica Neue", -apple-system, sans-serif;
    font-size: 38px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--cream);
    margin: 4px 0 2px;
    text-shadow:
      0 1px 0 rgba(0,0,0,0.6),
      0 0 28px rgba(240,133,49,0.18);
  }
  .wordmark .accent { color: var(--orange-hot); }
  .slogan {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 14px;
    font-style: italic;
    color: var(--cream-dim);
    letter-spacing: 0.04em;
    margin: 2px 0 18px;
    text-shadow: 0 1px 0 rgba(0,0,0,0.5);
  }
  .divider {
    width: 220px; height: 1px;
    margin: 0 auto 14px;
    background: linear-gradient(90deg, transparent, rgba(243,234,212,0.35), transparent);
  }
  .meta {
    font-size: 11px;
    color: var(--cream-dim);
    letter-spacing: 0.04em;
    line-height: 1.7;
  }
  .meta .version-label { color: var(--orange-hot); font-weight: 700; }
  .meta .ver-num { color: var(--cream); font-weight: 700; font-feature-settings: "tnum"; }
  .meta .author { color: var(--cream); }
  .footer {
    margin-top: auto;
    font-size: 9.5px;
    color: rgba(243,234,212,0.42);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
</style></head>
<body>
  <div class="glow"></div>
  <div class="logo-wrap">
    ${logoFilename
      ? `<img class="logo" src="${logoFilename}" alt="JakeTunes" />`
      : `<div class="logo-fallback">J</div>`}
  </div>
  <div class="wordmark">Jake<span class="accent">Tunes</span></div>
  <div class="slogan">"Take The Music Back"</div>
  <div class="divider"></div>
  <div class="meta">
    <div><span class="version-label">VERSION</span> <span class="ver-num">${ver}</span></div>
    <div>by <span class="author">Jacob Rosenbaum</span></div>
  </div>
  <div class="footer">© ${year} · 2008 visuals · 2040 brain</div>
</body>
</html>`
          await writeFile(htmlPath, html, 'utf8')
          about.loadFile(htmlPath)
        },
      },
      { type: 'separator' },
      { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('open-preferences') },
      { type: 'separator' },
      { label: 'Quit JakeTunes', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
    ]
  },
  {
    label: 'File',
    submenu: [
      { label: 'New Playlist', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-playlist') },
      { label: 'Import...', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('import-files') },
      { label: 'Import and Convert...', accelerator: 'Shift+CmdOrCtrl+O', click: () => sendMenuAction('open-import-convert') },
      { type: 'separator' },
      { label: 'Get Info', accelerator: 'CmdOrCtrl+I', click: () => sendMenuAction('get-info') },
      { type: 'separator' },
      {
        label: 'Library',
        submenu: [
          // Re-encode high-bit-depth ALAC files that iPod Classic can't
          // decode (causes random track skips on hardware).
          { label: 'Fix iPod Compatibility…',  click: () => sendMenuAction('fix-ipod-compat') },
          // 4.1: ALAC play-cache management. Replaces the launch-time
          // prewarm scanner with explicit user actions.
          { label: 'Prepare ALAC Tracks for Instant Play…', click: () => sendMenuAction('prepare-alac-cache') },
          { label: 'Prune Play-Cache…', click: () => sendMenuAction('prune-alac-cache') },
          { label: 'Clean Orphan Files…', click: () => sendMenuAction('clean-orphan-files') },
          // Surface library entries that share artist+title+album so the
          // user can pick which copies to remove. Per-row delete only —
          // never bulk, never auto. Solves the "iPod Shuffle shows 4542
          // but library has 4550" gap caused by re-imported tracks.
          { label: 'Show Duplicates…',         click: () => sendMenuAction('show-duplicates') },
          { type: 'separator' },
          // Brief 020: push the user-edited override fields (title, artist,
          // album, genre, year, track/disc numbers) into the audio files'
          // embedded tags so Plex sees the corrected metadata on its next
          // scan. Per-edit write-back fires automatically inside
          // save-metadata-override; this menu item is the one-shot
          // backfill for the ~1.6k existing writable overrides that
          // accumulated before the per-edit hook existed.
          { label: 'Apply Overrides to Files…',  click: () => sendMenuAction('apply-overrides-to-files') },
          // Brief 016 commit 2: one-shot retrofit of stale library.json
          // fileSize values. Diagnostic phase found 29.7% of tracks had
          // library.json fileSize ≠ actual on-disk size (likely from a
          // historical "Fix iPod Compatibility" re-encode pass that cut
          // ~515KB per track). This menu walks every track, stats the
          // actual file, and writes back the corrected fileSize. Audio
          // files themselves are NOT modified.
          { label: 'Refresh File Sizes…',         click: () => sendMenuAction('refresh-file-sizes') },
          // (Removed: "Verify & Repair Library…" — the underlying tag
          // matcher had false-negative cases (e.g. file tag "Pt. 1" vs.
          // library "Part 1") that would land real tracks in the
          // unrepairable bucket and, with --delete-unrepairable on,
          // silently delete them. Restored from backup, then ripped the
          // UI out. iTunes never had this; sync should "just work."
          // The Python CLI is still in core/repair_mismatches.py for
          // any future controlled debug pass.)
        ],
      },
      { type: 'separator' },
      { label: 'Close Window', accelerator: 'CmdOrCtrl+W', role: 'close' }
    ]
  },
  {
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
      { type: 'separator' },
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
      { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
    ]
  },
  {
    label: 'Controls',
    submenu: [
      { label: 'Play/Pause', accelerator: 'F8', click: () => sendMenuAction('play-pause') },
      { label: 'Previous', accelerator: 'F7', click: () => sendMenuAction('prev-track') },
      { label: 'Next', accelerator: 'F9', click: () => sendMenuAction('next-track') },
      { type: 'separator' },
      { label: 'Increase Volume', accelerator: 'CmdOrCtrl+Up', click: () => sendMenuAction('volume-up') },
      { label: 'Decrease Volume', accelerator: 'CmdOrCtrl+Down', click: () => sendMenuAction('volume-down') },
      { type: 'separator' },
      { label: 'Go to Current Song', accelerator: 'CmdOrCtrl+L', click: () => sendMenuAction('show-now-playing') }
    ]
  },
  {
    label: 'View',
    submenu: [
      { label: 'Songs', click: () => sendMenuAction('view-songs') },
      { label: 'Artists', click: () => sendMenuAction('view-artists') },
      { label: 'Albums', click: () => sendMenuAction('view-albums') },
      { label: 'Genres', click: () => sendMenuAction('view-genres') },
      { type: 'separator' },
      { label: 'The Music Man', accelerator: 'Shift+CmdOrCtrl+M', click: () => sendMenuAction('toggle-music-man') },
      // ⌘T is handled in the renderer (Visualizer.tsx keydown) — show the
      // shortcut here without registering it, or one press toggles twice.
      { label: 'Visualizer', accelerator: 'CmdOrCtrl+T', registerAccelerator: false, click: () => sendMenuAction('toggle-visualizer') },
      { type: 'separator' },
      { label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', role: 'toggleDevTools' }
    ]
  },
]

// Search Wikipedia for artist info
async function searchWikipedia(query: string): Promise<string> {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=2&origin=*`
    const res = await fetch(url)
    if (!res.ok) return ''
    const data = await res.json() as { query?: { search?: { title: string }[] } }
    const pages = data.query?.search || []
    if (pages.length === 0) return ''
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pages[0].title)}`
    const summaryRes = await fetch(summaryUrl)
    if (!summaryRes.ok) return ''
    const summary = await summaryRes.json() as { extract?: string }
    return summary.extract || ''
  } catch {
    return ''
  }
}

// Search MusicBrainz for accurate music data (genre, country, years
// active, releases). 4.5.0-66 — routed through resolveCanonicalArtist
// so the right entity wins for common names like Drake / Beck / Bush.
async function searchMusicBrainz(artist: string, album?: string): Promise<string> {
  try {
    const libraryGenres = await getLibraryGenresForArtist(artist)
    const canon = await resolveCanonicalArtist(artist, { libraryGenres })
    if (!canon) return ''

    const parts: string[] = []
    parts.push(`${canon.name}${canon.disambiguation ? ` (${canon.disambiguation})` : ''}`)
    if (canon.type) parts.push(`Type: ${canon.type}`)
    if (canon.country) parts.push(`From: ${canon.country}`)
    if (canon.lifeSpan.begin) parts.push(`Active since: ${canon.lifeSpan.begin}${canon.lifeSpan.ended ? ' (disbanded)' : ''}`)
    if (canon.tags.length) parts.push(`Genres/tags: ${canon.tags.slice(0, 5).join(', ')}`)

    // If album provided, search for release info
    if (album) {
      try {
        await mbThrottle()
        const headers = { 'User-Agent': `JakeTunes/${app.getVersion()} (jacobrosenbaum@gmail.com)`, 'Accept': 'application/json' }
        // Constrain by the resolved MBID so the release picker doesn't
        // also pick up the wrong-Drake's albums.
        const releaseUrl = `https://musicbrainz.org/ws/2/release/?query=release:"${encodeURIComponent(album)}" AND arid:${canon.mbid}&fmt=json&limit=1`
        const releaseRes = await fetch(releaseUrl, { headers })
        if (releaseRes.ok) {
          const releaseData = await releaseRes.json() as { releases?: { title: string; date?: string; 'label-info'?: { label?: { name: string } }[] }[] }
          const release = releaseData.releases?.[0]
          if (release) {
            if (release.date) parts.push(`"${release.title}" released: ${release.date}`)
            const label = release['label-info']?.[0]?.label?.name
            if (label) parts.push(`Label: ${label}`)
          }
        }
      } catch { /* ignore release lookup errors */ }
    }

    return parts.join('. ')
  } catch {
    return ''
  }
}

// ── MusicBrainz discography fetcher (4.5) ───────────────────────────
// Used by ArtistDetailView's per-album drill-down to show the
// canonical tracklist with owned-vs-not badges. Returns the artist's
// release-group catalog (albums + EPs) with each album's tracklist
// (track titles + positions). Cached to disk for 7 days per artist,
// MusicBrainz ToS limits us to ~1 req/sec so a typical 12-album
// artist takes ~15s on a cold lookup; cached lookups are instant.
//
// Returned shape:
//   { albums: [{ title, year, tracks: [{ title, position }] }] }
//
// Renderer matches each canonical track to the user's library by
// (artist + normalized title) to compute the owned/not-owned dots.

interface DiscographyAlbum {
  title: string
  year: string  // 4-digit, or '' if unknown
  tracks: { title: string; position: number }[]
}
interface DiscographyResult {
  artist: string
  albums: DiscographyAlbum[]
  fetchedAt: number
  schemaVersion?: number
}

// Bump when the discography shape/filtering changes so old disk caches are
// ignored. v2: drop regional repackagings / hits comps via tracklist overlap
// (the US Capitol Beatles albums MusicBrainz doesn't flag as Compilation).
const DISCO_SCHEMA_VERSION = 2
const DISCO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MB_RATE_LIMIT_MS = 1100  // MB asks for ≤1 req/sec; pad to 1.1s
let mbLastRequestAt = 0

// 4.5.0-75 — serialized throttle (was racy). Old design: each caller
// read mbLastRequestAt, computed `since`, awaited the gap. With N
// concurrent callers (resolveCanonicalArtist firing from import +
// hover prefetch + chat lookup in parallel), every one of them saw
// the same lastRequestAt timestamp, all waited the same gap, all
// fired their fetch within milliseconds — MB returned 429s that
// were swallowed by the per-call try/catch, leaving canonical
// names stale. Per Grok audit (#6).
//
// New design: chain promises so each call awaits the PRIOR call's
// release, not just a wall-clock interval. Single in-flight slot at
// a time. `.catch(() => undefined)` on the chain prevents one
// rejected call from poisoning every caller after it.
let mbChain: Promise<void> = Promise.resolve()
function mbThrottle(): Promise<void> {
  const my = mbChain.then(async () => {
    const since = Date.now() - mbLastRequestAt
    const wait = Math.max(0, MB_RATE_LIMIT_MS - since)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    mbLastRequestAt = Date.now()
  })
  mbChain = my.catch(() => undefined)
  return my
}

// 4.5.0-66 — canonical artist resolver. Single source of truth for
// "given a string like 'Drake', which MusicBrainz entity is the music
// artist the user means?" Used by Wikipedia bio, artist photo,
// discography, and chat artist-facts.
//
// Why this exists: every external lookup used to take the raw string
// and pass it directly to a backend (Wikipedia, Bandsintown, MB
// search). Common names ("Drake", "Beck", "Bush", "Train", "Cake",
// "Phoenix", "Madonna") hit disambiguation pages, wrong-artist photos,
// and wrong-MBID discographies. This resolver picks the right entity
// ONCE and returns enough metadata that every downstream lookup uses
// the disambiguated identity instead of the raw string.
//
// Resolution strategy:
//   1. MB search with the raw name, fetch up to 10 candidates with
//      url-rels (so we can extract wiki links).
//   2. Filter to type=Person|Group (drops places, characters, fictional).
//   3. Score = MB's own `score` + a library-context boost if the
//      candidate's tags overlap with genres the user actually has
//      tracks in for this artist. This is the key disambiguator —
//      the "Drake" with rap tags wins because the user's Drake tracks
//      are tagged rap, not Welsh-language-medieval-figure.
//   4. Returns canonical name, MBID, type, life-span, country, the top
//      MB tags, AND the canonical Wikipedia title (via url-rels) if MB
//      knows one — that's the authoritative wiki page to fetch, no
//      "(musician)" suffix-guessing needed.
//
// 24h cache keyed by lowercase artist name + the genre-hint hash. A
// genre-hint change re-resolves (rare; happens when the user adds
// tracks of a new genre for the same artist name).
interface CanonicalArtist {
  name: string            // MB's canonical capitalization
  mbid: string
  type: 'Person' | 'Group' | 'Other' | ''
  country: string
  lifeSpan: { begin?: string; end?: string; ended?: boolean }
  tags: string[]          // top tags, score-sorted, lowercased
  wikiTitle: string | null // canonical wikipedia article title if MB has the relation
  disambiguation: string  // MB's own disambiguation string ("rapper", etc.) when present
}
const CANONICAL_CACHE_DIR = join(app.getPath('userData'), 'canonical-artist-cache')
const CANONICAL_TTL_MS = 24 * 60 * 60 * 1000
async function resolveCanonicalArtist(
  rawName: string,
  opts?: { libraryGenres?: string[] },
): Promise<CanonicalArtist | null> {
  if (!rawName || typeof rawName !== 'string') return null
  const name = rawName.trim()
  if (!name) return null
  const genreHint = (opts?.libraryGenres || [])
    .map(g => g.toLowerCase().trim())
    .filter(Boolean)
    .sort()
    .join('|')
  const cacheKey = createHash('md5').update(`${name.toLowerCase()}::${genreHint}`).digest('hex')
  const cachePath = join(CANONICAL_CACHE_DIR, `${cacheKey}.json`)
  await mkdir(CANONICAL_CACHE_DIR, { recursive: true }).catch(() => {})
  // Cache hit
  try {
    const st = await stat(cachePath)
    if (Date.now() - st.mtimeMs < CANONICAL_TTL_MS) {
      return JSON.parse(await readFile(cachePath, 'utf-8')) as CanonicalArtist
    }
  } catch { /* miss */ }

  await mbThrottle()
  const headers = {
    'User-Agent': `JakeTunes/${app.getVersion()} (jacobrosenbaum@gmail.com)`,
    'Accept': 'application/json',
  }
  try {
    const url = `https://musicbrainz.org/ws/2/artist/?query=artist:"${encodeURIComponent(name)}"&fmt=json&limit=10&inc=url-rels+tags`
    const res = await fetch(url, { headers })
    if (!res.ok) return null
    const data = await res.json() as {
      artists?: Array<{
        id: string
        name: string
        type?: string
        score?: number
        country?: string
        disambiguation?: string
        'life-span'?: { begin?: string; end?: string; ended?: boolean }
        tags?: Array<{ name: string; count: number }>
        relations?: Array<{ type: string; url?: { resource?: string } }>
      }>
    }
    const candidates = (data.artists || [])
      .filter(a => a.type === 'Person' || a.type === 'Group')
    if (candidates.length === 0) return null
    // Score: MB's score + library-genre overlap bonus. The bonus is
    // sized to dominate ties between "score 100" entries (which is
    // what an exact name match always returns) — for "Drake" both the
    // rapper and the historical figure score 100, but only the rapper
    // has tags overlapping with the user's Drake-tagged-as-rap tracks.
    const genreSet = new Set((opts?.libraryGenres || []).map(g => g.toLowerCase()))
    const scored = candidates.map(c => {
      let s = c.score || 0
      const tags = (c.tags || []).map(t => t.name.toLowerCase())
      for (const t of tags) {
        for (const g of genreSet) {
          if (t === g || t.includes(g) || g.includes(t)) { s += 25; break }
        }
      }
      return { c, s }
    }).sort((a, b) => b.s - a.s)
    const top = scored[0].c
    const wikiRel = (top.relations || []).find(r => r.type === 'wikipedia' && r.url?.resource)
    const wikiTitle = wikiRel?.url?.resource
      ? decodeURIComponent(wikiRel.url.resource.split('/wiki/')[1] || '').replace(/_/g, ' ')
      : null
    const result: CanonicalArtist = {
      name: top.name,
      mbid: top.id,
      type: (top.type === 'Person' || top.type === 'Group') ? top.type : (top.type ? 'Other' : ''),
      country: top.country || '',
      lifeSpan: top['life-span'] || {},
      tags: (top.tags || [])
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .map(t => t.name.toLowerCase()),
      wikiTitle,
      disambiguation: top.disambiguation || '',
    }
    await writeFile(cachePath, JSON.stringify(result)).catch((err) => console.warn('[canonical] cache write failed:', err?.message ?? err))
    return result
  } catch (err) {
    console.warn('[resolveCanonicalArtist] failed for', name, err)
    return null
  }
}

// Helper: read the user's library and return the genre set for tracks
// by `artistName` (case-insensitive). Used to feed `libraryGenres` into
// resolveCanonicalArtist — the disambiguator that makes Drake-the-
// rapper win over Drake-the-Welsh-figure for a user whose Drake tracks
// are tagged "Rap."
async function getLibraryGenresForArtist(artistName: string): Promise<string[]> {
  try {
    const raw = await readFile(LIBRARY_PATH, 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: Array<{ artist?: string; genre?: string }> }
    const norm = artistName.toLowerCase().trim()
    const genres = new Set<string>()
    for (const t of lib.tracks || []) {
      if ((t.artist || '').toLowerCase().trim() !== norm) continue
      const g = (t.genre || '').trim()
      if (g) genres.add(g)
    }
    return Array.from(genres)
  } catch { return [] }
}

function discoCachePath(artist: string): string {
  const safe = artist.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80)
  return join(app.getPath('userData'), 'discography-cache', `${safe}.json`)
}

// ── Scene-graph reach (2026-08-07, the Ceremony problem) ─────────────
// Jake found Ceremony because a record-store manager played them — a
// SCENE connection (labels, splits, bandmates), not a sonic one. Sonic
// neighbors mirror the library; scene neighbors extend it the way a
// clerk does. This walks the HUMAN-MADE graph on MusicBrainz: an anchor
// artist's collaborators/bandmates plus their independent labels'
// rosters, one hop past the library's edge. Majors are excluded — a
// scene is Bridge Nine or Deathwish, not Universal.
const SCENE_MAJOR_LABELS = /columbia|universal|warner|atlantic|interscope|capitol|epic\b|rca|island|geffen|republic|\bemi\b|sony|virgin|mercury|elektra|arista|def jam|polydor/i
async function fetchSceneNeighbors(anchor: string): Promise<Array<{ name: string; connection: string; sampleTitle?: string }>> {
  const headers = {
    'User-Agent': `JakeTunes/${app.getVersion()} (jacobrosenbaum@gmail.com)`,
    'Accept': 'application/json',
  }
  const out = new Map<string, { connection: string; sampleTitle?: string }>()
  try {
    const libraryGenres = await getLibraryGenresForArtist(anchor)
    const canon = await resolveCanonicalArtist(anchor, { libraryGenres })
    if (!canon) return []
    // Direct human relations: bandmates, side projects, collaborations.
    await mbThrottle()
    const relRes = await fetch(`https://musicbrainz.org/ws/2/artist/${canon.mbid}?inc=artist-rels&fmt=json`, { headers, signal: AbortSignal.timeout(8000) })
    if (relRes.ok) {
      const rel = await relRes.json() as { relations?: Array<{ type?: string; artist?: { name?: string } }> }
      for (const r of rel.relations || []) {
        const n = r.artist?.name
        // Tribute/parody acts point AT the anchor, not into their scene.
        if (/tribute|parody/i.test(r.type || '')) continue
        if (n && n.toLowerCase() !== anchor.toLowerCase() && !out.has(n)) {
          out.set(n, { connection: `${r.type || 'connected'} · ${anchor}` })
        }
      }
    }
    // Label rosters: who else lives on the anchor's independent labels.
    await mbThrottle()
    const relsRes = await fetch(`https://musicbrainz.org/ws/2/release?artist=${canon.mbid}&inc=labels&fmt=json&limit=25`, { headers, signal: AbortSignal.timeout(8000) })
    if (relsRes.ok) {
      const data = await relsRes.json() as { releases?: Array<{ title?: string; 'label-info'?: Array<{ label?: { id?: string; name?: string } }> }> }
      const labelCount = new Map<string, { id: string; name: string; n: number }>()
      for (const rl of data.releases || []) {
        for (const li of rl['label-info'] || []) {
          const lb = li.label
          if (!lb?.id || !lb.name || SCENE_MAJOR_LABELS.test(lb.name)) continue
          const e = labelCount.get(lb.id) || { id: lb.id, name: lb.name, n: 0 }
          e.n++
          labelCount.set(lb.id, e)
        }
      }
      const topLabels = [...labelCount.values()].sort((a, b) => b.n - a.n).slice(0, 2)
      for (const lb of topLabels) {
        await mbThrottle()
        const rosterRes = await fetch(`https://musicbrainz.org/ws/2/release?label=${lb.id}&inc=artist-credits&fmt=json&limit=60`, { headers, signal: AbortSignal.timeout(8000) })
        if (!rosterRes.ok) continue
        const roster = await rosterRes.json() as { 'release-count'?: number; releases?: Array<{ title?: string; 'artist-credit'?: Array<{ name?: string }> }> }
        // Distributor detector by ROSTER SHAPE (2026-08-07, the Celia
        // Cruz incident): a scene label's releases REPEAT its bands (SST:
        // ~20 artists per 60 releases); a distributor's are strangers
        // shipping boxes (Cargo). Release counts proved useless (SST 564
        // vs Cargo 240) and MB label "type" is usually unset — the shape
        // of the roster itself is the honest signal.
        if ((roster['release-count'] ?? 0) > 1500) continue
        const rosterArtists = new Set<string>()
        for (const rl of roster.releases || []) {
          for (const ac of rl['artist-credit'] || []) if (ac.name) rosterArtists.add(ac.name.toLowerCase())
        }
        if (rosterArtists.size > 35) continue
        for (const rl of roster.releases || []) {
          for (const ac of rl['artist-credit'] || []) {
            const n = ac.name
            if (n && n.toLowerCase() !== anchor.toLowerCase() && !out.has(n)) {
              out.set(n, { connection: `label-mates with ${anchor} on ${lb.name}`, sampleTitle: rl.title })
            }
          }
        }
      }
    }
  } catch { /* scene reach is best-effort */ }
  return [...out.entries()].map(([name, v]) => ({ name, connection: v.connection, sampleTitle: v.sampleTitle }))
}

async function fetchArtistDiscography(artist: string): Promise<DiscographyResult | null> {
  const cachePath = discoCachePath(artist)
  // Cache hit
  try {
    const raw = await readFile(cachePath, 'utf-8')
    const cached = JSON.parse(raw) as DiscographyResult
    if (cached.schemaVersion === DISCO_SCHEMA_VERSION && cached.fetchedAt && Date.now() - cached.fetchedAt < DISCO_CACHE_TTL_MS) {
      return cached
    }
  } catch { /* miss */ }

  const headers = {
    'User-Agent': `JakeTunes/${app.getVersion()} (jacobrosenbaum@gmail.com)`,
    'Accept': 'application/json',
  }

  try {
    // 1. Resolve artist MBID via the canonical resolver — uses library
    //    genre context to pick the right entity for common names. Old
    //    in-line `.find(exact-name-match) ?? first` consistently picked
    //    the wrong "Drake" / "Beck" / "Bush" MBID, giving the user
    //    someone else's discography on common-name artists.
    const libraryGenres = await getLibraryGenresForArtist(artist)
    const canon = await resolveCanonicalArtist(artist, { libraryGenres })
    if (!canon) return null
    const mbid = canon.mbid

    // 2. Fetch release-groups (albums + EPs, sorted by date)
    await mbThrottle()
    const rgUrl = `https://musicbrainz.org/ws/2/release-group?artist=${mbid}&type=album|ep&fmt=json&limit=100`
    const rgRes = await fetch(rgUrl, { headers })
    if (!rgRes.ok) return null
    const rgData = await rgRes.json() as {
      'release-groups'?: Array<{ id: string; title: string; 'first-release-date'?: string; 'primary-type'?: string; 'secondary-types'?: string[] }>
    }
    // 4.5.0-66 — also filter on secondary-types. Old behavior accepted any
    // release-group whose primary-type was Album/EP, which leaked Compilation/
    // Live/Remix/DJ-mix entries into the list. Studio albums only — but ALLOW
    // Soundtrack, so a band's own film-soundtrack ALBUMS (A Hard Day's Night,
    // Help!) survive; the tracklist-overlap dedup below catches the comps that
    // MB mislabels as plain "Album".
    const rgs = (rgData['release-groups'] || [])
      .filter(rg => rg['primary-type'] === 'Album' || rg['primary-type'] === 'EP')
      .filter(rg => (rg['secondary-types'] || []).every(s => s.toLowerCase() === 'soundtrack'))
      .sort((x, y) => (y['first-release-date'] || '').localeCompare(x['first-release-date'] || ''))
      .slice(0, 30)  // cap at 30 release groups per artist — keeps fetch under ~35s worst-case
      // Then process OLDEST-first so the tracklist-overlap dedup below keeps the
      // ORIGINAL album and drops later repackagings of it.
      .sort((x, y) => (x['first-release-date'] || '').localeCompare(y['first-release-date'] || ''))

    const albums: DiscographyAlbum[] = []
    // Tracklist-overlap dedup: MusicBrainz tags the US Capitol/Vee-Jay Beatles
    // albums (Meet The Beatles!, Beatles VI, …) as plain "Album", so type alone
    // can't catch them. Track which song titles we've already kept (oldest-
    // first); if a later album is mostly the same songs, it's a repackaging.
    const seenTitles = new Set<string>()
    const normTrackTitle = (s: string) => foldAccents(s).replace(/[^a-z0-9]/g, '')
    // 3. For each release group, fetch one release with recordings (the
    // tracklist). Sequential because of the rate limit.
    for (const rg of rgs) {
      try {
        await mbThrottle()
        const relUrl = `https://musicbrainz.org/ws/2/release?release-group=${rg.id}&inc=recordings&fmt=json&limit=1`
        const relRes = await fetch(relUrl, { headers })
        if (!relRes.ok) continue
        const relData = await relRes.json() as {
          releases?: Array<{
            id: string
            date?: string
            media?: Array<{ tracks?: Array<{ title: string; position: number }> }>
          }>
        }
        const release = relData.releases?.[0]
        if (!release) continue
        const tracks: { title: string; position: number }[] = []
        for (const m of release.media || []) {
          for (const t of m.tracks || []) {
            tracks.push({ title: t.title, position: t.position })
          }
        }
        if (tracks.length === 0) continue
        // If ≥30% of this album's songs already appeared on earlier albums,
        // it's a repackaging/hits comp — not a new studio record. Skip it.
        // 0.3 sits in the clean gap measured on the Beatles' catalog: real
        // studio albums score 0.00–0.14 overlap, the US Capitol comps 0.36+.
        const titles = tracks.map(t => normTrackTitle(t.title)).filter(Boolean)
        const overlap = titles.filter(t => seenTitles.has(t)).length
        if (titles.length >= 4 && overlap / titles.length > 0.3) continue
        for (const t of titles) seenTitles.add(t)
        const year = (rg['first-release-date'] || release.date || '').slice(0, 4)
        albums.push({ title: rg.title, year, tracks })
      } catch { /* skip this release group */ }
    }

    // Restore newest-first for display.
    albums.sort((a, b) => (b.year || '').localeCompare(a.year || ''))

    const result: DiscographyResult = { artist, albums, fetchedAt: Date.now(), schemaVersion: DISCO_SCHEMA_VERSION }
    // Persist to disk
    try {
      await mkdir(join(app.getPath('userData'), 'discography-cache'), { recursive: true })
      await writeFile(cachePath, JSON.stringify(result), 'utf-8')
    } catch (err) {
      console.warn('[discography] cache write failed:', err)
    }
    return result
  } catch (err) {
    console.warn('[discography] fetch failed:', err)
    return null
  }
}

ipc.handle('get-artist-discography', async (_e, artist: string) => {
  if (!artist || typeof artist !== 'string') return { ok: false, error: 'No artist' }
  const result = await fetchArtistDiscography(artist)
  if (!result) return { ok: false, error: 'Discography unavailable' }
  return { ok: true, albums: result.albums }
}, { refuse: REFUSED_SENDER })

// Combined multi-source search for artist info
// 4.5: Exa.ai added as a third source. Runs in parallel with Wikipedia
// + MusicBrainz; concatenated into the artist-facts block fed to every
// Music Man / Megan / Stephen / chat call. Skips silently if
// EXA_API_KEY is missing — Wikipedia + MusicBrainz still ground the
// facts. Query templates live in src/main/exa.ts — edit those to tune
// what Exa actually retrieves.
async function searchWeb(query: string, album?: string, mode: 'artist' | 'chat' = 'artist'): Promise<string> {
  const { exaArtistFacts, exaArtistAlbum, exaChatContext } = await import('./exa')
  const artist = query.replace(/\s*(musician|band|artist|music)\s*/gi, '').trim()
  // 'chat': the query is a whole user message, not an artist name. Before
  // this mode existed it went through the artistFacts template, so "what
  // should I spin tonight" became a hunt for an artist by that name.
  const exaPromise = mode === 'chat'
    ? exaChatContext(query)
    : album ? exaArtistAlbum(artist, album) : exaArtistFacts(artist)
  const [wiki, mb, exa] = await Promise.all([
    searchWikipedia(query),
    searchMusicBrainz(artist, album),
    exaPromise,
  ])
  const parts = []
  if (mb) parts.push(`[MusicBrainz] ${mb}`)
  if (wiki) parts.push(`[Wikipedia] ${wiki}`)
  if (exa) parts.push(exa)
  return parts.join('\n\n')
}

// 4.5: short-lived cache for artist-fact lookups. Hover-prefetch from the
// mic button writes here; the streaming musicman-dj handler reads here.
// 5 min TTL is long enough to cover "user hovers mic, takes a beat,
// clicks" + the streaming response itself, short enough that stale facts
// don't pile up if the user leaves the app open for hours. Keyed on a
// normalized artist+album signature so prefetches for the same track
// from different views coalesce.
interface FactCacheEntry { value: string; expiresAt: number }
const factCache = new Map<string, FactCacheEntry>()
const FACT_CACHE_TTL_MS = 5 * 60 * 1000

function factCacheKey(artist: string, album: string): string {
  return `${(artist || '').toLowerCase().trim()}|||${(album || '').toLowerCase().trim()}`
}

async function searchWebCached(query: string, album?: string): Promise<string> {
  const artist = query.replace(/\s*(musician|band|artist|music)\s*/gi, '').trim()
  const key = factCacheKey(artist, album || '')
  const now = Date.now()
  const cached = factCache.get(key)
  if (cached && cached.expiresAt > now) return cached.value
  const value = await searchWeb(query, album)
  factCache.set(key, { value, expiresAt: now + FACT_CACHE_TTL_MS })
  return value
}

// 4.5: sync-time bitrate conversion. Re-encodes lossless tracks
// (ALAC/FLAC/WAV/AIFF) into AAC at the user-chosen target before they
// land on the iPod — same iTunes feature as "Convert higher bit rate
// songs to 256 kbps AAC". Saves typically 4-6x space on lossless
// libraries without touching the master files on the laptop.
//
// Cache layout: userData/sync-convert-cache/<sha1(src+target)>.m4a
// Mtime-keyed freshness so re-syncs reuse existing mirrors instantly.
// Separate from the play-cache (which is ALAC→256k only, for Chromium
// playback) because sync target is user-selectable (128/192/256) and
// we don't want the play-cache hit to silently downgrade playback
// quality when the user picks a sync target other than 256.
const SYNC_CONVERT_CACHE_SUBDIR = 'sync-convert-cache'
const LOSSLESS_EXTS = new Set(['.alac', '.flac', '.wav', '.wave', '.aiff', '.aif'])
const LOSSLESS_CODECS = new Set(['alac', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s16be', 'pcm_s24be'])

// Is Apple's afconvert (the CoreAudio AAC encoder that iTunes itself used)
// available? Memoized. We prefer it over ffmpeg's native `aac` encoder for
// iPod sync mirrors: the device's ~20-year-old hardware AAC decoder is the
// same lineage as afconvert's output, whereas ffmpeg's native-AAC bitstream
// — though spec-clean and decode-perfect in software — is the one variable
// that changed the sync Jake reported as "a lot of squeaks" (2026-07-11).
// macOS-only; every other platform falls back to (capped) ffmpeg.
let _afconvertOk: Promise<boolean> | null = null
async function afconvertAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  if (_afconvertOk) return _afconvertOk
  _afconvertOk = (async () => {
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      await promisify(execFile)('afconvert', ['--help'], { timeout: 4000 })
      return true
    } catch { return false }
  })()
  return _afconvertOk
}

async function buildAacMirror(srcPath: string, targetKbps: number): Promise<string | null> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const execP = promisify(execFile)
  const { createHash } = await import('crypto')

  // Quick ext gate: if the source doesn't smell lossless, skip without
  // even probing. Saves the ~200-500ms ffprobe round trip per non-
  // lossless track in a large library sync.
  const ext = srcPath.slice(srcPath.lastIndexOf('.')).toLowerCase()
  let probeNeeded = LOSSLESS_EXTS.has(ext)
  // .m4a files can be either ALAC (lossless) or AAC (already
  // compressed). Need ffprobe to tell which.
  if (ext === '.m4a' || ext === '.mp4') probeNeeded = true
  if (!probeNeeded) return null

  // Source mtime gates cache freshness.
  const srcStat = await stat(srcPath).catch(() => null)
  if (!srcStat) return null

  // ffprobe codec
  let codec = ''
  try {
    const { stdout } = await execP('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', srcPath,
    ], { timeout: 5000 })
    codec = (stdout || '').trim().toLowerCase()
  } catch {
    return null
  }
  // Remember the codec so future syncs short-circuit the byte-identical
  // skip without paying for another ffprobe + USB recopy round-trip.
  if (codec) codecByAbsPath.set(srcPath, codec)
  if (!LOSSLESS_CODECS.has(codec)) return null  // AAC, MP3, etc — keep as-is

  // Cache path keyed on source + target bitrate. Different bitrates
  // produce different mirror files.
  const cacheDir = join(app.getPath('userData'), SYNC_CONVERT_CACHE_SUBDIR)
  await mkdir(cacheDir, { recursive: true }).catch(() => {})
  // Cache key carries an encoder-format version token. `afenc-44100-2-v2`
  // invalidates every mirror produced by the old ffmpeg-native path so the
  // next sync re-encodes them with afconvert + the iPod-safe 44.1k/stereo
  // cap. Bump this token whenever the encode recipe changes.
  const hash = createHash('sha1').update(`${srcPath}|${targetKbps}|afenc-cbr-44100-2-v3`).digest('hex').slice(0, 16)
  const cached = join(cacheDir, `${hash}.m4a`)
  try {
    const cStat = await stat(cached)
    if (cStat.mtimeMs >= srcStat.mtimeMs) return cached  // fresh
  } catch { /* not cached yet */ }

  // Transcode. ~5-30s per track depending on length + CPU.
  const tmp = cached + '.partial.m4a'
  const { rename: renameFS } = await import('fs/promises')
  try {
    if (await afconvertAvailable()) {
      // Two-stage, iPod-native path: ffmpeg decodes ANY source (FLAC/ALAC/
      // WAV/AIFF, incl. hi-res) down to clean 44.1kHz/16-bit stereo LPCM;
      // Apple's afconvert then encodes AAC-LC that the iPod hardware decoder
      // is guaranteed to handle. The -ar/-ac cap also fixes any >48kHz
      // source that the old ffmpeg-only path passed through untouched.
      const pcm = cached + '.partial.wav'
      try {
        await execP('ffmpeg', [
          '-nostdin', '-y', '-i', srcPath, '-vn',
          '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le',
          '-f', 'wav', pcm,
        ], { timeout: 600000 })
        await execP('afconvert', [
          pcm, '-o', tmp,
          '-d', 'aac',                    // AAC-LC (not aach/HE — iPod-safe)
          '-f', 'm4af',                   // MPEG-4 Audio container (.m4a)
          '-b', String(targetKbps * 1000),
          '-q', '127',                    // max encoder quality
          '-s', '0',                      // TRUE CBR — the iTunes-era-native mode every Mini shipped against
        ], { timeout: 600000 })
        await renameFS(tmp, cached)
        return cached
      } finally {
        try { await unlink(pcm) } catch { /* already gone */ }
      }
    }

    // Fallback (non-macOS / afconvert missing): ffmpeg native AAC, but now
    // hard-capped to iPod-safe 44.1kHz/stereo so a hi-res source can never
    // pass through at a rate the device can't clock.
    await execP('ffmpeg', [
      '-nostdin', '-y', '-i', srcPath, '-vn',
      '-c:a', 'aac', '-b:a', `${targetKbps}k`,
      '-ar', '44100', '-ac', '2',
      '-map_metadata', '0',
      '-movflags', '+faststart',
      tmp,
    ], { timeout: 600000 })
    await renameFS(tmp, cached)
    return cached
  } catch (err) {
    try { await unlink(tmp) } catch { /* already gone */ }
    console.warn(`[sync-convert] transcode failed for ${srcPath}:`, err)
    return null
  }
}

/**
 * FLAC (and only FLAC) → 16-bit / 44.1 kHz ALAC .m4a for the Mini.
 * Activity sync is ALAC-on-purpose — do not route this through AAC.
 * Mini 1.4.1 cannot index .flac; 2026-08-15 left Cassius "Feeling for You"
 * on the card as FLAC and that row is the same skip class as 497.
 */
async function buildIpodSafeAlacMirror(srcPath: string): Promise<string | null> {
  const srcStat = await stat(srcPath).catch(() => null)
  if (!srcStat) return null
  const cacheDir = join(app.getPath('userData'), SYNC_CONVERT_CACHE_SUBDIR)
  await mkdir(cacheDir, { recursive: true }).catch(() => {})
  const { createHash } = await import('crypto')
  const hash = createHash('sha1').update(`${srcPath}|ipod-alac-16-44100-v1`).digest('hex').slice(0, 16)
  const cached = join(cacheDir, `${hash}.m4a`)
  try {
    const cStat = await stat(cached)
    if (cStat.mtimeMs >= srcStat.mtimeMs && cStat.size > 0) return cached
  } catch { /* miss */ }
  const tmp = cached + '.partial.m4a'
  try {
    await convertAudio(srcPath, tmp, 'alac')
    await rename(tmp, cached)
    return cached
  } catch (err) {
    try { await unlink(tmp) } catch { /* already gone */ }
    console.warn(`[sync-alac] FLAC→ALAC failed for ${srcPath}:`, err)
    return null
  }
}

// ── Auto-detect iPod (cross-platform: scans /Volumes/ on macOS, drive letters on Windows) ──
let detectedIpodMount: string | null = null  // Full mount path: "/Volumes/JACOBROSENB" or "E:\\"
let detectedIpodVolume: string | null = null // Display name: "JACOBROSENB" or "E:"
// Debounce: iFlash-modded iPods on macOS's fskit FAT32 driver FLAP — the
// volume drops out of /Volumes for a scan or two while staying fully
// readable, so a single missed poll would make the iPod vanish from the UI
// mid-use (Jake 2026-07-23). Tolerate a few consecutive misses before we
// believe it's really gone, and re-stat the last-known iTunesDB directly
// (that read survives a /Volumes readdir hiccup) before counting a miss.
let ipodMissStreak = 0

// Wired up by the ipod-audio protocol handler inside app.whenReady().
// Call with a list of absolute source-file paths to kick off background
// ALAC -> AAC transcodes into the play cache, so first playback of a
// freshly-ripped lossless track doesn't stall on a 2-3s transcode.
let prewarmAlacCache: (paths: string[]) => Promise<void> = async () => { /* not wired yet */ }

// Register a known codec for a file we just wrote, so the play handler
// can skip the ~300ms ffprobe round-trip on first play. Known codecs
// bypass ffprobe entirely on the next access. Wired up alongside
// prewarmAlacCache when the audio protocol handler initialises.
let registerKnownCodec: (path: string, mtime: number, codec: string) => void = () => {}

// Read directly from iPod database (used for sync only).
// If the mount hasn't been detected yet (e.g. load-tracks fires before
// the renderer calls check-ipod-mounted), probe for it here so we
// don't spuriously return "no iPod" when the device is actually
// plugged in. Prevents the "library went empty" footgun on cold start.
async function readIpodDatabase(): Promise<{ tracks: Array<Record<string, unknown>>; playlists: Array<{ name: string; trackIds: number[] }> }> {
  if (!detectedIpodMount) {
    try {
      detectedIpodMount = await findIpodMount()
      detectedIpodVolume = detectedIpodMount ? volumeNameFromMount(detectedIpodMount) : null
    } catch {
      /* swallow — handled below */
    }
  }
  if (!detectedIpodMount) throw new Error('No iPod detected')
  const ipodDbPath = join(detectedIpodMount, 'iPod_Control', 'iTunes', 'iTunesDB')
  const scriptPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/db_reader.py')
  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON_CMD ?? 'python3', [scriptPath, '--json', ipodDbPath])
    py.on('error', (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(PYTHON_INSTALL_HINT))
      } else {
        reject(err)
      }
    })
    let stdout = ''
    let stderr = ''
    py.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    py.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    py.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`db_reader.py exited with code ${code}: ${stderr}`))
      } else {
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error(`Invalid JSON from db_reader.py: ${stdout.slice(0, 200)}`))
        }
      }
    })
  })
}

// 4.5.0-90 — STATE_DIR resolves to NAS (/Volumes/JakeShared/JakeTunesState)
// when mounted at app boot, else falls back to userData. See state-dir.ts.
const LIBRARY_PATH = join(STATE_DIR, 'library.json')
// Here rather than at startup: the digest's throttled refresh reads this
// path, and a user metadata edit can land before any startup IIFE finishes.
initLibraryDigest({ libraryPath: LIBRARY_PATH })

// Pre-load self-heal for failed atomic saves.
//
// V3's save-library writes to a temp sidecar (`<lib>.partial.json` or
// `<lib>.new`) and then atomically renames over `library.json`. On a
// healthy local FS that's bulletproof. On SMB-mounted state dirs
// (macOS Sequoia + Synology) the rename intermittently fails with
// "Resource busy (16)" when another process or a wedged kernel SMB
// session holds a stale handle on `library.json`. When that happens:
//   - the sidecar file is left on disk with the FULL up-to-date state
//   - `library.json` keeps the old state
//   - if V3 quits before retry succeeds, the next launch reads the
//     stale `library.json` and the in-memory imports are lost
//
// 2026-05-28 incident: 31 imports (Marlo Thomas + Death Lens) sat in
// `library.json.partial.json` for ~20 min while V3 retried; required
// manual unmount/remount + mv to recover. This helper makes the next
// recurrence self-healing: on every load, before reading library.json,
// check the partial sidecars. If one has STRICTLY more tracks than the
// current library.json, swap it in. Identical or smaller sidecars are
// cleaned up (they're stale from a save where atomic-rename had
// completed but the sidecar got orphaned for some other reason).
async function recoverPartialIfNewer(libraryPath: string): Promise<void> {
  const candidates = [`${libraryPath}.partial.json`, `${libraryPath}.new`]
  const { rename, unlink } = await import('fs/promises')
  let currentTrackCount = 0
  try {
    const cur = JSON.parse(await readFile(libraryPath, 'utf-8'))
    currentTrackCount = Array.isArray(cur?.tracks) ? cur.tracks.length : 0
  } catch { /* current missing or unparseable — any non-empty partial wins */ }

  for (const candidate of candidates) {
    let partialTrackCount = 0
    try {
      const partial = JSON.parse(await readFile(candidate, 'utf-8'))
      partialTrackCount = Array.isArray(partial?.tracks) ? partial.tracks.length : 0
    } catch {
      continue // candidate missing or unparseable — leave it for next run
    }
    if (partialTrackCount === 0) continue
    if (partialTrackCount > currentTrackCount) {
      try {
        await rename(candidate, libraryPath)
        console.log(`[load-tracks] RECOVERED ${partialTrackCount - currentTrackCount} tracks from ${candidate} (current had ${currentTrackCount}, partial has ${partialTrackCount})`)
        currentTrackCount = partialTrackCount
      } catch (err) {
        console.warn(`[load-tracks] partial recovery rename failed for ${candidate}:`, err)
      }
    } else {
      try { await unlink(candidate) } catch { /* concurrent cleanup race — fine */ }
    }
  }
}

// 4.5.0-106 Phase 2.5 — singleton in-memory caches for the hottest NAS
// state files. Lazy-loaded on first access, mutated in RAM, flushed to
// NAS in the background. See state-cache.ts.
//
// Library cache is read-only (writes still go through the save-tracks
// atomic-rename path which uses a pre-write disk read for deleted-path
// diff). Callers that mutate via save-tracks invalidate the cache so
// the next read picks up fresh content.
interface CachedLibrary { tracks: unknown[]; playlists?: unknown[] }
const libraryCache = new JsonFileCache<CachedLibrary>(
  () => LIBRARY_PATH,
  () => ({ tracks: [], playlists: [] }),
  'library',
)
// RAG retrieval core lives in ai/rag-retrieval.ts (6.0 Phase 1) — hand
// it its world before any retrieval call can fire.
initRagRetrieval({ libraryCache, libraryPath: () => LIBRARY_PATH })
const overridesCache = new JsonFileCache<Record<string, unknown>>(
  () => join(STATE_DIR, 'metadata-overrides.json'),
  () => ({}),
  'overrides',
)
// Lyrics sidecar (lyrics.json) — grounded lyrics from LRCLIB, written by
// scripts/lyrics-fetch.mjs and keyed by String(track.id). The desktop reads it
// LOCALLY for the Get Info Lyrics section; the LOCAL→NAS mirror (STATE_FILE_NAMES
// below) carries it to homemini so the nightly brain-trainer's "meaning" pass can
// read it. The laptop fetcher is the SINGLE writer. NEVER fabricated: a genuine
// not-found is { miss:true }, an instrumental { instrumental:true }.
// ⚠️ Schema mirror: scripts/lyrics-fetch.mjs recordFrom() writes this exact shape.
export interface LyricsRecord {
  plain?: string
  synced?: string
  instrumental?: boolean
  miss?: boolean
  source?: string
  lrclibId?: number
  fetchedAt?: number
}
const lyricsCache = new JsonFileCache<Record<string, LyricsRecord>>(
  () => join(STATE_DIR, 'lyrics.json'),
  () => ({}),
  'lyrics',
)
// Discovery feedback — the radar's memory of Jake's verdicts. notForMe keys
// are normalized artist names ("not for me" = that artist never surfaces in
// Discovery again); served tracks per-candidate view counts so stale cards
// rotate out instead of squatting for weeks (the Vince Staples bug).
interface DiscoveryFeedback {
  notForMe: Record<string, { artist: string; at: number }>
  served: Record<string, { first: number; last: number; views: number }>
}
const discoveryFeedbackCache = new JsonFileCache<DiscoveryFeedback>(
  () => join(STATE_DIR, 'discovery-feedback.json'),
  () => ({ notForMe: {}, served: {} }),
  'discovery-feedback',
)
// Friends ledger — who sends Jake music and how reliable they are. Updated on
// list adds ('add'), downloads that land ('got'), and tosses ('tossed');
// the Scouts strip in Listen to the List ranks by hit rate.
interface FriendEntry { name: string; adds: number; got: number; tossed: number; lastAt: number; imported?: number }
const friendsCache = new JsonFileCache<Record<string, FriendEntry>>(
  () => join(STATE_DIR, 'friends.json'),
  () => ({}),
  'friends',
)
// Friend credit RECORDS — the identity behind each earned credit, so points
// can be recomputed against the live library (deletion-aware standings).
// friends.json keeps the counters; this keeps the evidence.
const friendCreditsCache = new JsonFileCache<{ credits: import('./friend-standings-core.ts').CreditRecord[] }>(
  () => join(STATE_DIR, 'friend-credits.json'),
  () => ({ credits: [] }),
  'friend-credits',
)
const mobileStarsCache = new JsonFileCache<{ trackIds: string[] }>(
  () => join(STATE_DIR, 'mobile-stars.json'),
  () => ({ trackIds: [] }),
  'mobile-stars',
)
// Brief 121 — read-only mirrors of the iOS-owned playlist sidecars. V3
// never writes either file (the Mini's backend owns them), so these
// caches exist purely to keep startup reads off the SMB hot path.
// Same JsonFileCache contract as mobile-stars: error-fallback locks
// writes anyway, but we also just never call .update() on these.
export interface MobilePlaylistRecord { id: string; name: string; trackIds: string[]; createdAt?: string; source?: string }
const mobilePlaylistsCache = new JsonFileCache<{ playlists: MobilePlaylistRecord[] }>(
  () => join(STATE_DIR, 'mobile-playlists.json'),
  () => ({ playlists: [] }),
  'mobile-playlists',
)
// ── Phone-authored state mirrors — NAS → LOCAL refresh ──────────────
// The iOS app writes these on the NAS (via homemini). STATE_DIR is
// frozen at boot, so a boot that raced the SMB mount runs the whole
// session on the userData fallback — and nothing ever refreshed those
// local mirrors, so phone playlists silently rotted (stale since
// Jun 20 when Jake reported it, 2026-07-19). Refresh newer NAS copies
// into userData at boot + every 5 minutes and bust the caches so the
// next read serves fresh data in EITHER STATE_DIR mode.
// Song-info edits made ON THE PHONE — same {id: {fp, fields}} shape as the
// desktop's metadata-overrides.json, but a separate file so each device
// stays the single writer of its own edits. V3 never writes this; it
// mirrors + overlays it (see load-metadata-overrides).
const mobileMetadataOverridesCache = new JsonFileCache<Record<string, { fp?: string; fields?: Record<string, string> }>>(
  () => join(STATE_DIR, 'mobile-metadata-overrides.json'),
  () => ({}),
  'mobile-metadata-overrides',
)
const PHONE_AUTHORED_FILES = [
  // Phone playlist sidecars — names from @jaketunes/contracts
  // (sidecars.phonePlaylistSidecarsNeverPushFromDesktop). Pull/mirror only;
  // never blunt-push. See assertNoDesktopBluntPush(STATE_FILE_NAMES).
  ...phonePlaylistSidecarsNeverPushFromDesktop,
  'mobile-stars.json', 'mobile-plays.json',
  // Missing from this list until 2026-08-07 — phone song-info edits landed on
  // the NAS and simply never came down (Jake: "why arent the song info
  // updates appearing from my phone?? SEAMLESS SYNCING!!!").
  'mobile-metadata-overrides.json',
  // Phone Qobuz downloads (Brief-128/130 sidecar). Same 2026-08-07 lesson,
  // bigger stakes: the audio was already in the vault and the records on
  // the NAS, but nothing here ever read them — songs downloaded on the
  // phone simply never existed on desktop (Jake: "songs i downloaded on
  // mobile are not on desktop. why???"). Mirrored + pushed to the renderer,
  // which absorbs them into the library via ADD_IMPORTED_TRACKS; the mobile
  // backend then drops absorbed rows from its sidecar automatically.
  'mobile-imports.json',
]
async function refreshPhoneAuthoredMirrors(): Promise<void> {
  // 2026-08-30 ("do a better job of adding the songs i download on mobile
  // to the library"): mirroring moved to phone-mirrors.ts — HTTP from the
  // backend FIRST (works from anywhere), the flappy NAS mount only as
  // fallback. The old NAS-only path sat NINE DAYS stale behind breaker
  // cooldowns while phone downloads waited invisible.
  const refreshedNames = await refreshPhoneMirrors({
    files: PHONE_AUTHORED_FILES,
    localDir: app.getPath('userData'),
    nasDir: '/Volumes/JakeShared/JakeTunesState',
    backendUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    nasAvailable,
  })
  if (refreshedNames.length > 0) {
    mobilePlaylistsCache.invalidate()
    mobileStarsCache.invalidate()
    playlistAdditionsCache.invalidate()
    mobileMetadataOverridesCache.invalidate()
    console.log(`[phone-mirrors] refreshed ${refreshedNames.length} file(s) from NAS: ${refreshedNames.join(', ')}`)
    // Fresh phone song-info edits — push them to the open window so they
    // apply live (SEAMLESS), not on next launch. The renderer validates each
    // entry's fingerprint against the live track before applying.
    if (refreshedNames.includes('mobile-metadata-overrides.json')) {
      try {
        const ov = await mobileMetadataOverridesCache.get()
        sendToRenderer('mobile-overrides-updated', { overrides: ov })
      } catch { /* next boot's overlay still applies them */ }
    }
  }
  // Phone downloads: push on mid-session change. Boot-time absorb is
  // renderer-PULLED (get-mobile-imports below) — a boot push raced the
  // React listener mount and vanished silently (found live 2026-08-07:
  // Jake restarted, nothing absorbed, "is it though????").
  if (refreshedNames.includes('mobile-imports.json')) {
    try {
      const raw = await readFile(join(app.getPath('userData'), 'mobile-imports.json'), 'utf-8')
      const parsed = JSON.parse(raw) as { tracks?: unknown[] }
      const tracks = Array.isArray(parsed?.tracks) ? parsed.tracks : []
      if (tracks.length > 0 && mainWindow) {
        // Audio FIRST (pulled straight from homemini — no rsync, no NAS),
        // so the absorb always lands rows whose bytes are already on disk.
        await ensureMobileImportAudio(tracks as never, { libraryRoot: MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, ''), backendUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, '') })
        sendToRenderer('mobile-imports-updated', { tracks })
      }
    } catch { /* no imports yet — next tick retries */ }
  }
}

// Renderer pulls the phone-download sidecar AFTER its library loads —
// deterministic ordering, no boot race. Refreshes the NAS mirror first so
// a just-restarted app absorbs rows adopted while it was closed.
ipc.handle('get-mobile-imports', async () => {
  await refreshPhoneAuthoredMirrors().catch((err) => console.warn('[mobile-imports] mirror refresh failed (serving last-known rows):', err?.message ?? err))
  let overrides: Record<string, { fp?: string; fields?: Record<string, string> }> = {}
  try { overrides = await mobileMetadataOverridesCache.get() } catch { /* none yet */ }
  try {
    const raw = await readFile(join(app.getPath('userData'), 'mobile-imports.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { tracks?: unknown[] }
    const tracks = Array.isArray(parsed?.tracks) ? parsed.tracks : []
    if (tracks.length > 0) await ensureMobileImportAudio(tracks as never, { libraryRoot: MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, ''), backendUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, '') })
    return { tracks, overrides }
  } catch {
    return { tracks: [], overrides }
  }
}, { public: true })
setTimeout(() => { void refreshPhoneAuthoredMirrors() }, 5_000)
setInterval(() => { void refreshPhoneAuthoredMirrors() }, 5 * 60_000)

const playlistAdditionsCache = new JsonFileCache<Record<string, string[]>>(
  () => join(STATE_DIR, 'playlist-additions.json'),
  () => ({}),
  'playlist-additions',
)
const listenerProfileCache = new JsonFileCache<Record<string, unknown>>(
  () => join(STATE_DIR, 'listener-profile.json'),
  () => ({}),
  'listener-profile',
)

// Wire the listener profile here rather than at startup: it must be live
// before the first record-play IPC, and this is the earliest point where the
// cache it needs actually exists. discogsSummary and onReflect are FUNCTIONS —
// the Discogs blurb is fetched later, and generateObservation makes a Claude
// call this module deliberately doesn't own.
initListenerProfile({
  stateDir: STATE_DIR,
  profileCache: listenerProfileCache,
  discogsSummary: () => discogsCollection,
  activityBlock: getActivityPromptBlockSync,
  onReflect: () => { generateObservation().catch((err) => console.warn('[persona] observation generation failed:', err?.message ?? err)) },
})
const musicmanMemoryCache = new JsonFileCache<unknown[]>(
  () => join(STATE_DIR, 'musicman-memory.json'),
  () => [],
  'musicman-memory',
)
const playlistsCache = new JsonFileCache<unknown[]>(
  () => join(STATE_DIR, 'playlists.json'),
  () => [],
  'playlists',
)
// V5 Live Concert Mode — declared live sets. Key = albumKey
// (artist|||album, the renderer's canonical key), value = the merged
// track's id + exact per-song cue offsets. Synced one-way to homemini
// (see ~/bin/jaketunes-homemini-sync.sh) so mobile can grow a setlist
// UI later; V3 is the single writer.
// ⚠️ TWIN: src/renderer/types.ts LiveSetEntry (the renderer-side type).
export interface LiveSetEntry {
  mergedTrackId: number
  cues: Array<{ trackId: number; title: string; artist: string; startMs: number; durationMs: number }>
  totalDurationMs: number
  createdAt: string
  // Constituents reimported to the regular library (right-click → Add to
  // Library). Exempted from the concert's library-hide. See src/renderer/types.ts.
  promotedTrackIds?: number[]
  concert?: { venue?: string; city?: string; date?: string; poster?: string; facts?: string[]; notes?: string; source?: string; label?: string; merchUrl?: string; segments?: Array<{ before: number; label: string }> }  /* ⚠️ TWIN: renderer types.ts ConcertMeta */
}
const liveSetsCache = new JsonFileCache<Record<string, LiveSetEntry>>(
  () => join(STATE_DIR, 'live-sets.json'),
  () => ({}),
  'live-sets',
)

// 4.5.0-91 Phase 2.5 — orphaned-edit detection state. Populated by
// detectStateConflicts() at boot when STATE_IS_NAS. UI reads it via
// the get-state-conflicts IPC; reconcile-state-conflicts pushes the
// local-newer files to NAS (with .reconcile-bak snapshots of what
// got overwritten on NAS, in case the reconciliation itself was
// wrong). Skipped entirely in local-fallback mode (there's nothing
// to compare against).
const STATE_FILE_NAMES = [
  'library.json',
  'metadata-overrides.json',
  // Grounded LRCLIB lyrics sidecar. The laptop is the single writer; mirroring
  // it LOCAL→NAS is what lets homemini's nightly brain-trainer read lyrics for
  // its "meaning" enrichment pass. Same desktop-authored contract as overrides.
  'lyrics.json',
  'discovery-feedback.json',
  'friends.json',
  'playlists.json',
  'mobile-stars.json',
  'mobile-plays.json',
  // Phone playlist sidecars (sidecars.phonePlaylistSidecarsNeverPushFromDesktop
  // in @jaketunes/contracts) are deliberately ABSENT (2026-08-12): same
  // single-writer contract as recommendations.json. The iOS backend on homemini
  // owns both files. V3 only mirrors them read-only (Brief 121 +
  // refreshPhoneAuthoredMirrors). A reconcile / auto-backup LOCAL→NAS push of
  // a stale MacBook mirror is the whole-file clobber that made phone "Add to
  // Playlist" look completely broken. Locked by assertNoDesktopBluntPush below.
  // recommendations.json is deliberately ABSENT (Brief 125 / contracts notes
  // recommendationsSingleWriter): the mobile backend on homemini is the SINGLE
  // writer of the shared recommendations files. V3 mutates only through its
  // HTTP API — a reconcile push of V3's local copy is exactly the whole-file
  // clobber that resurrected phone-deleted recos.
  'play-events.jsonl',
  'embeddings.bin',
  // The vibe brain rides to the NAS like embeddings.bin so the homemini
  // backend can route mixes/DJ vibe queries against it (phase 2).
  'mood-index.bin',
  // Live Concert Mode declarations — the ONLY file that records "these tracks
  // form a declared concert" (mergedTrackId + cues + facts). Without it a
  // concert declared on one machine lands as an orphan track on the others.
  // Single-writer (the desktop app), so no clobber risk like recommendations.json.
  'live-sets.json',
  // Group membership grounded in MusicBrainz (scripts/artist-members.mjs) —
  // the trainer on homemini folds `members:` into each track's text.
  'artist-members.json',
] as const
assertNoDesktopBluntPush(STATE_FILE_NAMES, 'STATE_FILE_NAMES')
interface StateConflict {
  file: string
  localMtimeMs: number
  nasMtimeMs: number
  localPath: string
  nasPath: string
  /** Local file size (bytes) — used for push ETA and backup skip. */
  localSizeBytes: number
}
/** Skip .reconcile-bak when pushing tiny sidecars — halves SMB round-trips. */
const RECONCILE_BACKUP_MIN_BYTES = 64 * 1024
let stateConflicts: StateConflict[] = []
async function detectStateConflicts(): Promise<void> {
  stateConflicts = []
  const localDir = app.getPath('userData')
  const CONFLICT_THRESHOLD_MS = 60_000 // ignore <60s jitter
  for (const f of STATE_FILE_NAMES) {
    const localPath = join(localDir, f)
    const nasPath = join(NAS_STATE_DIR_PATH, f)
    try {
      const [ls, ns] = await Promise.all([
        stat(localPath).catch(() => null),
        stat(nasPath).catch(() => null),
      ])
      if (!ls) continue // no local copy: nothing to reconcile
      if (!ns) {
        // NAS file missing entirely (first-run migration?) — local
        // wins by default. Worth surfacing so user can decide.
        stateConflicts.push({ file: f, localMtimeMs: ls.mtimeMs, nasMtimeMs: 0, localPath, nasPath, localSizeBytes: ls.size })
        continue
      }
      if (ls.mtimeMs > ns.mtimeMs + CONFLICT_THRESHOLD_MS) {
        stateConflicts.push({ file: f, localMtimeMs: ls.mtimeMs, nasMtimeMs: ns.mtimeMs, localPath, nasPath, localSizeBytes: ls.size })
      }
    } catch { /* skip on stat error */ }
  }
  if (stateConflicts.length > 0) {
    const summary = stateConflicts.map(c => `${c.file} (local +${Math.round((c.localMtimeMs - c.nasMtimeMs) / 1000)}s)`).join(', ')
    // Warn once per FILE-SET per run, not per check: the same unresolved
    // condition re-warned every ~2 min (23 identical lines in one flight
    // log). Keyed on the file names — a NEW file joining the orphan set
    // re-warns with the full picture; the drift seconds ticking up do not.
    const orphanKey = stateConflicts.map(c => c.file).sort().join('|')
    if (orphanKey !== lastOrphanWarnKey) {
      lastOrphanWarnKey = orphanKey
      quietWarn('state-orphaned-edits', `[state] ORPHANED LOCAL EDITS detected (offline-mode work that didn't reach NAS): ${summary}. Use Settings → Library → Push local edits to NAS to resolve.`)
    }
  } else {
    lastOrphanWarnKey = ''
    console.log('[state] no orphaned local edits detected')
  }
}

// ── Atomic NAS publish (2026-06-27 duplicated-tail fix) ────────────────────
// The ONLY sanctioned way to overwrite a file on the SMB/NAS state dir. The
// `stage` callback writes the new bytes into a unique sibling `.tmp` on the
// SAME share (and fsyncs them); this helper then rename()s that tmp over the
// destination. rename() is atomic at the filesystem layer, so a reader — the
// homemini mobile backend loads library.json from here via LIBRARY_JSON_PATH —
// sees either the whole old file or the whole new file, never a half-written
// one.
//
// Why this exists: a direct copyFile()/writeFile() onto an existing NAS file
// overwrites in place from offset 0 and, on SMB, does NOT reliably truncate to
// the new length. When the new content is shorter than the old — a routine
// one-track edit or delete — the previous file's trailing bytes survive,
// producing the duplicated closing-brace tail ("...}\n  ]\n}  }\n  ]\n}") that
// corrupted the NAS library.json on 2026-06-27 and made the mobile backend 500
// on every library load. tmp+rename cannot produce that. On SMB the rename can
// fail "Resource busy (16)"; that fails SAFE — the prior complete file stays
// and the tmp is cleaned up, so a reader never observes a torn/duplicated file.
//
// `verifyJson` JSON.parses the STAGED tmp BEFORE it is renamed live, so a bad
// stage is discarded WITHOUT clobbering the prior good copy (used for
// library.json, which the mobile backend hard-depends on).
async function atomicPublishToNas(
  destPath: string,
  stage: (tmpPath: string) => Promise<void>,
  opts?: { verifyJson?: boolean },
): Promise<void> {
  const tmp = `${destPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await stage(tmp)
    if (opts?.verifyJson) {
      // Parse the staged tmp before publishing. If it didn't round-trip we
      // throw here and the prior good NAS file is left untouched.
      JSON.parse(await readFile(tmp, 'utf-8'))
    }
    await rename(tmp, destPath)
  } catch (err) {
    try { await unlink(tmp) } catch { /* tmp may never have been created */ }
    throw err
  }
}

// Stage helper: copy a local source file into the NAS tmp, then fsync it to the
// Synology (not just the local SMB write cache). fsync is best-effort — some
// SMB configs reject it; atomicity comes from the rename, fsync is durability.
async function stageCopyToTmp(srcPath: string, tmpPath: string): Promise<void> {
  await copyFile(srcPath, tmpPath)
  try {
    const fh = await open(tmpPath, 'r+')
    try { await fh.sync() } finally { await fh.close() }
  } catch { /* fsync/open unsupported on this share — rename still makes it atomic */ }
}

async function handleReconcileStateConflicts(event: import('electron').IpcMainInvokeEvent): Promise<{ ok: boolean; pushed: number; backups: string[]; error?: string }> {
  if (!(await nasAvailable())) {
    return { ok: false, pushed: 0, backups: [], error: 'Synology not mounted or not responding — connect /Volumes/JakeShared and retry.' }
  }
  if (stateConflicts.length === 0) {
    return { ok: true, pushed: 0, backups: [] }
  }
  const total = stateConflicts.length
  const totalBytes = stateConflicts.reduce((n, c) => n + c.localSizeBytes, 0)
  const sendProgress = (phase: 'backup' | 'push' | 'verify', file: string, index: number) => {
    event.sender.send('reconcile-state-progress', { phase, file, index, total, localSizeBytes: file ? stateConflicts[index - 1]?.localSizeBytes : undefined, totalBytes })
  }
  // Snapshot directory for the NAS copies we're about to overwrite —
  // single rollback point if the reconciliation itself is wrong.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(NAS_STATE_DIR_PATH, '.reconcile-bak', stamp)
  await mkdir(backupDir, { recursive: true }).catch(() => {})
  const backups: string[] = []
  let pushed = 0
  let index = 0
  for (const c of stateConflicts) {
    index++
    try {
      // Back up NAS copy first when it exists and the push is non-trivial.
      const backupNas = c.nasMtimeMs > 0 && c.localSizeBytes >= RECONCILE_BACKUP_MIN_BYTES
      if (backupNas) {
        sendProgress('backup', c.file, index)
        try {
          await copyFile(c.nasPath, join(backupDir, c.file))
          backups.push(join(backupDir, c.file))
        } catch { /* NAS file missing originally — nothing to back up */ }
      }
      sendProgress('push', c.file, index)
      // Atomic publish (tmp+fsync+rename) — never overwrite the NAS file in
      // place, which on SMB can leave a duplicated-tail torn write.
      await atomicPublishToNas(c.nasPath, (tmp) => stageCopyToTmp(c.localPath, tmp), { verifyJson: c.file === 'library.json' })
      pushed++
      console.log(`[state] reconciled "${c.file}" → NAS (${(c.localSizeBytes / (1024 * 1024)).toFixed(1)} MB, local +${Math.round((c.localMtimeMs - c.nasMtimeMs) / 1000)}s newer)`)
    } catch (err) {
      console.warn(`[state] reconcile failed for "${c.file}":`, err instanceof Error ? err.message : err)
    }
  }
  // Re-scan so the renderer's next get-state-conflicts returns the
  // empty post-reconciliation state (extra SMB stats — can be slow).
  sendProgress('verify', '', total)
  await detectStateConflicts()
  return { ok: true, pushed, backups }
}

// 4.5: automatic, silent NAS backup. Jake doesn't want a "local is ahead, go
// click a button" banner — the backup should just happen. This pushes any
// local-newer state file to the NAS mirror in the background (boot + on a
// timer). It is a ROUTINE mirror, not the manual reconcile: no per-push
// .reconcile-bak snapshots (those would bloat the NAS with 48 MB copies every
// time embeddings.bin changes). It KEEPS the one guard that matters — a shrink
// refusal: never overwrite a good NAS backup with a local copy that's
// dramatically smaller (the torn-write / truncation signature). Suspicious
// files are left untouched + logged, never silently destroyed.
let autoBackupBusy = false
async function autoBackupStateToNas(): Promise<void> {
  if (autoBackupBusy) return
  if (!(await nasAvailable())) return   // breaker open: skip ALL NAS IO
  autoBackupBusy = true
  try {
    await detectStateConflicts()
    if (stateConflicts.length === 0) return
    let pushed = 0, skipped = 0
    for (const c of stateConflicts) {
      try {
        if (c.nasMtimeMs > 0) {
          const ns = await stat(c.nasPath).catch(() => null)
          if (ns && c.localSizeBytes < ns.size * 0.5) {
            quietWarn(`state-backup-skip:${c.file}`, `[state] auto-backup SKIPPED "${c.file}" — local ${(c.localSizeBytes / 1048576).toFixed(1)}MB ≪ NAS ${(ns.size / 1048576).toFixed(1)}MB (possible truncation; left for manual review)`)
            skipped++
            continue
          }
        }
        // Atomic publish (tmp+fsync+rename) — never overwrite the NAS file in
        // place. A direct copyFile here was the 2026-06-27 duplicated-tail
        // corruption: a routine small shrink (one-track edit) sails past the
        // >50% shrink-skip above, and the in-place overwrite left the prior
        // file's longer tail behind, which the mobile backend then 500'd on.
        await atomicPublishToNas(c.nasPath, (tmp) => stageCopyToTmp(c.localPath, tmp), { verifyJson: c.file === 'library.json' })
        pushed++
      } catch (err) {
        console.warn(`[state] auto-backup failed for "${c.file}":`, err instanceof Error ? err.message : err)
      }
    }
    if (pushed) console.log(`[state] auto-backup → NAS: pushed ${pushed} file(s)${skipped ? `, skipped ${skipped} suspicious` : ''}`)
    await detectStateConflicts()
  } finally {
    autoBackupBusy = false
  }
}

ipc.handle('get-music-library-path', () => {
  return MUSIC_DIR.replace(/\/iPod_Control\/Music$/, '')
}, { refuse: '' })

// ── "Download" (offline pin) — Spotify-style, streaming/cache machines only ──
// On a streaming machine (e.g. workmini) the library is a "cache farm": each
// track file under musicRoot is either a real local file (instant) or a
// symlink to the NAS mount (streamed). "Download" copies a streamed track's
// bytes local; "Remove download" reverts it to a symlink. Pinned paths are
// recorded in downloads-state.json so the cache manager never evicts them.
// Fully inert on all-local libraries: no library.streamRoot configured →
// remove-download refuses and the renderer hides the controls.
function trackFarmPath(ipodPath: string): string {
  const root = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  return join(root, ipodPath.replace(/:/g, IS_WINDOWS ? '\\' : '/'))
}
async function readStreamRoot(): Promise<string | null> {
  try {
    const s = JSON.parse(await readFile(appSettingsPath(), 'utf-8'))
    const r = s?.library?.streamRoot
    return typeof r === 'string' && r.length > 0 ? r : null
  } catch { return null }
}
// Cached for the playback hot path — same TTL rationale as streamSource.
let _streamRootCache: { v: string | null; t: number } | null = null
async function readStreamRootCached(): Promise<string | null> {
  const now = Date.now()
  if (_streamRootCache && now - _streamRootCache.t < 5000) return _streamRootCache.v
  const v = await readStreamRoot()
  _streamRootCache = { v, t: now }
  return v
}
/** Homemini HTTP before any fs call — streamSource OR streamRoot (workmini). */
async function isHomeminiPlaybackClientCached(): Promise<boolean> {
  return isHomeminiPlaybackClient({
    streamSource: await readStreamSourceCached(),
    streamRoot: await readStreamRootCached(),
  })
}
function downloadsStatePath(): string {
  return join(app.getPath('userData'), 'downloads-state.json')
}
async function readPins(): Promise<string[]> {
  try {
    const s = JSON.parse(await readFile(downloadsStatePath(), 'utf-8'))
    return Array.isArray(s?.pinned) ? (s.pinned as string[]) : []
  } catch { return [] }
}
async function writePins(pinned: string[]): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(downloadsStatePath(), { pinned, updatedAt: new Date().toISOString() })
}

// ── Streaming migration helpers (hoisted to module scope 2026-07-09) ────────
// homemini serves audio by library id; these map a track ↔ id and pull bytes
// over HTTP. Shared by the ipod-audio:// protocol handler (playback), the
// download/pin IPC, and the ingestion redirect. See project_jaketunes_streaming.
const HOMEMINI_AUDIO_BASE = process.env.JAKETUNES_MOBILE_BACKEND
  ? `${process.env.JAKETUNES_MOBILE_BACKEND}/audio`
  : 'http://homemini:3000/audio'
let streamTrackIdByColonPath: Map<string, string | number> | null = null
let streamTrackIdMapMtime = -1
async function trackIdForAbsPath(absPath: string): Promise<string | number | null> {
  const i = absPath.indexOf('iPod_Control')
  if (i < 0) return null
  const colon = ':' + absPath.slice(i).replace(/\//g, ':')
  try {
    const st = await stat(LIBRARY_PATH)
    if (!streamTrackIdByColonPath || st.mtimeMs !== streamTrackIdMapMtime) {
      const lib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8')) as { tracks?: Array<{ id: string | number; path?: string }> }
      const m = new Map<string, string | number>()
      for (const t of lib.tracks || []) if (t.path) m.set(t.path, t.id)
      streamTrackIdByColonPath = m
      streamTrackIdMapMtime = st.mtimeMs
    }
  } catch { return null }
  return streamTrackIdByColonPath.get(colon) ?? null
}
async function fetchAudioFromHomemini(
  id: string | number,
  rangeHeader: string | null,
  // ALAC only. Chromium has no ALAC decoder, so homemini transcodes to FLAC
  // on the fly (its copy of the file is on local disk, so this is nearly
  // free). Without it the Mac had to read the ALAC itself over SMB from the
  // NAS — 0.09s vs two minutes on a remote machine. iOS never sends this:
  // AVPlayer decodes ALAC natively and keeps the untouched raw path.
  wantFlac = false,
): Promise<Response | null> {
  // Cold ALAC→FLAC on homemini can take >8s before the first header when the
  // transcode cache is empty. A short header budget then looks like "music
  // doesn't play" until relaunch warms the cache. Give headers room; the body
  // is never aborted by this timer (fetchHeadersWithin).
  const headerBudgetMs = wantFlac ? 25_000 : 12_000
  const url = `${HOMEMINI_AUDIO_BASE}/${encodeURIComponent(String(id))}${wantFlac ? '?fmt=flac' : ''}`
  // Spool ("do the deeper buffering thing", 2026-08-28): a landed local copy serves every range from disk — WAN jitter can't reach a playing song. Not landed yet: kick the full download, live-proxy this request as before.
  const viaSpool = await spoolAwareServe(join(app.getPath('userData'), 'stream-spool'), `${id}${wantFlac ? '-flac' : ''}`, url, rangeHeader); if (viaSpool) return viaSpool

  const once = async (): Promise<Response | null> => {
    try {
      const reqHeaders: Record<string, string> = {}
      // homemini transcodes to a CACHED file and serves it through its normal
      // range-capable path, so seeking works on FLAC exactly like anything else.
      if (rangeHeader) reqHeaders['Range'] = rangeHeader
      const res = await fetchHeadersWithin(url, { headers: reqHeaders }, headerBudgetMs)
      if (!res.ok && res.status !== 206) {
        // Once per id+status per run: a not-yet-propagated import 404s on
        // every play attempt and retry (36 near-identical lines in one
        // flight log while nine fresh imports crossed the WAN). First
        // occurrence is the signal; repeats are noise. A STATUS change
        // (404→500) still warns — that's a different story.
        const streamWarnKey = `${id}:${res.status}:${wantFlac}`
        if (!streamWarnedOnce.has(streamWarnKey)) {
          streamWarnedOnce.add(streamWarnKey)
          console.warn(`[stream] homemini ${res.status} for id=${id} flac=${wantFlac}`)
        }
        return null
      }
      if (!res.body) return null
      const out: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        'X-JT-Audio-Source': wantFlac ? 'homemini-flac' : 'homemini',
      }
      const ct = res.headers.get('content-type'); if (ct) out['Content-Type'] = ct
      const cr = res.headers.get('content-range'); if (cr) out['Content-Range'] = cr
      const cl = res.headers.get('content-length'); if (cl) out['Content-Length'] = cl
      return new Response(res.body as unknown as ReadableStream<Uint8Array>, { status: res.status, headers: out })
    } catch (err) {
      console.warn(
        `[stream] homemini fetch failed id=${id} flac=${wantFlac}:`,
        err instanceof Error ? err.message : err,
      )
      return null
    }
  }

  // Retries — Tailscale blips and a cold first-byte regularly look like a
  // permanent miss; a second try after 400ms recovers most. A third try after
  // 2s rides out an in-flight homemini kickstart (index-sync reloads the id
  // map — brand-new imports 404 for a few seconds while launchd brings :3000
  // back). Without that window, workmini marks today's songs dead until relaunch.
  const first = await once()
  if (first) return first
  await new Promise((r) => setTimeout(r, 400))
  const second = await once()
  if (second) return second
  await new Promise((r) => setTimeout(r, 2000))
  return once()
}

/** True when Chromium needs homemini's FLAC transcode (no native ALAC). */
function wantsHomeminiFlac(absPath: string): boolean {
  const hint = (codecByAbsPath.get(absPath) || '').toLowerCase()
  if (hint === 'alac') return true
  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase()
  if (ext === '.alac') return true
  // .m4a with no codec hint: could be AAC or ALAC. Prefer asking homemini
  // for FLAC on streaming clients — AAC re-encoded to FLAC still plays;
  // raw ALAC in Chromium does not. Known AAC (hint set) stays on the raw path.
  if (ext === '.m4a' && !hint) return true
  return false
}

/**
 * Boot / deploy canary for streaming clients. Non-blocking: logs loudly if
 * homemini is unreachable so "won't play" is diagnosable from the main log
 * instead of looking like a random Howler hang. Never throws.
 */
async function probeHomeminiReachability(): Promise<void> {
  if (!(await isHomeminiPlaybackClientCached())) return
  const base = (process.env.JAKETUNES_MOBILE_BACKEND || 'http://homemini:3000').replace(/\/$/, '')
  const url = `${base}/healthz`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      console.log(`[stream] homemini reachable at ${url} — streaming playback path OK`)
    } else {
      console.warn(
        `[stream] homemini healthz returned ${res.status} from ${url}. ` +
        `This machine is a streaming client (streamRoot/streamSource); tracks will 404 until homemini is healthy.`,
      )
    }
  } catch (err) {
    console.warn(
      `[stream] homemini UNREACHABLE at ${url} (${err instanceof Error ? err.message : err}). ` +
      `This machine will not play symlinked/cache-farm tracks until homemini:3000 answers. ` +
      `Do NOT "fix" by reading the NAS SMB mount on the hot path — that is the hang.`,
    )
  }
}

// ── Streaming ingestion engine (Stage 3, dormant until streamSource is set) ──
// "Streaming mode" for THIS machine, from app settings library.streamSource:
//   'homemini'   → new imports are pushed to homemini and kept locally only as
//                  a symlink (streamed).
//   absent/null  → fully local (default; behavior unchanged).
async function readStreamSource(): Promise<'homemini' | null> {
  try {
    const s = JSON.parse(await readFile(appSettingsPath(), 'utf-8'))
    return s?.library?.streamSource === 'homemini' ? 'homemini' : null
  } catch { return null }
}
// Cached for the playback hot path (the ipod-audio handler checks it per play to
// decide whether a symlinked track streams from homemini). 5s TTL so a settings
// change is picked up quickly without a file read on every request.
let _streamSourceCache: { v: 'homemini' | null; t: number } | null = null
async function readStreamSourceCached(): Promise<'homemini' | null> {
  const now = Date.now()
  if (_streamSourceCache && now - _streamSourceCache.t < 5000) return _streamSourceCache.v
  const v = await readStreamSource()
  _streamSourceCache = { v, t: now }
  return v
}
// The local symlink target for streamed tracks: a single always-present 0-byte
// sentinel under the library root. Playback keys off isSymbolicLink() (→ homemini);
// a non-dangling target just means any un-guarded stat()-follower sees a present
// (empty) file instead of an ENOENT throw. Created lazily.
function streamedSentinelPath(): string {
  const root = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  return join(root, '.jt-streamed')
}
async function ensureStreamedSentinel(): Promise<string> {
  const p = streamedSentinelPath()
  try { await stat(p) } catch { try { await writeFile(p, '') } catch { /* best effort */ } }
  return p
}
// Identity gate for a destructive convert-to-streamed: homemini must serve the
// EXACT bytes we're about to drop locally. Fetch the first 256KB from homemini
// and require sha1(bytes) to match the stored audioFingerprint hash (the same
// window computeAudioFingerprint uses). Refuse on any mismatch, missing
// fingerprint, or unreachable homemini — never evict blind (CLAUDE.md
// destructive-ops rule: gate on identity/binary fingerprint, not text).
async function homeminiServesMatchingBytes(id: string | number, storedFingerprint: string | undefined): Promise<boolean> {
  if (!storedFingerprint || !storedFingerprint.startsWith('sha1:')) return false
  const wantHash = storedFingerprint.split('|')[0].slice('sha1:'.length)
  try {
    const res = await fetch(`${HOMEMINI_AUDIO_BASE}/${encodeURIComponent(String(id))}`, {
      headers: { Range: 'bytes=0-262143' },   // first 256KB — matches the fingerprint window
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok && res.status !== 206) return false
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length <= 0) return false
    const got = createHash('sha1').update(buf).digest('hex').slice(0, 16)
    return got === wantHash
  } catch { return false }
}
// Look up a track's stored audioFingerprint by its colon path (for the
// convert-to-streamed identity gate when the caller doesn't already have it).
async function fingerprintForIpodPath(ipodPath: string): Promise<string | undefined> {
  try {
    const lib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8')) as { tracks?: Array<{ path?: string; audioFingerprint?: string }> }
    for (const t of lib.tracks || []) {
      if (t.path === ipodPath) return typeof t.audioFingerprint === 'string' ? t.audioFingerprint : undefined
    }
  } catch { /* ignore */ }
  return undefined
}
// Convert a local track file into a streamed symlink — DESTRUCTIVE (drops the
// local bytes). Gated on homeminiServesMatchingBytes: the identity check that
// keeps this from ever orphaning a track. Atomic (symlink tmp → rename). No-op
// if already a symlink.
async function convertTrackToStreamed(ipodPath: string, storedFingerprint: string | undefined): Promise<{ ok: boolean; error?: string }> {
  try {
    const fp = trackFarmPath(ipodPath)
    let st
    try { st = await lstat(fp) } catch { return { ok: false, error: 'local file not found' } }
    if (st.isSymbolicLink()) return { ok: true }         // already streamed
    const id = await trackIdForAbsPath(fp)
    if (id == null) return { ok: false, error: 'track id not found in library' }
    if (!(await homeminiServesMatchingBytes(id, storedFingerprint))) {
      return { ok: false, error: 'homemini does not yet serve matching bytes — kept local' }
    }
    const sentinel = await ensureStreamedSentinel()
    const tmp = fp + '.stream.tmp'
    await unlink(tmp).catch(() => {})
    await symlink(sentinel, tmp)
    await rename(tmp, fp)                                  // atomic: real file → symlink
    return { ok: true }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}
// Pull homemini bytes onto this Mac when eviction (or a NAS symlink) left
// nothing copyFile can send to the Mini. HTTP only — never SMB.
async function materializeLibraryTrack(colonPath: string, trackId: number | string): Promise<{ ok: boolean; error?: string; pulled?: boolean }> {
  const localMount = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  const r = await materializeTrackFromHomemini({
    colonPath,
    trackId,
    localMount,
    pathSep: IS_WINDOWS ? '\\' : '/',
    homeminiAudioBase: HOMEMINI_AUDIO_BASE,
    lstat,
    mkdir,
    writeFile,
    rename,
    unlink,
    fetchAudio: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      return { ok: res.ok, status: res.status, buffer: Buffer.from(await res.arrayBuffer()) }
    },
  })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, pulled: r.pulled }
}

// Pull a streamed/evicted track's real bytes down from homemini into a local
// file (the "Download"/pin action, and iPod sync's copy source). Additive —
// never destructive. Atomic. Works when the Mac file is gone (evicted), not
// only when a symlink is still sitting in the F-dir.
async function pinStreamedTrackFromHomemini(ipodPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const fp = trackFarmPath(ipodPath)
    const id = await trackIdForAbsPath(fp)
    if (id == null) return { ok: false, error: 'track id not found in library' }
    return await materializeLibraryTrack(ipodPath, id)
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}

// ── Stream-convert queue (Stage 3 ingestion redirect) ───────────────────────
// A newly-imported track is written locally as a real file (so fingerprint /
// analysis run on real bytes), then enqueued here. A background pass keeps the
// track LOCAL and PLAYABLE until homemini is confirmed to serve byte-identical
// bytes (macbook→NAS→homemini propagation, typically ≤60-120s), then converts
// it to a streamed symlink. If homemini never serves a match within
// STREAM_CONVERT_MAX_AGE_MS, the track just stays local (safe). Crash-safe:
// persisted in userData. Poll interval is > 30s to dodge homemini's miss-cache.
interface StreamConvertItem { ipodPath: string; fingerprint?: string; enqueuedAt: number }
const STREAM_CONVERT_MAX_AGE_MS = 30 * 60 * 1000   // give up after 30 min → stays local
let streamConvertTimer: ReturnType<typeof setInterval> | null = null
function streamConvertQueuePath(): string {
  return join(app.getPath('userData'), 'stream-convert-queue.json')
}
async function readStreamConvertQueue(): Promise<StreamConvertItem[]> {
  try {
    const s = JSON.parse(await readFile(streamConvertQueuePath(), 'utf-8'))
    return Array.isArray(s?.items) ? (s.items as StreamConvertItem[]) : []
  } catch { return [] }
}
async function writeStreamConvertQueue(items: StreamConvertItem[]): Promise<void> {
  await writeJsonAtomic(streamConvertQueuePath(), { items, updatedAt: new Date().toISOString() })
}
async function enqueueStreamConvert(ipodPath: string, fingerprint: string | undefined, enqueuedAt: number): Promise<void> {
  try {
    const items = await readStreamConvertQueue()
    if (items.some((it) => it.ipodPath === ipodPath)) return
    items.push({ ipodPath, fingerprint, enqueuedAt })
    await writeStreamConvertQueue(items)
    ensureStreamConvertWorker()
  } catch { /* non-fatal: track just stays local */ }
}
let streamConvertPassRunning = false
async function runStreamConvertPass(now: number): Promise<void> {
  if (streamConvertPassRunning) return
  streamConvertPassRunning = true
  try {
    if ((await readStreamSource()) !== 'homemini') return   // mode off → do nothing
    let items = await readStreamConvertQueue()
    if (!items.length) return
    const keep: StreamConvertItem[] = []
    for (const it of items) {
      if (now - it.enqueuedAt > STREAM_CONVERT_MAX_AGE_MS) {
        console.log(`[stream-convert] gave up (homemini never served a match in time), staying local: ${it.ipodPath}`)
        continue                                            // drop → stays local
      }
      const fpr = it.fingerprint ?? await fingerprintForIpodPath(it.ipodPath)
      const r = await convertTrackToStreamed(it.ipodPath, fpr)
      if (r.ok) {
        console.log(`[stream-convert] converted to streamed: ${it.ipodPath}`)
      } else {
        keep.push(it)                                       // not ready yet → retry next pass
      }
    }
    if (keep.length !== items.length) await writeStreamConvertQueue(keep)
    if (!keep.length && streamConvertTimer) { clearInterval(streamConvertTimer); streamConvertTimer = null }
  } catch { /* non-fatal */ } finally {
    streamConvertPassRunning = false
  }
}
function ensureStreamConvertWorker(): void {
  if (streamConvertTimer) return
  // 90s interval: > homemini's 30s miss-cache window, ~aligned to the 60s NAS
  // sync legs. Pass reads the queue itself, so a stale closure is impossible.
  streamConvertTimer = setInterval(() => { void runStreamConvertPass(Date.now()) }, 90 * 1000)
}

ipc.handle('track-local-state', async (_e, ipodPath: string): Promise<'local' | 'streamed' | 'unknown'> => {
  try {
    const st = await lstat(trackFarmPath(ipodPath))
    return st.isSymbolicLink() ? 'streamed' : 'local'
  } catch { return 'unknown' }
}, { refuse: 'unknown' as const })

ipc.handle('load-downloads-state', async (): Promise<{ pinned: string[]; streaming: boolean }> => {
  const streaming = (await readStreamRoot()) !== null || (await readStreamSource()) === 'homemini'
  return { pinned: await readPins(), streaming }
}, { public: true })

ipc.handle('download-track', async (_e, ipodPath: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    if ((await readStreamSource()) === 'homemini') {
      // Laptop homemini mode: pull the real bytes over HTTP from homemini.
      const r = await pinStreamedTrackFromHomemini(ipodPath)
      if (!r.ok) return r
    } else {
      // Workmini NAS cache-farm mode: copy from the symlink's NAS target.
      const fp = trackFarmPath(ipodPath)
      const st = await lstat(fp)
      if (st.isSymbolicLink()) {
        const target = await readlink(fp)
        await stat(target)                       // NAS source must be reachable
        const tmp = fp + '.dl.tmp'
        await unlink(tmp).catch(() => {})
        await copyFile(target, tmp)              // pull the real bytes local
        await rename(tmp, fp)                    // atomic: symlink → real file
      }
    }
    const pins = await readPins()
    if (!pins.includes(ipodPath)) { pins.push(ipodPath); await writePins(pins) }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}, { refuse: REFUSED_SENDER })

ipc.handle('remove-download', async (_e, ipodPath: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    if ((await readStreamSource()) === 'homemini') {
      // Laptop homemini mode: re-stream. convertTrackToStreamed hash-verifies
      // homemini serves the exact bytes before dropping the local file, so this
      // can never orphan a track.
      const r = await convertTrackToStreamed(ipodPath, await fingerprintForIpodPath(ipodPath))
      if (!r.ok) return r
    } else {
      // Workmini NAS cache-farm mode: symlink back to the NAS master.
      const root = await readStreamRoot()
      if (!root) return { ok: false, error: 'This library is fully local — nothing to un-download.' }
      const fp = trackFarmPath(ipodPath)
      const target = join(root, ipodPath.replace(/:/g, IS_WINDOWS ? '\\' : '/'))
      await stat(target)                         // never orphan: NAS must have it first
      const st = await lstat(fp)
      if (!st.isSymbolicLink()) {
        const tmp = fp + '.rm.tmp'
        await unlink(tmp).catch(() => {})
        await symlink(target, tmp)
        await rename(tmp, fp)                     // atomic: real file → symlink
      }
    }
    await writePins((await readPins()).filter((p) => p !== ipodPath))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}, { refuse: REFUSED_SENDER })

// 4.4.85: at app boot, read library.json and seed the codecByAbsPath map
// from every track that has a `codec` field. Imports made before this
// version don't have the field — those tracks fall back to the ffprobe
// path inside the protocol handler. Idempotent; safe to call again on
// library reload if we ever wire that.
async function loadCodecMapFromLibrary(): Promise<void> {
  try {
    const raw = await readFile(LIBRARY_PATH, 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: Array<{ path?: string; codec?: string }> }
    const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
    const pathSep = IS_WINDOWS ? '\\' : '/'
    let added = 0
    for (const t of lib.tracks || []) {
      if (!t.path || !t.codec) continue
      const abs = join(LOCAL_MOUNT, t.path.replace(/:/g, pathSep))
      codecByAbsPath.set(abs, t.codec)
      added += 1
    }
    console.log(`[codec-map] seeded ${added} entries from library.json`)
  } catch (err) {
    // Library may not exist yet (fresh install) — fine, map stays empty.
    console.log(`[codec-map] no seed (${err instanceof Error ? err.message : String(err)})`)
  }
}

// Single source of truth for the app version, sourced from package.json.
// Renderer pulls this once at startup so version-display surfaces don't
// drift from the actual installed build (the way the About dialog
// hardcoded "4.0.5" did across 4.0.6 → 4.1.2).
ipc.handle('get-app-version', () => app.getVersion(), { public: true })

// Load the JakeTunes master library (independent of iPod).
//
// Return shape includes `noDataSource: true` when we fall through to an
// empty result (no local file AND no iPod available). The renderer uses
// that flag to refuse auto-saving the empty state back to disk, so a
// cold-start with the iPod not yet detected can't silently wipe the
// library file.
ipc.handle('load-tracks', async () => {
  // Self-heal any failed prior save before we read. If the previous
  // app session crashed (or was killed, or hit an SMB Resource-busy
  // rename) mid-atomic-save, a `library.json.partial.json` sidecar
  // is sitting next to library.json with the un-committed state.
  // Promote it before reading so the renderer sees the imports the
  // user thought they made. No-op when no sidecar exists. See
  // recoverPartialIfNewer for the failure mode and rationale.
  await recoverPartialIfNewer(LIBRARY_PATH)

  // If a local library exists, use it (source of truth)
  try {
    const raw = await readFile(LIBRARY_PATH, 'utf-8')
    const library = JSON.parse(raw)
    const tracks = library.tracks || []
    // Bug #2: record the mtime we just observed so save-library can detect
    // external writes that happen between this load and the next save.
    try {
      const s = await stat(LIBRARY_PATH)
      lastLoadedLibraryMtimeMs = Math.round(s.mtimeMs)
    } catch { /* non-fatal */ }
    // 4.5: refresh the structural taste digest so every character call
    // gets the fresh shape of the library (top artists, eras, genres,
    // signatures). Cheap — runs once per load-tracks event.
    refreshLibraryDigest(tracks)
    // (4.1: removed launch-time prewarm scheduler. ALAC transcodes are
    // now done synchronously at import time and via the explicit
    // "Prepare ALAC tracks" maintenance action — no background scan
    // on every load-tracks. See prepare-alac-cache IPC handler.)
    return {
      tracks,
      playlists: library.playlists || [],
      noDataSource: tracks.length === 0,
    }
  } catch (err) {
    // The library.json file exists but failed to parse — almost always
    // because save-library was writing the file at the exact moment we
    // tried to read it. DO NOT fall through to the "seed from iPod"
    // path below: that path overwrites library.json with iTunesDB
    // content, which loses any renderer-side changes (deletes, edits,
    // imports) that were about to be saved. Instead, re-try the read
    // with a few 200ms backoff tries — by then save-library's atomic
    // rename has completed and the full file is available.
    const { stat: statFn } = await import('fs/promises')
    try {
      await statFn(LIBRARY_PATH)
      for (const delay of [200, 500, 1000]) {
        await new Promise(r => setTimeout(r, delay))
        try {
          const raw = await readFile(LIBRARY_PATH, 'utf-8')
          const library = JSON.parse(raw)
          const tracks = library.tracks || []
          try {
            const s = await statFn(LIBRARY_PATH)
            lastLoadedLibraryMtimeMs = Math.round(s.mtimeMs)
          } catch { /* non-fatal */ }
          return {
            tracks,
            playlists: library.playlists || [],
            noDataSource: tracks.length === 0,
          }
        } catch { /* still mid-write; retry */ }
      }
      // Still unreadable after retries. Surface the error instead of
      // destroying the library by overwriting with iPod data.
      console.error('load-tracks: library.json exists but parse kept failing — refusing iPod fallback to avoid data loss', err)
      return { tracks: [], playlists: [], noDataSource: true, error: 'library-parse-failed' }
    } catch {
      // library.json genuinely does not exist — first launch case,
      // safe to seed from iPod.
    }
  }

  // TRUE first launch (no library.json at all): read from iPod and save as local library
  try {
    const ipodData = await readIpodDatabase()
    await writeFile(LIBRARY_PATH, JSON.stringify(ipodData, null, 2))
    return { ...ipodData, noDataSource: false }
  } catch (err) {
    console.error('Failed to read iPod database:', err)
    return { tracks: [], playlists: [], noDataSource: true }
  }
}, { public: true })

// (4.1: removed `schedulePrewarmFromLibrary`. The launch-time prewarm
// scanner used to fire on every load-tracks, scan the entire library,
// run ffprobe on every m4a candidate, and queue ffmpeg transcodes for
// any uncached ALAC files. Two problems: it spent CPU/disk on every
// launch even when no work was needed, and the launch-time scan
// competed with whatever the user was doing in the first 30 seconds.
// Replaced by:
//   - import-time await of prewarmAlacCache (cache hot the moment a
//     track lands; no on-demand transcode at first-play),
//   - explicit "Prepare ALAC tracks" maintenance action in
//     LibraryMaintenanceModal for the existing library backlog.)

// Save the master library to disk.
//
// Guard against persisting an empty library on top of an existing one —
// that's how the renderer could otherwise wipe the canonical file when
// load-tracks happens to return []. If the caller really does want to
// write an empty library (e.g., factory-reset), they can pass force=true.
//
// Also stamps the file's mtime we wrote so the external-change watcher
// can tell "we wrote this" from "someone else wrote this".
let lastSelfWriteMtimeMs = 0

// Bug #2: record library.json's mtime at every successful load. Save-library
// uses this as the "baseline" for detecting external writes that happened
// between our load and our save. If on-disk mtime is newer than BOTH our
// last load AND our last self-write (with 2s drift tolerance), another
// machine wrote to NAS while we were sitting on a stale snapshot — refusing
// the save prevents the silent overwrite that lost workmini's 12 imports.
let lastLoadedLibraryMtimeMs = 0

// Debounced iTunesDB rewrite trigger. Multiple rapid deletes should
// only result in ONE iTunesDB rebuild — costly operation that requires
// reading + re-writing the whole DB. 1.5s window catches a typical
// "select 10 songs and delete" interaction in a single rebuild.
let pendingDbRebuild: NodeJS.Timeout | null = null
let pendingDeletedPaths = new Set<string>()
function scheduleDbRebuild(deletedPaths: string[]) {
  for (const p of deletedPaths) pendingDeletedPaths.add(p)
  if (pendingDbRebuild) clearTimeout(pendingDbRebuild)
  pendingDbRebuild = setTimeout(async () => {
    pendingDbRebuild = null
    const removed = Array.from(pendingDeletedPaths)
    pendingDeletedPaths = new Set()
    if (!detectedIpodMount) return  // iPod not mounted — nothing to do

    // 4.0 Settings gate: skip the auto-delete-from-iPod when Jake hasn't
    // opted in. Tracks are still removed from library.json — just not
    // mirrored to the iPod automatically. They'll go on the next manual
    // sync. Default-off matches the user's "don't surprise me" expectation.
    // FAIL CLOSED (2026-08-03). This read `if (sync && sync.… === false) return`
    // — it only bailed when the flag was EXPLICITLY false, so a missing key, an
    // absent settings file, or a parse failure all fell through to deleting
    // files off the iPod. That contradicted the comment directly above it, and
    // the failure modes it ignored are exactly the ones you get on a fresh
    // machine or a bad read. An opt-in destructive action must require the
    // opt-in to be present, not merely not-refused.
    const settings = await readAppSettingsAsync()
    const sync = settings?.sync as { autoRemoveDeletedFromIpod?: boolean } | undefined
    if (sync?.autoRemoveDeletedFromIpod !== true) {
      return
    }
    try {
      const ipodMount = detectedIpodMount
      const { unlink: unlinkFS } = await import('fs/promises')
      // Delete the files from iPod first
      for (const colon of removed) {
        const rel = colon.replace(/:/g, IS_WINDOWS ? '\\' : '/')
        try {
          await unlinkFS(join(ipodMount, rel))
        } catch { /* file might already be gone */ }
      }
      // Re-read the current library and write a fresh iTunesDB so
      // the iPod's track count drops to match.
      const lib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8'))
      const ipodDb = join(ipodMount, 'iPod_Control', 'iTunes', 'iTunesDB')
      try { await copyFile(ipodDb, ipodDb + '.bak') } catch { /* non-fatal */ }
      const scriptPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/db_reader.py')
      await new Promise<void>((resolve, reject) => {
        const py = spawn(PYTHON_CMD ?? 'python3', [scriptPath, '--write', ipodDb])
        py.on('error', reject)
        py.on('close', (code) => code === 0 ? resolve() : reject(new Error(`db_reader exit ${code}`)))
        // EPIPE-safe stdin write. If the Python child dies before we
        // finish writing (iPod unmount, parse error, signal), Node
        // emits 'error' on stdin and — without a listener — escalates
        // to an Uncaught Exception that crashes the main process.
        // Same pattern at every spawn-and-write site below.
        py.stdin.on('error', (err) => reject(err))
        try {
          py.stdin.write(JSON.stringify({ tracks: lib.tracks, playlists: lib.playlists || [] }))
          py.stdin.end()
        } catch (err) { reject(err) }
      })
      console.log(`[delete-sync] removed ${removed.length} files from iPod, iTunesDB rebuilt`)
      sendToRenderer('ipod-db-rebuilt', { removed: removed.length })
    } catch (err) {
      console.warn('[delete-sync] iPod cleanup after delete failed:', err)
    }
  }, 1500)
}

// 4.5.0-114: best-effort async backup mirror of library.json to the NAS.
// Local is the source of truth; this keeps an off-machine copy current
// WITHOUT ever being on the hot path. If the NAS isn't mounted or the write
// tears, it's a harmless no-op — the app never reads the NAS, so a stale or
// missing mirror can't cause empty-display or loss. tmp+rename for atomicity
// when it does land.
async function mirrorLibraryToNas(library: unknown): Promise<void> {
  if (!(await nasAvailable())) return   // breaker open: skip ALL NAS IO
  const nasPath = join(NAS_STATE_DIR_PATH, 'library.json')
  const json = JSON.stringify(library, null, 2)
  // Two attempts: SMB rename intermittently fails "Resource busy"; a quick
  // retry usually lands. Fire-and-forget — never throws, never blocks the save
  // (local is the source of truth; a stale/missing mirror is harmless, the app
  // never reads the NAS). atomicPublishToNas guarantees the file the mobile
  // backend reads is either the whole old copy or the whole new copy — never a
  // duplicated-tail torn write (the 2026-06-27 corruption).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await atomicPublishToNas(
        nasPath,
        async (tmp) => {
          const fh = await open(tmp, 'w')
          try {
            await fh.writeFile(json)
            try { await fh.sync() } catch { /* fsync best-effort on SMB */ }
          } finally {
            await fh.close()
          }
        },
        { verifyJson: true },
      )
      return // staged copy parsed clean and was renamed live
    } catch (err) {
      if (attempt === 2) {
        console.warn('[mirror] NAS backup push failed after retry (harmless — local is truth):', err instanceof Error ? err.message : err)
      }
    }
  }
}

// Serialize library saves. Two concurrent save-library calls both stage through
// the FIXED `library.json.partial.json` sidecar, so a shorter payload landing
// over a longer one leaves the tail of the long write past the end of the short
// one — and rename() then atomically installs the corruption. That is exactly
// how ui-state.json ended up unparseable (fixed 2026-08-03), and the same
// class of bug already bit the overrides writer once before (see the note near
// writeOverridesSerialized).
//
// The sidecar name cannot simply be made unique: the crash-recovery scanner
// looks for `${libraryPath}.partial.json` by name. So the overlap is removed
// instead. This is the highest-stakes file in the app — the NAS copy has been
// zeroed once already — and the renderer's 1s debounce does NOT prevent
// overlap: an 8.6 MB pretty-printed write to SMB can outlast the next debounce.
let librarySaveChain: Promise<unknown> = Promise.resolve()

ipc.handle('save-library', (_e, tracks: unknown[], playlists?: unknown[], force?: boolean) => {
  // Only our own top-level window may rewrite the library. `ipcMain.handle`
  // answers any frame in the app, and the Bandcamp store runs a remote page
  // in a <webview> in this session.
  const run = librarySaveChain.then(
    () => saveLibraryImpl(tracks, playlists, force),
    () => saveLibraryImpl(tracks, playlists, force),
  )
  // Chain-keeper only: save errors are surfaced by saveLibraryImpl itself
  // (both .then arms call it); this catch merely keeps the chain adoptable.
  // Silent BY DESIGN — do not convert to a warn (it would double-report).
  librarySaveChain = run.catch(() => {})
  return run
}, { refuse: REFUSED_SENDER })

async function saveLibraryImpl(tracks: unknown[], playlists?: unknown[], force?: boolean) {
  // Bug #1 guard: if we booted in local-fallback mode and NAS later
  // reappeared, our in-memory tracks are stale relative to whatever
  // workmini/homemini wrote to NAS while we were offline. Saving here
  // would silently overwrite that work (the "12 vanished songs" bug).
  // Refuse the write until restart; the renderer banner explains why.
  const lockReason = isSaveLocked()
  if (lockReason) {
    console.warn(`[save-library] refused (saves locked): ${lockReason}`)
    return { ok: false, error: 'state-save-locked', reason: lockReason }
  }
  // Bug #2 guard: another machine may have written to library.json on NAS
  // since our last load/save. Check on-disk mtime against both baselines
  // (lastLoadedLibraryMtimeMs from load-tracks + lastSelfWriteMtimeMs from
  // our own writes). If on-disk is meaningfully newer than both, we'd be
  // overwriting fresh work — refuse, surface the conflict, ask the
  // renderer to reload. 2s tolerance matches the existing watcher's
  // self-write skip window so atomic-rename drift doesn't false-positive.
  // `force` skips the check (used by recovery paths).
  if (!force && lastLoadedLibraryMtimeMs > 0) {
    try {
      const onDisk = await stat(LIBRARY_PATH)
      const onDiskMtime = Math.round(onDisk.mtimeMs)
      const driftFromLoad = onDiskMtime - lastLoadedLibraryMtimeMs
      const driftFromSelfWrite = onDiskMtime - lastSelfWriteMtimeMs
      if (driftFromLoad > 2000 && driftFromSelfWrite > 2000) {
        console.warn(`[save-library] EXTERNAL-WRITE CONFLICT: on-disk mtime ${onDiskMtime} > load ${lastLoadedLibraryMtimeMs} (+${driftFromLoad}ms) AND > self-write ${lastSelfWriteMtimeMs} (+${driftFromSelfWrite}ms). Refusing to overwrite.`)
        libraryCache.invalidate()
        sendToRenderer('library-external-change')
        return {
          ok: false,
          error: 'external-write-conflict',
          onDiskMtime,
          lastLoadedMtime: lastLoadedLibraryMtimeMs,
          lastSelfWriteMtime: lastSelfWriteMtimeMs,
        }
      }
    } catch { /* file briefly missing during atomic replace — proceed */ }
  }
  try {
    // Read the current on-disk library ONCE — reused by the empty/shrink
    // data-loss guards and the deleted-paths diff below.
    let prevTracks: Array<{ path?: string }> = []
    try {
      const prevLib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8')) as { tracks?: Array<{ path?: string }> }
      prevTracks = Array.isArray(prevLib.tracks) ? prevLib.tracks : []
    } catch { /* first save / unreadable — no prior state to protect */ }
    const prevCount = prevTracks.length
    const newCount = Array.isArray(tracks) ? tracks.length : 0

    // ── Data-loss circuit-breaker (2026-05-29 shedding incident) ──
    // Refuse to PERSIST a catastrophic shrink. A drop to empty, or to less
    // than half the library in one save, is never a legitimate non-forced
    // action — it's the signature of a torn load, a stale/partial in-memory
    // list, or a reconcile gone wrong. Gates on count as a circuit-breaker
    // only; per-track identity is protected by the no-mass-unlink rule
    // below. `force` is the recovery escape hatch. On refusal we tell the
    // renderer to reload, so its view re-syncs from the intact disk copy.
    const refusal = shouldRefuseSave(prevCount, newCount, force)
    if (refusal) {
      console.warn(`[save-library] REFUSED (${refusal.error}): ${prevCount} → ${newCount} tracks. Pass force to override.`)
      libraryCache.invalidate()
      sendToRenderer('library-external-change')
      return { ok: false, ...refusal }
    }
    if (newCount < prevCount) {
      console.warn(`[save-library] library shrinking ${prevCount} → ${newCount} (-${prevCount - newCount}); audio preserved unless small & deliberate (see unlink guard).`)
    }

    // ── Detect deleted paths so we can clean up disk + iPod ──
    // Compare the previous library.json on disk to the new track list.
    // Any path that disappeared = a candidate deletion. Catches every
    // removal mechanism (right-click, playlist removal, batch delete)
    // without each call site pushing to the iPod itself.
    // Gated on IDENTITY, not on path text — see library-deletions.ts. The old
    // version diffed path sets, so a track whose path changed while the track
    // still existed (re-import, sync rewrite, colon-path normalization) looked
    // like a deletion and had its audio unlinked underneath it.
    let deletedPaths: string[] = computeDeletedPaths(
      prevTracks as Array<{ id?: number | string; path?: string }>,
      tracks as Array<{ id?: number | string; path?: string }>,
    )

    // ── Atomic write: tmp file → rename ──
    // Without this, any other process reading library.json
    // simultaneously (e.g. the file-watcher-triggered reload, a
    // Python script, or this same app's load-tracks fallback) could
    // observe a half-written file, fail JSON.parse, and take the
    // "fallback to iPod DB" path in load-tracks — which OVERWRITES
    // library.json with iTunesDB content, losing any pending
    // renderer-side edits. A rename() is atomic at the filesystem
    // level: observers see either the old full file or the new full
    // file, never a mid-write slice.
    const library = { tracks, playlists: playlists || [] }
    // 4.5: refresh the structural library digest so character calls
    // see up-to-date ownership shape (new imports change top artists,
    // genre counts, era spread). Called BEFORE write so even if write
    // fails the digest matches the renderer's current state.
    refreshLibraryDigest(tracks as DigestTrack[])
    // 4.5.0-109: prime (not set) — cache stays hot in RAM but does NOT
    // schedule a background NAS write of its own. The atomic write
    // below is the single canonical writer; the cache's flush racing
    // with it on SMB is what zeroed out NAS library.json overnight in
    // -106/-108 (rename-after-unlink failure left a 0-byte file).
    libraryCache.prime(library as unknown as CachedLibrary)
    const tmp = LIBRARY_PATH + '.partial.json'
    await writeFile(tmp, JSON.stringify(library, null, 2))
    const { rename: renameFS, unlink: unlinkFS } = await import('fs/promises')
    // Brief 016: pre-stamp lastSelfWriteMtimeMs BEFORE the rename so the
    // fsWatch handler (which fires synchronously with the rename) reads
    // a fresh value when it compares mtimes. Previously the stamp landed
    // AFTER the await stat below, but fsWatch's own async stat() could
    // resolve first and observe lastSelfWriteMtimeMs as 0 (or a stale
    // value), produce the `self 0` smoking-gun in the logs, and dispatch
    // library-external-change for what was really our own write.
    //
    // The post-rename stat below still runs to refine the value to the
    // actual on-disk mtime — both writes stay within the watcher's
    // 2-second skip window, so a small Date.now() vs. stat.mtimeMs drift
    // doesn't matter.
    lastSelfWriteMtimeMs = Date.now()
    await renameFS(tmp, LIBRARY_PATH)
    try {
      const s = await stat(LIBRARY_PATH)
      lastSelfWriteMtimeMs = Math.round(s.mtimeMs)
    } catch { /* non-fatal */ }

    // ── Torn-write self-heal (NAS/SMB) ── A rename over an SMB share can
    // leave library.json missing or zero-byte — the 2026-05-29 incident,
    // where the NAS copy vanished mid-save and the app then loaded empty.
    // Re-read what actually landed; if it's gone or doesn't match what we
    // just wrote, rewrite it directly. Non-atomic, but there's no concurrent
    // reader mid-incident and a correct-present file beats a missing one.
    try {
      const check = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8')) as { tracks?: unknown[] }
      const landed = Array.isArray(check.tracks) ? check.tracks.length : -1
      if (landed !== newCount) throw new Error(`landed ${landed} vs expected ${newCount}`)
    } catch (verifyErr) {
      console.error(`[save-library] post-write verify failed (${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}); self-healing with direct write`)
      try {
        await writeFile(LIBRARY_PATH, JSON.stringify(library, null, 2))
        const s2 = await stat(LIBRARY_PATH)
        lastSelfWriteMtimeMs = Math.round(s2.mtimeMs)
      } catch (healErr) {
        console.error('[save-library] self-heal direct write also failed:', healErr)
      }
    }

    // 4.5.0-114: async best-effort backup mirror to the NAS. Local is the
    // source of truth; this just keeps an off-machine copy current. Fire-and-
    // forget — never blocks the save, never affects local, so a flaky/torn
    // NAS write here is harmless (the app never reads the NAS).
    void mirrorLibraryToNas(library)
    // 4.5.0-117: throttled local backup snapshot (Phase 0). Best-effort, off
    // the hot path — keeps a rotating restore history (≤1 snapshot / 30 min).
    void maybeAutoSnapshot('save')

    // Disk now reflects the current library — the session-level
    // fingerprint set existed only to bridge the gap between an
    // import succeeding and save-library flushing. Clear it so a
    // user-initiated delete + re-import of the same source file
    // doesn't get falsely flagged as a duplicate.
    clearSessionImportedFingerprints()

    // ── Commit deletions ──
    let preservedOrphanCount = 0
    // Delete the audio file from the local mirror immediately so the
    // disk doesn't grow ghost orphans. Schedule a debounced iTunesDB
    // rebuild to push the deletion to the iPod (if mounted) without
    // hammering it on every individual delete in a batch.
    if (deletedPaths.length > 0) {
      // ── Audio-preservation guard ── Only auto-delete the underlying
      // masters for a SMALL, plausibly-deliberate batch. A large drop keeps
      // the files on disk as orphans (recoverable via
      // scripts/recover-orphans.mjs) rather than permanently unlinking
      // precious audio. `force` (explicit recovery/cleanup) bypasses the cap.
      if (mayUnlinkDeletions(deletedPaths.length, force)) {
        const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
        const pathSep = IS_WINDOWS ? '\\' : '/'
        for (const colon of deletedPaths) {
          const rel = colon.replace(/:/g, pathSep)
          try { await unlinkFS(join(LOCAL_MOUNT, rel)) } catch { /* file might already be gone */ }
        }
      } else {
        preservedOrphanCount = deletedPaths.length
        console.warn(`[save-library] preserved ${deletedPaths.length} audio file(s) on disk (exceeds unlink cap ${UNLINK_CAP}); index updated, files kept as orphans.`)
      }
      scheduleDbRebuild(deletedPaths)
    }

    // Brief 023: removed the mobile-snapshot auto-export. The
    // export-library-snapshot / mobile-overrides-pick-file /
    // mobile-overrides-apply IPC handlers, the
    // exportSnapshotIfConfigured helper, and the
    // library-snapshot.ts + library-overrides.ts modules they
    // depended on are all gone. Plex (via tag write-back, Brief
    // 020) is the path mobile consumes JakeTunes data through now.
    // 4.5.0-115: debounced save-library is the most common path for
    // library.json to change (edits, deletes, rating changes). Trigger
    // homemini sync here — quick mode — so homemini isn't blocked on
    // the 10-min safety-net full rsync that often times out mid-walk.
    triggerSync('metadata-edit')
    return {
      ok: true,
      deletedPaths: deletedPaths.length,
      preservedOrphanCount,
    }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'io-failed') }
  }
}

// ── Watch library.json for EXTERNAL modifications ──
// If our Python maintenance scripts (repair_mismatches.py, etc.) or any
// other process edits library.json while the app is running, the app's
// in-memory state silently diverges from disk. The next save-library
// then writes the stale in-memory state back, wiping the external
// edits. That's how fixes kept "disappearing" earlier tonight.
//
// Solution: watch the file. When mtime changes AND it wasn't us who
// wrote it, tell the renderer to reload. The renderer calls load-tracks
// which reads the fresh disk state into memory.
import { watch as fsWatch } from 'fs'
let libraryWatcherStarted = false
let lastObservedLibraryMtimeMs = 0
async function checkLibraryExternalChange(): Promise<void> {
  try {
    const s = await stat(LIBRARY_PATH)
    const mt = Math.round(s.mtimeMs)
    if (lastObservedLibraryMtimeMs === 0) {
      lastObservedLibraryMtimeMs = mt
      return
    }
    if (mt === lastObservedLibraryMtimeMs) return
    lastObservedLibraryMtimeMs = mt
    // Skip any change event that landed within a 2-second window of
    // our own save-library finishing. Atomic-rename writes can fire
    // watch events with slight mtime drift (up to hundreds of ms on
    // some filesystems), and the renderer's debounced save loop can
    // chain several saves inside a second — a too-tight tolerance
    // caused a feedback loop where save→reload→save spawned
    // cascading db_reader.py processes.
    if (Math.abs(mt - lastSelfWriteMtimeMs) < 2000) return
    console.log(`[watch] library.json changed externally (mtime ${mt}, self ${lastSelfWriteMtimeMs}) — asking renderer to reload`)
    // 4.5.0-106: external change happened — drop the in-memory cache
    // so the next reader picks up fresh content. Without this the cache
    // would serve stale data until app restart.
    libraryCache.invalidate()
    // Keep ALAC→FLAC routing current when the index sync pushes a fresh
    // library.json (workmini learns songs every minute). Without this the
    // codec map freezes at boot and new ALACs play as raw Chromium-illegal
    // audio until relaunch.
    void loadCodecMapFromLibrary()
    sendToRenderer('library-external-change')
  } catch { /* file briefly missing during atomic replace — ignore */ }
}
function startLibraryWatcher() {
  if (libraryWatcherStarted) return
  libraryWatcherStarted = true
  try {
    fsWatch(LIBRARY_PATH, () => { void checkLibraryExternalChange() })
    console.log('[watch] library.json fsWatch active')
  } catch (err) {
    console.warn('[watch] fsWatch could not start:', err)
  }
  // 4.5.0-92 — periodic mtime poll as fsWatch backstop. fsWatch over
  // SMB (Phase 2 NAS mode) is notoriously unreliable — events may
  // not fire when external writers (Mini, future workmini) update
  // library.json. The poll runs at a low cadence so it's cheap even
  // on local SSD, and guarantees we eventually notice external
  // changes regardless of fsWatch's delivery reliability. setInterval
  // is process-lifetime; no cleanup needed for the app's lifetime.
  setInterval(() => { void checkLibraryExternalChange() }, 15_000)
  console.log(`[watch] library.json mtime poll active (15s cadence, ${STATE_IS_NAS ? 'NAS-mode backstop' : 'local-mode redundant'})`)
}

// Sync: read iPod DB and return NEW tracks/playlists not already in the library
// Read the iPod's actual iTunesDB and return the full track + playlist
// set. This is what iTunes used to call "On This iPod" — it's what the
// device itself reports as present, independent of the app's local
// library.json. Handy for reconciling "library says X / iPod says Y"
// discrepancies.
// ── The Music Man's wall: what the brain actually knows (Jake asked
// "how is progress?" — this makes the answer a glance, not an audit).
// Pure reads; every number is a real file, every stamp a real mtime.
ipc.handle('brain-status', async () => {
  const ud = app.getPath('userData')
  const out: Record<string, unknown> = {}
  try {
    const lib = (await libraryCache.get()) as { tracks?: Array<Record<string, unknown>> }
    const tracks = Array.isArray(lib.tracks) ? lib.tracks : []
    out.tracks = tracks.length
    out.subgenred = tracks.filter((t) => t.subgenre).length
    out.starred = tracks.filter((t) => t.rating === 5).length
  } catch { /* library unreadable — tiles show gaps honestly */ }
  try {
    const raw = await readFile(join(ud, 'brain-descriptors.json'), 'utf-8')
    const d = JSON.parse(raw) as Record<string, { te?: unknown }>
    out.descriptors = Object.keys(d).length
    out.themed = Object.values(d).filter((v) => v && (v as { te?: unknown }).te).length
    out.descriptorsMtime = (await stat(join(ud, 'brain-descriptors.json'))).mtimeMs
  } catch { /* no descriptors yet */ }
  try {
    const ly = JSON.parse(await readFile(join(ud, 'lyrics.json'), 'utf-8')) as Record<string, unknown>
    out.lyrics = Object.keys(ly).length
  } catch { /* none */ }
  try {
    const st = await stat(join(ud, 'embeddings.bin'))
    out.embeddingsMtime = st.mtimeMs
    out.embeddingsBytes = st.size
  } catch { /* none */ }
  try {
    const hist = JSON.parse(await readFile(join(ud, 'workout-sync-history.json'), 'utf-8')) as Array<{ syncedAt?: string; added?: unknown[]; removed?: unknown[] }>
    out.syncs = hist.length
    out.syncEdits = hist.reduce((n, h) => n + (h.added?.length || 0) + (h.removed?.length || 0), 0)
    out.lastSync = hist[0]?.syncedAt || null
  } catch { /* none yet */ }
  return { ok: true, ...out }
}, { public: true })
// ── Sync library TO iPod ── (pipeline extracted to sync-engine/ —
// 6.0 Phase 1 / roadmap P1C2. Behavior lives there; this is the host.)
const syncEngine = createSyncEngine({
  LOSSLESS_EXTS, LOSSLESS_CODECS, codecByAbsPath,
  getMusicDir: () => MUSIC_DIR,
  getMount: () => detectedIpodMount,
  setMount: (m) => {
    detectedIpodMount = m
    detectedIpodVolume = m ? volumeNameFromMount(m) : null
  },
  buildAacMirror, buildIpodSafeAlacMirror, candidateMusicMounts, cleanOrphansOnMusicRoot,
  computeAudioFingerprint, getConcertOwnedTrackIds, isStreamedTrackFile,
  materializeLibraryTrack, readIpodDatabase, resolveTrackAbsPath, scheduleDbRebuild,
  sendToRenderer, verifyAndHealTracks, walkAudioFilesUnder,
})
const { handleSyncToIpod, handleSyncIpodFromDevice } = syncEngine

// ── iPod Classic ALAC compatibility fix ──
//
// (Removed: 'verify-library' / 'apply-library-repair' IPC handlers and
// the menu entry that fired them. The Python script in
// core/repair_mismatches.py classified files as "unrepairable" using a
// strict tag normalizer that didn't equate "Pt. 1" with "Part 1", and
// the apply handler was hard-coded to pass --delete-unrepairable, so a
// matcher false-negative meant real tracks got silently deleted from
// library.json. The audio files themselves were never touched — the
// timestamped library.json.bak-repair-* backup the script writes is
// always recoverable. iTunes/iPod never had a verify step; we shouldn't
// either. The CLI script stays on disk for future opt-in debugging.)
ipc.handle('alac-compat-scan', async () => {
  const script = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/alac_compat_fix.py')
  return await new Promise<{ ok: boolean; count?: number; samples?: unknown[]; error?: string }>((resolve) => {
    const py = spawn(PYTHON_CMD ?? 'python3', [script])
    let stdout = ''
    let stderr = ''
    py.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    py.on('error', (err) => resolve({ ok: false, error: safeIpcError(err, 'tool-failed') }))
    py.on('close', async (code) => {
      if (code !== 0) { resolve({ ok: false, error: safeIpcError(stderr, 'tool-failed') }); return }
      try {
        const rJson = await readFile('/tmp/jaketunes-alac-compat-report.json', 'utf-8')
        const r = JSON.parse(rJson) as { incompatible: number; samples: unknown[] }
        resolve({ ok: true, count: r.incompatible, samples: r.samples })
      } catch {
        resolve({ ok: true, count: 0, samples: [] })
      }
    })
  })
}, { refuse: REFUSED_SENDER })

ipc.handle('alac-compat-fix', async () => {
  const script = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/alac_compat_fix.py')
  return await new Promise<{ ok: boolean; error?: string; summary?: string }>((resolve) => {
    const py = spawn(PYTHON_CMD ?? 'python3', [script, '--apply'])
    let stdout = ''
    let stderr = ''
    py.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      // Stream progress to renderer so user can watch the bar fill. Each
      // Python line "[N/M] file … OK" counts as a step.
      const m = d.toString().match(/\[(\d+)\/(\d+)\]\s+(\S+)/)
      if (m) {
        sendToRenderer('alac-compat-progress', {
          current: Number(m[1]), total: Number(m[2]), file: m[3],
        })
      }
    })
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    py.on('error', (err) => resolve({ ok: false, error: safeIpcError(err, 'tool-failed') }))
    py.on('close', async (code) => {
      if (code === 0) {
        // (4.1: removed schedulePrewarmFromLibrary call here. The user
        // can hit "Prepare ALAC tracks for instant play" in the
        // Library Maintenance modal to refresh the cache for the
        // re-encoded files. Doing it inline here would silently spawn
        // ffmpeg jobs the user didn't ask for.)
        resolve({ ok: true, summary: stdout.slice(-3000) })
      } else {
        resolve({ ok: false, error: safeIpcError(stderr || `python exit ${code}`, 'tool-failed') })
      }
    })
  })
}, { refuse: REFUSED_SENDER })

// ── Import tracks from dropped files ──
// Music library storage — Brief 011b three-tier resolution:
//   1. library.musicRoot in app-settings.json (explicit override wins absolutely)
//   2. If both legacy ~/Music2 and default ~/Music candidates exist, pick the
//      richer one by populated F00–F49 subdirectory count (mtime as tiebreak)
//   3. Single- or no-candidate fallback (default path if nothing exists)
//
// The hand-fix history: pre-Brief-011b this was an `existsSync(LEGACY) ? LEGACY
// : DEFAULT` ternary that broke on workmini today — `~/Music2/JakeTunesLibrary`
// existed as a stale legacy folder while the canonical fresh library lived at
// `~/Music/JakeTunesLibrary`. The auto-detect picked the stale one and recent
// imports became silent + 0:00/0:00. Resolution now runs once at app.whenReady;
// MUSIC_DIR is a `let` initialised to the default so module-load reads see a
// sensible value before resolution completes.
import { existsSync, statSync } from 'fs'
const LEGACY_MUSIC_DIR = join(process.env.HOME || '', 'Music2/JakeTunesLibrary/iPod_Control/Music')
const DEFAULT_MUSIC_DIR = join(app.getPath('music'), 'JakeTunesLibrary/iPod_Control/Music')
let MUSIC_DIR: string = DEFAULT_MUSIC_DIR

// Count populated F00–F49 directories under an iPod-style music root. A real
// library has most/all 50; stale folders typically have fewer. Used as the
// auto-detect tiebreaker when both candidates exist.
function countFDirs(musicDir: string): number {
  if (!existsSync(musicDir)) return -1
  let count = 0
  for (let i = 0; i < 50; i++) {
    const fName = `F${String(i).padStart(2, '0')}`
    if (existsSync(join(musicDir, fName))) count++
  }
  return count
}

async function resolveMusicDir(): Promise<string> {
  // Tier 1: explicit setting wins absolutely. The deploy script writes this
  // on every fresh deploy so the stale-legacy bug is impossible on machines
  // we deploy to.
  try {
    const settings = await readAppSettingsAsync()
    const lib = (settings?.library ?? null) as { musicRoot?: string } | null
    if (lib?.musicRoot && typeof lib.musicRoot === 'string') {
      const explicit = join(lib.musicRoot, 'iPod_Control/Music')
      if (existsSync(explicit)) {
        console.log(`[library] using explicit musicRoot from app-settings: ${explicit}`)
        return explicit
      }
      console.warn(`[library] explicit musicRoot setting "${lib.musicRoot}" does not exist; falling back to auto-detect`)
    }
  } catch (err) {
    console.warn('[library] failed to read app-settings for musicRoot:', err)
  }

  // Tier 2: both candidates exist → pick the richer one.
  const legacyExists = existsSync(LEGACY_MUSIC_DIR)
  const defaultExists = existsSync(DEFAULT_MUSIC_DIR)
  if (legacyExists && defaultExists) {
    const legacyCount = countFDirs(LEGACY_MUSIC_DIR)
    const defaultCount = countFDirs(DEFAULT_MUSIC_DIR)
    console.log(`[library] both candidates exist: legacy=${legacyCount} F-dirs, default=${defaultCount} F-dirs`)
    if (defaultCount > legacyCount) {
      console.log(`[library] default wins by F-count: ${DEFAULT_MUSIC_DIR}`)
      return DEFAULT_MUSIC_DIR
    }
    if (legacyCount > defaultCount) {
      console.log(`[library] legacy wins by F-count: ${LEGACY_MUSIC_DIR}`)
      return LEGACY_MUSIC_DIR
    }
    // Tie on F-count → mtime tiebreak.
    try {
      const legacyMtime = statSync(LEGACY_MUSIC_DIR).mtimeMs
      const defaultMtime = statSync(DEFAULT_MUSIC_DIR).mtimeMs
      const winner = defaultMtime > legacyMtime ? DEFAULT_MUSIC_DIR : LEGACY_MUSIC_DIR
      console.log(`[library] F-count tie; mtime tiebreak picks: ${winner}`)
      return winner
    } catch (err) {
      console.warn('[library] mtime tiebreak failed; defaulting to default-path:', err)
      return DEFAULT_MUSIC_DIR
    }
  }

  // Tier 3: only one candidate exists, or neither.
  if (legacyExists) {
    console.log(`[library] using legacy (only candidate): ${LEGACY_MUSIC_DIR}`)
    return LEGACY_MUSIC_DIR
  }
  if (defaultExists) {
    console.log(`[library] using default (only candidate): ${DEFAULT_MUSIC_DIR}`)
    return DEFAULT_MUSIC_DIR
  }
  console.log(`[library] no candidate dirs exist; will use default: ${DEFAULT_MUSIC_DIR}`)
  return DEFAULT_MUSIC_DIR
}

// All music ROOT mounts (the parent of iPod_Control/Music) that currently exist
// on disk: the resolved root, the default + legacy auto-detect roots, an
// explicit configured root, and a mounted iPod. Dead-track reconciliation
// verifies a track against EVERY one of these, so a file present under ANY mount
// keeps the track alive. A track is only ever flagged "dead" when its audio is
// absent from all of them — this closes the single-resolved-root over-deletion
// hole (a library that spans / migrated between ~/Music and ~/Music2, or whose
// mirror landed in a different root than resolveMusicDir happened to pick).
async function candidateMusicMounts(): Promise<string[]> {
  const stripSuffix = (p: string): string => p.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  const roots: string[] = [
    stripSuffix(MUSIC_DIR),
    stripSuffix(DEFAULT_MUSIC_DIR),
    stripSuffix(LEGACY_MUSIC_DIR),
  ]
  try {
    const settings = await readAppSettingsAsync()
    const lib = (settings?.library ?? null) as { musicRoot?: string; streamRoot?: string } | null
    if (lib?.musicRoot && typeof lib.musicRoot === 'string') roots.push(lib.musicRoot)
    // NEVER put streamRoot (JakeShareNAS / SMB) into verify/dead-track mounts
    // on a cache-farm machine. existsSync + readdir on that tree is the
    // workmini pinwheel (203s listings). Local musicRoot holds symlinks for
    // every track; lstat treats those as present. Homemini serves the bytes.
    if (
      lib?.streamRoot &&
      typeof lib.streamRoot === 'string' &&
      !(await isHomeminiPlaybackClientCached())
    ) {
      roots.push(lib.streamRoot)
    }
  } catch { /* settings unreadable — auto-detect roots still apply */ }
  if (detectedIpodMount) roots.push(detectedIpodMount)
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of roots) {
    if (!r || seen.has(r)) continue
    seen.add(r)
    // Async probe — never existsSync. A wedged mount must not beachball the
    // main process; treat timeout/failure as "not a usable mount".
    const musicTree = join(r, 'iPod_Control', 'Music')
    const ok = await Promise.race([
      lstat(musicTree).then(() => true, () => false),
      new Promise<boolean>((res) => setTimeout(() => res(false), 1500)),
    ])
    if (ok) out.push(r)
  }
  return out
}

// resolveAudioPaths lives in ipc/import-ipc.ts (shared with the
// import-resolve-paths handler + session allowlist grants).

// ── Per-file import primitive ──
// Pulled out of the batch loop so the renderer-side queue can call it
// for ONE file at a time. That keeps each IPC short, makes failures
// retryable per-item, and prevents one slow conversion from blocking
// the whole drop. The batch handler below now just walks the list and
// calls this for each entry.
// Import pipeline moved to import-pipeline.ts (renovation P1C1).
// _normFingerprint / fingerprintTrack / the session dupe set /
// loadDupeFingerprintsFromLibrary live there now; index keeps only the
// binary computeAudioFingerprint (shared by sync + reconcile + CD import).

// ── Audio content fingerprint ──
//
// Identity-based replacement for the old text-matching verify pass. We
// hash the first 256KB of the audio file plus the duration. That window
// covers all audio container metadata atoms and well into the actual
// audio stream, so two different songs cannot collide. Stored once per
// track at import time as `audioFingerprint`. Re-computed on demand
// during the silent post-sync verifier.
//
// Format: "sha1:<hex16>|<duration_ms>". Duration is included so a
// re-encode that produced byte-different but-same-song output (very
// rare in practice) still has a chance of matching by partial.
async function computeAudioFingerprint(absPath: string, durationMs: number): Promise<string | null> {
  try {
    const fh = await open(absPath, 'r')
    try {
      const buf = Buffer.alloc(256 * 1024)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      if (bytesRead <= 0) return null
      const hash = createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex').slice(0, 16)
      return `sha1:${hash}|${Math.round(Number(durationMs) || 0)}`
    } finally {
      await fh.close().catch(() => {})
    }
  } catch {
    return null
  }
}

// ── Streaming: streamed-track detection (Stage 2/3 data-loss safety) ──────
// A "streamed" track's on-disk file is a SYMLINK — its real bytes live on
// homemini and are fetched over HTTP at playback time (see the ipod-audio://
// handler). Such a track is PRESENT-by-definition, even when the symlink
// target is unreachable (homemini offline, no NAS mount). Every destructive
// or verify path that stat()-FOLLOWS a track path must treat a symlink as
// present-and-streamed — otherwise the dead-track deletion chain reads it as
// audioMissing and silently deletes it (the library-data-loss class). lstat()
// does not follow the link, so it sees the symlink itself regardless of target.
async function isStreamedTrackFile(absPath: string): Promise<boolean> {
  try { return (await lstat(absPath)).isSymbolicLink() } catch { return false }
}

// Best-effort: turn a track's colon-style library path into an absolute
// path under either the local mount or the iPod mount. Returns the
// first one that exists, or null. Sync flows use this when we don't
// know which mount the file lives on at verify time.
async function resolveTrackAbsPath(colonPath: string, mounts: string[]): Promise<string | null> {
  const pathSep = IS_WINDOWS ? '\\' : '/'
  if (!colonPath) return null
  const rel = colonPath.replace(/:/g, pathSep)
  for (const mount of mounts) {
    if (!mount) continue
    const abs = join(mount, rel)
    // lstat FIRST — never stat()-follow a farm symlink into SMB. On workmini
    // that was thousands of hung pool threads during verify/sync and the
    // classic pinwheel. Symlink = present (streamed); real file = present.
    try {
      const st = await lstat(abs)
      if (st.isSymbolicLink() || st.isFile()) return abs
    } catch { /* not on this mount */ }
  }
  return null
}

// VerifyTrackInput / VerifyTrackUpdate moved to sync-engine/ with their
// only caller; the implementation below still lives here as host duty.

// Silent post-sync verifier. For each input track:
//   1. Resolve current path against {local, iPod} mounts.
//   2. If the file exists and has no stored fingerprint, compute one
//      and emit a backfill update. (Never overwrites an existing
//      fingerprint — that would mask a real wrong-file case.)
//   3. If the file exists AND a fingerprint is stored AND they differ,
//      scan the available F-dirs looking for a file whose fingerprint
//      matches the stored one. If found, rewrite the track's path
//      silently. If not found, mark audioMissing.
//   4. If the file doesn't exist, do the same F-dir scan with the
//      stored fingerprint. Same outcome — re-link if found, mark
//      audioMissing if not.
//
// NEVER deletes a track. NEVER updates the stored fingerprint when a
// mismatch is detected (only on initial backfill). The worst this can
// do is mark a track as audioMissing, which is a UI flag the user can
// resolve by re-importing or pointing at a new file.
async function verifyAndHealTracks(
  inputs: VerifyTrackInput[],
  mounts: string[],
): Promise<VerifyTrackUpdate[]> {
  if (inputs.length === 0) return []
  const updates: VerifyTrackUpdate[] = []

  // Lazy-build a fingerprint index across the F-dirs of each mount.
  // Only computed on first miss so a clean sync (everything matches)
  // costs nothing extra. Indexes file → fingerprint (we look up the
  // other direction by filtering).
  let indexBuilt = false
  const fpToPath = new Map<string, string>()  // fingerprint → first abs path
  const buildIndex = async () => {
    if (indexBuilt) return
    indexBuilt = true
    const { readdir: rd } = await import('fs/promises')
    for (const mount of mounts) {
      if (!mount) continue
      for (let i = 0; i < 50; i++) {
        const sub = join(mount, 'iPod_Control', 'Music', `F${String(i).padStart(2, '0')}`)
        let entries: string[] = []
        try { entries = await rd(sub) } catch { continue }
        for (const fn of entries) {
          const abs = join(sub, fn)
          // We don't know the file's duration without parsing tags,
          // which is expensive. Use 0 for the duration component;
          // verify lookups below match by fingerprint *string* with the
          // correct duration on each side, so an index entry built with
          // duration=0 is keyed differently from a stored fingerprint.
          // We accept that and instead store hash-only keys for the
          // index, then compare the hash portion separately.
          // Compute the file fingerprint with duration=0 to get a stable hash key.
          const hashOnly = await computeAudioFingerprint(abs, 0)
          if (hashOnly) {
            // Strip the "|0" duration suffix to leave just "sha1:<hex>".
            const key = hashOnly.split('|')[0]
            if (!fpToPath.has(key)) fpToPath.set(key, abs)
          }
        }
      }
    }
  }

  // Convert "sha1:<hex>|<dur>" → "sha1:<hex>" so we can lookup against
  // the hash-only index above.
  const hashKey = (fp: string | undefined): string | null => {
    if (!fp || !fp.startsWith('sha1:')) return null
    return fp.split('|')[0]
  }

  // Convert an absolute path on either mount back into the colon form
  // the library uses. Returns null if abs is not under any mount.
  const colonFromAbs = (abs: string): string | null => {
    const pathSep = IS_WINDOWS ? '\\' : '/'
    for (const mount of mounts) {
      if (!mount) continue
      if (abs.startsWith(mount + pathSep)) {
        return ':' + abs.slice(mount.length + 1).split(pathSep).join(':')
      }
    }
    return null
  }

  for (const tr of inputs) {
    const absNow = await resolveTrackAbsPath(tr.path, mounts)
    // Streamed tracks (symlink → homemini) are present-by-definition: their
    // bytes aren't local, so there's nothing to fingerprint or heal, and they
    // must NEVER be flagged audioMissing. Skipping here is the single chokepoint
    // that keeps the dead-track deletion chain (scan/remove-dead-tracks + the
    // post-sync verifier) and the expensive F-dir fingerprint index off them.
    if (absNow && await isStreamedTrackFile(absNow)) {
      if (tr.audioMissing) updates.push({ id: tr.id, audioMissing: false })
      continue
    }
    if (absNow) {
      // File exists at expected path. Backfill fingerprint if missing.
      // (One-time per track; after that the field is permanent and only
      // updated by an explicit re-import.)
      if (!tr.audioFingerprint) {
        const fp = await computeAudioFingerprint(absNow, tr.duration)
        if (fp) updates.push({ id: tr.id, audioFingerprint: fp, audioMissing: false })
        continue
      }
      // Stored fingerprint present — verify against the current file.
      const cur = await computeAudioFingerprint(absNow, tr.duration)
      if (cur && cur === tr.audioFingerprint) {
        // Healthy. Retract a stale flag; otherwise nothing to do.
        if (tr.audioMissing) updates.push({ id: tr.id, audioMissing: false })
        continue
      }
      // Stored fingerprint differs from the current file. Two cases:
      //   (a) The file at this path was overwritten by a re-encode
      //       (ALAC compat fix, etc.) — file is fine, fingerprint is
      //       stale. We can't tell this case apart from (b) without
      //       text matching, which is what we deliberately moved away
      //       from. So we don't touch path or fingerprint here. The
      //       stale fingerprint will get refreshed if the user
      //       re-imports the track.
      //   (b) The path got cross-linked to a different song — this is
      //       the actual bug we want to catch. We DO try to find the
      //       right audio elsewhere on the mounts via the fingerprint
      //       index. If found, re-link silently. If not found, leave
      //       the track alone (do NOT flag audioMissing — the file
      //       exists, the user can still play SOMETHING, even if it's
      //       wrong; and we want to avoid false positives on case
      //       (a)).
      await buildIndex()
      const target = hashKey(tr.audioFingerprint)
      const found = target ? fpToPath.get(target) : null
      if (found) {
        const newColon = colonFromAbs(found)
        if (newColon && newColon !== tr.path) {
          updates.push({ id: tr.id, path: newColon, audioMissing: false })
          continue
        }
      }
      // Mismatch with no recovery possible; leave the track untouched.
      continue
    }
    // File missing entirely (path resolved to nothing on any mount).
    // Try the heal-by-fingerprint scan. If we find it, re-link. If
    // not, flag audioMissing so the UI can show the user.
    if (tr.audioFingerprint) {
      await buildIndex()
      const target = hashKey(tr.audioFingerprint)
      const found = target ? fpToPath.get(target) : null
      if (found) {
        const newColon = colonFromAbs(found)
        if (newColon) {
          updates.push({ id: tr.id, path: newColon, audioMissing: false })
          continue
        }
      }
    }
    updates.push({ id: tr.id, audioMissing: true })
  }
  return updates
}

// ── Library orphan scan/purge (identity-safe: basename not in library.json) ──
const ORPHAN_AUDIO_EXTS = new Set([
  '.m4a', '.mp3', '.flac', '.aac', '.wav', '.alac', '.aiff', '.aif', '.m4p', '.m4b',
])

function colonPathBasename(colonPath: string): string {
  const parts = colonPath.replace(/:/g, '/').split('/')
  return parts[parts.length - 1] || ''
}

function indexedBasenamesFromTracks(tracks: Array<{ path?: string }>): Set<string> {
  const indexed = new Set<string>()
  for (const t of tracks) {
    const fn = colonPathBasename(String(t.path || ''))
    if (fn) indexed.add(fn)
  }
  return indexed
}

async function walkAudioFilesUnder(root: string): Promise<string[]> {
  const { readdir } = await import('fs/promises')
  let out: string[] = []
  let ents: import('fs').Dirent[] = []
  try { ents = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(root, e.name)
    if (e.isDirectory()) out = out.concat(await walkAudioFilesUnder(p))
    else {
      const ext = p.slice(p.lastIndexOf('.')).toLowerCase()
      if (ORPHAN_AUDIO_EXTS.has(ext)) out.push(p)
    }
  }
  return out
}

function isDiskOrphanFile(filePath: string, indexed: Set<string>): boolean {
  const fn = filePath.split(/[/\\]/).pop() || ''
  if (fn.startsWith('._')) return true
  return !indexed.has(fn)
}

interface OrphanScanResult {
  trackCount: number
  diskCount: number
  orphanCount: number
  orphanBytes: number
  samples: Array<{ basename: string; mtimeMs: number; size: number }>
}

async function scanLibraryOrphans(): Promise<OrphanScanResult> {
  let lib: { tracks?: Array<{ path?: string }> }
  try {
    lib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8'))
  } catch (err) {
    throw new Error(`library.json read failed: ${err instanceof Error ? err.message : err}`)
  }
  const tracks = lib.tracks || []
  const indexed = indexedBasenamesFromTracks(tracks)
  const files = await walkAudioFilesUnder(MUSIC_DIR)
  const orphans: Array<{ path: string; mtimeMs: number; size: number }> = []
  for (const f of files) {
    if (!isDiskOrphanFile(f, indexed)) continue
    const s = await stat(f).catch(() => null)
    orphans.push({
      path: f,
      mtimeMs: s?.mtimeMs ?? 0,
      size: s?.size ?? 0,
    })
  }
  orphans.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const orphanBytes = orphans.reduce((sum, o) => sum + o.size, 0)
  return {
    trackCount: tracks.length,
    diskCount: files.length,
    orphanCount: orphans.length,
    orphanBytes,
    samples: orphans.slice(0, 8).map((o) => ({
      basename: o.path.split(/[/\\]/).pop() || o.path,
      mtimeMs: o.mtimeMs,
      size: o.size,
    })),
  }
}

async function purgeLibraryOrphans(): Promise<{ deleted: number; bytesFreed: number }> {
  let lib: { tracks?: Array<{ path?: string }> }
  try {
    lib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8'))
  } catch (err) {
    throw new Error(`library.json read failed: ${err instanceof Error ? err.message : err}`)
  }
  const indexed = indexedBasenamesFromTracks(lib.tracks || [])
  const files = await walkAudioFilesUnder(MUSIC_DIR)
  let deleted = 0
  let bytesFreed = 0
  for (const f of files) {
    if (!isDiskOrphanFile(f, indexed)) continue
    const s = await stat(f).catch(() => null)
    if (s) bytesFreed += s.size
    try {
      await unlink(f)
      deleted++
    } catch (err) {
      console.warn(`[purge-orphans] failed to delete ${f}:`, err)
    }
  }
  return { deleted, bytesFreed }
}

// ⚠️ 2026-07-21: this deletes device files by BASENAME string-match — the
// destructive-op-on-text-comparison pattern CLAUDE.md forbids (it deleted
// tracks before). Root cause of Jake's shrinking iPod: successive syncs
// showed 892→857→854→846 because a file freshly copied THIS sync whose
// basename didn't line up with the set (convert-renames, path rewrites)
// was matched as an "orphan" and deleted right after being written. The
// `protectMtimeAfterMs` guard makes it structurally impossible to delete
// anything this sync touched: a file modified at/after the sync started is
// never an orphan, no matter what its name is. Only genuinely stale files
// (old mtime AND unreferenced) are reclaimed.
async function cleanOrphansOnMusicRoot(
  musicRoot: string,
  tracks: Array<{ path?: string }>,
  protectMtimeAfterMs = 0,
): Promise<{ deleted: number; bytesFreed: number; protected: number }> {
  const indexed = indexedBasenamesFromTracks(tracks)
  let files = await walkAudioFilesUnder(musicRoot)
  // fskit hides files across readdirs — one walk left 153 orphans on the Mini
  // after a "successful" wipe (2026-08-15). Re-walk until two listings agree
  // or we cap out.
  for (let pass = 0; pass < 4; pass++) {
    const again = await walkAudioFilesUnder(musicRoot)
    if (again.length === files.length) {
      const prev = new Set(files)
      if (again.every((p) => prev.has(p))) break
    }
    files = again
  }
  let deleted = 0
  let bytesFreed = 0
  let protectedCount = 0
  for (const f of files) {
    if (!isDiskOrphanFile(f, indexed)) continue
    const s = await stat(f).catch(() => null)
    // NEVER delete a file this sync just wrote — the guard that stops the
    // shrinking-iPod bug at its root.
    if (protectMtimeAfterMs > 0 && s && s.mtimeMs >= protectMtimeAfterMs - 2000) {
      protectedCount++
      console.warn(`[clean-orphans] PROTECTED freshly-written file, not deleting: ${f.split(/[/\\]/).pop()}`)
      continue
    }
    if (s) bytesFreed += s.size
    try {
      await unlink(f)
      deleted++
    } catch (err) {
      console.warn(`[clean-orphans] failed to delete ${f}:`, err)
    }
  }
  return { deleted, bytesFreed, protected: protectedCount }
}

// SingleImportResult / findFreeImportedId / importOneFile moved to
// import-pipeline.ts (renovation P1C1). The ⚠️ TWIN note about
// rip-cd-tracks' scan-then-loop travelled with findFreeImportedId.

// Single-file IPC for the renderer-side import queue. The queue calls
// this once per item, in series, with retry on failure. Folders are
// resolved before enqueuing in the renderer so this only ever sees
// individual audio files.
ipc.handle('import-track', async (_e, srcPath: string, id: number, preferredFormat?: string) => {
  // Session allowlist — path must have come from the file picker, a
  // drag-drop grant (webUtils), inbox emission, or folder expand.
  if (!isImportPathAllowed(srcPath)) {
    console.warn('[import-track] refused non-allowlisted path')
    return { ok: false, error: 'path-not-allowed' }
  }
  const validFormats: AudioFormat[] = ['aac-128', 'aac-256', 'aac-320', 'alac', 'aiff', 'wav']
  // 4.0 Settings: when caller doesn't specify a format, fall back to the
  // user's preferred default from app-settings.json (Library tab).
  let resolvedFormat = preferredFormat
  if (!validFormats.includes(resolvedFormat as AudioFormat)) {
    const settings = await readAppSettingsAsync()
    const lib = settings?.library as { defaultImportFormat?: string } | undefined
    if (lib && validFormats.includes(lib.defaultImportFormat as AudioFormat)) {
      resolvedFormat = lib.defaultImportFormat
    }
  }
  const userPreferred: AudioFormat = validFormats.includes(resolvedFormat as AudioFormat)
    ? (resolvedFormat as AudioFormat)
    : 'aac-256'
  // Jake's import policy: FLAC/WAV sources become AAC regardless of the
  // user preference; ALAC stays ALAC; everything else honors preference.
  const chosenFmt = resolveImportFormat(srcPath, userPreferred)
  const dupeFingerprints = await loadDupeFingerprintsFromLibrary()
  const r = await importOneFile(srcPath, id, chosenFmt, preferredFormat, dupeFingerprints)

  // Record this import's fingerprint at the session level so the
  // NEXT import-track call (which may fire before save-library has
  // had a chance to flush) sees this track as already present and
  // refuses to import it a second time. Pass duration in
  // milliseconds — fingerprintTrack normalises to seconds itself.
  if (r.ok && r.track) {
    const fp = fingerprintTrack({
      title: r.track.title,
      artist: r.track.artist,
      duration: r.track.duration,
    })
    if (fp) addSessionImportedFingerprint(fp)
  }

  // If we just wrote an ALAC file, transcode its AAC mirror to the
  // play-cache NOW (await) — Chromium can't decode ALAC, and the user
  // is already in import-progress UI so an extra 3-5s here is invisible.
  // Without this await, the transcode is async-fire-and-forget, and the
  // first time the user clicked play on the new track they hit the 5s
  // on-demand transcode wait. (4.1 design: cache is hot the moment
  // import completes, never on-demand at play-time.)
  if (r.ok && r.track && chosenFmt === 'alac') {
    const colon = String(r.track.path || '')
    if (colon) {
      const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
      const pathSep = IS_WINDOWS ? '\\' : '/'
      const abs = join(LOCAL_MOUNT, colon.replace(/:/g, pathSep))
      await prewarmAlacCache([abs]).catch((err) => {
        console.warn(`[import] alac cache transcode failed for ${abs}:`, err)
      })
    }
  }

  // Enqueue background audio analysis (4.0 §2.4a). Non-blocking — the
  // import response is sent before analysis starts. Failures don't fail
  // the import; the worker logs and writes the audioAnalysisAt sentinel
  // so we don't retry every session.
  if (r.ok && r.track) {
    const t = r.track
    const colon = String(t.path || '')
    const trackId = Number(t.id) || 0
    if (colon && trackId > 0) {
      const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
      const pathSep = IS_WINDOWS ? '\\' : '/'
      const abs = join(LOCAL_MOUNT, colon.replace(/:/g, pathSep))
      const title = String(t.title || '').toLowerCase().trim()
      const artist = String(t.artist || '').toLowerCase().trim()
      const duration = Number(t.duration) || 0
      const fp = `${title}|${artist}|${duration}`
      enqueueAudioAnalysis({ trackId, path: abs, fingerprint: fp })
    }
  }

  // 4.4.18: fire the multi-device sync after every successful import.
  // Debounced 30 sec inside the orchestrator so an album of 12 tracks
  // (whether dropped via Finder drag, the inbox-watcher, or anything
  // else) coalesces into ONE sync, not 12.
  if (r.ok && r.track) {
    triggerSync('import')
  }

  return r
}, { refuse: REFUSED_SENDER })

// One-shot audio analysis for a single track. Used by §2.4b's backfill
// scan UI (renderer drives the loop) and for any future on-demand
// re-analysis. Does NOT enqueue — runs the script inline and persists.
// For new imports, prefer the enqueue path which de-dupes and serializes.
//
// Takes the track's colon-format path (the on-disk format used in
// library.json); main resolves to an absolute path because renderer
// doesn't know LOCAL_MOUNT.
ipc.handle('analyze-track', async (_e, trackId: number, colonPath: string, fingerprint: string) => {
  // Brief 010b: same null guard as processAudioAnalysisJob — skip
  // entirely (no sentinel write) when no librosa-equipped Python was
  // found at startup, so the failure is surfaced loud and the track
  // remains a candidate for re-analysis after the user fixes Python.
  if (!PYTHON_CMD) {
    console.warn(`[audio-analysis] analyze-track ${trackId} skipped — no Python with librosa available`)
    return { ok: false, error: 'no Python with librosa available; check startup logs' }
  }
  const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  const pathSep = IS_WINDOWS ? '\\' : '/'
  const absPath = join(LOCAL_MOUNT, colonPath.replace(/:/g, pathSep))
  const result = await runAudioAnalysisScript(absPath)
  const fields: Record<string, string> = {
    audioAnalysisAt: String(Date.now()),
  }
  if (result.ok) {
    if (typeof result.bpm === 'number' && result.bpm > 0) fields.bpm = String(result.bpm)
    if (result.keyRoot) fields.keyRoot = result.keyRoot
    if (result.keyMode) fields.keyMode = result.keyMode
    if (result.camelotKey) fields.camelotKey = result.camelotKey
    if (typeof result.keyConfidence === 'number') fields.keyConfidence = String(result.keyConfidence)
  }
  try {
    await persistOverrideFields(trackId, fields, fingerprint)
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'io-failed') }
  }
  return result
}, { refuse: REFUSED_SENDER })

// Brief 010 Phase 4: queue-based audio analysis IPCs. The renderer
// backfill button uses these instead of calling analyze-track per-track
// in a renderer-side loop. The worker's playback gate (existing) + the
// persistent queue (Phase 2) then handle pause/resume + survive-restart
// for free. Renderer sends colon-path; main resolves to absolute path
// using the same logic the analyze-track handler uses.
ipc.handle('audio-analysis:enqueue-many', async (_e, jobs: Array<{ trackId: number; colonPath: string; fingerprint: string }>) => {
  const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  const pathSep = IS_WINDOWS ? '\\' : '/'
  // Dedupe against a Set instead of re-scanning the array per job, and persist
  // ONCE for the whole batch — see enqueueAudioAnalysis's `batch` note. A
  // full-library enqueue is a single write here instead of one per track.
  const queued = new Set(audioAnalysisQueue.map(j => j.trackId))
  let enqueued = 0
  for (const j of jobs) {
    if (queued.has(j.trackId)) continue
    queued.add(j.trackId)
    const abs = join(LOCAL_MOUNT, j.colonPath.replace(/:/g, pathSep))
    enqueueAudioAnalysis({ trackId: j.trackId, path: abs, fingerprint: j.fingerprint }, { batch: true })
    enqueued++
  }
  await persistQueue()
  kickAudioAnalysisWorker()
  return { ok: true, enqueued, totalQueued: audioAnalysisQueue.length }
}, { refuse: REFUSED_SENDER })

ipc.handle('audio-analysis:status', async () => {
  return {
    ok: true,
    queueLength: audioAnalysisQueue.length,
    workerRunning: audioAnalysisRunning,
    isPlaybackActive: playbackActive,
  }
}, { public: true })

ipc.handle('audio-analysis:clear-queue', async () => {
  audioAnalysisQueue.length = 0
  await persistQueue()
  return { ok: true }
}, { refuse: REFUSED_SENDER })

// import-resolve-paths + import-pick-files + import-allow-dropped-paths
// registered in ipc/import-ipc.ts (session allowlist grants).

ipc.handle('import-tracks', async (_e, filePaths: string[], nextId: number, preferredFormat?: string) => {
  if (!Array.isArray(filePaths) || filePaths.some((p) => !isImportPathAllowed(p))) {
    console.warn('[import-tracks] refused non-allowlisted path(s)')
    return { ok: false, error: 'path-not-allowed' }
  }
  // Resolve folders into individual audio files; grant children so a
  // future per-file retry via import-track still passes the allowlist.
  const resolvedPaths = await resolveAudioPaths(filePaths)
  allowImportPaths(resolvedPaths)
  const imported: Array<Record<string, unknown>> = []
  const skippedDupes: Array<{ src: string; matchedTitle: string; matchedArtist: string }> = []
  // 4.4.12: artwork records returned to the renderer so it can dispatch
  // ADD_ARTWORK in one shot at end-of-batch instead of per-file IPC.
  // De-duped by key (one album with 10 tracks shows up once here).
  const artworkKeysSeen = new Set<string>()
  const artwork: Array<{ key: string; hash: string }> = []
  let id = nextId

  const validFormats: AudioFormat[] = ['aac-128', 'aac-256', 'aac-320', 'alac', 'aiff', 'wav']
  // 4.0 Settings: when caller doesn't specify a format, fall back to the
  // user's preferred default from app-settings.json.
  let resolvedFormat = preferredFormat
  if (!validFormats.includes(resolvedFormat as AudioFormat)) {
    const settings = await readAppSettingsAsync()
    const lib = settings?.library as { defaultImportFormat?: string } | undefined
    if (lib && validFormats.includes(lib.defaultImportFormat as AudioFormat)) {
      resolvedFormat = lib.defaultImportFormat
    }
  }
  const chosenFmt: AudioFormat = validFormats.includes(resolvedFormat as AudioFormat)
    ? (resolvedFormat as AudioFormat)
    : 'aac-256'

  const dupeFingerprints = await loadDupeFingerprintsFromLibrary()

  // Initial progress event so the pill lights up immediately
  sendToRenderer('import-progress', {
    current: 0, total: resolvedPaths.length, title: '',
  })

  const batchBaseTime = Date.now()
  let trackIndex = 0

  for (const srcPath of resolvedPaths) {
    const trackTime = new Date(batchBaseTime + trackIndex)
    const r = await importOneFile(srcPath, id, chosenFmt, preferredFormat, dupeFingerprints, trackTime)
    if (r.ok && r.track) {
      imported.push(r.track)
      // 4.4.12: accumulate artwork records from successful imports.
      // de-duped by key (10-track album → one artwork record returned).
      if (r.artwork && !artworkKeysSeen.has(r.artwork.key)) {
        artworkKeysSeen.add(r.artwork.key)
        artwork.push(r.artwork)
      }
      // Track in session set — guards future single-file imports from
      // racing this batch (and matches what import-track does).
      // duration is in ms; fingerprintTrack divides to seconds itself.
      const fp = fingerprintTrack({
        title: r.track.title,
        artist: r.track.artist,
        duration: r.track.duration,
      })
      if (fp) addSessionImportedFingerprint(fp)

      // Enqueue audio analysis (4.0 §2.4a). Mirrors import-track's
      // enqueue. Single-threaded worker means a 100-file batch trickles
      // through one analysis at a time without pinning the user's CPU.
      const t = r.track
      const colon = String(t.path || '')
      const trackId = Number(t.id) || 0
      if (colon && trackId > 0) {
        const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
        const pathSep = IS_WINDOWS ? '\\' : '/'
        const abs = join(LOCAL_MOUNT, colon.replace(/:/g, pathSep))
        const title = String(t.title || '').toLowerCase().trim()
        const artist = String(t.artist || '').toLowerCase().trim()
        const duration = Number(t.duration) || 0
        const analysisFp = `${title}|${artist}|${duration}`
        enqueueAudioAnalysis({ trackId, path: abs, fingerprint: analysisFp })
      }

      id++
      trackIndex++
      sendToRenderer('import-progress', {
        current: imported.length,
        total: resolvedPaths.length,
        title: r.track.title as string,
      })
    } else if (r.ok && r.dupe) {
      skippedDupes.push(r.dupe)
      trackIndex++
      sendToRenderer('import-progress', {
        current: trackIndex, total: resolvedPaths.length,
        title: `Skipped (already in library): ${r.dupe.matchedTitle}`,
      })
    } else {
      sendToRenderer('import-progress', {
        current: imported.length,
        total: resolvedPaths.length,
        title: srcPath.substring(srcPath.lastIndexOf('/') + 1),
        error: r.error,
      })
    }
  }

  // 4.4.18: post-batch sync. One trigger per multi-file import batch
  // (the orchestrator's debounce also handles the case where this fires
  // alongside per-file import-track triggers).
  if (imported.length > 0) {
    triggerSync('import')
  }

  return { ok: true, tracks: imported, skippedDupes, artwork }
}, { refuse: REFUSED_SENDER })

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4p': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.alac': 'audio/mp4',
}

// Artwork engine extracted to artwork-engine.ts (6.0 Phase 1).
// 30 days so labels that get added later eventually surface.
function getArtistImageDir(): string {
  return join(app.getPath('userData'), 'artist-images')
}

const ARTIST_IMAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 days
// 4.5.0-72 — miss tombstones used to share the 30-day TTL with hits.
// Reality: a real "Bandsintown + TheAudioDB both have no photo for
// this artist" is rare; transient misses (network, source rate-limit,
// fetch threw) are common. 30-day misses meant The Beatles + The
// Smiths + literally-any-band could go without a photo for a month
// after one bad lookup. New: misses live 6 hours, refresh on next
// view. Hits keep the 30-day TTL.
const ARTIST_IMAGE_MISS_TTL_MS = 6 * 60 * 60 * 1000  // 6 hours
const ARTIST_IMAGE_IN_FLIGHT = new Map<string, Promise<string | null>>()

function artistSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining marks
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    || 'unknown'
}

/** Resolve a Bandsintown artist photo to a local slug. Returns null
 *  if the artist isn't on Bandsintown or the fetch failed. Idempotent;
 *  single-flight per slug; 30-day disk cache (hit + miss). */
async function getArtistImage(artist: string): Promise<string | null> {
  const slug = artistSlug(artist)
  if (!slug || slug === 'unknown') return null

  // Single-flight: collapse concurrent calls for the same artist into
  // one network request.
  const existing = ARTIST_IMAGE_IN_FLIGHT.get(slug)
  if (existing) return existing

  const task = (async () => {
    const dir = getArtistImageDir()
    const jpg = join(dir, `${slug}.jpg`)
    const miss = join(dir, `${slug}.miss`)
    await mkdir(dir, { recursive: true }).catch(() => {})

    // Disk-cache HIT path. If the .jpg exists and is fresh, return slug.
    try {
      const st = await stat(jpg)
      if (Date.now() - st.mtimeMs < ARTIST_IMAGE_MAX_AGE_MS) return slug
    } catch { /* doesn't exist — fall through */ }
    // Disk-cache MISS tombstone. Don't hammer Bandsintown for artists
    // they don't have until the tombstone expires.
    try {
      const st = await stat(miss)
      if (Date.now() - st.mtimeMs < ARTIST_IMAGE_MISS_TTL_MS) return null
    } catch { /* doesn't exist — fall through */ }

    // 4.5.0-66 — photo fallback chain. Old behavior: Bandsintown only;
    // miss → letter avatar. New: Bandsintown → TheAudioDB (MBID-resolved
    // when possible) → letter avatar. Both sources are name-based, so
    // we use resolveCanonicalArtist's MB-canonical name + MBID to
    // disambiguate ("Drake" the rapper vs other Drakes).
    const tryDownload = async (imgUrl: string): Promise<Buffer | null> => {
      try {
        const r = await fetch(imgUrl, {
          headers: { 'User-Agent': `JakeTunes/${app.getVersion()}` },
          signal: AbortSignal.timeout(10_000),
        })
        if (!r.ok) return null
        const b = Buffer.from(await r.arrayBuffer())
        return b.length >= 200 ? b : null
      } catch { return null }
    }
    let buf: Buffer | null = null
    // Resolve MBID once — used by both backends. Library-genre context
    // makes the resolver pick the right entity for common names.
    const libraryGenres = await getLibraryGenresForArtist(artist)
    const canon = await resolveCanonicalArtist(artist, { libraryGenres })
    const lookupName = canon?.name || artist
    // Source 1: Bandsintown
    try {
      const url = `https://rest.bandsintown.com/artists/${encodeURIComponent(lookupName)}?app_id=jaketunes-desktop`
      const res = await fetch(url, {
        headers: { 'User-Agent': `JakeTunes/${app.getVersion()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(7000),
      })
      if (res.ok) {
        const body = await res.json() as { image_url?: string; thumb_url?: string }
        const imgUrl = body.image_url || body.thumb_url
        if (imgUrl && !imgUrl.includes('bandsintown-no-image') && !imgUrl.includes('placeholder')) {
          buf = await tryDownload(imgUrl)
        }
      }
    } catch { /* fall through to next source */ }
    // Source 2: TheAudioDB. Free, no auth. Prefer MBID lookup when we
    // have one (artist-mb.php) — eliminates the name-disambiguation
    // problem the Bandsintown source still has. Falls back to name
    // search if no MBID.
    if (!buf) {
      try {
        const tadbUrl = canon?.mbid
          ? `https://www.theaudiodb.com/api/v1/json/2/artist-mb.php?i=${canon.mbid}`
          : `https://www.theaudiodb.com/api/v1/json/2/search.php?s=${encodeURIComponent(lookupName)}`
        const res = await fetch(tadbUrl, {
          headers: { 'User-Agent': `JakeTunes/${app.getVersion()}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(7000),
        })
        if (res.ok) {
          const body = await res.json() as { artists?: Array<{ strArtistThumb?: string; strArtistFanart?: string; strArtistLogo?: string }> }
          const a = body.artists?.[0]
          const candidate = a?.strArtistThumb || a?.strArtistFanart || a?.strArtistLogo
          if (candidate) buf = await tryDownload(candidate)
        }
      } catch { /* both sources missed */ }
    }
    if (!buf) {
      await writeFile(miss, '').catch(() => {})
      return null
    }
    await writeFile(jpg, buf)
    await unlink(miss).catch(() => {})
    return slug
  })()

  ARTIST_IMAGE_IN_FLIGHT.set(slug, task)
  try {
    return await task
  } finally {
    ARTIST_IMAGE_IN_FLIGHT.delete(slug)
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'ipod-audio', privileges: { stream: true, bypassCSP: true, supportFetchAPI: true } },
  { scheme: 'album-art', privileges: { bypassCSP: true, supportFetchAPI: true } },
  // 4.4.40 — Bandsintown artist photos for the Artists view.
  { scheme: 'artist-image', privileges: { bypassCSP: true, supportFetchAPI: true } },
  // 2026-08-09 — custom playlist covers (see main/playlist-covers.ts).
  { scheme: 'playlist-cover', privileges: { bypassCSP: true, supportFetchAPI: true } }
])

// Music Man DJ commentary
// 4.5: hover-prefetch of artist facts. Wired to the mic button hover so
// that by the time the user clicks, the Wikipedia + MusicBrainz round
// trips are already cached and the streaming Claude call starts ~500-
// 1500 ms sooner. Fire-and-forget — the handler returns immediately
// (resolving once the lookup either hits cache or completes), and the
// renderer never depends on the return value.
ipc.handle('musicman-prefetch-facts', async (_event, track: { artist: string; album: string }) => {
  try {
    await searchWebCached(`${track.artist} musician`, track.album)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}, { refuse: REFUSED_SENDER })

// 4.5: streaming variant of musicman-dj for the mic button. Same prompt
// + persona logic as the non-streaming handler above, but emits each
// Claude text chunk as a 'musicman-dj-chunk' event so the renderer can
// type the response into the pill in real time instead of waiting for
// the full message. Returns the final accumulated text + transition
// (Stephen-only) so the renderer can fire TTS and audio playback on the
// completed string. Non-streaming handler stays for DJ Mode transitions
// where the auto-DJ doesn't need the typing UX.
ipc.handle('musicman-dj-streaming', async (event, track: { title: string; artist: string; album: string; genre: string; year: string | number }, persona?: 'mm' | 'stephen') => {
  const isStephen = persona === 'stephen'
  const djInstructions = isStephen
    ? `A track is on. Give a Stephen Hands DJ comment. Pure Stephen voice — short, hyped, party-first. Usually one beat is the whole comment; two beats if the second one earns it. NEVER pad to hit a meter; never explain a banger.`
    : `The listener is currently playing a song. This will be SPOKEN ALOUD, so it should sound like you're TALKING — not reading. Length serves the take: sometimes one line is the whole comment, sometimes you take three. Vary the rhythm. NEVER hit a sentence count just because it was written down.

Be unpredictable — sometimes a verified fun fact, sometimes an arrogant opinion, sometimes a memory of seeing them live, sometimes a roast of the listener's taste, sometimes a defense of an underrated cut. Use fragments. Cut yourself off when a better thought arrives. Don't restate the situation back ("So we've got a track on by X…") — go straight to the take.

If background info from MusicBrainz or Wikipedia is provided below, USE IT for facts. If no background info and you're not confident, pivot to the sound/genre/era — never invent a story.`

  const systemPrompt = isStephen ? (withLibraryDigest(DJ_HANDS_CORE) + '\n\n' + djInstructions) : buildMusicManPrompt(djInstructions)

  // Hover prefetch usually fills the cache before we get here; on a
  // cold click this is the lookup itself (no slower than the non-
  // streaming path).
  const artistFacts = await searchWebCached(`${track.artist} musician`, track.album)
  let userMessage = `Now playing: "${track.title}" by ${track.artist} from the album "${track.album}" (${track.genre}, ${track.year})`
  if (artistFacts) userMessage += `\n\nBackground on ${track.artist}: ${artistFacts}`

  await loadClaudeStats()
  rolloverIfNewDay()
  if (claudeStats.callsToday >= claudeStats.dailyCeiling) {
    return { ok: false, error: `Claude daily ceiling reached (${claudeStats.dailyCeiling}).` }
  }
  sessionCallCount++
  claudeStats.callsToday++
  console.log(`[claude] musicman-dj-streaming — session=${sessionCallCount} today=${claudeStats.callsToday}/${claudeStats.dailyCeiling}`)

  try {
    let accumulated = ''
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      // 4.5.0-50: 500 → 300. The hard "1-3 sentence default" rule in
      // MUSIC_MAN_CORE means most takes are now 60-120 tokens; 300
      // leaves headroom for the rare longer take without enabling the
      // ramble pattern Jake flagged. 500 was the wordy regime.
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })
    stream.on('text', (textChunk: string) => {
      accumulated += textChunk
      try {
        event.sender.send('musicman-dj-chunk', { chunk: textChunk, accumulated })
      } catch { /* renderer gone — stream completes silently */ }
    })
    const final = await stream.finalMessage()
    const text = final.content[0]?.type === 'text' ? final.content[0].text : accumulated
    if (text) {
      noteMusicManUtterance('dj', text)
      // 4.5: hive-mind log — every mic press captured for future
      // personalization. Persona is 'stephen' if requested, else the
      // active host (mm/megan) at call time.
      logHiveMindInteraction({
        at: Date.now(),
        mode: 'mic',
        persona: isStephen ? 'stephen' : readActiveHostSync(),
        track: { title: track.title, artist: track.artist, album: track.album, genre: track.genre, year: track.year },
        response: text,
        facts: artistFacts || undefined,
      })
    }
    void saveClaudeStats()
    return { ok: true, text }
  } catch (err: unknown) {
    void saveClaudeStats()
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, error: msg }
  }
}, { refuse: REFUSED_SENDER })

ipc.handle('musicman-dj', async (_event, track: { title: string; artist: string; album: string; genre: string; year: string | number }, nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number }, persona?: 'mm' | 'stephen') => {
  // 4.4.0: persona override. The mic button (one-shot commentary on the
  // current track) keeps Music Man as the host. DJ Mode (continuous
  // AI-DJ between-track commentary) routes through Stephen Hands —
  // brief, party-first, beats-forward.
  const isStephen = persona === 'stephen'
  // 4.4.49: when Stephen is running a DJ-Mode transition (isStephen +
  // nextTrack), he also CALLS the transition style — talk / scratch /
  // cut — so "scratches only when appropriate" is HIS judgment, not a
  // random roll. The handler parses the TRANSITION: line off the end.
  const stephenTransition = isStephen && !!nextTrack
  const djInstructions = isStephen
    ? `${nextTrack ? "You're transitioning between songs on a continuous DJ set you're running." : 'A track is on.'} Give a Stephen Hands DJ comment. Pure Stephen voice — short, hyped, party-first. Usually one beat is the whole comment; two beats if the second one earns it. Length serves the moment; never pad to hit a meter.${stephenTransition ? `

After your comment, on a NEW LINE, declare the transition you're running into the next track — exactly one of:
TRANSITION: talk    — your comment plays in the gap, then the next track drops. This is the DEFAULT. Use it for MOST transitions.
TRANSITION: scratch — a turntable scratch punches the change, then your comment, then the drop. Use ONLY when it genuinely fits: a hard genre or energy flip, a hype peak, dropping into something with a serious beat. A scratch on a mellow, introspective, or singer-songwriter transition is WRONG. Scratch is a spice — rare, earned, never a default.
TRANSITION: cut     — slam straight into the next track. No scratch, minimal-to-no talk. Use for back-to-back bangers that just need the energy to keep rolling.
Pick the ONE that actually serves THIS specific transition. If you're unsure, it's 'talk'.` : ''}`
    : `${nextTrack ? "You're DJing between songs on the listener's playlist." : 'The listener is currently playing a song.'} This will be SPOKEN ALOUD, so it should sound like you're TALKING — not reading. Length serves the take; vary the rhythm. Sometimes one beat is the whole thing, sometimes three. Never hit a sentence count just because it was written down.

Be unpredictable — sometimes a verified fun fact, sometimes an arrogant opinion, sometimes a memory of seeing them live, sometimes a roast of the listener's taste, sometimes a defense of an underrated cut. Use fragments. Cut yourself off when a better thought arrives.

If background info from MusicBrainz or Wikipedia is provided below, USE IT for any facts. If no background info and you're not confident, go with a take on the sound/genre rather than making up a story.`

  const djPrompt = isStephen
    ? (() => {
        const act = getActivityPromptBlockSync()
        return withLibraryDigest(DJ_HANDS_CORE) + '\n\n' + djInstructions
          + (act ? `\n\n${act}\nMatch energy and density to this activity when you talk — a hard ski set is not a casual stroll.` : '')
      })()
    : buildMusicManPrompt(djInstructions)

  // Look up artist facts for accuracy (Wikipedia + MusicBrainz + Bandcamp)
  // 4.5: routed through searchWebCached so a hover-prefetch from the
  // streaming sibling handler shortcuts the lookup here too.
  const [artistFacts, nextArtistFacts] = await Promise.all([
    searchWebCached(`${track.artist} musician`, track.album),
    nextTrack && nextTrack.artist !== track.artist ? searchWebCached(`${nextTrack.artist} musician`, nextTrack.album) : Promise.resolve('')
  ])

  let userMessage = nextTrack
    ? `Song that just finished: "${track.title}" by ${track.artist} from "${track.album}" (${track.genre}, ${track.year}). Coming up next: "${nextTrack.title}" by ${nextTrack.artist} from "${nextTrack.album}" (${nextTrack.genre}, ${nextTrack.year}). Give a DJ-style transition — comment on what just played, hype what's coming, or draw a connection between the two.`
    : `Now playing: "${track.title}" by ${track.artist} from the album "${track.album}" (${track.genre}, ${track.year})`
  if (artistFacts) userMessage += `\n\nBackground on ${track.artist}: ${artistFacts}`
  if (nextArtistFacts && nextTrack) userMessage += `\nBackground on ${nextTrack.artist}: ${nextArtistFacts}`

  try {
    const response = await claudeCall('musicman-dj', {
      model: 'claude-sonnet-4-6',
      // 4.5.0-50: 500 → 300, matching the streaming sibling above.
      max_tokens: 300,
      system: djPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
    let text = response.content[0].type === 'text' ? response.content[0].text : ''
    // 4.4.49: parse Stephen's transition call off the end (DJ Mode only)
    // and strip it from the spoken text so it never gets read aloud.
    let transition: 'talk' | 'scratch' | 'cut' = 'talk'
    if (stephenTransition) {
      const m = text.match(/TRANSITION:\s*(talk|scratch|cut)/i)
      if (m) transition = m[1].toLowerCase() as 'talk' | 'scratch' | 'cut'
      text = text.replace(/\n*\s*TRANSITION:\s*(talk|scratch|cut)\s*/i, '').trim()
    }
    if (text) {
      noteMusicManUtterance('dj', text)
      // 4.5: hive-mind log — DJ Mode + non-streaming DJ commentary
      // (Stephen transitions, mic fallback). Includes nextTrack when
      // we're transitioning so the corpus has full context.
      logHiveMindInteraction({
        at: Date.now(),
        mode: nextTrack ? 'dj-transition' : 'dj-comment',
        persona: isStephen ? 'stephen' : readActiveHostSync(),
        track: { title: track.title, artist: track.artist, album: track.album, genre: track.genre, year: track.year },
        nextTrack: nextTrack ? { title: nextTrack.title, artist: nextTrack.artist, album: nextTrack.album } : undefined,
        response: text,
        facts: artistFacts || undefined,
      })
    }
    return { ok: true, text, transition }
  } catch (err: unknown) {
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, text: msg, error: msg }
  }
}, { refuse: { ok: false, text: '', error: 'refused-sender' } as const })

// Music Man Radio Mode — between-song commentary in classic FM-radio
// style (call sign, station ID, back-announce, hype-up). Distinct from
// `musicman-dj` (which is the casual one-shot mic-click commentary)
// because Radio Mode runs continuously between every track and needs a
// stylistically consistent voice.
//
// `opener=true` flips the prompt into "welcome to the show" mode for
// the very first segment when the user clicks Radio on. Without this
// the show feels like it starts mid-sentence.
ipc.handle('musicman-radio', async (_event,
  track: { title: string; artist: string; album: string; genre: string; year: string | number },
  nextTrack?: { title: string; artist: string; album: string; genre: string; year: string | number },
  opener?: boolean,
  forceAnnouncer?: boolean,
  callerSegment?: boolean,
  djHandsSegment?: boolean,
  callerId?: string,  // 4.4.0: which caller from the 9-person rolodex
  archetypeId?: string,  // 4.4.1: which structural archetype to use
  slot?: number,  // 4.4.1: slot 0..11 — informs hour clock + memory
  hourCounter?: number,  // 4.4.1: which hour we're in (for slot-1/slot-11 scoping)
  miniId?: boolean,  // 4.4.1: slot-7 mini station ID (different from full slot-0 ID)
) => {
  // Segment modes:
  //   - opener            → ALWAYS [ANNOUNCER] first (show going live)
  //   - forceAnnouncer    → ALWAYS [ANNOUNCER] first (every 4th transition)
  //   - callerSegment     → caller from the rolodex phones in (callerId picks
  //                          which one — Giovanni, Rajiv, Bernard, LaShonte,
  //                          Kristina, Devin, Maya, Mike, or Zoe). Each
  //                          caller has a distinct conversational function;
  //                          see src/main/cast.ts for the full bible.
  //   - djHandsSegment    → DJ Stephen Hands stops by (rare guest, beats focus)
  //   - default           → NO [ANNOUNCER], NO guest. Pure MM + Megan banter.
  const wantsAnnouncer = opener || forceAnnouncer
  const segmentMode = opener
    ? `This is the SHOW OPEN. The radio just went live; listeners just clicked in.

ALWAYS lead with TWO [ANNOUNCER] lines, in this exact order:
  1. The MANDATORY signature open — write it EXACTLY, verbatim, EVERY show (this is WJLR's cold open; it must be identical every single time, the way a real station opens the same way daily):
     [ANNOUNCER] We are LIVE... live here in Greenpoint!
     (Those exact words — "We are LIVE... live here in Greenpoint!" — OPEN every show, word for word. ALL CAPS the first "LIVE" so the TTS punches it. You may drop the "WJLR 330.9" call sign right after, but the Greenpoint line comes FIRST and unchanged.)
  2. The MANDATORY hosts intro line — write it EXACTLY like this, with this phrasing and emphasis:
     [ANNOUNCER] Here's Megan, and the one, the only, the MUSIC MAN!
     (You may replace "Here's" with synonyms like "It's" or "Welcome back to" but the rest of the line — "Megan, and the one, the only, the MUSIC MAN!" — stays verbatim. ALL CAPS on "MUSIC MAN" so the TTS punches it.)

After those two announcer lines, MM and Megan welcome the listener, set the energy, and tee up the first track.`
    : miniId
      ? `MID-HOUR MINI STATION ID. Brief — about 8 seconds. ONE [ANNOUNCER] line that re-anchors any listener who tuned in late, then immediate hand-off to MM and Megan with a single quick exchange about what's been playing. The mini-ID is DRY — no production sting under it (production handles that).

Format:
  [ANNOUNCER] One short ID line — "Triple-W Jay El Arr. Three thirty point nine. You're listening." (or close variant — keep it under 10 words).
  [MM] One quick line bridging.
  [MEGAN] Quick reply, hand off to the next track.`
      : callerSegment
        ? buildCallerSegmentMode(callerId || 'giovanni')
      : djHandsSegment
        ? `You're transitioning between songs and DJ STEPHEN HANDS is in the booth — a rare guest spot. He doesn't sit in for the whole show, just drops by to weigh in. He'll cut MM off if MM is wrong about a beat or a sample. Megan respects him more than MM (she likes that he doesn't perform expertise).

Format for this segment:
  [MM] One line bringing him in ("got Stephen Hands in the booth — Stephen, what we got?")
  [STEPHEN] 1-2 sentences of his take on the just-played or upcoming track. ALWAYS pivots to whether it MOVES a room — danceable, beat / sample / production / BPM angle. He'll either spot a sample, name-drop a producer, call out a disco / boogie / house lineage other people miss, or bluntly say it doesn't bang. Brief and confident, no overexplaining.
  [MEGAN] Reacts — agrees with him over MM, or pushes him on something specific.
  [MM] Tries to reassert. Stephen undercuts him OR Megan does.
  Optional one more [STEPHEN] line as he peaces out.`
        : forceAnnouncer
          ? `You're transitioning between songs in a continuous broadcast. ALWAYS lead with a campy [ANNOUNCER] station ID drop, THEN MM and Megan back-announce / tee up next.`
          : `${nextTrack ? "You're transitioning between songs in a continuous broadcast. NO station ID this segment — pure MM + Megan banter." : 'A song is currently on the air.'}`

  // 4.2.17: TOPIC ROTATION. Each segment picks ONE angle from this list
  // so the show doesn't fall into "they always argue about whether the
  // last song was overrated." Real radio shows roam — back-announce,
  // tee-up, hot take, industry gossip, scene lore, personal anecdote,
  // local color. The fixed personas (MUSIC_MAN_CORE / MEGAN_CORE) keep
  // their opinions consistent across topics, but the *terrain* of each
  // segment is different. Opener and forceAnnouncer segments get the
  // tee-up / station-ID flavor and skip the rotation.
  const TOPIC_ANGLES = [
    `BACK-ANNOUNCE — focus the segment on the song that JUST played. One of them picks apart a specific element (the bass tone, the snare hit, a single line of lyrics, the production choice on the bridge). The other disagrees about whether that element works. Reference the actual song by name.`,
    `TEE-UP HYPE — focus on the song that's coming up next. Build anticipation OR trash-talk it before it plays. One of them is excited, the other thinks it's a misfire. Reference the upcoming track and artist by name.`,
    `GENRE BEEF — argue about the genre, scene, or era the just-played song belongs to. Is it actually that genre? Is the genre played out, underrated, dead, due for a revival? Both come at it from their FIXED opinions but disagree on the angle.`,
    `HOT TAKE — one of them drops a wildly contrarian opinion about music in general (not necessarily this song). The other absolutely loses it. Examples: "albums are over, EPs are the only honest format" / "vinyl was always a scam" / "the drum machine ruined music" / "no rock band after 1979 has mattered."`,
    `INDUSTRY GOSSIP — riff like there's recent music-industry news (don't fabricate specific people, but be plausibly current — label drama, a feud, a contract leak, someone canceling a tour). They have OPPOSITE reactions to whatever it is.`,
    `PERSONAL ANECDOTE — one of them tells a 10-second story (in character) about hearing this song for the first time, a show they went to, a record store, a band they used to know. The other one cuts in skeptical that it happened that way.`,
    `BROOKLYN LOCAL COLOR — ground the segment in WJLR being LIVE FROM BROOKLYN. Reference a neighborhood, a venue, a specific spot, the weather outside, the studio. Megan and MM disagree about something local (best slice, best venue, most overrated park).`,
    `SOUND CRITIQUE — pick apart the SONIC details. Drum sound, mix, the way the vocals sit, whether it's compressed to death, the room sound. One of them defends the choices, the other says they hate it.`,
    `CONNECTION BRIDGE — explicitly tie the just-played song to the upcoming song. Lineage, sonic similarity, sharp contrast, a producer or guest in common, opposite emotional registers. They agree on the connection but argue about which song does it better.`,
    `NOSTALGIA / ERA — the year/era the just-played song came from. What ELSE was happening then. They disagree about whether the era was actually any good or just remembered fondly.`,
    `MEGAN OFF-TOPIC — Megan kicks off with something seemingly unrelated (a movie she watched, a tweet she saw, a thing she ate) and loops it back to the song. MM is annoyed she's wasting airtime, then grudgingly admits the connection works.`,
    `MM HISTORIAN — MM drops an obscure factual claim about the just-played artist (recording session lore, a session musician who really played the part, a famously bad gig). Megan questions whether that's true. MM doubles down.`,
    `LIVE-IN-STUDIO — react to something happening "in the room": food someone brought, the producer doing something dumb, the mic levels, a phone ringing, a guest who hasn't shown up. Anchor the segment in studio physicality, then loop back to the music.`,
    `PRETEND CALLER — riff like they're responding to a caller (don't voice the caller; just react). "Mark from Bay Ridge with a take we did NOT need." MM and Megan disagree about whether the imaginary caller was right.`,
    `ROAST SPECIFIC LYRIC — one of them quotes a specific line from the just-played song and roasts it. The other defends it as unironically great. Quote the lyric in their lines.`,
    `CHARTS / RECEPTION — argue about how the song was received critically vs. commercially. One of them says "people slept on this", the other says it got exactly the reception it deserved.`,
    `BAND DYNAMICS — argue about the human relationships inside the band that made the song. Who actually wrote it, who pushed for it, who hated it, who quit over it. Made-up but plausible based on the actual band's known history.`,
    `LIVE VS STUDIO — one of them claims this song is way better live (or the studio version's the only version that works). The other has the opposite take.`,
  ]
  // Don't apply the rotation to opener — opener has its own dedicated job
  // (welcome the listener, set the energy, tee up the first track). The
  // forceAnnouncer middle-of-show ID drops still get a topic since they're
  // long enough to fit one.
  const topicAngle = opener
    ? null
    : TOPIC_ANGLES[Math.floor(Math.random() * TOPIC_ANGLES.length)]
  // Time-of-day context — real radio shows have different vibes morning
  // vs late-night. Cheap to add, gives Claude a natural color knob.
  const now = new Date()
  const hour = now.getHours()
  const timeOfDay =
    hour < 6  ? 'late night / overnight (after-hours, low-lit, conspiratorial)' :
    hour < 11 ? 'morning (coffee, sharper, talky)' :
    hour < 14 ? 'midday (steady, lunch-hour energy)' :
    hour < 18 ? 'afternoon drive (commute, hyped, wider audience)' :
    hour < 22 ? 'evening (relaxed, dialed-in)' :
                'late evening (winding down, looser, weirder)'

  const radioInstructions = `You are scripting a 20-second on-air segment for WJLR 330.9 (call sign WJLR, frequency 330.9, broadcasting LIVE FROM BROOKLYN) between two co-hosts who actively bicker:

  • The Music Man (tag: [MM]) — confident, opinionated, slightly arrogant, a bit of a music snob. His knowledge comes out as strong OPINIONS and hot takes, NEVER as facts or history lessons. He'd rather be provocatively wrong than correctly boring.
  • Megan (tag: [MEGAN])  — sharp, witty, lower-key. Often the counterweight to MM, but NOT reflexively: she agrees and builds on him when he's actually right, then pounces when he overreaches. Her pushback lands BECAUSE it isn't automatic. Pricks his bubble, doesn't pull punches, isn't mean.
  • CALLERS (tags: [GIOVANNI] / [RAJIV] / [BERNARD] / [LASHONTE] / [KRISTINA] / [DEVIN] / [MAYA] / [MIKE] / [ZOE]) — WJLR has a 9-person caller rolodex. The most frequent is Giovanni (Bay Ridge, earnest, rambling). The others occupy distinct conversational functions: Rajiv challenges the show's framing, Bernard is the elder who was actually there, LaShonte forces them out of the 1970s, Kristina demands they cover metal, Devin called the wrong show, Maya asks the questions that make them think, Mike has industry intel he won't quite source, Zoe announces wildly committed takes. EACH caller appears only when this segment's mode says THEY'RE calling in — the prompt will tell you which one and how MM and Megan should react.
  • DJ Stephen Hands (tag: [STEPHEN]) — RARE GUEST. JakeTunes' in-house DJ. Goes by Stephen, Hands, or Stephen Hands. PARTY-FIRST: house, rap, electronic, techno, disco, boogie — anything to make a room move. Loves the disco / boogie source-code lineage (Patrick Adams, Larry Levan, Paradise Garage, Salsoul) and modern dance (Daft Punk, Justice, Disclosure, Fred again..). Doesn't engage with rock or pop discourse on its own terms — pivots back to whether anyone could DANCE to it. Brief, hyped, "this fucking goes" energy. Not a man of many words. Only appears when this segment's mode says he's on the show.

${segmentMode}

TIME OF DAY (set the show's energy accordingly): ${timeOfDay}.
${topicAngle ? `\nTOPIC FOCUS THIS SEGMENT (USE THIS SPECIFIC ANGLE — do NOT default to the same generic "was that song overrated" beat every time):\n${topicAngle}\n\nMM and Megan keep their FIXED opinions across all topics (those don't change), but the TERRAIN of this segment is the angle above. Stay on it. A real radio show roams between angles like this — back-announce, hot take, gossip, anecdote, local color — and never sounds like the same conversation twice.\n` : ''}
This is a REAL conversation, not a script being read. Make it sound like two people actually talking to each other:

  • REACT to specific words the other one just said. Quote them, mock them, agree-then-twist them. "Underrated? You think THIS is underrated?" "A masterpiece — sure, if you've never heard a Steely Dan record."
  • CUT EACH OTHER OFF mid-thought. End MM's line with an em-dash and have Megan barge in. End Megan's line with "—" and have MM stomp on it.
  • Use FILLER and reactions: "I mean—", "Oh come ON", "ha—", "wait wait wait", "no, no", "right? RIGHT?", "ugh", "okay but". Real radio is full of these.
  • DISAGREE on something specific every time. Taste, the artist's reputation, who the song's really for, whether the upcoming track is going to be good. Megan PUSHES BACK on MM's takes — she's not playing along.
  • Reference the same thing from different angles. If MM says "this album invented the genre," Megan replies about the SAME album from a different angle, not a totally new tangent.

KILL VANILLA, KILL EXPOSITION (the most important rule on this page):
  • You have NO notes, no Wikipedia, no liner notes in front of you — you're going off memory, instinct, and opinion. If you catch yourself about to STATE a fact, stop and REACT instead. The #1 failure is sounding like you're reading an encyclopedia: if a line could appear on a Wikipedia page, it is WRONG.
  • DO NOT recite biographical facts. NO "X was formed in Y in Z." NO "released in 1972 by RCA on the album…" NO "their fourth studio album, which featured…" That's Wikipedia talk, not radio talk.
  • DO NOT explain the song to the listener. The listener just heard it / is about to hear it. They don't need a synopsis.
  • DO NOT do the "fun fact" thing ("did you know X recorded this in Y?"). It reads as a teleprompter.
  • RULE OF THUMB: if a sentence starts with the artist's name or song title and a "to be" verb (X is / was / are…), DELETE IT and write a human reaction instead. "Steely Dan is a band that emerged from the LA studio scene" → "Hands, you ever try to dance to Steely Dan? You can't. That's the whole problem."
  • Reactions > facts. Tiny moments > sweeping summaries. Half-remembered details > confident timelines.

HUMAN MOVES — the show should sound like two friends with a microphone, not a station-imaging package:
  • Imperfect memory: "I think this is '74? Could be '73, who cares." "Wasn't this the one where they fired the bass player mid-tour? Or am I thinking of someone else." Half-knowing is more human than confident-knowing.
  • Tiny lived-in details (made up, in character): "I saw them in a basement in '07, the kick drum literally fell over." "My buddy used to bartend at the place they recorded most of side two." "Last time I heard this I was changing a tire on the BQE, which probably says something."
  • Talking AROUND the song, not always ABOUT it: a segment can be 80% about something else (the weather outside, what someone ate, MM's shitty week, Megan's neighbor's terrible taste) and just glance at the music in passing. That's how real radio breathes.
  • Distractions that DON'T fully resolve: start a thought, get sidetracked, the next song interrupts. Don't always wrap it up neatly.
  • Each other's "lives" (in character, fictional but consistent): MM mentions his record store, his ex who hated this band, his nephew. Megan mentions her column, her dog, her studio neighbor. Brief reference, no exposition.
  • Sentence FRAGMENTS. Real talk is full of them. "Yeah." "No." "Sure, sure." "Pass." "What is even—" "Anyway."
  • Running-bit potential: if Megan rolls her eyes at something MM said in this segment, she might come back to it three segments later. (You can't see history, but lean into the feel that there is one.)

LANGUAGE — they're broadcast personalities, not a corporate playlist host. Drop natural profanity when it earns its place: "this song fucking slaps", "goddamn masterpiece", "shit-hot pick", "hell of a record". Megan especially uses sharper language when calling MM out. Don't be gratuitous, DON'T sand them flat either.

DELIVERY CUES (TTS reads punctuation directly):
  • CAPITALIZE the word that gets punched ("absolutely INSANE drum break").
  • Exclamation marks for genuine excitement ("hell yes!").
  • Ellipses... for stretched, thinking pauses.
  • Em-dashes — for cut-offs and overlapping reactions.
  • Multiple commas for stuttering ("it's, it's just, it's not even close").

INLINE PERFORMANCE MARKERS — the TTS model performs these as actual sound. Sprinkle them in WHERE THEY EARN IT (not on every line, not lazily). They're how a written line becomes a spoken moment:
  [laughs] — short laugh, used after MM says something Megan finds dumb.
  [chuckles] — quieter, more under-the-breath.
  [sighs] — exasperation, fatigue, "I cannot believe I'm doing this again."
  [scoffs] — short dismissive exhale, one of Megan's signatures.
  [whispers] — quiet aside, conspiratorial.
  [excited] — bumps energy on the next phrase.
  [sarcastic] — flips the tone of the next phrase.
  [interrupts] — used at the START of a line that's stomping on the previous speaker.
  [pauses] — beat of silence, "thinking" feel.
Examples in context:
  [MM] [scoffs] Underrated? You think THIS is underrated?
  [MEGAN] [laughs] I mean — yeah, actually. The [excited] *whole* second side does it for me.
  [MM] [sighs] Here we go.
  [MEGAN] [interrupts] Don't "here we go" me, you said the same thing about Steely Dan.
Use markers SPARINGLY — one per line at most, only when it does work. Overuse reads as a special-effects show, not a real conversation.

Write the way you want them to SOUND.

CAMPY STATION ID — only when the segmentMode above explicitly tells you to (opener / forceAnnouncer). When required, OPEN with a campy station ID line tagged [ANNOUNCER] — this voice is a CONFIDENT, BIG, deep FM-radio drop voice, distinct from MM and Megan. He never sounds unsure or tentative.

CRITICAL — write call-sign letters PHONETICALLY so the TTS pronounces each letter individually, but with CONFIDENCE not hesitation:
  • "WJLR" → write it as "DOUBLE YOU JAY EL ARR" (each letter as a separate uppercase word, single space, NO ellipses, NO hyphens between letters)
  • "330.9" → write it as "three thirty point nine" (words, never digits)
  • DO NOT use ellipses (...) between letters or words — ellipses make the TTS pause uncertainly and the announcer sounds tentative. Use ONLY commas, periods, and exclamation marks for cadence.
  • For repeated W energy use "TRIPLE-W" (one word) — never "double-yoo... double-yoo..." which reads as stutter / hesitation.

Example drops (use these as templates — vary the form each time):
  [ANNOUNCER] TRIPLE-W JAY EL ARR! Three thirty point nine FM! LIVE from BROOKLYN!
  [ANNOUNCER] You are LOCKED IN to DOUBLE YOU JAY EL ARR, three thirty point nine, broadcasting LIVE from the boroughs!
  [ANNOUNCER] DOUBLE YOU JAY EL ARR, three thirty point nine. The sound of Brooklyn, ALL NIGHT LONG!
  [ANNOUNCER] This is DOUBLE YOU JAY EL ARR, three thirty point nine FM — Brooklyn's loudest, and we are HOT!

Capitals signal punched emphasis. Exclamation marks drive energy. Make it campy and over-the-top — the energy of a real radio station ID jingle, delivered with TOTAL CONFIDENCE. The [ANNOUNCER] line is a SINGLE drop; MM and Megan banter follows it.

When NOT explicitly told to include [ANNOUNCER], DO NOT include it. The frequency is controlled at the system level, not at your discretion.

Format the segment STRICTLY as speaker-tagged lines${callerSegment ? ' — caller mode is dictated above, follow that structure verbatim.' : djHandsSegment ? ' — DJ Stephen Hands guest mode is dictated above, follow that structure verbatim.' : ':'}
MANDATORY FORMAT: EVERY line begins with exactly ONE bracketed speaker tag from the cast above (e.g. [MM], [MEGAN], the specific [CALLER] this segment allows, or [STEPHEN] only when he's on). NEVER output an untagged line, a "Name:" prefix, or a bare dash, and NEVER split one speaker's thought onto an untagged continuation line — one tag, then their words. An untagged line is dropped, so a missing tag = lost dialogue.
${opener
  ? `[ANNOUNCER] Campy WJLR station ID drop.
[ANNOUNCER] Here's Megan, and the one, the only, the MUSIC MAN!  (mandatory verbatim — "Here's" / "It's" / "Welcome back to" interchangeable, rest of the line is fixed)`
  : forceAnnouncer
    ? '[ANNOUNCER] Campy station ID drop FIRST (mandatory this segment).'
    : (callerSegment || djHandsSegment ? '' : '(NO [ANNOUNCER] line this segment.)')}
${callerSegment || djHandsSegment ? '' : `Sound like two people who've co-hosted for years — NOT a fixed call-and-response. VARY the dynamic so no two segments feel alike:
  • Sometimes they AGREE and pile on together, hyping the same thing.
  • Sometimes Megan undercuts MM — but NOT every time; predictable disagreement is exactly what makes it stiff.
  • Sometimes one gets ROLLING on a tangent and the other just punctuates it ("...mhm", "there it is", a laugh).
  • Sometimes it's fast and overlapping — short cut-ins, [interrupts], one stepping on the tail of the other's line.
  • Vary who STARTS — don't always open on [MM].
It's a CONTINUING show, not a cold reset: they can call back to something from earlier in the broadcast and let a thread carry.`}

Vary the LENGTH and rhythm by segment${wantsAnnouncer ? ' (NOT counting the [ANNOUNCER] drop)' : ''}: sometimes a quick 2-line hit, sometimes a 5-6 line riff where one of them really gets going — never the same shape twice in a row. Lines usually run 1-2 sentences, but a clipped 3-word reaction or one longer mid-riff line is good — that variation IS flow. Sound natural read aloud — no asterisks, no stage directions, no emojis, no scene-setting. Cover what a real DJ pair would: react to what just played, tease what's next, a hot take / roast / tangent / bit — opinions ABOUT the music, never facts about it.

EXTERNAL CONTEXT — below the user message you may see Brooklyn weather, US Last.fm scrobble charts this week, recent music-press headlines (Pitchfork / Stereogum / The Quietus), Wikidata structured artist info, Discogs pressing detail, Last.fm "similar to" data, and MusicBrainz / Wikipedia background. Use these as TEXTURE AND REACTION HOOKS, not as a fact dump.

  • Weather → drop ONE line about it if it's interesting ("36 and miserable out, perfect for this one"). Don't beat it.
  • Charts → only if it gives you a sharp hot take ("I see Sabrina Carpenter at the top, you and I both know that's not real").
  • Press headlines → if a Pitchfork rating or Stereogum take is worth reacting to (Megan especially), USE IT. Otherwise skip.
  • Wikidata / Discogs → ONE small detail at most, dropped naturally ("right, this was on Sub Pop"). NOT a recital. NEVER list members or release years like a teleprompter.
  • Last.fm similar → if MM/Megan want to say "if you like X, you should be into Y," reach for the similar list rather than inventing.

Don't invent specifics you can't verify — if you don't have facts, lean into opinion and the bicker. Vary which speaker opens; sometimes MM, sometimes Megan kicks off.`

  const radioPrompt = buildMusicManPrompt(radioInstructions)

  // 4.3.0: pull external context in parallel — weather, charts, recent
  // music-press headlines, Wikidata structured facts for both the
  // outgoing and incoming artists, Discogs pressing detail, and Last.fm
  // similar artists. All cached, all fail-soft. The prompt picks
  // selectively from this firehose; we don't dump it all.
  // 2026-08-15: the first two slots used to be full searchWeb() calls whose
  // results radioV2 stopped injecting ("reading a Wikipedia page" feel) —
  // but the FETCHES stayed, so every segment paid Wikipedia + MusicBrainz +
  // Exa for two artists and discarded all of it. Replaced with the
  // exaRecentNews template (day-cached, livecrawled), which radioV2's
  // philosophy actually wants: news is reaction bait, not encyclopedia.
  const { exaRecentNews } = await import('./exa')
  const [
    newsCurrent,
    newsNext,
    weather,
    chart,
    reviews,
    wdCurrent,
    wdNext,
    discogsCurrent,
    discogsNext,
    similarCurrent,
    memoryBlock,
  ] = await Promise.all([
    exaRecentNews(track.artist),
    nextTrack && nextTrack.artist !== track.artist ? exaRecentNews(nextTrack.artist) : Promise.resolve(''),
    getBrooklynWeather(),
    getLastFmNyChart(),
    getRecentReviews(),
    getWikidataArtist(track.artist),
    nextTrack && nextTrack.artist !== track.artist ? getWikidataArtist(nextTrack.artist) : Promise.resolve(null),
    getDiscogsReleaseInfo(track.artist, track.album),
    nextTrack && nextTrack.artist !== track.artist ? getDiscogsReleaseInfo(nextTrack.artist, nextTrack.album) : Promise.resolve(null),
    getLastFmSimilarArtists(track.artist),
    formatMemoryForPrompt(),
  ])

  let userMessage: string
  if (opener && nextTrack) {
    userMessage = `Show open — first track up: "${nextTrack.title}" by ${nextTrack.artist} from "${nextTrack.album}" (${nextTrack.genre}, ${nextTrack.year}). Welcome the listener, do a campy [ANNOUNCER] station ID, get the show rolling.`
  } else if (nextTrack) {
    userMessage = `Song that just finished: "${track.title}" by ${track.artist} from "${track.album}" (${track.genre}, ${track.year}). Coming up next: "${nextTrack.title}" by ${nextTrack.artist} from "${nextTrack.album}" (${nextTrack.genre}, ${nextTrack.year}).`
  } else {
    userMessage = `Now playing: "${track.title}" by ${track.artist} from the album "${track.album}" (${track.genre}, ${track.year})`
  }
  // 4.5 radioV2: artist "Background" facts (Exa web search) REMOVED from the
  // radio prompt — the #1 source of the "reading a Wikipedia page" feel. The
  // hosts now run on opinion + reaction, not researched facts.

  // External-API enrichment — append only what came back. The prompt's
  // KILL VANILLA / HUMAN MOVES rules tell Claude to use these as
  // *texture and reaction hooks*, not facts to recite.
  // 4.5 radioV2: reaction-bait only (no encyclopedia) — see prior comment
  // history. MERGE 2026-07-18: the listener's ACTIVITY place weather (from the
  // last iPod sync brief) outranks Brooklyn — an Aspen ski day should not
  // sound like Brooklyn radio filler.
  const activityCtx = getActivityBrainContextSync()
  const activityWx = activityCtx?.weather
  const weatherLine = activityWx
    ? `${activityWx.placeLabel || activityCtx?.brief?.place || 'There'}: ${activityWx.tempF}°F, ${(activityWx.description || activityWx.condition || '').toLowerCase()}.`
    : formatWeatherForPrompt(weather)
  const activityPrompt = getActivityPromptBlockSync()
  if (activityPrompt) userMessage += `\n\n${activityPrompt}`
  const chartLine = formatLastFmChartForPrompt(chart)
  const reviewsBlock = formatReviewsForPrompt(reviews)
  if (weatherLine) userMessage += `\n\n${weatherLine}`
  if (chartLine) userMessage += `\n${chartLine}`
  if (reviewsBlock) userMessage += `\n\n${reviewsBlock}`
  // Artist news: the one kind of researched context radioV2 wants — hosts
  // reacting to something that HAPPENED, not reciting a bio. Absent block
  // = no news; the instruction line keeps them from inventing any.
  if (newsCurrent || newsNext) {
    userMessage += `\n\nARTIST NEWS (react like DJs who saw the story this morning — one beat, never a report; if it's not here, there IS no news):`
    if (newsCurrent) userMessage += `\n${newsCurrent}`
    if (newsNext) userMessage += `\n${newsNext}`
  }
  // 4.3.2: persistent radio memory — recent angles + callback fuel.
  if (memoryBlock) userMessage += `\n\n${memoryBlock}`

  // 4.5: per-segment plan injection REMOVED. The double disk read
  // (formatPlanForPrompt + getShowPlan) was firing on every between-
  // track call, contributing latency that compounded with the
  // planner-at-toggle and produced a "Radio Mode takes forever +
  // tracks skip on their own" experience for Jake. Show-plan
  // storage is still set/cleared by the Toolbar (radio-set-show-
  // plan / radio-clear-show-plan) — future per-segment integration
  // should batch into a single in-memory read, not per-call disk hits.

  // 4.4.1: archetype block — names the structural template the segment
  // should follow, with shape, length, energy, dwell, and tone-reference
  // examples. For the deferred-punchline / hour-out archetypes (slot 11),
  // also pulls the slot-1 hot take from memory so the close pays it off.
  let archetypeBlock = ''
  if (archetypeId && ARCHETYPES[archetypeId as ArchetypeId]) {
    const id = archetypeId as ArchetypeId
    let slot1HotTake: string | undefined
    if ((id === 'deferred-punchline' || id === 'hour-out') && hourCounter !== undefined) {
      const ht = await getHotTake(hourCounter)
      slot1HotTake = ht?.text
    }
    archetypeBlock = buildArchetypeBlock(id, { slot1HotTake })
  }
  if (archetypeBlock) userMessage += `\n\n${archetypeBlock}`

  try {
    const response = await claudeCall('musicman-radio', {
      model: 'claude-sonnet-4-6',
      max_tokens: 220,
      system: radioPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    if (text) noteMusicManUtterance('radio', text)
    // 4.3.2: persist this segment to radio memory so future segments
    // can reference it. Fire-and-forget — failure to write doesn't
    // affect the response.
    if (text) {
      const speakers: string[] = ['mm', 'megan']
      if (callerSegment) speakers.push(callerId || 'giovanni')  // record the ACTUAL caller, not always Giovanni
      if (djHandsSegment) speakers.push('stephen')
      if (wantsAnnouncer) speakers.push('announcer')
      void appendMemory({
        ts: Date.now(),
        transition: 0, // counter is renderer-side; we don't have it here, but ts ordering is enough
        slot: slot ?? -1,
        angle: topicAngle ? topicAngle.split(' — ')[0] : null,
        speakers,
        prevTrack: `${track.title} — ${track.artist}`,
        nextTrack: nextTrack ? `${nextTrack.title} — ${nextTrack.artist}` : '',
        callbacks: extractCallbacks(text),
      })
      // 4.4.1: if this was a Cold Open Hot Take (slot 1, archetype A),
      // extract the actual claim from MM/Megan's first line and store
      // it as the hour's hot take. Slot 11 will pay it off.
      if (archetypeId === 'cold-open-hot-take' && hourCounter !== undefined) {
        const firstLine = text.split('\n')
          .map(l => l.trim())
          .find(l => /^\[(MM|MEGAN)\]/i.test(l))
        if (firstLine) {
          const m = firstLine.match(/^\[(MM|MEGAN)\]\s*(.+)/i)
          if (m) {
            const speaker = m[1].toUpperCase() === 'MEGAN' ? 'megan' : 'mm'
            void setHotTake(m[2].trim(), speaker, hourCounter)
          }
        }
      }
    }
    return { ok: true, text }
  } catch (err: unknown) {
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, text: msg, error: msg }
  }
}, { refuse: { ok: false, text: '', error: 'refused-sender' } as const })


// Music Man DJ Set — picks a batch of songs and generates a DJ intro
ipc.handle('musicman-dj-set', async (_event, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number; bpm?: number | null; camelotKey?: string; keyRoot?: string; keyMode?: string }[], recentIds: number[]) => {
  // 4.5.0-88 — RAG candidate pool for DJ-set. No user mood string
  // here (the IPC just says "pick a set"), so seed with a generic
  // danceable-vibe query to bias retrieval toward party-flow tracks
  // while still casting a wide net (K=300). Exclude recently-played
  // post-retrieval. Falls back to full-library prompt when
  // embeddings aren't ready.
  const RAG_DJSET_K = 300
  const recentSet = new Set(recentIds)
  let candidateTracks: typeof tracks = tracks
  if (ragIsConfigured()) {
    const idxCount = await ragIndexedCountForTracks(tracks)
    if (idxCount >= Math.max(50, Math.floor(tracks.length * 0.8))) {
      const hits = await ragRetrieveByQuery(
        'danceable high-energy party set with rhythm groove BPM-matched flow',
        RAG_DJSET_K,
      )
      if (hits.length >= 50) {
        const idSet = new Set(hits.map(h => h.trackId).filter(id => !recentSet.has(id)))
        const subset = tracks.filter(t => idSet.has(t.id))
        if (subset.length >= 50) {
          candidateTracks = subset
          console.log(`[musicman-dj-set] RAG pool: ${candidateTracks.length} candidates from ${tracks.length} total`)
        }
      }
    }
  }
  // Include measured BPM + Camelot so Stephen can actually match tempo/key
  // instead of guessing from genre/year (Jake 2026-08: brain wasn't utilizing
  // correct analysis). '?' when unanalyzed — never fabricate.
  const trackList = candidateTracks.map(t => {
    const bpm = typeof t.bpm === 'number' && t.bpm > 0 ? String(Math.round(t.bpm)) : '?'
    const cam = (t.camelotKey || '').trim() || '?'
    return `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}|${t.year}|bpm=${bpm}|camelot=${cam}`
  }).join('\n')
  const recentStr = recentIds.length > 0 ? `\nRecently played track IDs (AVOID these): ${recentIds.join(', ')}` : ''

  // 4.4.0: DJ Mode is now Stephen Hands' lane, not Music Man's. Stephen
  // is the in-house DJ — party-first, beats-forward, brief. He runs the
  // continuous AI-DJ flow that DJ Mode triggers between tracks.
  const djSetInstructions = `You are DJ Stephen Hands running a continuous DJ set from inside the listener's library. Pick 6-10 songs that hang together AS A SET. The criteria: do they MOVE A ROOM. Use the bpm= and camelot= columns on each row — match tempos within ~6 BPM when possible, prefer Camelot neighbors (±1 number or relative major/minor), build an energy arc. Ignore '?' values (unanalyzed).

Return ONLY a JSON object (no markdown, no code fences):
{"intro":"YOUR spoken DJ intro in Stephen Hands' voice — 1-2 sentences MAX. Hyped, brief, party-first. NOT a Music Man intro — no historian-style framing, no genealogy talk. Sound like a DJ in a booth at 1AM. Examples of the right length: 'Stephen Hands. Pulled up a set that runs hot — disco into house into something nasty. Hands up.' OR 'Yo. Stephen. Built this around BPM matches and one Patrick Adams sample. Lock in.'","trackIds":[array of track ID numbers in play order],"theme":"short theme label in Stephen's voice — 'After Midnight', 'Disco / Boogie / House', 'Drum Programming Mt. Rushmore', etc."}

Rules:
- ONLY use track IDs from the provided library
- Do NOT pick any recently played tracks${recentStr ? ' (see list below)' : ''}
- HARD ARTIST RULE: each artist appears AT MOST ONCE in the set. Aim for all distinct artists.
- Order matters — build a journey, but a DANCE FLOOR journey, not a Music Man lecture journey
- Prefer tracks with real bpm=/camelot= over '?' when choosing between equals
- Keep the intro SHORT — Stephen is NOT a man of many words${recentStr}`

  const act = getActivityPromptBlockSync()
  const systemPrompt = withLibraryDigest(DJ_HANDS_CORE) + '\n\n' + djSetInstructions
    + (act ? `\n\n${act}\nBias the set toward this activity's energy when it fits the dancefloor.` : '')

  try {
    const response = await claudeCall('musicman-dj-set', {
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Pick songs for your next DJ set.\n\nLibrary (ID|Title|Artist|Album|Genre|Year):\n${trackList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.intro) noteMusicManUtterance('dj-set', parsed.intro)
      return { ok: true, intro: parsed.intro, trackIds: parsed.trackIds, theme: parsed.theme }
    }
    return { ok: false, error: 'Could not parse DJ set' }
  } catch (err: unknown) {
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, error: msg }
  }
}, { refuse: REFUSED_SENDER })

// ── Discogs Collection — Music Man knows your vinyl/CD collection ──
const DISCOGS_CACHE_PATH = join(app.getPath('userData'), 'discogs-collection.json')
let discogsCollection = ''

async function fetchDiscogsCollection() {
  const token = process.env.DISCOGS_API_TOKEN
  if (!token) return

  // Use cache if less than 24 hours old
  try {
    const cached = JSON.parse(await readFile(DISCOGS_CACHE_PATH, 'utf-8'))
    if (cached.ts && Date.now() - cached.ts < 24 * 60 * 60 * 1000) {
      discogsCollection = cached.summary
      console.log(`Discogs: loaded ${cached.count} releases from cache`)
      return
    }
  } catch { /* no cache */ }

  try {
    // First get the username
    const identityRes = await fetch('https://api.discogs.com/oauth/identity', {
      headers: { 'Authorization': `Discogs token=${token}`, 'User-Agent': 'JakeTunes/3.0' }
    })
    if (!identityRes.ok) { console.error('Discogs identity failed:', identityRes.status); return }
    const identity = await identityRes.json() as { username: string }
    const username = identity.username

    // Fetch collection (folder 0 = all) — paginate up to 500 releases
    const releases: { artist: string; title: string; year: number; formats: string[] }[] = []
    let page = 1
    while (releases.length < 500) {
      const url = `https://api.discogs.com/users/${username}/collection/folders/0/releases?page=${page}&per_page=100&sort=added&sort_order=desc`
      const res = await fetch(url, {
        headers: { 'Authorization': `Discogs token=${token}`, 'User-Agent': 'JakeTunes/3.0' }
      })
      if (!res.ok) break
      const data = await res.json() as { releases: { basic_information: { artists: { name: string }[]; title: string; year: number; formats: { name: string }[] } }[]; pagination: { pages: number } }
      for (const r of data.releases) {
        const bi = r.basic_information
        releases.push({
          artist: bi.artists?.map((a: { name: string }) => a.name).join(', ') || 'Unknown',
          title: bi.title,
          year: bi.year,
          formats: bi.formats?.map((f: { name: string }) => f.name) || []
        })
      }
      if (page >= data.pagination.pages) break
      page++
    }

    if (releases.length === 0) return

    // Build summary for Music Man
    const formatCounts: Record<string, number> = {}
    const artistCounts: Record<string, number> = {}
    for (const r of releases) {
      for (const f of r.formats) formatCounts[f] = (formatCounts[f] || 0) + 1
      artistCounts[r.artist] = (artistCounts[r.artist] || 0) + 1
    }
    const topCollected = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)
    const formatStr = Object.entries(formatCounts).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${n} ${f}s`).join(', ')
    const recentAdds = releases.slice(0, 15).map(r => `${r.artist} — ${r.title} (${r.year})`).join(', ')
    const collectedArtists = topCollected.map(([a, n]) => `${a} (${n})`).join(', ')

    discogsCollection = `Discogs collection: ${releases.length} releases (${formatStr}). Most collected artists: ${collectedArtists}. Recently added: ${recentAdds}`

    // Cache it
    await writeFile(DISCOGS_CACHE_PATH, JSON.stringify({ ts: Date.now(), count: releases.length, summary: discogsCollection }))
    console.log(`Discogs: fetched ${releases.length} releases for ${username}`)
  } catch (err) {
    console.error('Discogs fetch error:', err)
  }
}


// Periodically generate new Music Man observations (called after every ~20 plays)
async function generateObservation() {
  const p = getListenerProfile()
  if (p.totalPlays < 10) return // not enough data yet

  const tasteCtx = buildTasteProfile()
  try {
    const response = await claudeCall('listener-obs', {
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: `You are analyzing a music listener's habits. Based on the data below, write 1-2 SHORT, specific observations about their taste that a DJ would find useful. Be concrete — don't say "they like rock", say "they keep coming back to post-punk revival bands" or "they listen to Radiohead more than anything but skip the later albums." If you've already made similar observations, note what's CHANGED or NEW. Return ONLY the observations, no preamble.`,
      messages: [{ role: 'user', content: tasteCtx }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    if (text) {
      // Keep only the most recent 15 observations (capped and saved inside)
      addObservation(text)
    }
  } catch { /* non-critical */ }
}

// ─── Shared Music Man persona + cross-handler memory ───
//
// Every Music Man endpoint (chat, DJ commentary, playlist gen,
// recommendations, etc.) used to carry its own inline copy of the
// persona and fixed opinions. Each call was a separate API request
// with separate state, so he'd happily contradict himself between
// modes — e.g. drop a fun fact about Pearl Jam during DJ mode, then
// in chat act like he'd never heard of them. The fixed-opinion
// text also drifted between handlers as features were added.
//
// Solution: one canonical system prompt core, plus a rolling log of
// the last ~10 things Music Man has said (across ALL modes), injected
// into every new call so he sees his own recent statements and
// doesn't contradict them.


// The rolling utterance log itself lives in ./persona-memory.ts — Music Man's
// 12 entries in STATE_DIR (shared across devices) and Cynthia's 8 locally.

// 4.5: append-only HIVE MIND log. Every mic press / DJ comment / radio
// segment lands here with full context (track, persona, response, facts
// looked up). Never capped, never dropped — Jake: "all data is good
// data". Future personalization / fine-tuning / RAG can train on this
// corpus. File is jsonl (one JSON object per line) so appending is a
// single fs.write call and parsing is a streaming line-split — scales
// to years of interactions without re-serializing the whole array on
// every write.
// 4.5.0-92 — hive-mind interaction log moves to STATE_DIR. Append-only
// jsonl; each line is one mic-button or DJ-comment event. SMB append
// is per-call atomic so multi-device interleaving is safe (any future
// secondary device's appends won't tear the file).
const HIVE_MIND_LOG_PATH = join(STATE_DIR, 'musicman-interactions.jsonl')
interface HiveMindEntry {
  at: number                      // epoch ms
  mode: string                    // 'mic' | 'dj-transition' | 'radio' | 'playlist' | etc.
  persona?: string                // 'mm' | 'megan' | 'stephen' | 'announcer' | 'giovanni' | ...
  track?: {                       // track context the persona was speaking about
    title?: string
    artist?: string
    album?: string
    genre?: string
    year?: string | number
  }
  nextTrack?: {                   // present for DJ-transition mode
    title?: string
    artist?: string
    album?: string
  }
  response: string                // the actual response text (with audio tags intact)
  facts?: string                  // artist facts looked up (Wikipedia/MusicBrainz)
}
function logHiveMindInteraction(entry: HiveMindEntry): void {
  try {
    const line = JSON.stringify(entry) + '\n'
    // Fire-and-forget append. A failed write here MUST NOT break the
    // user-facing response — corpus building is best-effort.
    void writeFile(HIVE_MIND_LOG_PATH, line, { flag: 'a' }).catch(err => {
      console.warn('[hive-mind] log append failed:', err)
    })
  } catch (err) {
    console.warn('[hive-mind] log serialize failed:', err)
  }
}
// ── Megan: the co-host persona (alternate to Music Man) ──
//
// 4.2.5 lets the user pick between Music Man and Megan as the default
// host voice for chat / picks / recommendations / DJ-set workflows.
// They co-host on Radio Mode together (always, regardless of preference);
// the preference only affects the SOLO persona for everything else.
//
// Megan is NOT a softer Music Man. She's a different listener with
// different taste, different opinions, different reference points. The
// fixed-opinions block here is intentionally non-overlapping with
// MUSIC_MAN_CORE so when the user asks both of them about the same
// artist, they give genuinely different answers.

// ── DJ Hands: the in-house beats specialist ──
//
// Drops in for DJ Mode (AI commentary on continuous sets) and rare
// guest spots on the WJLR show. Lives in rap and electronic — refuses
// to engage with rock-canon discourse on its own terms; pivots back to
// beats, samples, drum programming, BPM. His picks lean heavy into
// hip-hop, house, techno, footwork, IDM, drum-and-bass, drill, UK garage,
// jungle, miami bass, baltimore club. Doesn't perform expertise — when
// he says something is good, it's a small precise claim, not a sweeping
// "greatest of all time" pronouncement.

// ── Cynthia: the digital file archivist (subordinate persona) ──
//
// Music Man is the front of the house — opinions, DJ banter, recommendations.
// Cynthia is the back office — metadata, organization, missing tracks, wrong
// track numbers, misspellings. Investigate/chat/report IPC lives in
// ipc/cynthia-ipc.ts; MB lookup + embedded-tag reads stay here for the
// sweep hooks and CynthiaIpcHost.


// MusicBrainz album lookup with full track listings (the killer tool for
// "find my missing tracks"). Returns a JSON object Cynthia can read.
async function musicBrainzAlbumLookup(artist: string, album: string): Promise<string> {
  try {
    const headers = { 'User-Agent': `JakeTunes/${app.getVersion()} (jacobrosenbaum@gmail.com)`, 'Accept': 'application/json' }
    // Step 1: find candidate releases.
    const query = `release:"${album}" AND artist:"${artist}"`
    const searchUrl = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(query)}&fmt=json&limit=8`
    const searchRes = await fetch(searchUrl, { headers })
    if (!searchRes.ok) return JSON.stringify({ error: `MusicBrainz search failed: ${searchRes.status}` })
    const searchData = await searchRes.json() as {
      releases?: Array<{
        id: string
        title: string
        date?: string
        country?: string
        'track-count'?: number
        'artist-credit'?: Array<{ name: string }>
        'release-group'?: { 'primary-type'?: string }
      }>
    }
    const releases = searchData.releases || []
    if (releases.length === 0) {
      return JSON.stringify({
        artist, album,
        candidates: [],
        note: 'No releases found on MusicBrainz. Try alternate spellings of the artist or album, or tell the user MusicBrainz has no record of this release.',
      })
    }
    // Step 2: fetch full track listing for the top candidate, plus a short
    // list of alternate candidates so Cynthia can pick a different one.
    const top = releases[0]
    const detailUrl = `https://musicbrainz.org/ws/2/release/${top.id}?inc=recordings+media+artist-credits&fmt=json`
    const detailRes = await fetch(detailUrl, { headers })
    let canonical: { tracks: Array<{ disc: number; position: number; title: string; durationSec: number | null }>; trackCount: number } | null = null
    if (detailRes.ok) {
      const detail = await detailRes.json() as {
        media?: Array<{
          position?: number
          tracks?: Array<{
            position?: number
            title?: string
            length?: number  // milliseconds
            recording?: { title?: string; length?: number }
          }>
        }>
      }
      const tracks: Array<{ disc: number; position: number; title: string; durationSec: number | null }> = []
      for (const medium of detail.media || []) {
        const disc = medium.position || 1
        for (const t of medium.tracks || []) {
          const lenMs = t.length ?? t.recording?.length ?? null
          tracks.push({
            disc,
            position: t.position || 0,
            title: t.title || t.recording?.title || '',
            durationSec: lenMs ? Math.round(lenMs / 1000) : null,
          })
        }
      }
      canonical = { tracks, trackCount: tracks.length }
    }
    return JSON.stringify({
      artist, album,
      chosenRelease: {
        id: top.id,
        title: top.title,
        artist: top['artist-credit']?.[0]?.name || artist,
        date: top.date || null,
        country: top.country || null,
        type: top['release-group']?.['primary-type'] || null,
      },
      canonicalTracks: canonical?.tracks || [],
      canonicalTrackCount: canonical?.trackCount || 0,
      otherCandidates: releases.slice(1, 5).map(r => ({
        id: r.id,
        title: r.title,
        artist: r['artist-credit']?.[0]?.name || '',
        date: r.date || null,
        country: r.country || null,
        trackCount: r['track-count'] || null,
      })),
    })
  } catch (err: unknown) {
    return JSON.stringify({ error: safeIpcError(err, 'api-failed') })
  }
}

// Cynthia overhaul — read_file_tags host helper for cynthia-ipc:
// batch-read embedded tags via core/tag_reader.py.
async function readEmbeddedTagsForCynthia(trackIds: number[]): Promise<string> {
  try {
    if (trackIds.length === 0) return JSON.stringify({ error: 'no track ids given' })
    const lib = await libraryCache.get()
    const tracks = (lib.tracks as Array<{ id?: number; path?: string; title?: string }>) || []
    const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
    const pathSep = IS_WINDOWS ? '\\' : '/'
    const wanted = new Map<string, number>()
    for (const id of trackIds) {
      const t = tracks.find(tr => tr.id === id)
      if (t?.path) wanted.set(join(LOCAL_MOUNT, String(t.path).replace(/:/g, pathSep)), id)
    }
    if (wanted.size === 0) return JSON.stringify({ error: 'no file paths resolved for those ids' })
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
      py.stdin.on('error', reject)
      try {
        py.stdin.write(JSON.stringify([...wanted.keys()]))
        py.stdin.end()
      } catch (err) { reject(err) }
    })
    const arr = JSON.parse(read) as Array<{ path: string; [k: string]: unknown }>
    return JSON.stringify(arr.map(entry => ({ trackId: wanted.get(entry.path), ...entry, path: undefined })))
  } catch (err) {
    return JSON.stringify({ error: safeIpcError(err, 'api-failed') })
  }
}

// ─────────────────────────────────────────────────────────────────────
// Cynthia overhaul — background sweep wiring + IPC family.
// The sweep engine lives in cynthia-sweep.ts (idle-gated worker, per the
// audio-analysis queue pattern); these are its hooks into main's plumbing
// and the renderer's read/mutate surface.
// ─────────────────────────────────────────────────────────────────────

function cynthiaGetAlbumsSnapshot(): Map<string, { label: string; tracks: CynthiaScanTrack[] }> {
  const out = new Map<string, { label: string; tracks: CynthiaScanTrack[] }>()
  const lib = libraryCache.peek()
  if (!lib) return out
  const tracks = (lib.tracks as CynthiaScanTrack[]) || []
  for (const t of tracks) {
    if (!t || typeof t.id !== 'number') continue
    const key = albumKeyOfMain(t)
    let entry = out.get(key)
    if (!entry) {
      const artist = String(t.albumArtist || t.artist || 'Unknown Artist')
      const album = String(t.album || 'Unknown')
      entry = { label: `${artist} — ${album}`, tracks: [] }
      out.set(key, entry)
    }
    entry.tracks.push(t)
  }
  return out
}

function buildCynthiaSweepHooks() {
  return {
    getAlbums: cynthiaGetAlbumsSnapshot,
    fetchMbRelease: musicBrainzAlbumLookup,
    applyOverride: async (trackId: number, field: string, value: string, fingerprint: string) => {
      await applyMetadataOverrideInternal(trackId, field, value, fingerprint)
      triggerSync('metadata-edit')
    },
    isIdle: () => !playbackActive,
    sendProgress: (payload: { swept: number; total: number; withFindings: number; autoApplied: Array<{ trackId: number; field: string; newValue: string }>; currentAlbum?: string }) => {
      sendToRenderer('cynthia-sweep:progress', payload)
    },
    escalate: async (_albumKey: string, label: string, tracks: CynthiaScanTrack[], evidence: string) => {
      const res = await runCynthiaInvestigation(
        cynthiaIpcHost,
        `Background sweep escalation — the release identity for this album is ambiguous (multiple editions with different track counts). ${evidence}. Pick the right edition and propose ONLY fixes you are sure about, each with its source.`,
        { type: 'album', label, tracks: tracks as unknown as CynthiaTrackInScope[] },
      )
      if (!res.ok) return null
      const fixes = (res.fixes as Array<Record<string, unknown>> | undefined) ?? []
      const findings: CynthiaFinding[] = fixes
        .filter(f => typeof f.trackId === 'number' && typeof f.field === 'string')
        .map(f => ({
          trackId: f.trackId as number,
          field: f.field as CynthiaFinding['field'],
          oldValue: String(f.oldValue ?? ''),
          newValue: String(f.newValue ?? ''),
          reason: String(f.reason ?? ''),
          source: (f.source as CynthiaFinding['source']) ?? 'musicbrainz',
          confidence: f.confidence === 'high' ? 'high' : 'medium',
          provable: false,   // model output never auto-applies
        }))
      return { findings, summary: res.summary || '' }
    },
  }
}


/** Build a full system prompt by combining MUSIC_MAN_CORE with mode-
 *  specific instructions, library context, taste profile, and recent
 *  Music Man utterances. Every Music Man endpoint should use this.
 *
 *  Returns structured TextBlockParam[] (rather than a single string) so
 *  the stable prefix — MUSIC_MAN_CORE + library context — can be marked
 *  for prompt caching (4.0 §2.3). The library context is identical for
 *  every Music Man call within a session, so caching it saves ~all of
 *  the system-prompt tokens on repeat calls. The dynamic suffix (mode
 *  instructions, taste profile, recent utterances) changes per call and
 *  is left uncached.
 *
 *  If the cacheable prefix is below Anthropic's minimum cache size (1024
 *  tokens for Sonnet), the cache_control marker is silently ignored by
 *  the API — no benefit, but no error either.
 */


// Music Man chat
ipc.handle('musicman-chat', async (_event, messages: { role: string; content: string }[], context?: string) => {
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || ''
  // Drawer context (2026-09-02): what's playing / which page is open, so
  // "is this any good?" means THIS song. Bounded; never trusted as fact.
  const lookingAt = typeof context === 'string' && context.trim() ? context.trim().slice(0, 400) : ''
  // 4.5.0-87 — RAG retrieval kicks off in parallel with web search so
  // both round trips overlap. The retrieval result is injected as a
  // FOCUSED tracks block alongside the digest — model gets BOTH the
  // shape (digest) and the relevant rows (retrieval). No-ops cleanly
  // when OPENAI_API_KEY is missing or no embeddings are indexed yet.
  const USE_RAG_FOR_CHAT = true
  // 4.5.0-92 — RAG retrieval gets a 3s timeout race so a stalled NAS
  // embedding read (file mid-rsync, SMB hiccup) doesn't lock the chat
  // forever. Empty block on timeout means the model falls back to the
  // legacy library digest path — no quality cliff, just less grounded.
  const retrievalWithTimeout = USE_RAG_FOR_CHAT
    ? Promise.race([
        buildRetrievalBlockForQuery(lastUserMsg, 30),
        new Promise<string>((resolve) => setTimeout(() => resolve(''), 3000)),
      ])
    : Promise.resolve('')
  const [searchResults, retrievedTracksBlock] = await Promise.all([
    searchWeb(lastUserMsg, undefined, 'chat'),
    retrievalWithTimeout,
  ])

  // 4.5: chat output is READ AS TEXT in the panel, but the user can
  // ALSO click the speaker button under any assistant message to play
  // it via ElevenLabs v3. So we want Claude to FREELY use performance
  // tags ([scoff]/[laughs]/[softer]/etc.) for the spoken path, AND we
  // strip them for display. Two return fields: `text` (clean, for
  // display) and `textRaw` (tagged, for TTS). Renderer shows `text`
  // and passes `textRaw` to musicmanSpeak when the speaker button is
  // clicked — best of both worlds: clean reading + expressive playback.
  const chatInstructions = `You're chatting with the listener in JakeTunes. Use the library context and taste profile (below) to personalize — reference artists they own, notice gaps, recommend things tuned to what you know about them.

LENGTH (re-stated because chat is where this fails most):
Default: 1-3 sentences. The user asked a question — answer it. Don't lecture, don't recap, don't lay out a full history unless they specifically asked for one. The Pink Floyd Roger Waters lawsuit story is a 2-sentence take, not a 10-sentence chronicle. Trust the user to ask follow-ups if they want more.

CRITICAL — NEVER PUNT. You ARE the music expert. The user comes to YOU because you know this stuff. You have live web search (Exa.ai) results injected below for every question, plus deep training knowledge. NEVER respond with:
  - "I don't have a verified roster"
  - "check his official site"
  - "check Wikipedia"
  - "look it up to be sure"
  - any variant of "I can't confirm"
If the search results below give you the answer, USE IT confidently. If your training knowledge is solid (Beatles lineup, who produced Thriller, who was Wings' drummer in 1976, etc.), STATE IT — you're allowed to be wrong occasionally, that's the price of being the guy who actually knows. The user explicitly does NOT want you hedging like a lawyer. Better to confidently say "Brian Ray on bass, Rusty Anderson on guitar, Abe Laboriel Jr. on drums, Wix Wickens on keys — same core band for two decades now" and be slightly wrong than to make the user google it themselves.

When you DO need to acknowledge uncertainty, do it in ONE clause inside a confident answer — not as the whole reply. ("…last I knew Abe Laboriel Jr. was still on drums, that's been the case for like 20 years.")

PLAYLIST REQUESTS — you have a create_playlist TOOL and you USE it.
When the user asks for a playlist/mix/list of songs: call create_playlist
with CONCRETE tracks — real titles + artists chosen from the library
context and taste profile below (they must be songs the user plausibly
OWNS; the tool only accepts library matches and tells you what missed so
you can swap). Honor constraints literally (count, one-per-artist, year).
NEVER answer a playlist request with prose only, NEVER pad with picks you
can't name ("whatever's freshest from X" is a firing offense), NEVER
sneak in a track that violates a stated constraint. After the tool
returns, confirm in 1-2 sentences with a couple of highlights — the
playlist itself is already in their sidebar; don't recite it.

This response is shown as text in a chat panel, but the user may click a speaker button to hear it via ElevenLabs v3. Feel free to use v3 performance tags ([scoff], [laughs], [sighs], [softer], [whispers], [excited], [sarcastic]) where they meaningfully shape the delivery — they're invisible in the text panel (stripped before display) and performed by v3 if the user opts to hear the message.${searchResults ? `\n\nLive web search results — TREAT AS GROUND TRUTH and answer FROM these. Don't tell the user to "check" anything; you just did:\n${searchResults}` : ''}${retrievedTracksBlock ? `\n\n${retrievedTracksBlock}` : ''}${lookingAt ? `\n\nWHAT THE LISTENER HAS IN FRONT OF THEM RIGHT NOW (the drawer is open beside the library): ${lookingAt}. When they say "this" or "it", they mean that.` : ''}`

  const systemPrompt = buildMusicManPrompt(chatInstructions)

  // 4.5.0: Music Man recommends IN CONVERSATION only — he no longer writes to
  // "Listen to the List". The old add_to_recommendations tool quietly stuffed
  // the user's list with source-less picks they then had to delete forever
  // (the list is the USER's; the assistant shouldn't auto-commit to it). He
  // suggests; the user adds what they want via the list UI. (Tool + its
  // backend POST helper removed.)

  try {
    const convo: Anthropic.Messages.MessageParam[] = messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    // 2026-08-07 (Jake: "isnt he supposed to make playlists???? hes been
    // AWFUL"): the Music Man has HANDS now — a create_playlist tool that
    // resolves his picks against the real library, so a playlist request
    // produces a playlist in the sidebar, not a wall of prose. 1400
    // tokens because list assembly needs room; brevity of the VISIBLE
    // reply is governed by the prompt.
    const playlistTool: Anthropic.Messages.Tool = {
      name: 'create_playlist',
      description: 'Create a real playlist in the user\'s sidebar from library tracks. Returns which picks matched their library and which missed (swap the misses and call again if needed — max one retry).',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Playlist name — short, evocative, no quotes' },
          tracks: {
            type: 'array',
            items: { type: 'object', properties: { title: { type: 'string' }, artist: { type: 'string' } }, required: ['title', 'artist'] },
            description: 'Concrete picks, in play order',
          },
        },
        required: ['name', 'tracks'],
      },
    }
    let createdPlaylist: { name: string; trackIds: number[] } | null = null
    const resolvePlaylist = async (input: { name?: string; tracks?: Array<{ title?: string; artist?: string }> }) => {
      const lib = (await libraryCache.get() as { tracks?: Array<{ id: number; title?: string; artist?: string; albumArtist?: string }> }).tracks ?? []
      const trackIds: number[] = []
      const matchedDesc: string[] = []
      const missed: string[] = []
      const usedArtists = new Set<string>()
      for (const want of input.tracks ?? []) {
        const wt = String(want.title || ''); const wa = String(want.artist || '')
        const hit = lib.find((t) => recoTitleMatches(wt, String(t.title || '')) && recoArtistMatches(wa, String(t.albumArtist || t.artist || '')))
        if (!hit) { missed.push(`${wt} — ${wa}`); continue }
        const ak = String(hit.albumArtist || hit.artist || '').toLowerCase().trim()
        if (usedArtists.has(ak)) { missed.push(`${wt} — ${wa} (artist already in list)`); continue }
        usedArtists.add(ak)
        trackIds.push(hit.id)
        matchedDesc.push(`${hit.title} — ${hit.artist}`)
      }
      if (trackIds.length > 0) {
        createdPlaylist = { name: String(input.name || 'Music Man Mix').slice(0, 60), trackIds }
      }
      return { matched: matchedDesc.length, missed, note: trackIds.length ? 'Playlist created in the sidebar.' : 'Nothing matched the library — pick songs the user actually owns.' }
    }

    let response = await claudeCall('musicman-chat', { model: 'claude-sonnet-4-6', max_tokens: 1400, system: systemPrompt, messages: convo, tools: [playlistTool] })
    for (let round = 0; round < 2 && response.stop_reason === 'tool_use'; round++) {
      const toolUses = response.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
      const results: Anthropic.Messages.ToolResultBlockParam[] = []
      for (const tu of toolUses) {
        const out = tu.name === 'create_playlist'
          ? await resolvePlaylist(tu.input as { name?: string; tracks?: Array<{ title?: string; artist?: string }> })
          : { error: 'unknown tool' }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) })
      }
      convo.push({ role: 'assistant', content: response.content })
      convo.push({ role: 'user', content: results })
      response = await claudeCall('musicman-chat', { model: 'claude-sonnet-4-6', max_tokens: 1400, system: systemPrompt, messages: convo, tools: [playlistTool] })
    }

    // Aggregate text across any text blocks in the response.
    const textRaw = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim()
    // Strip performance tags WITHOUT flattening structure — the old
    // `\s+ → ' '` collapse destroyed every newline the model wrote,
    // which is exactly how a 50-song list became an unreadable wall
    // (2026-08-07). Newlines survive; runs of spaces/tabs collapse.
    const text = textRaw
      .replace(/\s*\[[a-zA-Z][a-zA-Z\s]*\]\s*/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text) noteMusicManUtterance('chat', text)
    return { ok: true, text, textRaw, createdPlaylist }
  } catch (err: unknown) {
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, text: msg, textRaw: msg, error: msg }
  }
}, { refuse: { ok: false, text: '', textRaw: '', error: 'refused-sender' } as const })

// 4.5: Radio Mode show planner. Before playback starts the hosts
// generate a 12-15 track SET LIST with a theme + throughline — instead
// of just shuffling the whole library and reacting per track (which
// produced the "jumpy with genres" feel Jake flagged: jazz → metal →
// pop → ambient with no connective tissue).
//
// The planner reads:
//   - Library digest computed inline (top artists, top genres, era
//     distribution from the tracks payload + their play counts)
//   - Recently-played track IDs (avoid pulling tracks the user heard
//     in the last week — radio is about rediscovery and fresh sequencing)
//
// Returns:
//   - theme       — 1-line title for the show ("Late-Night Lo-Fi Hour")
//   - throughline — 2-3 sentence pitch the hosts can reference between
//                   tracks ("we're walking from West Coast hip-hop into
//                   the soul samples that built it, then back out…")
//   - trackIds    — ordered set list (Toolbar uses these as the radio
//                   playback queue)
//
// Variety enforcement mirrors musicman-playlist: ≤3 per artist, ≥10
// distinct artists in a 13-track show. Retry once on violation. The
// hosts' library expertise comes from the digest — even if Claude can
// only see N tracks in the prompt, the digest tells it "this user has
// 87 tracks of jazz, 142 of hip-hop" so the show can lean into the
// listener's actual collection shape rather than reading the prompt
// list literally.
ipc.handle('musicman-radio-plan', async (_event, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number; playCount?: number; rating?: number; lastPlayedAt?: number; dateAdded?: string }[], recentPlayedIds: number[]) => {
  // ── Library digest ───────────────────────────────────────────────
  const recentSet = new Set(recentPlayedIds || [])
  const eligibleTracks = tracks.filter(t => !recentSet.has(t.id))
  if (eligibleTracks.length < 25) {
    // Library too small after recent-filter — fall through to using all
    // tracks. Better to risk a small repeat than ship an empty show.
    eligibleTracks.push(...tracks.filter(t => !eligibleTracks.find(e => e.id === t.id)).slice(0, 50))
  }

  const artistPlays = new Map<string, number>()
  const genrePlays = new Map<string, number>()
  const eraBuckets: Record<string, number> = { '<70': 0, '70s': 0, '80s': 0, '90s': 0, '00s': 0, '10s': 0, '20s': 0, 'unk': 0 }
  for (const t of tracks) {
    if (t.artist) artistPlays.set(t.artist, (artistPlays.get(t.artist) || 0) + (t.playCount || 0))
    if (t.genre) genrePlays.set(t.genre, (genrePlays.get(t.genre) || 0) + (t.playCount || 0))
    const yr = parseInt(`${t.year || ''}`)
    if (!yr || isNaN(yr)) eraBuckets['unk']++
    else if (yr < 1970) eraBuckets['<70']++
    else if (yr < 1980) eraBuckets['70s']++
    else if (yr < 1990) eraBuckets['80s']++
    else if (yr < 2000) eraBuckets['90s']++
    else if (yr < 2010) eraBuckets['00s']++
    else if (yr < 2020) eraBuckets['10s']++
    else eraBuckets['20s']++
  }
  const topArtists = [...artistPlays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  const topGenres = [...genrePlays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  const digest = [
    `Library size: ${tracks.length} tracks`,
    `Top artists by plays: ${topArtists.map(([a, n]) => `${a} (${n})`).join(', ')}`,
    `Top genres by plays: ${topGenres.map(([g, n]) => `${g} (${n})`).join(', ')}`,
    `Era distribution: ${Object.entries(eraBuckets).filter(([, n]) => n > 0).map(([e, n]) => `${e}=${n}`).join(', ')}`,
  ].join('\n')

  // ── Track list payload ───────────────────────────────────────────
  const now = Date.now()
  function lpBucket(ms: number | undefined): string {
    if (!ms) return 'never'
    const days = Math.floor((now - ms) / 86400000)
    if (days < 2) return 'yday'
    if (days < 8) return 'wk'
    if (days < 32) return 'mo'
    if (days < 366) return 'yr'
    return 'old'
  }
  const trackList = eligibleTracks.map(t => {
    const parts = [
      String(t.id), t.title || '', t.artist || '', t.album || '', t.genre || '', `${t.year || '?'}`,
      `plays=${Math.min(999, t.playCount || 0)}`, `lp=${lpBucket(t.lastPlayedAt)}`,
    ]
    if (t.rating && t.rating > 0) parts.push(`★${t.rating}`)
    return parts.join('|')
  }).join('\n')

  const TARGET_COUNT = 13
  const MAX_PER_ARTIST = 3
  const MIN_DISTINCT_ARTISTS = 10

  const planInstructions = `You are planning the next WJLR 330.9 radio show. Hosts: The Music Man (record-store savant), Megan (working music critic). The set should feel like a REAL radio show curated by experts who know this listener's collection cold — not a shuffle, not a mood-playlist.

Use the LIBRARY DIGEST to ground your taste. You see ${tracks.length} tracks, but the digest tells you the SHAPE of the collection. Lean into it; don't pretend you don't know what this person owns.

Build a ${TARGET_COUNT}-track set with:
- A coherent THEME (1 line, e.g. "Late-Night Lo-Fi Hour", "From West Coast Hip-Hop to the Soul That Built It", "The Year Was 1979")
- A THROUGHLINE the hosts can ride for 75 minutes (2-3 sentences — what's the arc, what story does the sequence tell, what payoff at the end)
- An intentional FLOW: opener that announces the vibe, middle that develops it, last 2 tracks that send it home

Return ONLY a JSON object (no markdown, no code fences):
{"theme":"...","throughline":"...","trackIds":[array of track ID numbers in show order]}

HARD RULES (the show is rejected and you'll be asked to redo it):
- ONLY use track IDs from the provided eligible-tracks list — do not invent IDs
- MAXIMUM ${MAX_PER_ARTIST} tracks per artist across the show
- At least ${MIN_DISTINCT_ARTISTS} different artists in ${TARGET_COUNT} tracks
- Never put two tracks by the same artist back-to-back
- The set must have THEMATIC COHERENCE — random genre whiplash is a fail (Jake's words: "too jumpy with genres"). Each track-to-track transition should make sense to the hosts

CRAFT RULES:
- 'plays=' is total play count, '★N' is rating, 'lp=' is when last heard. The set should mix beloved (high plays + ★) with rediscovery ('lp=old' / 'lp=never'). Avoid 'lp=yday' tracks.
- Lean on the user's top genres — but build a show, not a top-25 dump. Pull a deep cut, run an unexpected segue, end somewhere different from where you started.
- Reach into the catalog the user forgot they owned.`

  const systemPrompt = buildMusicManPrompt(planInstructions)

  function validate(trackIds: number[]): string | null {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return 'empty trackIds'
    const byId = new Map<number, { artist: string }>()
    for (const t of tracks) byId.set(t.id, { artist: t.artist || '' })
    const artistCounts = new Map<string, number>()
    const seen = new Set<number>()
    let lastArtist = ''
    for (const id of trackIds) {
      const t = byId.get(id)
      if (!t) return `track id ${id} is not in the library`
      if (seen.has(id)) return `track id ${id} appears twice`
      seen.add(id)
      const a = t.artist.toLowerCase().trim()
      artistCounts.set(a, (artistCounts.get(a) || 0) + 1)
      if (a && a === lastArtist) return `back-to-back tracks by ${t.artist}`
      lastArtist = a
    }
    const over = [...artistCounts.entries()].filter(([, n]) => n > MAX_PER_ARTIST)
    if (over.length > 0) return over.map(([a, n]) => `"${a}" appears ${n} times (cap is ${MAX_PER_ARTIST})`).join('; ')
    if (artistCounts.size < MIN_DISTINCT_ARTISTS) return `only ${artistCounts.size} distinct artists (need ≥${MIN_DISTINCT_ARTISTS})`
    return null
  }

  async function callOnce(extra: string | null): Promise<{ theme?: string; throughline?: string; trackIds?: number[] }> {
    const userContent = `LIBRARY DIGEST:\n${digest}\n\nELIGIBLE TRACKS (ID|Title|Artist|Album|Genre|Year|plays|lp|★rating) — recent-week tracks have been removed:\n${trackList}${extra ? `\n\n${extra}` : ''}`
    const response = await claudeCall('musicman-radio-plan', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })
    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return {}
    try {
      const parsed = JSON.parse(m[0])
      return { theme: parsed.theme, throughline: parsed.throughline, trackIds: parsed.trackIds }
    } catch {
      return {}
    }
  }

  try {
    let attempt = await callOnce(null)
    if (!attempt.trackIds) return { ok: false, error: 'Could not parse show plan' }
    const violation = validate(attempt.trackIds)
    if (violation) {
      console.log(`[musicman-radio-plan] retry — violation: ${violation}`)
      attempt = await callOnce(`Your previous draft violated: ${violation}. Regenerate respecting MAX ${MAX_PER_ARTIST} per artist + ≥${MIN_DISTINCT_ARTISTS} distinct artists. Keep the same theme + throughline if possible.`)
      if (!attempt.trackIds) return { ok: false, error: 'Could not parse show plan (retry)' }
    }
    return { ok: true, theme: attempt.theme, throughline: attempt.throughline, trackIds: attempt.trackIds }
  } catch (err: unknown) {
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, error: msg }
  }
}, { refuse: REFUSED_SENDER })

ipc.handle('musicman-playlist', async (_event, mood: string, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number; playCount?: number; rating?: number; lastPlayedAt?: number; dateAdded?: string }[]) => {
  // 4.5: serialize each row with play signals so Claude can weight
  // picks by listening behaviour. Without these the model only sees
  // metadata and falls back to clustering by the first few artists
  // alphabetically / by genre, producing the "5-6 artists in 25
  // tracks" pattern Jake complained about.
  //
  // plays — total play count (caps at 999 in the prompt to avoid
  //   long-tail formatting noise; the relative ranking is what matters)
  // rated — 0-5 stars, omitted if unrated
  // lp    — relative bucket ("yday", "wk", "mo", "yr", "old") so
  //   Claude can avoid stuff the user just heard or surface stuff
  //   they haven't played in a year (rediscovery)
  // (year is included but inline so the row stays scannable)
  const now = Date.now()
  function lastPlayedBucket(ms: number | undefined): string {
    if (!ms) return 'never'
    const days = Math.floor((now - ms) / (24 * 60 * 60 * 1000))
    if (days < 2) return 'yday'
    if (days < 8) return 'wk'
    if (days < 32) return 'mo'
    if (days < 366) return 'yr'
    return 'old'
  }
  // 4.5.0-88 — RAG-driven candidate pool. Pre-fix every musicman-
  // playlist call sent the WHOLE library (~6,800 lines, ~540 KB) to
  // Claude. Now, if RAG is configured and ≥80% of the library is
  // indexed, we retrieve the top-K mood-relevant tracks (K = max(200,
  // TARGET × 5)) and send ONLY those to Claude. Net effect:
  //   - Prompt shrinks 30-40× → faster + cheaper per call
  //   - Candidate pool is mood-aware → fewer "I picked the wrong
  //     genre" misses
  //   - The deterministic top-up below still draws from the FULL
  //     library on shortfall, so quality doesn't regress for queries
  //     where retrieval misses something niche.
  // Falls back to full-library prompt when retrieval returns < 50
  // hits (suggests embeddings haven't been backfilled or are sparse).
  const RAG_PLAYLIST_OVERSAMPLE = 5
  const RAG_PLAYLIST_MIN_POOL = 50
  const moodDecade = parseDecadeConstraint(mood)
  // Decade claim → hard-filter the candidate pool by library year BEFORE
  // Claude sees it. Cosine retrieval alone will surface Turnstile on a
  // "1970s" mood (the daily-mix failure). Missing year = out.
  let candidateTracks: typeof tracks = moodDecade
    ? tracks.filter(t => yearInDecade(t.year, moodDecade))
    : tracks
  if (moodDecade) {
    console.log(`[musicman-playlist] decade hard-gate ${moodDecade.label}: ${candidateTracks.length}/${tracks.length}`)
    if (candidateTracks.length < 5) {
      return {
        ok: false,
        error: `Not enough ${moodDecade.label} tracks in the library (${candidateTracks.length}) to build a set — need at least 5 with a year in ${moodDecade.start}–${moodDecade.end}.`,
      }
    }
  }
  let ragUsed = false
  if (ragIsConfigured()) {
    const idxCount = await ragIndexedCountForTracks(candidateTracks.length ? candidateTracks : tracks)
    if (idxCount >= Math.max(50, Math.floor((candidateTracks.length || tracks.length) * 0.8))) {
      const queryMatch = mood.match(/\b(\d{1,3})\s*(?:song|track|tune|cut|jam)/i)
      const queryTarget = queryMatch ? Math.max(5, Math.min(200, parseInt(queryMatch[1], 10))) : 25
      const k = Math.max(RAG_PLAYLIST_MIN_POOL, queryTarget * RAG_PLAYLIST_OVERSAMPLE)
      const hits = await ragRetrieveByQuery(mood, k)
      if (hits.length >= Math.min(RAG_PLAYLIST_MIN_POOL, candidateTracks.length || RAG_PLAYLIST_MIN_POOL)) {
        const idSet = new Set(hits.map(h => h.trackId))
        const subset = candidateTracks.filter(t => idSet.has(t.id))
        const minPool = moodDecade ? Math.min(RAG_PLAYLIST_MIN_POOL, Math.max(5, Math.floor(candidateTracks.length * 0.5))) : RAG_PLAYLIST_MIN_POOL
        if (subset.length >= minPool) {
          candidateTracks = subset
          ragUsed = true
          console.log(`[musicman-playlist] RAG pool: ${candidateTracks.length} candidates`)
        }
      }
    }
  }

  const trackList = candidateTracks.map(t => {
    const parts = [
      String(t.id),
      t.title || '',
      t.artist || '',
      t.album || '',
      t.genre || '',
      `${t.year || '?'}`,
      `plays=${Math.min(999, t.playCount || 0)}`,
      `lp=${lastPlayedBucket(t.lastPlayedAt)}`,
    ]
    if (t.rating && t.rating > 0) parts.push(`★${t.rating}`)
    return parts.join('|')
  }).join('\n')
  void ragUsed  // surfaced via log line above; reserved for future telemetry

  // 4.5.0-85 — mood-driven count + primary-artist parsing. Jake's
  // example: "40 songs of drake and similar" must return exactly 40,
  // Drake-heavy. Pre-fix the hardcoded constants returned ~25 tracks
  // with at most 3 per artist regardless of what the user asked for.
  //
  // Count parse: "40 songs/tracks" / "give me 50" / "100 song mix"
  // clamps to [5, 200] so a typo doesn't ask for 9999 tracks.
  //
  // Primary-artist parse: walks the library artist set and finds the
  // longest artist name whose lowercase form appears in mood as a
  // word match. "drake and similar" → Drake. Used to RELAX the per-
  // artist cap (so the playlist can be heavy on the asked-for artist)
  // and to drive the deterministic top-up below if Claude returns
  // short.
  const moodLower = mood.toLowerCase()
  const countMatch = mood.match(/\b(\d{1,3})\s*(?:song|track|tune|cut|jam)/i)
  const REQUESTED_COUNT = countMatch ? Math.max(5, Math.min(200, parseInt(countMatch[1], 10))) : 25
  const TARGET_COUNT = REQUESTED_COUNT
  // Find a library artist whose name appears in mood. Longest match
  // wins so "Pink Floyd" beats "Pink" when both are mentioned.
  const libraryArtists = new Set<string>()
  for (const t of tracks) if (t.artist) libraryArtists.add(t.artist)
  let primaryArtist: string | null = null
  for (const a of libraryArtists) {
    const al = a.toLowerCase().trim()
    if (al.length < 3) continue
    // Require word-boundary on either side so "drake" doesn't false-
    // match "drakes" or "soundtrack."
    if (new RegExp(`\\b${al.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(moodLower)) {
      if (!primaryArtist || a.length > primaryArtist.length) primaryArtist = a
    }
  }
  // Per-artist cap: relaxed dramatically when a primary artist is
  // mentioned (caller WANTS lots of that artist). Otherwise 3.
  const MAX_PER_ARTIST = primaryArtist ? Math.max(3, Math.floor(TARGET_COUNT * 0.75)) : 3
  // Distinct-artist floor: relaxed when a primary artist is named OR
  // when the count is small. Otherwise scales with TARGET_COUNT so a
  // 40-track playlist needs ~18 distinct artists by default.
  const MIN_DISTINCT_ARTISTS = primaryArtist ? 2 : Math.max(3, Math.floor(TARGET_COUNT * 0.45))

  const playlistInstructions = `Build a playlist from the user's ACTUAL library for their requested mood. Return EXACTLY ${TARGET_COUNT} tracks — not 38, not 39, not 24 — exactly ${TARGET_COUNT}. The user asked for a specific count; honor it. If your first cut comes up short, KEEP DIGGING through the library for more matches; the deterministic top-up below is a safety net, not your job to rely on.${primaryArtist ? ` The user explicitly called out "${primaryArtist}" — this playlist should be ${primaryArtist}-HEAVY (up to ${MAX_PER_ARTIST} ${primaryArtist} tracks is fine), with the rest being artists in a similar lane.` : ''} Track ORDER matters — think about flow, transitions, energy arc. This is a curated experience, not a shuffle.

Return ONLY a JSON object (no markdown, no code fences):
{"name":"creative playlist name","commentary":"2-3 sentences about your picks, in character","trackIds":[array of track ID numbers in playlist order]}

HARD RULES (the playlist is rejected and you'll be asked to redo it if any of these are violated):
- ONLY use track IDs from the provided library — do not invent IDs
- MAXIMUM ${MAX_PER_ARTIST} tracks per artist across the entire playlist. ${MAX_PER_ARTIST} is a ceiling, not a target — use it sparingly for headliners only
- At least ${MIN_DISTINCT_ARTISTS} DIFFERENT artists in a ${TARGET_COUNT}-track playlist (UNLESS the mood is a specific catalog — see CATALOG ACCURACY below — in which case authentic membership beats artist count)
- Never put two tracks by the same artist back-to-back
${moodDecade ? `- ERA GATE: the mood claims the ${moodDecade.label}. ONLY pick tracks whose Year column is ${moodDecade.start}–${moodDecade.end}. A song that "feels" like the era but was released later is a FAIL — Turnstile on a 1970s tape is how the brain looks broken.\n` : ''}- COMMENTARY MUST MATCH THE PICKS. Write the commentary AFTER you finalize trackIds, never before. Do NOT claim "the user doesn't have X" if X is in your trackIds. Do NOT claim "I'm pulling from Y" if Y isn't in your trackIds. Self-contradiction reads as the model wasn't paying attention. If your commentary needs editing because your picks changed, edit the commentary — not the other way around.

CATALOG ACCURACY (CRITICAL when the user names a specific canon — Bond themes, Pixar songs, Disney villain songs, Tarantino soundtracks, Christmas standards, Marvel scores, etc.):
- A "Bond theme" is a song from the OPENING TITLES of a James Bond film. There are ~25 of them. "Thunderball" (Tom Jones), "Goldfinger" (Shirley Bassey), "Live and Let Die" (Wings), "Nobody Does It Better" (Carly Simon), "A View to a Kill" (Duran Duran), "Goldeneye" (Tina Turner), "Skyfall" (Adele), "No Time To Die" (Billie Eilish), etc. Songs that ARE NOT Bond themes even if they share keywords or artists: "Thunderball" by Johnny Cash (rejected demo, never used), "Sixteen Saltines" by Jack White, "Danger Zone" by Kenny Loggins (Top Gun).
- The general rule: if the user names a CANON, only include tracks you are HIGHLY CONFIDENT belong to it. A track that has the right artist on a DIFFERENT topic is NOT a member. A track with a title that sounds vibey-adjacent is NOT a member. Better a 6-track accurate playlist than a 25-track one polluted with false positives.
- If you're not sure whether a track belongs to a named canon, EXCLUDE IT. The user will trust an under-inclusive list far more than an over-inclusive one with embarrassing wrong picks.
- For a named-canon playlist, the MIN_DISTINCT_ARTISTS rule above is suspended — authentic membership matters more than variety.

CRAFT RULES (for non-canon mood requests):
- Weight picks by signal: 'plays=' is total play count, '★N' is star rating, 'lp=' is when they last heard it (yday/wk/mo/yr/old/never). Beloved tracks (high plays + 4-5★) are the SPINE. 'lp=old' or 'lp=never' tracks are great for rediscovery — sprinkle them in. Avoid 'lp=yday' tracks unless they're truly perfect — the user just heard them.
- Build a journey: opener that announces the vibe, middle that develops it, last few that send it somewhere. Don't just stack 25 same-energy songs.
- Reach DEEP into the library — your job is to surface things the user forgot they owned, not just play their top 25. If a track has plays=0 but ★4, that's gold: they loved it once and lost it.
- If the mood is vague, interpret it with confidence. Don't ask for clarification.`

  const systemPrompt = buildMusicManPrompt(playlistInstructions)

  // 4.5: detect "named canon" requests so the validator suspends the
  // MIN_DISTINCT_ARTISTS rule. A Bond-themes playlist legitimately
  // has ~25 different artists, but a Beatles-only or Pixar-songs
  // playlist won't — and we don't want the retry path to bounce a
  // genuinely accurate canon list for low artist count.
  const isNamedCanon = /\b(bond|james bond|pixar|disney|tarantino|wes anderson|christmas|marvel|star wars|harry potter|holiday|lord of the rings|movie soundtrack|musical|broadway|only|just|all)\b/i.test(mood)

  // Helper: validate trackIds against the hard rules. Returns null if
  // valid, otherwise a violation string Claude can act on in retry.
  function validate(trackIds: number[]): string | null {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return 'empty trackIds'
    const byId = new Map<number, { artist: string; title: string; year: string | number }>()
    for (const t of tracks) byId.set(t.id, { artist: t.artist || '', title: t.title || '', year: t.year })
    const artistCounts = new Map<string, number>()
    const seen = new Set<number>()
    let lastArtist = ''
    for (const id of trackIds) {
      const t = byId.get(id)
      if (!t) return `track id ${id} is not in the library`
      if (seen.has(id)) return `track id ${id} appears twice`
      seen.add(id)
      if (moodDecade && !yearInDecade(t.year, moodDecade)) {
        return `"${t.title}" by ${t.artist} is year ${t.year || '?'} — outside ${moodDecade.label} (${moodDecade.start}–${moodDecade.end})`
      }
      const a = t.artist.toLowerCase().trim()
      artistCounts.set(a, (artistCounts.get(a) || 0) + 1)
      if (a && a === lastArtist) return `back-to-back tracks by ${t.artist}`
      lastArtist = a
    }
    const overCap = [...artistCounts.entries()].filter(([, n]) => n > MAX_PER_ARTIST)
    if (overCap.length > 0) {
      return overCap.map(([a, n]) => `"${a}" appears ${n} times (cap is ${MAX_PER_ARTIST})`).join('; ')
    }
    // 4.5: skip distinct-artist check for named-canon requests — see
    // isNamedCanon above. An authentic 6-track Bond list shouldn't get
    // bounced and re-padded with non-Bond filler.
    if (!isNamedCanon && artistCounts.size < MIN_DISTINCT_ARTISTS) {
      return `only ${artistCounts.size} distinct artists (need ≥${MIN_DISTINCT_ARTISTS})`
    }
    return null
  }

  async function callOnce(extraUserHint: string | null): Promise<{ name?: string; commentary?: string; trackIds?: number[]; rawText: string }> {
    const userContent = `Build me a playlist for: "${mood}"\n\nMy library (ID|Title|Artist|Album|Genre|Year|plays|lp|★rating):\n${trackList}${extraUserHint ? `\n\n${extraUserHint}` : ''}`
    const response = await claudeCall('musicman-playlist', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { rawText: text }
    try {
      const parsed = JSON.parse(jsonMatch[0])
      return { name: parsed.name, commentary: parsed.commentary, trackIds: parsed.trackIds, rawText: text }
    } catch {
      return { rawText: text }
    }
  }

  try {
    let attempt = await callOnce(null)
    if (!attempt.trackIds) return { ok: false, error: 'Could not parse playlist' }

    const violation = validate(attempt.trackIds)
    if (violation) {
      // One-shot retry with explicit feedback on what went wrong. Sonnet
      // reliably obeys constraint violations when they're called out by
      // count; pre-4.5 the prompt only said "variety is key" with no
      // numerical floor, so it routinely shipped 5-6-artist playlists.
      console.log(`[musicman-playlist] retry — violation: ${violation}`)
      attempt = await callOnce(`Your previous draft violated the hard rules: ${violation}. Regenerate the WHOLE playlist respecting MAX ${MAX_PER_ARTIST} per artist and ≥${MIN_DISTINCT_ARTISTS} distinct artists. Keep the same mood and similar flow.`)
      if (!attempt.trackIds) return { ok: false, error: 'Could not parse playlist (retry)' }
    }

    // 4.5.0-85 — exact-count enforcement post-Claude. The model
    // routinely undershoots (returns 38 when you asked for 40) and
    // sometimes overshoots. Truncate the overshoots; deterministically
    // top up the undershoots from the library so the user gets the
    // EXACT count they asked for. Top-up priority:
    //   1. More tracks by the primary artist (if specified), sorted
    //      by plays + rating desc — best Drake catalog first.
    //   2. Tracks by other artists sharing the primary artist's top
    //      genre (extracted from the library), again best-first.
    //   3. Anything from the library by play count desc, skipping
    //      what's already in the list.
    let finalIds = Array.isArray(attempt.trackIds) ? [...attempt.trackIds] : []
    if (finalIds.length > TARGET_COUNT) {
      console.log(`[musicman-playlist] truncating ${finalIds.length} → ${TARGET_COUNT}`)
      finalIds = finalIds.slice(0, TARGET_COUNT)
    }
    if (finalIds.length < TARGET_COUNT) {
      const inList = new Set(finalIds)
      const trackById = new Map(tracks.map(t => [t.id, t]))
      const score = (t: { playCount?: number; rating?: number }) =>
        (Number(t.playCount) || 0) + (Number(t.rating) || 0) * 5
      // 4.5.0-92 — was an array + `candidates.includes(t)` which is
      // O(N²) over the full library (6,800² = 46M includes-hops on a
      // worst-case top-up). Now a Set<id> for O(1) membership checks;
      // the visited-IDs check below uses Set.has across all three
      // tiers so candidates can stay a flat list.
      const candidates: typeof tracks = []
      const visited = new Set<number>(inList)
      // Tier 1: more of the primary artist.
      if (primaryArtist) {
        const primaryLower = primaryArtist.toLowerCase().trim()
        for (const t of tracks) {
          if (visited.has(t.id)) continue
          if ((t.artist || '').toLowerCase().trim() === primaryLower) {
            candidates.push(t)
            visited.add(t.id)
          }
        }
      }
      // Tier 2: same-genre as the primary artist (or top library
      // genre if no primary).
      const refGenres = new Set<string>()
      const refArtist = primaryArtist?.toLowerCase().trim() || ''
      for (const t of tracks) {
        if (refArtist && (t.artist || '').toLowerCase().trim() === refArtist && t.genre) {
          refGenres.add(t.genre.trim().toLowerCase())
        }
      }
      if (refGenres.size > 0) {
        for (const t of tracks) {
          if (visited.has(t.id)) continue
          if (refGenres.has((t.genre || '').trim().toLowerCase())) {
            candidates.push(t)
            visited.add(t.id)
          }
        }
      }
      // Tier 3: top-played overall — last-resort filler.
      for (const t of tracks) {
        if (visited.has(t.id)) continue
        candidates.push(t)
        visited.add(t.id)
      }
      candidates.sort((a, b) => score(b) - score(a))
      // Avoid back-to-back same artist when appending.
      const seenArtists: string[] = finalIds
        .map(id => (trackById.get(id)?.artist || '').toLowerCase().trim())
      for (const c of candidates) {
        if (finalIds.length >= TARGET_COUNT) break
        const a = (c.artist || '').toLowerCase().trim()
        const last = seenArtists[seenArtists.length - 1] || ''
        if (a && a === last) continue
        finalIds.push(c.id)
        seenArtists.push(a)
      }
      const added = finalIds.length - (Array.isArray(attempt.trackIds) ? attempt.trackIds.length : 0)
      if (added > 0) console.log(`[musicman-playlist] topped up +${added} (${primaryArtist ? `primary=${primaryArtist}` : 'no primary'}; final=${finalIds.length}/${TARGET_COUNT})`)
    }

    if (attempt.commentary) noteMusicManUtterance('playlist', attempt.commentary)
    return { ok: true, name: attempt.name, commentary: attempt.commentary, trackIds: finalIds }
  } catch (err: unknown) {
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, error: msg }
  }
}, { refuse: REFUSED_SENDER })

// ── 4.4.48: Weekly picks cache + variety enforcement ──────────────────
//
// Two long-standing bugs this fixes — both reported by Jake more than
// once ("there is absolutely no variety", "it feels like it is
// resetting a lot").
//
//  (1) RESETTING. Before 4.4.48 the ONLY weekly cache for picks lived in
//      the renderer's localStorage — per-device, per-component-mount,
//      bypassed on any miss (corrupt entry, fresh install, second
//      device, app-data wipe, a navigate-away mid-generation). A miss
//      meant a fresh Claude call → a completely different 25-track
//      list. So picks "reset" far more often than the intended
//      Friday-to-Friday cadence. Fix: a main-process picks-cache.json
//      in userData — the single authoritative weekly cache. Once a
//      persona's picks are generated for a given week, every call that
//      week returns the SAME list with no Claude hit. Survives app
//      restarts, reinstalls, and renderer churn.
//
//  (2) NO VARIETY. The picks prompt asks for "each artist at most
//      once," but the model reliably ignores it and returns album
//      blocks (4 Talking Heads, 4 Steely Dan, ...). enforcePicksVariety
//      does NOT trust the model: it round-robin-interleaves the model's
//      picks so no artist clusters, caps each artist, and backfills
//      from the wider library (genre-matched, fresh artists) when the
//      cap leaves the list short. The personas keep their distinct
//      lanes (that part works); this fixes the within-lane sameness.

interface CachedPicksEntry {
  weekStart: string   // YYYY-MM-DD of the Friday that starts the week
  name: string
  commentary: string
  trackIds: number[]
}

function getPicksCachePath(): string {
  return join(app.getPath('userData'), 'picks-cache.json')
}

/** YYYY-MM-DD of the Friday that starts the current Fri→Thu week
 *  (local time). Same value for any moment within that window — so
 *  equality on it means "still this week's picks." Mirrors the
 *  renderer's getWeekStartFriday so both sides agree on week boundaries. */
function weekStartFridayISO(d: Date = new Date()): string {
  const r = new Date(d)
  const daysSinceFriday = (r.getDay() - 5 + 7) % 7   // getDay: 0=Sun … 5=Fri
  r.setDate(r.getDate() - daysSinceFriday)
  r.setHours(0, 0, 0, 0)
  const y = r.getFullYear()
  const m = String(r.getMonth() + 1).padStart(2, '0')
  const dd = String(r.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

async function loadPicksCache(): Promise<Record<string, CachedPicksEntry>> {
  try {
    const raw = await readFile(getPicksCachePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch {
    return {}   // missing / corrupt → empty cache, regenerate
  }
}

async function savePicksCacheEntry(persona: string, entry: CachedPicksEntry): Promise<void> {
  try {
    const cache = await loadPicksCache()
    cache[persona] = entry
    await writeFile(getPicksCachePath(), JSON.stringify(cache, null, 2))
  } catch (err) {
    console.warn('[picks-cache] write failed:', err)
  }
}

type PicksTrack = { id: number; title: string; artist: string; album: string; genre: string; year: string | number }

/** Don't trust the model's artist spread. Round-robin-interleave its
 *  picks so no artist clusters, cap each artist at CAP, then backfill
 *  from the wider library (genre-matched, artists not yet used) if the
 *  cap left the list short. Guarantees `target` IDs whenever the
 *  library can supply them — relaxing the cap only as a last resort. */
function enforcePicksVariety(modelTrackIds: number[], tracks: PicksTrack[], target: number): number[] {
  const byId = new Map<number, PicksTrack>(tracks.map(t => [t.id, t]))
  const artistOf = (id: number) => (byId.get(id)?.artist || 'Unknown').toLowerCase().trim()
  const CAP = 2   // at most 2 tracks per artist before backfill kicks in

  // Group the model's valid, de-duped picks by artist, preserving the
  // order the model chose within each artist.
  const modelByArtist = new Map<string, number[]>()
  const seenModel = new Set<number>()
  for (const id of modelTrackIds) {
    if (!byId.has(id) || seenModel.has(id)) continue
    seenModel.add(id)
    const a = artistOf(id)
    if (!modelByArtist.has(a)) modelByArtist.set(a, [])
    modelByArtist.get(a)!.push(id)
  }

  const out: number[] = []
  const perArtist = new Map<string, number>()
  const take = (id: number) => {
    out.push(id)
    const a = artistOf(id)
    perArtist.set(a, (perArtist.get(a) || 0) + 1)
  }

  // Pass 1 — round-robin the model's picks, capped at CAP per artist.
  // This is what de-clusters "4 Talking Heads in a row" into a spread.
  {
    const queues = Array.from(modelByArtist.values()).map(q => [...q])
    let progress = true
    while (out.length < target && progress) {
      progress = false
      for (const q of queues) {
        if (out.length >= target) break
        if (q.length === 0) continue
        if ((perArtist.get(artistOf(q[0])) || 0) >= CAP) continue
        take(q.shift()!)
        progress = true
      }
    }
  }

  // Pass 2 — backfill from the wider library if the cap left us short.
  // Match the genres the picks already use (keeps it roughly in-lane
  // without hardcoding persona→genre maps), prefer artists not yet
  // represented, round-robin so the backfill is varied too.
  if (out.length < target) {
    const usedGenres = new Set<string>()
    for (const id of out) {
      const g = (byId.get(id)?.genre || '').toLowerCase().trim()
      if (g) usedGenres.add(g)
    }
    const usedIds = new Set(out)
    const backfillByArtist = new Map<string, number[]>()
    for (const t of tracks) {
      if (usedIds.has(t.id)) continue
      const g = (t.genre || '').toLowerCase().trim()
      if (usedGenres.size > 0 && g && !usedGenres.has(g)) continue
      const a = (t.artist || 'Unknown').toLowerCase().trim()
      if (!backfillByArtist.has(a)) backfillByArtist.set(a, [])
      backfillByArtist.get(a)!.push(t.id)
    }
    const fresh = Array.from(backfillByArtist.entries()).filter(([a]) => !perArtist.has(a)).map(([, q]) => [...q])
    const rest  = Array.from(backfillByArtist.entries()).filter(([a]) =>  perArtist.has(a)).map(([, q]) => [...q])
    for (const pool of [fresh, rest]) {
      let progress = true
      while (out.length < target && progress) {
        progress = false
        for (const q of pool) {
          if (out.length >= target) break
          if (q.length === 0) continue
          if ((perArtist.get(artistOf(q[0])) || 0) >= CAP) continue
          take(q.shift()!)
          progress = true
        }
      }
    }
  }

  // Pass 3 — last resort for an artist-thin library: relax the cap and
  // take whatever's left (model's leftovers first, then any library
  // track) so we still hit `target`. A slightly-clustered full list
  // beats a short one.
  if (out.length < target) {
    const usedIds = new Set(out)
    const leftover = [
      ...modelTrackIds.filter(id => byId.has(id) && !usedIds.has(id)),
      ...tracks.map(t => t.id).filter(id => !usedIds.has(id)),
    ]
    for (const id of leftover) {
      if (out.length >= target) break
      if (usedIds.has(id)) continue
      usedIds.add(id)
      out.push(id)
    }
  }

  return out.slice(0, target)
}

/** Shared weekly-cache + variety wrapper for all three persona pickers.
 *  `generate` runs the persona-specific Claude call and returns the raw
 *  { name, commentary, trackIds }. This wrapper owns the weekly-cache
 *  check, the variety pass, and persisting the result — so the three
 *  IPC handlers stay thin and can never drift on caching behavior. */
async function getOrGeneratePicks(
  persona: 'mm' | 'megan' | 'djhands',
  tracks: PicksTrack[],
  force: boolean,
  generate: () => Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }>,
): Promise<{ ok: boolean; name?: string; commentary?: string; trackIds?: number[]; error?: string }> {
  const currentWeek = weekStartFridayISO()
  if (!force) {
    const cache = await loadPicksCache()
    const hit = cache[persona]
    if (hit && hit.weekStart === currentWeek && Array.isArray(hit.trackIds) && hit.trackIds.length > 0) {
      // Same week → return the EXACT same list, no Claude call. This is
      // the "stop resetting" fix.
      return { ok: true, name: hit.name, commentary: hit.commentary, trackIds: hit.trackIds }
    }
  }
  const raw = await generate()
  if (!raw.ok || !raw.trackIds || raw.trackIds.length === 0) return raw
  const varied = enforcePicksVariety(raw.trackIds, tracks, 25)
  const entry: CachedPicksEntry = {
    weekStart: currentWeek,
    name: raw.name || '',
    commentary: raw.commentary || '',
    trackIds: varied,
  }
  await savePicksCacheEntry(persona, entry)
  return { ok: true, name: entry.name, commentary: entry.commentary, trackIds: entry.trackIds }
}

// Music Man daily picks
// 4.2.18: Picks are now WEEKLY — 25 tracks each, reset every Friday. The
// week-of framing replaces the "today's vibe" framing and makes the
// picks feel curated rather than churned. Friday-to-Friday matches how
// real station rotations work (new chart drops, weekly highlight reels).
function buildPicksInstructions(opts: { trackCount: number; persona: 'mm' | 'megan' }): string {
  const today = new Date()
  // Find Friday-of-this-week (or today if today IS Friday).
  // getDay(): 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  const day = today.getDay()
  const daysSinceFriday = (day - 5 + 7) % 7
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - daysSinceFriday)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)
  const startStr = weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  const endStr = weekEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const month = today.getMonth()
  const season = month <= 1 || month === 11 ? 'winter' : month <= 4 ? 'spring' : month <= 7 ? 'summer' : 'fall'

  const personaName = opts.persona === 'megan' ? 'Megan' : 'the Music Man'
  const isMegan = opts.persona === 'megan'

  // 4.4.2: per-persona LANE separation. Without this, MM and Megan keep
  // picking the same indie/contemporary tracks, both drift into Stephen
  // Hands' dance territory, and the three picks panels read as
  // overlapping rather than three distinct curatorial points of view.
  const laneRules = isMegan
    ? `MEGAN'S LANE — STAY IN IT:
You're a working music critic with broader taste than Music Man and less reverence for canon. Your picks come from:
  • Indie + indie-folk (Phoebe Bridgers, Big Thief, Adrianne Lenker, Snail Mail, Soccer Mommy, Fontaines D.C., Wednesday)
  • Contemporary critic territory — current records that are actually getting written about
  • Sharp left-field — jazz that's actually weird (Alice Coltrane, Don Cherry), post-punk's lesser-known second wave, contemporary R&B that doesn't crossover, ambient with ideas
  • Underrated singer-songwriter — Bill Callahan, Nick Cave, Cass McCombs, Joanna Newsom
  • Anything with sharp lyrics and arrangement substance
NOT YOUR LANE — leave to MM/Stephen:
  • Classic rock canon (Beatles, Stones, Floyd, Zeppelin) — Music Man's territory
  • Pure dance music, club tracks, hip-hop bangers — Stephen Hands' territory
  • Heritage prog, jazz-fusion-as-historical-deep-dive — Music Man's territory
You PICK things Music Man would side-eye — that's the point. You don't pick what he'd put on.`
    : `MUSIC MAN'S LANE — STAY IN IT:
You're a record-store-clerk-savant with deep canon knowledge. Your picks come from:
  • Classic rock canon — Beatles, Stones, Zeppelin, Floyd, Who, Doors, Hendrix, CSN&Y
  • Art rock + post-punk + new wave — Bowie, Eno, Talking Heads, Roxy Music, Television, Wire
  • Heritage jazz-as-listening — Coltrane, Mingus, Davis, Monk, Coleman
  • Steely Dan (yes always — your ride-or-die)
  • Singer-songwriter heritage — Joni, Dylan, Cohen, Van Morrison, Tom Waits
  • '70s soul, '60s soul, Stax / Motown / Hi
  • Prog with substance — King Crimson, Yes, Genesis-with-Gabriel
NOT YOUR LANE — leave to Megan/Stephen:
  • Contemporary indie / current critic-darlings — Megan's territory
  • Pure dance music, club tracks, hip-hop bangers, electronic — Stephen Hands' territory
  • Newer singer-songwriters — leave to Megan
You PICK from the canon and the deep-dives. You don't chase contemporary buzz.`

  return `It's the week of ${startStr} – ${endStr} (${season}). Build ${personaName}'s WEEKLY rotation — exactly ${opts.trackCount} tracks from the user's library that you stand behind for THIS WEEK. The list resets every Friday and runs Friday-through-Thursday.

${laneRules}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE #1 RULE — ARTIST VARIETY. READ THIS BEFORE YOU PICK ANYTHING.
A weekly rotation is a SPREAD, not a stack of albums. Aim for
${opts.trackCount} DIFFERENT artists — one track each. If the library is
thin in your lane, an artist may appear TWICE, never more.

  ✗ WRONG (this is the bug being fixed): 4 Talking Heads, then 3 Lou
    Reed, then 4 Steely Dan, then 4 Bowie. That is FOUR ALBUMS, not a
    rotation. It is lazy and it is exactly what you must NOT do.
  ✓ RIGHT: Talking Heads, Lou Reed, Steely Dan, Bowie, the Who,
    Television, Roxy Music, Coltrane, Joni Mitchell, … — each artist
    appearing once, the whole ${opts.trackCount} reading like a great
    radio hour where every song is a different world.

Before you return the JSON: count your artists. If any artist appears
3+ times, you have failed the assignment — go back and swap them out
for other artists in your lane. (The app also enforces this after the
fact, but a list that needs heavy enforcement isn't really your taste.)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your picks should also be shaped by:
- The week itself — the season, weather, news, cultural moments, anniversaries of famous albums/events landing in this 7-day window
- Your obsession-of-the-week — what you've been chewing on lately, in character
- Pacing across the week — these will be on rotation for 7 days, so build a list that holds up across morning coffee, afternoon work, evening wind-down

LIBRARY-AWARE FALLBACK: if the user's library doesn't have ${opts.trackCount} tracks in your strict lane, take what's CLOSEST to your lane — but stay AS FAR AS POSSIBLE from the other two personas' territory. You MUST return EXACTLY ${opts.trackCount} tracks. If you genuinely can't find ${opts.trackCount} in-lane, acknowledge it in the commentary ("Library was thin in my territory this week — these are the closest matches.").

Return ONLY a JSON object (no markdown, no code fences):
{"name":"creative weekly rotation name","commentary":"1-2 sentences, max 30 words total, about THE MUSIC IN THIS LIST — what it sounds like and who it is for. Name a band or two. NO musing about festivals, the news, the state of the library, or your own feelings. NO 'I will die on this hill'. NO throat-clearing. Say what is in here and stop.","trackIds":[array of exactly ${opts.trackCount} track ID numbers]}

Rules:
- ONLY use track IDs from the provided library
- EXACTLY ${opts.trackCount} track IDs in trackIds
- ★ ARTIST VARIETY (see the box above) — aim for ${opts.trackCount} distinct artists, max TWO per artist, NEVER three
- Reference the actual week (season / current moment / mood) so the list feels of-this-week, not generic
- Stay deeply in character — your fixed opinions show up in the picks themselves, not just the commentary`
}

// 4.4.48: thin handler — getOrGeneratePicks owns the weekly cache +
// variety pass. `force` (from the Regenerate button) bypasses the cache.
ipc.handle('musicman-picks', async (_event, tracks: PicksTrack[], force?: boolean) => {
  return getOrGeneratePicks('mm', tracks, !!force, async () => {
    // 4.5.0-89 — RAG candidate pool. Seed query frames Music Man's
    // lane: deep-cut record-store-savant picks spanning genres and
    // eras. K=400 so MM still gets eclectic variety to choose from.
    const { pool, used } = await buildRagPoolForPicks(
      'eclectic record-store deep cuts spanning genres rock pop hip-hop jazz funk soul electronic across decades',
      tracks,
      400,
    )
    if (used) console.log(`[musicman-picks] RAG pool: ${pool.length} candidates from ${tracks.length}`)
    const trackList = pool.map(t => `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}`).join('\n')
    const picksInstructions = buildPicksInstructions({ trackCount: 25, persona: 'mm' })
    // Force MM persona regardless of the user's default-host preference —
    // the user explicitly asked for Music Man's list under his name.
    const taste = buildTasteProfile()
    const systemPrompt = MUSIC_MAN_CORE + '\n\n' + picksInstructions
      + (taste ? `\n\nWhat you know about this listener:\n${taste}` : '')
    const chart = await getLastFmNyChart()
    const chartLine = formatLastFmChartForPrompt(chart)
    const userContent = `Build this week's picks.\n\nMy library (ID|Title|Artist|Album|Genre):\n${trackList}${chartLine ? `\n\nWeek context — ${chartLine} (Use this only as a 'what's the cultural moment' anchor — DO NOT pick from this list unless it's already in my library.)` : ''}`

    try {
      const response = await claudeCall('musicman-picks', {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.commentary) noteMusicManUtterance('picks', parsed.commentary)
        return { ok: true, name: parsed.name, commentary: parsed.commentary, trackIds: parsed.trackIds }
      }
      return { ok: false, error: 'Could not parse picks' }
    } catch (err: unknown) {
      const msg = safeIpcError(err, 'api-failed')
      return { ok: false, error: msg }
    }
  })
}, { refuse: REFUSED_SENDER })

// Megan's weekly picks — same structure as MM picks but uses MEGAN_CORE
// so her fixed contrarian opinions (Charli XCX overrated, Steely Dan
// cold, LCD Soundsystem unimpressive, Phoebe Bridgers' Stranger in the
// Alps over Punisher, etc.) shape what gets selected and how the
// commentary reads. 25 tracks, weekly Friday-to-Friday rotation.
ipc.handle('megan-picks', async (_event, tracks: PicksTrack[], force?: boolean) => {
  return getOrGeneratePicks('megan', tracks, !!force, async () => {
    // 4.5.0-89 — RAG pool biased toward Megan's lane: working-critic
    // perspective, newer / indie / contrarian / female-fronted. K=400
    // so her contrarian streak still has range to pull from.
    const { pool, used } = await buildRagPoolForPicks(
      'critic indie newer contemporary female-fronted alternative experimental contrarian deep cut',
      tracks,
      400,
    )
    if (used) console.log(`[megan-picks] RAG pool: ${pool.length} candidates from ${tracks.length}`)
    const trackList = pool.map(t => `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}`).join('\n')
    const picksInstructions = buildPicksInstructions({ trackCount: 25, persona: 'megan' })
    const taste = buildTasteProfile()
    const systemPrompt = MEGAN_CORE + '\n\n' + picksInstructions
      + (taste ? `\n\nWhat you know about this listener:\n${taste}` : '')
    const [chart, reviews] = await Promise.all([getLastFmNyChart(), getRecentReviews()])
    const chartLine = formatLastFmChartForPrompt(chart)
    const reviewsBlock = formatReviewsForPrompt(reviews)
    const userContent = `Build this week's picks.\n\nMy library (ID|Title|Artist|Album|Genre):\n${trackList}${chartLine ? `\n\n${chartLine}` : ''}${reviewsBlock ? `\n\n${reviewsBlock}\n\n(The press headlines are reaction context for the COMMENTARY — Megan can roast a Pitchfork take while she explains the picks. Do NOT pick tracks from these — pick only from MY library.)` : ''}`

    try {
      const response = await claudeCall('megan-picks', {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return { ok: true, name: parsed.name, commentary: parsed.commentary, trackIds: parsed.trackIds }
      }
      return { ok: false, error: 'Could not parse picks' }
    } catch (err: unknown) {
      const msg = safeIpcError(err, 'api-failed')
      return { ok: false, error: msg }
    }
  })
}, { refuse: REFUSED_SENDER })

// DJ Hands' weekly picks — beats / electronic / hip-hop forward. Same
// 25-track Friday-to-Friday weekly rotation as MM and Megan.
ipc.handle('dj-hands-picks', async (_event, tracks: PicksTrack[], force?: boolean) => {
 return getOrGeneratePicks('djhands', tracks, !!force, async () => {
  // 4.5.0-89 — RAG pool biased toward Stephen Hands' DJ lane (dance,
  // hip-hop, electronic, funk/soul with groove). Matches the YOUR
  // LANE block in his prompt below. K=400.
  const { pool, used } = await buildRagPoolForPicks(
    'house techno disco boogie club garage hip-hop drill trap drum-and-bass jungle dubstep footwork breakbeat funk soul groove sample dancefloor BPM-matched',
    tracks,
    400,
  )
  if (used) console.log(`[dj-hands-picks] RAG pool: ${pool.length} candidates from ${tracks.length}`)
  const trackList = pool.map(t => `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}`).join('\n')
  // Use the shared scaffolding but override the persona-name reference to
  // "DJ Hands" — buildPicksInstructions's persona arg only knows mm/megan,
  // so the prompt manually references DJ Hands here.
  const today = new Date()
  const day = today.getDay()
  const daysSinceFriday = (day - 5 + 7) % 7
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - daysSinceFriday)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)
  const startStr = weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  const endStr = weekEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const month = today.getMonth()
  const season = month <= 1 || month === 11 ? 'winter' : month <= 4 ? 'spring' : month <= 7 ? 'summer' : 'fall'

  const picksInstructions = `It's the week of ${startStr} – ${endStr} (${season}). Build DJ Stephen Hands' WEEKLY rotation — exactly 25 tracks from the user's library that you stand behind for THIS WEEK. Friday-to-Friday rotation.

YOUR LANE — STAY IN IT:
Stephen Hands picks ONLY from these veins. He is a DJ, not a music critic.
  • Dance — house, techno, disco, boogie, club, garage, electroclash
  • Hip-hop / rap — golden-era, club rap, drill, trap, party rap, sample-heavy boom-bap
  • Electronic — drum & bass, jungle, IDM-with-groove, dubstep, footwork, breakbeat, electronica
  • Funk + soul + R&B WITH A GROOVE — anything sampled, anything Larry Levan would have played, anything Madlib would have flipped
  • Anything DANCEABLE in the library, period. If it grooves, if it has a real beat, if it has a drum machine, if it samples, if you'd play it at a house party at 1 AM — it's in.

WHAT IS NOT YOUR LANE (these belong to Music Man and Megan, NOT you):
  • Singer-songwriter, folk, acoustic ballads — leave them to Megan and Music Man
  • Classic rock canon (Beatles, Stones, Zeppelin, Floyd, etc.) — Music Man's territory
  • Indie rock, indie folk, sad indie — Megan's territory
  • Country, classical, jazz-as-listening — none of you
  Don't pick "interesting drum programming" track if it's a Big Thief song. That belongs to Megan. You pick things that MOVE A ROOM.

LIBRARY-AWARE FALLBACK ORDER (use this exact priority — work TOP-DOWN):
  1. Pure-form dance / disco / club / hip-hop / electronic / techno / house — take everything you can find
  2. Funk / soul / R&B with strong rhythm — Sly Stone, James Brown, P-Funk, Stevie Wonder grooves, modern R&B with club energy
  3. Sample-heavy or drum-driven hip-hop, even older / underground — anything by a beatmaker
  4. Dance-leaning rock — Talking Heads "Once in a Lifetime", LCD Soundsystem, !!!, Tom Tom Club, anything that has an actual groove
  5. ANYTHING in the library with a real beat that someone could move to. If the library is mostly singer-songwriter, this might be all you get — that's fine, take what works.

You MUST return EXACTLY 25 tracks. If after exhausting tier 5 you still can't find 25, take whatever's closest to "rhythmic" and apologize for it in the commentary ("Library leans introspective — I dug what I could.").

Return ONLY a JSON object (no markdown, no code fences):
{"name":"creative weekly rotation name in Stephen Hands' voice — short, hype, party-forward (NOT cerebral)","commentary":"1-2 sentences max in DJ Stephen Hands' voice. He is NOT a man of many words. NO long explanations, NO genre-historian talk. Examples: 'Dance floor week. If it doesn't knock, it's not in here.' OR 'Library leans rock so I had to dig — these are the ones with pulse.' One thought, maybe two. STOP.","trackIds":[array of exactly 25 track ID numbers]}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE #1 RULE — ARTIST VARIETY. A set is a SPREAD, not a stack of albums.
  ✗ WRONG: 4 from one artist, then 4 from the next. That's lazy.
  ✓ RIGHT: 25 different artists, one banger each — a real DJ set where
    every track is a different record.
Max TWO per artist, NEVER three. Count before you return.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Rules:
- ONLY use track IDs from the provided library
- EXACTLY 25 track IDs (use the fallback tiers above to get there)
- ★ ARTIST VARIETY (see the box above) — aim for 25 distinct artists, max TWO per artist, NEVER three
- Commentary: 1-2 sentences. STOP.`

  const act2 = getActivityPromptBlockSync()
  const systemPrompt = withLibraryDigest(DJ_HANDS_CORE) + '\n\n' + picksInstructions
    + (act2 ? `\n\n${act2}\nLean the weekly rotation toward this activity when the library allows.` : '')
  const chart = await getLastFmNyChart()
  const chartLine = formatLastFmChartForPrompt(chart)
  const userContent = `Build this week's picks.\n\nMy library (ID|Title|Artist|Album|Genre):\n${trackList}${chartLine ? `\n\n${chartLine} (Pick from MY library only — this is just party-pulse context.)` : ''}`

  try {
    const response = await claudeCall('dj-hands-picks', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return { ok: true, name: parsed.name, commentary: parsed.commentary, trackIds: parsed.trackIds }
    }
    return { ok: false, error: 'Could not parse picks' }
  } catch (err: unknown) {
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, error: msg }
  }
 })
}, { refuse: REFUSED_SENDER })

// Music Man recommendations
ipc.handle('musicman-recommendations', async (_event, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => {
  // Build a compact library summary — top artists and genres, not every track
  const artistCounts = new Map<string, number>()
  const genreCounts = new Map<string, number>()
  const albumSet = new Set<string>()
  for (const t of tracks) {
    if (t.artist) artistCounts.set(t.artist, (artistCounts.get(t.artist) || 0) + 1)
    if (t.genre) genreCounts.set(t.genre, (genreCounts.get(t.genre) || 0) + 1)
    if (t.album && t.artist) albumSet.add(`${t.artist} - ${t.album}`)
  }
  // Brief 122 Phase 3b — the reco page "always suggested the same shit"
  // because it sent an IDENTICAL prompt every call (fixed top-40 artists,
  // fixed top-15 genres → near-deterministic output). Inject variety: a
  // shuffled/sampled taste seed drawn from a WIDER slice of the library, a
  // rotating "lens" each call, and higher temperature (below). No library,
  // metadata, or artwork is touched.
  const shuffle = <T,>(arr: T[]): T[] => {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  // Sample from the top ~60 (not just the absolute top 40) so successive
  // calls anchor on different corners of their library.
  const topArtists = shuffle(Array.from(artistCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 60))
    .slice(0, 25).map(([a, c]) => `${a} (${c})`).join(', ')
  const topGenres = shuffle(Array.from(genreCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15))
    .slice(0, 10).map(([g, c]) => `${g} (${c})`).join(', ')
  const albumList = Array.from(albumSet).sort().join('\n')

  const LENSES = [
    'deep cuts and lesser-known records they would never stumble onto themselves',
    'essential classics squarely in their wheelhouse that they are somehow missing',
    'recent / contemporary releases that fit their taste',
    'left-field picks that connect to their taste from an unexpected angle',
    'a focused deep-dive into ONE of their top genres',
    'artists one hop away from their favorites — collaborators, side projects, clear influences',
  ]
  const lens = LENSES[Math.floor(Math.random() * LENSES.length)]

  // 2026-08-15: critical lineage from Exa for two of this round's sampled
  // artists. The "one hop away" lens used to run on model memory alone;
  // journalism that explicitly names who the press compares to whom gives
  // the picks a real lineage to cite. Seeds rotate with the shuffle and
  // each artist is 7-day cached, so a lineage map of the library's heavy
  // rotation builds itself over a few weeks of use.
  const { exaSimilarArtists } = await import('./exa')
  const lineageSeeds = shuffle(Array.from(artistCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30))
    .slice(0, 2).map(([a]) => a)
  const lineageBlocks = (await Promise.all(lineageSeeds.map(a => exaSimilarArtists(a)))).filter(Boolean)
  const lineageBlock = lineageBlocks.length
    ? `\n\nCritical lineage notes from music journalism (who the press actually links to whom — mine these for connections, especially "one hop away" picks; never recite them):\n${lineageBlocks.join('\n\n')}`
    : ''

  const recsInstructions = `You've been asked to recommend albums that are NOT already in the user's library.

CRITICAL RULES:
- NEVER recommend albums/artists the user ALREADY HAS. Check the album list carefully.
- Recommend 8-12 albums. Mix well-known essentials they're missing with deeper cuts they'd never find on their own.
- Each recommendation should connect to something already in their library — explain WHY based on what they listen to.
- Prefer Bandcamp and independent releases when possible, but don't force it. Major label classics are fine too.
- If an album is a masterpiece, say so. If it's an acquired taste, warn them.
- Tag each with a source: "bandcamp" for indie/small label, "qobuz" for hi-res/audiophile, "streaming" for widely available.

Return ONLY a JSON array (no markdown, no code fences):
[{"title":"album title","artist":"artist name","year":2020,"genre":"genre tag","source":"bandcamp|qobuz|streaming","why":"1-2 sentences explaining why this fits their library, in character"}]

THIS ROUND, lean toward: ${lens}. Vary your picks from what you'd reflexively reach for — the user has seen the obvious recommendations before and is tired of the same handful of albums. Surprise them.

The user's top artists (a rotating sample of their library, not the full list): ${topArtists}
Their top genres: ${topGenres}${lineageBlock}`

  const systemPrompt = buildMusicManPrompt(recsInstructions)

  try {
    const response = await claudeCall('musicman-recs', {
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      // Brief 122 Phase 3b — crank temperature for variety so the page
      // stops returning the same picks every visit.
      temperature: 1,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Recommend albums I don't have.\n\nMy albums:\n${albumList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { title: string; artist: string; year?: number; genre: string; source: string; why: string; artUrl?: string }[]

      // Deterministic post-filter: the prompt asks the model to skip
      // albums the user already has, but it regularly fails at this
      // and then backpedals in the commentary ("You already have X —
      // scratch that, moving on"). Drop those.
      //
      // Identity-based dedup is the long-term goal (4.0 §2.2) but
      // requires MBID storage on Track which doesn't exist yet —
      // tracked as a follow-up. For now this is a smarter text matcher
      // that handles the failure modes the previous aggressive-strip
      // version missed:
      //   - parenthetical suffixes: "(Deluxe)", "[Remastered]", "(Live)"
      //   - abbreviation expansion: "Pt." ↔ "Part", "Vol." ↔ "Volume"
      //   - ampersand/and: "Simon & Garfunkel" ↔ "Simon and Garfunkel"
      //   - diacritics: "Beyoncé" ↔ "Beyonce"
      //   - articles: "The Beatles" ↔ "Beatles"
      //   - case + whitespace
      // It is NOT used for any destructive operation (deletion, sync
      // abort, overwriting). Filtering recommendations is non-destructive
      // — false positives just mean a rec is hidden, never that data
      // is lost. See CLAUDE.md "destructive operations may not gate on
      // text comparison" for context.
      //
      // ⚠️ Intentionally NOT shared with the file-identity normalize at
      // ~line 968 (twin-paired with core/repair_mismatches.py). That one
      // is for sync-time identity matching and any change must be
      // mirrored in Python. This one is local, non-destructive, and free
      // to evolve. Do not consolidate.
      const normForOwnership = (s: string): string => {
        if (!s) return ''
        return s
          .normalize('NFKD').replace(/[̀-ͯ]/g, '')      // strip diacritics
          .toLowerCase()
          .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ')            // drop ( ... ) and [ ... ]
          .replace(/\bpts?\b\.?/g, m => m.startsWith('pts') ? 'parts' : 'part')
          .replace(/\bvols?\b\.?/g, m => m.startsWith('vols') ? 'volumes' : 'volume')
          .replace(/\bno\.?\s*(\d)/g, 'number $1')                // "No. 1" → "number 1"
          .replace(/&/g, ' and ')
          .replace(/\bthe\b/g, ' ')
          .replace(/[^a-z0-9\s]/g, ' ')                           // strip remaining punct (no mid-word merging)
          .split(/\s+/).filter(Boolean).join(' ')
      }
      const ownedArtistAlbum = new Set<string>()
      const ownedArtist = new Set<string>()
      for (const t of tracks) {
        if (t.artist) ownedArtist.add(normForOwnership(t.artist))
        if (t.artist && t.album) ownedArtistAlbum.add(`${normForOwnership(t.artist)}|${normForOwnership(t.album)}`)
      }
      let droppedAsOwned = 0
      const cleaned = parsed.filter(rec => {
        const key = `${normForOwnership(rec.artist)}|${normForOwnership(rec.title)}`
        if (ownedArtistAlbum.has(key)) {
          droppedAsOwned++
          return false
        }
        return true
      })
      if (droppedAsOwned > 0) {
        console.log(`[recs] filtered ${droppedAsOwned} recommendation(s) the user already owns`)
      }
      // Strip any leftover self-correction phrases from commentary —
      // belt-and-suspenders in case the model still slips it in.
      for (const rec of cleaned) {
        if (!rec.why) continue
        rec.why = rec.why
          .replace(/^(you already (have|own)[^.]*\.\s*)+/i, '')
          .replace(/\s*(—|--)\s*(scratch that|wait|no|my mistake|moving on)[^.]*\./gi, '.')
          .replace(/\s*\(wait[^)]*\)\s*/gi, ' ')
          .trim()
      }

      // Fetch album art from Deezer for each recommendation (parallel, best-effort)
      await Promise.all(cleaned.map(async (rec) => {
        try {
          const aLo = rec.artist.toLowerCase().trim()
          const tLo = rec.title.toLowerCase().trim()
          const url = await searchDeezerArt(`${rec.artist} ${rec.title}`, aLo, tLo)
          if (url) rec.artUrl = url
        } catch { /* ignore art fetch failures */ }
      }))
      return { ok: true, recommendations: cleaned }
    }
    return { ok: false, error: 'Could not parse recommendations' }
  } catch (err: unknown) {
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, error: msg }
  }
}, { refuse: REFUSED_SENDER })

// Concert-owned track ids — unsyncable to the main iPod. ONE definition,
// used by BOTH sync-to-ipod (copy-time drop) and the workout-sync picker
// (pick-time exclusion). ⚠️ mirrors libraryHiddenTrackIds in
// src/renderer/liveSets.ts.
async function getConcertOwnedTrackIds(): Promise<Set<number>> {
  const sets = await liveSetsCache.get()
  const owned = new Set<number>()
  for (const e of Object.values(sets)) {
    owned.add(e.mergedTrackId)
    const promoted = new Set(e.promotedTrackIds || [])
    for (const c of e.cues) if (!promoted.has(c.trackId)) owned.add(c.trackId)
  }
  return owned
}

// Activity sync (Cursor branch) — builds the ≤1000-track iPod set from a brief
registerWorkoutSyncIpc({
  ipc,
  claudeCall,
  musicManCore: MUSIC_MAN_CORE,
  getIneligibleTrackIds: getConcertOwnedTrackIds,
})
// iPod Pool — the hand-built sync set (drag songs/albums/artists/playlists
// onto the sidebar row); build-workout-sync-set reads it in pool mode.
registerActivityPoolIpc(ipc)

// Mixtapes — songs → a real C60/C90/C120 cassette with Jake's voice on it
registerGaplessTrimIpc(ipc)
registerPlaylistCoverIpc(ipc, () => mainWindow)
registerMixtapesIpc({
  ipc,
  claudeCall,
  musicManCore: MUSIC_MAN_CORE,
  // Season tapes read the real listening record.
  loadLibraryTracks: async () => {
    const lib = (await libraryCache.get()) as { tracks?: Array<Record<string, unknown>> }
    return Array.isArray(lib.tracks) ? lib.tracks : []
  },
  loadPlayEvents: async () =>
    parsePlayEvents(await readFile(getPlayEventsPath(), 'utf-8').catch(() => '')),
  materializeTrack: (colonPath, trackId) => materializeLibraryTrack(colonPath, trackId),
})

// Music Man metadata scanner
ipc.handle('musicman-scan-metadata', async (_event, tracks: { id: number; title: string; artist: string; album: string; genre: string; year: string | number }[]) => {
  const trackList = tracks.map(t => `${t.id}|${t.title}|${t.artist}|${t.album}|${t.genre}|${t.year}`).join('\n')

  const scanInstructions = `You've been asked to scan a music library for metadata issues. Analyze the track list and find ALL issues. Categories:

1. **misspelling** — Artist or album names that are clearly misspelled (e.g., "Beetles" → "Beatles", "Radiohaed" → "Radiohead")
2. **inconsistent** — Same artist/album spelled differently across tracks (e.g., "RHCP" and "Red Hot Chili Peppers", "The Beatles" and "Beatles")
3. **generic** — Tracks with useless titles like "Track 01", "Track 1", "Audio Track", "Unknown Title" or blank titles
4. **missing** — Important fields that are empty or clearly wrong (blank artist, blank genre, year of 0)
5. **genre** — Genres that are obviously wrong or could be better (e.g., a punk band tagged as "Easy Listening")

Return ONLY a JSON array (no markdown, no code fences):
[{"type":"misspelling","trackIds":[1,2,3],"field":"artist","current":"Nirvanna","suggested":"Nirvana","commentary":"Come on. You had ONE job."},
{"type":"inconsistent","trackIds":[4,5],"field":"artist","current":"The Strokes","altTrackIds":[6,7],"altCurrent":"Strokes","suggested":"The Strokes","commentary":"Pick one and commit."},
{"type":"generic","trackIds":[8],"field":"title","current":"Track 01","suggested":"","commentary":"This isn't a title, it's a cry for help."},
{"type":"missing","trackIds":[9,10],"field":"genre","current":"","suggested":"","commentary":"Genre-less tracks are just lost souls."},
{"type":"genre","trackIds":[11,12],"field":"genre","current":"Other","suggested":"Alternative","commentary":"'Other' is not a genre, it's giving up."}]

Rules:
- ONLY flag issues you are CERTAIN about. If there's any doubt, skip it. No guessing. No maybes. False positives are worse than missed issues.
- Do NOT question whether a track title belongs to an artist. Many songs have been covered, re-recorded, or share names. "Wagon Wheel" by Lou Reed is real. Trust the library.
- Do NOT flag track titles as misspellings — titles are almost always correct. Focus misspelling detection on artist names and album names only.
- Do NOT flag the same track title appearing across DIFFERENT artists as "inconsistent". Common titles like "Untitled", "Intro", "Interlude", "Home", etc. are used by many artists independently. Only flag inconsistencies within the SAME artist (e.g., same artist has "The Night" and "the night").
- Do NOT flag artist names that are intentionally stylized (e.g., "CHVRCHES" is correct, "deadmau5" is correct, "k.d. lang" is correct)
- Do NOT flag genre disagreements unless the genre is clearly, objectively wrong (e.g., death metal tagged as "Children's Music")
- Do NOT suggest genre changes based on personal opinion — only flag truly incorrect genres
- For misspellings: only flag if you are 100% sure the spelling is WRONG and you know the correct one. If the name looks unusual but could be a real artist, skip it.
- For inconsistencies: only flag when the same real-world entity has different spellings (not when two different artists have similar names)
- Each issue should include a short, snarky commentary in character
- Include ALL affected track IDs for each issue
- For "inconsistent" issues, show both variants with trackIds and altTrackIds
- For "suggested" fixes, provide the correct value. If you're not sure of the fix, do NOT include the issue.
- Sort issues by severity (most impactful first)
- Return an empty array [] if there are no certain issues. That's fine.`

  const systemPrompt = buildMusicManPrompt(scanInstructions)

  try {
    const response = await claudeCall('musicman-scan-metadata', {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Scan this library for metadata issues.\n\nTracks (ID|Title|Artist|Album|Genre|Year):\n${trackList}` }]
    })
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const issues = JSON.parse(jsonMatch[0])
      return { ok: true, issues }
    }
    return { ok: false, error: 'Could not parse scan results' }
  } catch (err: unknown) {
    const msg = safeIpcError(err, 'api-failed')
    return { ok: false, error: msg }
  }
}, { refuse: REFUSED_SENDER })

// ── Restore iPod metadata from iTunes XML ──
async function runPythonRestore(args: string[], stdinData?: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const scriptPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'core/restore_from_xml.py')
  return new Promise((resolve) => {
    const py = spawn('python3', [scriptPath, ...args])
    let stdout = ''
    let stderr = ''
    py.on('error', (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ ok: false, error: 'Python 3 is not installed.' })
      } else {
        resolve({ ok: false, error: safeIpcError(err, 'tool-failed') })
      }
    })
    py.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    py.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    if (stdinData !== undefined) {
      // EPIPE-safe stdin write — see scheduleDbRebuild for why
      py.stdin.on('error', (err) => {
        resolve({ ok: false, error: `stdin write failed: ${safeIpcError(err, 'tool-failed')}` })
      })
      try {
        py.stdin.write(stdinData)
        py.stdin.end()
      } catch (err) {
        resolve({ ok: false, error: `stdin write threw: ${safeIpcError(err, 'tool-failed')}` })
      }
    }
    py.on('close', (code: number) => {
      if (code !== 0) {
        resolve({ ok: false, error: safeIpcError(`restore_from_xml.py exited with code ${code}: ${stderr}`, 'tool-failed') })
        return
      }
      try {
        resolve({ ok: true, data: JSON.parse(stdout) })
      } catch {
        resolve({ ok: false, error: safeIpcError(`Invalid JSON from restore_from_xml.py: ${stdout.slice(0, 200)}`, 'tool-failed') })
      }
    })
  })
}
// import-pick-files registered in ipc/import-ipc.ts

// Metadata overrides persistence — STATE_DIR-resolved (NAS or local).
function getOverridesPath(): string {
  return join(STATE_DIR, 'metadata-overrides.json')
}

// 4.5.0-77 — mobile-stars.json bridge.
//
// File lives next to library.json: `$userData/mobile-stars.json`,
// shape `{ "trackIds": ["5", "12", "37"] }`. Mobile backend wrote
// this first (Brief 054 in JakeTunesMobile); desktop now reads + writes
// the same file so star state is symmetric across both clients.
//
// Sync: ~/bin/jaketunes-homemini-sync.sh now pulls the Mini's copy
// after pushing the desktop copy, so phone-set stars land on the
// laptop within one sync cycle and desktop-set stars land on the
// phone backend's local file the same way.
//
// All writes go through a serialized single-flight chain so two
// rapid star clicks can't tear the file (each modifies the whole
// trackIds set + writes back).
function getMobileStarsPath(): string {
  return join(STATE_DIR, 'mobile-stars.json')
}

// 4.5.0-87 — RAG foundation: embedding-backed track retrieval. Lives
// in src/main/ai/embeddings.ts (binary format + cosine + OpenAI batch
// call). These IPCs are the desktop's interface:
//
//   embedding-status      — { configured, count, total } for Settings UI
//   embedding-backfill    — one-shot batch embed of every track that
//                           doesn't have an embedding yet. Emits
//                           `embedding-backfill-progress` events.
//
// Hook into musicman-chat: top-K retrieval over the user's question
// embedding REPLACES the pre-computed digest block when both flags
// align (USE_RAG_FOR_CHAT in buildMusicManPrompt + the user actually
// has embeddings for ≥80% of their library).
import {
  buildEmbeddingText as ragBuildEmbedText,
  embedTexts as ragEmbedTexts,
  getEmbeddingsMap as ragGetEmbeddingsMap,
  persistEmbeddingsMap as ragPersistEmbeddings,
  setEmbedding as ragSetEmbedding,
  topK as ragTopK,
  isEmbeddingsConfigured as ragIsConfigured,
  analyzeEmbeddings as ragAnalyzeEmbeddings,
  pruneStaleEmbeddings as ragPruneStaleEmbeddings,
  type EmbedTrackInput,
} from './ai/embeddings'
import {
  buildMoodText,
  getMoodIndexMap,
  setMoodVector,
  persistMoodIndex,
  pruneStaleMoodVectors,
} from './ai/mood-index'
import {
  DECADE_QUERY_RE,
  parseDecadeConstraint,
  yearInDecade,
} from './ai/decade-query'
import {
  parseOrbitSeed,
  resolveOrbitSeedIds,
  filterOrbitNeighbors,
} from './ai/orbit-quality'


// Tiny cosine k-means (Lloyd's, farthest-point init) to split a playlist's seed
// vectors into its distinct SUB-VIBES. Bounded + cheap (~60 seeds × k × 10 iters).
// Returns normalized cluster centroids. This is what lets a Brazilian-heavy but
// eclectic playlist still surface its electronic / hip-hop / disco corners.
// k-means + candidate scoring live in playlist-vibes.ts (pure, tested) —
// including the 2026-07-19 quality floor that stops outlier-song clusters
// from commanding a strip slot ("no reason why system of a down should be
// there" on a pool playlist).

// 4.5: brain-driven playlist suggestions. The old utils/playlistSuggest scored
// library tracks by ARTIST/genre/decade string-match — so it just surfaced more
// songs by the artists already on the playlist, and ↻ barely changed (it rotated
// a tiny artist-clustered pool). This returns the tracks most similar to the
// playlist's actual seed tracks instead — music that genuinely SOUNDS like it,
// regardless of artist. The renderer then filters for freshness (new artists,
// no same-album) + diversity. We return a generous pool so ↻ has real variety.
ipc.handle('playlist-similar', async (_e, playlistIds: number[], clusters: number = 5): Promise<{ ok: boolean; hits: Array<{ trackId: number; score: number; cluster: number }>; clusterSeeds?: number[] }> => {
  try {
    if (!Array.isArray(playlistIds) || playlistIds.length === 0) return { ok: false, hits: [] }
    const m = await ragGetEmbeddingsMap()
    if (m.size === 0) return { ok: false, hits: [] }
    const inPl = new Set(playlistIds)
    let seeds: Float32Array[] = []
    for (const id of playlistIds) { const v = m.get(id); if (v) seeds.push(v) }
    if (seeds.length === 0) return { ok: false, hits: [] }
    // Cap the seed set so a huge playlist can't blow up the scan.
    if (seeds.length > 60) {
      const step = seeds.length / 60
      const sampled: Float32Array[] = []
      for (let i = 0; i < 60; i++) sampled.push(seeds[Math.floor(i * step)])
      seeds = sampled
    }
    // Global-center penalty: down-weight tracks near the library's overall mean —
    // those generic "central" tracks were getting suggested for EVERY playlist.
    let gdim = 0, gn = 0
    let gc: Float32Array | null = null
    for (const vec of m.values()) {
      if (!gc) { gdim = vec.length; gc = new Float32Array(gdim) }
      for (let i = 0; i < gdim; i++) gc[i] += vec[i]
      gn++
    }
    if (gc && gn > 0) {
      let gnorm = 0
      for (let i = 0; i < gdim; i++) { gc[i] /= gn; gnorm += gc[i] * gc[i] }
      gnorm = Math.sqrt(gnorm) || 1
      for (let i = 0; i < gdim; i++) gc[i] /= gnorm
    }
    // Sub-vibe clustering + scoring + the outlier quality floor — see
    // playlist-vibes.ts for the design rules (and their history).
    function* candidateEntries(): Generator<[number, Float32Array]> {
      for (const e of m) { if (!inPl.has(e[0])) yield e }
    }
    const { hits, clusterSeeds } = scorePlaylistCandidates(seeds, candidateEntries(), gc, Math.max(1, Math.min(clusters, Math.floor(seeds.length / 3))))
    // Candidate DIVERSITY (2026-08-07, Jake: "it seems to only suggest
    // other songs by bands already in that playlist"): measured on Pool
    // Dos, 101 of 162 raw candidates were catalog-mates of the playlist's
    // own artists — an artist's other songs are always the nearest
    // embedding neighbors, so they flood the pools before variety gets a
    // seat. Balance each cluster's pool: max 2 candidates per artist, and
    // playlist-resident artists capped at ~25% of the pool. Relevance is
    // preserved (embedding-ranked walk); the strip finally breathes.
    const libForArtists = (await libraryCache.get() as { tracks?: Array<{ id: number; artist?: string; albumArtist?: string }> }).tracks ?? []
    const artistOf = new Map(libForArtists.map((t) => [t.id, String(t.albumArtist || t.artist || '').toLowerCase().trim()]))
    const plArtistSet = new Set(playlistIds.map((id) => artistOf.get(id)).filter(Boolean))
    const byClusterHits = new Map<number, typeof hits>()
    for (const h of hits) {
      const arr = byClusterHits.get(h.cluster) ?? []
      arr.push(h)
      byClusterHits.set(h.cluster, arr)
    }
    const balanced: typeof hits = []
    for (const arr of byClusterHits.values()) {
      arr.sort((a, b) => b.score - a.score)
      const perArtist = new Map<string, number>()
      const plCap = Math.max(6, Math.floor(arr.length * 0.25))
      let plCount = 0
      for (const h of arr) {
        const a = artistOf.get(h.trackId) || ''
        if ((perArtist.get(a) || 0) >= 2) continue
        const isPl = plArtistSet.has(a)
        if (isPl && plCount >= plCap) continue
        perArtist.set(a, (perArtist.get(a) || 0) + 1)
        if (isPl) plCount++
        balanced.push(h)
      }
    }
    return { ok: true, hits: balanced, clusterSeeds }
  } catch (err) {
    console.warn('[playlist-similar] failed:', err instanceof Error ? err.message : err)
    return { ok: false, hits: [], clusterSeeds: [] }
  }
}, { public: true })

// Settings → Library tab polls this on open. Without caching it re-reads
// library.json + loads the full embeddings.bin map every time — beach ball.
const EMBEDDING_STATUS_TTL_MS = 30_000
let embeddingStatusCache: {
  at: number
  value: { configured: boolean; count: number; total: number; stale: number }
} | null = null
function invalidateEmbeddingStatusCache(): void {
  embeddingStatusCache = null
}

ipc.handle('embedding-status', async (): Promise<{
  configured: boolean; count: number; total: number; stale: number;
}> => {
  const now = Date.now()
  if (embeddingStatusCache && now - embeddingStatusCache.at < EMBEDDING_STATUS_TTL_MS) {
    return embeddingStatusCache.value
  }
  let tracks: Array<{ id: number }> = []
  try {
    const lib = await libraryCache.get() as { tracks?: Array<{ id: number }> }
    tracks = (lib.tracks || []).filter(t => typeof t?.id === 'number')
  } catch { /* no library yet */ }
  const validIds = new Set(tracks.map(t => t.id))
  // Status read only — pruning runs on embedding-backfill, not on every
  // Settings open (prune persisted a 40+ MB file and blocked the main proc).
  const { indexed, stale } = await ragAnalyzeEmbeddings(validIds).catch(() => ({
    indexed: 0,
    stale: 0,
    missing: validIds.size,
  }))
  const value = { configured: ragIsConfigured(), count: indexed, total: tracks.length, stale }
  embeddingStatusCache = { at: now, value }
  return value
}, { public: true })

ipc.handle('embedding-backfill', async (event, opts?: { force?: boolean }): Promise<{ ok: boolean; embedded: number; total: number; error?: string }> => {
  if (!ragIsConfigured()) {
    return { ok: false, embedded: 0, total: 0, error: 'OPENAI_API_KEY not set. Add to .env to enable RAG.' }
  }
  try {
    const raw = await readFile(LIBRARY_PATH, 'utf-8')
    const lib = JSON.parse(raw) as { tracks?: Array<EmbedTrackInput & { id: number }> }
    const tracks = (lib.tracks || []).filter(t => typeof t?.id === 'number')
    const validIds = new Set(tracks.map(t => t.id))
    await ragPruneStaleEmbeddings(validIds).catch(() => 0)
    await pruneStaleMoodVectors(validIds).catch(() => 0)
    const existing = await ragGetEmbeddingsMap()
    const todo = opts?.force
      ? tracks
      : tracks.filter(t => !existing.has(t.id))
    if (todo.length === 0) {
      return { ok: true, embedded: 0, total: tracks.length }
    }
    // Send progress before kickoff so the UI flips to "embedding…" immediately.
    event.sender.send('embedding-backfill-progress', { done: 0, total: todo.length })
    const BATCH = 100
    let done = 0
    for (let i = 0; i < todo.length; i += BATCH) {
      const slice = todo.slice(i, i + BATCH)
      const texts = slice.map(ragBuildEmbedText)
      try {
        const vecs = await ragEmbedTexts(texts)
        for (let j = 0; j < slice.length && j < vecs.length; j++) {
          await ragSetEmbedding(slice[j].id, vecs[j])
        }
        // Persist after every batch so a mid-job crash doesn't lose
        // hours of API spend. The file is the source of truth; the
        // in-memory map mirrors it.
        await ragPersistEmbeddings()
        done += slice.length
        event.sender.send('embedding-backfill-progress', { done, total: todo.length })
      } catch (err) {
        console.warn('[embedding-backfill] batch failed (continuing with next):', err instanceof Error ? err.message : err)
      }
    }
    await moodIndexCatchup(tracks)
    const total = (await ragAnalyzeEmbeddings(validIds)).indexed
    invalidateEmbeddingStatusCache()
    return { ok: true, embedded: done, total }
  } catch (err) {
    return { ok: false, embedded: 0, total: 0, error: safeIpcError(err, 'api-failed') }
  }
}, { refuse: REFUSED_SENDER })

// 4.5: auto-index new songs into RAG. Jake wants EVERY imported track embedded
// automatically — not only when the nightly brain-trainer runs. This embeds any
// library track that has no vector yet (base embedding); the trainer then adds
// the sound/mood enrichment on its nightly pass. Cheap when there's nothing new
// (an in-memory membership check); bounded per pass. getEmbeddingsMap mtime-
// reloads, so it builds on the trainer's latest file rather than reverting it.
// Mood twin of the auto-index: give tracks missing a vibe vector one now
// (tempo+genre-only text for brand-new tracks — the nightly trainer
// upgrades the vector once the Gemma descriptor lands). Shared by
// autoIndexNewTracks and the embedding-backfill IPC; failures here never
// block the main index.
async function moodIndexCatchup(tracks: Array<EmbedTrackInput & { id: number }>): Promise<void> {
  try {
    const moodMap = await getMoodIndexMap()
    const moodTodo = tracks
      .map((t) => ({ t, text: buildMoodText(t) }))
      .filter(({ t, text }) => text && !moodMap.has(t.id))
      .slice(0, 300)
    for (let i = 0; i < moodTodo.length; i += 100) {
      const slice = moodTodo.slice(i, i + 100)
      const vecs = await ragEmbedTexts(slice.map((s) => s.text))
      for (let j = 0; j < slice.length && j < vecs.length; j++) await setMoodVector(slice[j].t.id, vecs[j])
      await persistMoodIndex()
    }
    if (moodTodo.length) console.log(`[mood-index] caught up ${moodTodo.length} track(s)`)
  } catch (err) {
    console.warn('[mood-index] catch-up failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * After Essentia (+ octave arbiter) lands BPM/key on a track, fold those
 * facts into embeddings.bin + mood-index.bin immediately. The import-time
 * auto-index often ran first with no tempo; waiting for nightly `teb`
 * left the brain tempo-blind for up to a day. Failures here never block
 * the analysis queue.
 */
async function reembedTracksAfterAnalysis(dispatches: AudioAnalysisDispatch[]): Promise<void> {
  if (!ragIsConfigured() || dispatches.length === 0) return
  try {
    const lib = (await libraryCache.get()) as { tracks?: Array<EmbedTrackInput & { id: number }> }
    const byId = new Map((lib.tracks || []).map((t) => [t.id, t]))
    const inputs: Array<EmbedTrackInput & { id: number }> = []
    for (const d of dispatches) {
      const base = byId.get(d.trackId)
      if (!base) continue
      inputs.push({
        ...base,
        bpm: d.bpm ?? base.bpm,
        keyRoot: d.keyRoot || base.keyRoot,
        keyMode: d.keyMode || base.keyMode,
        camelotKey: d.camelotKey || base.camelotKey,
        keyConfidence: d.keyConfidence ?? base.keyConfidence,
      })
    }
    if (inputs.length === 0) return
    const texts = inputs.map((t) => ragBuildEmbedText(t))
    const vecs = await ragEmbedTexts(texts)
    for (let i = 0; i < inputs.length && i < vecs.length; i++) {
      if (vecs[i]) await ragSetEmbedding(inputs[i].id, vecs[i])
    }
    await ragPersistEmbeddings()
    // Mood twin: overwrite vibe vector with tempo-bearing text (descriptor
    // may be absent until nightly — tempo alone is still a real upgrade).
    const moodEntries = inputs
      .map((t) => ({ t, text: buildMoodText(t) }))
      .filter((e) => e.text)
    if (moodEntries.length) {
      const mvecs = await ragEmbedTexts(moodEntries.map((e) => e.text))
      for (let i = 0; i < moodEntries.length && i < mvecs.length; i++) {
        if (mvecs[i]) await setMoodVector(moodEntries[i].t.id, mvecs[i])
      }
      await persistMoodIndex()
    }
    invalidateEmbeddingStatusCache()
    console.log(`[rag] re-embedded ${inputs.length} track(s) after audio analysis (tempo/key → brain)`)
  } catch (err) {
    console.warn('[rag] post-analysis re-embed failed:', err instanceof Error ? err.message : err)
  }
}

let autoIndexBusy = false
async function autoIndexNewTracks(): Promise<void> {
  if (!ragIsConfigured() || autoIndexBusy) return
  autoIndexBusy = true
  try {
    const lib = (await libraryCache.get()) as { tracks?: Array<EmbedTrackInput & { id: number }> }
    const tracks = (lib.tracks || []).filter((t) => typeof t?.id === 'number')
    const existing = await ragGetEmbeddingsMap()
    const todo = tracks.filter((t) => !existing.has(t.id) && (t.artist || t.title)).slice(0, 300)
    if (todo.length === 0) return
    let done = 0
    for (let i = 0; i < todo.length; i += 100) {
      const slice = todo.slice(i, i + 100)
      try {
        const vecs = await ragEmbedTexts(slice.map(ragBuildEmbedText))
        for (let j = 0; j < slice.length && j < vecs.length; j++) await ragSetEmbedding(slice[j].id, vecs[j])
        await ragPersistEmbeddings()
        done += slice.length
      } catch (err) {
        console.warn('[rag] auto-index batch failed:', err instanceof Error ? err.message : err)
      }
    }
    if (done) { console.log(`[rag] auto-indexed ${done} new track(s) into RAG`); invalidateEmbeddingStatusCache() }
    await moodIndexCatchup(tracks)
  } catch (err) {
    console.warn('[rag] auto-index failed:', err instanceof Error ? err.message : err)
  } finally {
    autoIndexBusy = false
  }
}


// 4.5.0-82 — per-play event log (true windowed counts).
//
// Until now the Top 25 "Last Week" / "Last Month" filter looked at
// `lastPlayedAt` to decide "played in window" but ranked by lifetime
// `playCount` — so a track played 500 times two years ago and once
// last week would dominate the Last Week list with 500. The comment
// in SmartPlaylistView spelled it out: "if we ever add per-play
// history we can compute true windowed play counts."
//
// Schema: newline-delimited JSON (jsonl). One line per play event:
//   {"id":<trackId>,"ts":<epochMs>}
// Append-only — never rewritten. Reading is a single full-file read +
// linear scan; bounded to ~1 KB per 50 plays so even a 10-year archive
// at a-track-per-day is ~7 MB, trivial.
function getPlayEventsPath(): string {
  return join(STATE_DIR, 'play-events.jsonl')
}
async function appendPlayEvent(trackId: number, ts: number): Promise<void> {
  try {
    const { appendFile } = await import('fs/promises')
    await appendFile(getPlayEventsPath(), `{"id":${trackId},"ts":${ts}}\n`, 'utf-8')
  } catch (err) {
    console.warn('[play-events] append failed:', err instanceof Error ? err.message : err)
  }
}
// ── Mobile-state reads ── (extracted to ipc/mobile-reads-ipc.ts, 6.0 Phase 1)
const mobileReadsApi = registerMobileReadsIpc(ipc, {
  getPlayEventsPath,
  libraryCache,
  mobileStarsCache,
  mobilePlaylistsCache,
  ragTrackYearMap,
  playlistAdditionsCache,
})


// Brief 122 — "Listen to the List". recommendations.json is a bare JSON
// array of Recommendation objects. The Mini backend (homemini) is the
// writer for phone adds; desktop reads/writes STATE_DIR/recommendations.json
// under local-primary (4.5.0-114). Phone picks never appeared on desktop
// because read-recommendations only read the local file (often missing)
// while the backend + NAS held the canonical list — sync on every read.
// Recommendations subsystem extracted to ipc/recommendations-ipc.ts (6.0 Phase 1).
const recoApi = registerRecommendations(ipc, {
  claudeCall,
  libraryCache,
  friendsCache: friendsCache as never,
})
const { readRecommendationsFile, syncRecommendationsToLocal, startRecoSyncTimer,
  runRecoResetV2IfNeeded, fetchCaaArtwork, recoRecordIdentityKey, recoIdentityKey } = recoApi


// ── Friend import credit: sweep + attribution ledger moved to
// friend-credit-sweep.ts (2026-08-28, the line-ratchet extraction, in the
// same change that added attribution credits — "lorin should get credit
// for the latest john mayer song that i imported"). Pure logic stays in
// friend-imports-core.ts.
const sweepDeps: import('./friend-credit-sweep.ts').SweepDeps = {
  readRecos: () => readRecommendationsFile() as unknown as Promise<Array<Record<string, unknown>>>,
  getTracks: async () => ((await libraryCache.get()) as { tracks?: Array<{ title?: string; artist?: string; albumArtist?: string; album?: string; dateAdded?: string }> }).tracks || [],
  updateFriends: (fn) => friendsCache.update(fn as never),
  creditsCache: friendCreditsCache,
}
const sweepFriendImports = (): Promise<number> => moduleSweepFriendImports(sweepDeps)
/**
 * Standings: friends ranked by deletion-aware points. Points are computed
 * fresh from credit records vs the live library on every call — nothing has
 * to fire when Jake deletes a song for the board to be right.
 *
 * Migration: credits earned before records existed (the bare `imported`
 * counters) become flat +1 "legacy" entries once, so history isn't erased —
 * but they carry no identity and can never go negative.
 */
// Taste ledger + weights extracted to ipc/taste-ipc.ts (6.0 Phase 1).
registerTasteIpc(ipc)
registerPreviewRefreshIpc(ipc)
registerSyncHistoryIpc(ipc, { stateDir: STATE_DIR })


ipc.handle('get-friend-standings', async () => {
  try {
    const ledger = await friendsCache.get()
    const store = await friendCreditsCache.get()
    const lib = (await libraryCache.get()) as { tracks?: Array<{ title?: string; artist?: string; albumArtist?: string; album?: string }> }

    const recorded = new Map<string, number>()
    for (const r of store.credits) {
      if (r.legacy) continue
      const k = r.friend.trim().toLowerCase()
      recorded.set(k, (recorded.get(k) ?? 0) + 1)
    }
    const legacyHave = new Set(store.credits.filter((r) => r.legacy).map((r) => r.recoId))
    const toMigrate: CreditRecord[] = []
    for (const [key, f] of Object.entries(ledger)) {
      const missing = (f.imported || 0) - (recorded.get(key) ?? 0)
      for (let i = 0; i < missing; i++) {
        const id = `legacy:${key}:${i}`
        if (legacyHave.has(id)) continue
        toMigrate.push({
          recoId: id, friend: f.name, kind: 'song',
          label: 'Imported before standings existed', creditedAt: '', legacy: true,
        })
      }
    }
    if (toMigrate.length > 0) {
      await friendCreditsCache.update((cur) => { cur.credits.push(...toMigrate); return cur })
    }

    const all = toMigrate.length > 0 ? (await friendCreditsCache.get()).credits : store.credits
    return { ok: true, standings: computeStandings(all, ledger, lib.tracks || []) }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}, { public: true })
ipc.handle('sweep-friend-imports', async () => ({ ok: true, credited: await sweepFriendImports() }), { refuse: REFUSED_SENDER })
setTimeout(() => { void sweepFriendImports() }, 30_000)
setInterval(() => { void sweepFriendImports() }, 5 * 60_000)

// ── Playlist hub (2026-08-28, final-form sync: "work like spotify") ──
// Converge with homemini quietly: on boot, every 10 minutes, and
// (debounced, via library-ipc) after every save. The hub's answer is
// adopted into the cache BEFORE the renderer hears about it, so the echo
// save diffs against already-adopted state. homemini down = quiet skip.
initPlaylistHubSync({
  hubUrl: MOBILE_BACKEND_URL,
  device: osHostname(),
  getPlaylists: () => playlistsCache.get() as Promise<HubPlaylistLike[]>,
  setPlaylists: (p) => { playlistsCache.set(p as unknown[]) },
  tombstonesFile: playlistTombstonesPath(STATE_DIR),
  pinsFile: playlistPinsPath(STATE_DIR),
  onApplied: (p) => { sendToRenderer('playlists-updated', { playlists: p }) },
})
setTimeout(() => { schedulePlaylistHubConverge(0) }, 45_000)
setInterval(() => { schedulePlaylistHubConverge(0) }, 10 * 60_000)

// Mixtape hub (same doctrine; tapes were the last ssh-synced collection).
// Voice audio heals through the hub's store in the same converge pass.
initMixtapeHubSync({
  hubUrl: MOBILE_BACKEND_URL,
  device: osHostname(),
  getMixtapes: () => readMixtapesForHub() as unknown as Promise<import('./mixtape-hub-sync.ts').HubTapeLike[]>,
  setMixtapes: (tapes) => writeMixtapesFromHub(tapes as never),
  tombstonesFile: mixtapeTombstonesFile(),
  introsDir: mixtapeIntrosDir(),
})
setTimeout(() => { scheduleMixtapeHubConverge(0) }, 60_000)
setInterval(() => { scheduleMixtapeHubConverge(0) }, 10 * 60_000)


// Album info + iTunes search extracted to ipc/album-info-ipc.ts (6.0 Phase 1).
registerAlbumInfoIpc(ipc)


ipc.handle('load-metadata-overrides', async () => {
  // 4.5.0-106: served from in-memory cache after first load (≤1ms vs the
  // 50-500ms NAS round-trip pre-cache). Cache is the source of truth from
  // the moment writeOverridesSerialized's synchronous mutate returns.
  //
  // 2026-08-07: phone-authored edits (mobile-metadata-overrides.json, same
  // {id: {fp, fields}} shape) OVERLAY the desktop's own overrides here.
  // Same-id entries field-merge when fingerprints agree — the phone's
  // albumArtist edit lands on top of the desktop's bpm/key analysis, not
  // instead of it. A mismatched fingerprint keeps the desktop entry: the
  // renderer would skip the stale-fp entry anyway, and desktop entries
  // carry analysis fields worth keeping. Desktop file is NEVER written
  // with phone entries — each device stays the single writer of its file.
  const base = await overridesCache.get() as Record<string, unknown>
  type OvEntry = { fp?: string; fields?: Record<string, string> }
  const merged: Record<string, unknown> = { ...base }
  try {
    const mobile = await mobileMetadataOverridesCache.get()
    for (const [id, entry] of Object.entries(mobile)) {
      if (!entry || typeof entry !== 'object' || !entry.fields) continue
      const cur = merged[id] as OvEntry | undefined
      if (!cur || !cur.fields) { merged[id] = entry; continue }
      if (cur.fp === entry.fp) merged[id] = { fp: cur.fp, fields: { ...cur.fields, ...entry.fields } }
    }
  } catch { /* phone overlay is best-effort; desktop overrides still serve */ }
  return { ok: true, overrides: merged }
}, { public: true })

// Save a metadata override for a single track.
//
// Fingerprint: iPod track IDs are assigned by parse order, so any change
// to the track set shifts IDs. An override stored by raw ID can silently
// re-target the wrong track. `fingerprint` is a stable signature
// ("title|artist|duration_ms") of the track AT THE TIME the override
// was saved; the renderer skips applying overrides whose fingerprint
// doesn't match the track currently sitting at that ID.
//
// Entry format on disk (v2):
//   { "<trackId>": { "fp": "<fingerprint>", "fields": { "<field>": "<value>" } } }
//
// Legacy format (v1, no fingerprint):
//   { "<trackId>": { "<field>": "<value>" } }
// Legacy entries are kept on disk but the renderer ignores them (can't
// validate), which is what we want after the wrong-overrides incident.
// Cynthia overhaul — the v2 fingerprint-merge write, extracted from the
// save-metadata-override handler so the background sweep's auto-apply
// goes through the IDENTICAL serialized pipeline (no twin logic). All
// semantics preserved verbatim: explicit fp mismatch wipes (re-parse
// safeguard), no-fp saves merge, fresh writes stamp the fp.
async function applyMetadataOverrideInternal(trackId: number, field: string, value: string, fingerprint?: string): Promise<void> {
  await writeOverridesSerialized((overrides) => {
    const key = String(trackId)
    const existing = overrides[key] as { fp?: string; fields?: Record<string, string> } | undefined
    const isV2 = !!existing && typeof existing === 'object' && 'fields' in existing
    const hasNewFp = typeof fingerprint === 'string' && fingerprint !== ''
    const existingFp = isV2 ? (existing!.fp || '') : ''
    if (isV2 && hasNewFp && existingFp && existingFp !== fingerprint) {
      // Explicit fingerprint mismatch — track at this ID has changed
      // identity (re-parse, library shift, etc). Old overrides don't
      // apply anymore; start fresh with just the new field.
      overrides[key] = { fp: fingerprint, fields: { [field]: value } }
    } else if (isV2) {
      // Same track (matching fp, or one side has no fp). MERGE — never
      // drop prior fields. Update fp only if a new one was passed.
      overrides[key] = {
        fp: hasNewFp ? fingerprint : existingFp,
        fields: { ...(existing!.fields || {}), [field]: value },
      }
    } else {
      // No prior entry — fresh write.
      overrides[key] = { fp: fingerprint || '', fields: { [field]: value } }
    }
    return overrides
  })
}

ipc.handle('save-metadata-override', async (_event, trackId: number, field: string, value: string, fingerprint?: string) => {
  const lockReason = isSaveLocked()
  if (lockReason) {
    console.warn(`[save-metadata-override] refused (saves locked): ${lockReason}`)
    return { ok: false, error: 'state-save-locked', reason: lockReason }
  }
  // 4.5.0-105 (option 3 perf): all the NAS-hitting work below — overrides
  // write, mobile-stars sidecar, artwork-key migration, tag writeback —
  // is wrapped in a fire-and-forget background block so the IPC returns
  // to the renderer immediately. Pre-fix every save blocked the UI for
  // the full SMB round-trip (100ms-1s). The serialized write chain still
  // preserves order across rapid saves; renderers update their state
  // optimistically so they don't need the synchronous round-trip.
  //
  // Routed through the serialized writer so this can't race with the
  // analysis worker's persistOverrideFields. Both go through the same
  // single-flight Promise chain — no shared tmp filename, no
  // interleaved writes, no lost updates.
  //
  // 4.4.5: merge logic rewritten to fix the metadata-cascade bug. Old
  // logic required `existing.fp === fingerprint` for merge — meaning
  // any save WITHOUT a fingerprint (Get Info modal, StarRating, bulk
  // rename) hit the else branch and OVERWROTE the whole entry,
  // wiping previously-set fields, playCount, skipCount, lastPlayedAt.
  // New logic: an explicit fingerprint MISMATCH still wipes (that's
  // the re-parse safeguard); a no-fingerprint save MERGES preserving
  // existing fields and keeping the existing fp; a matching
  // fingerprint or empty-fp existing entry merges as before.
  void (async () => {
  await applyMetadataOverrideInternal(trackId, field, value, fingerprint)
  // 4.4.18: metadata edits are a sync trigger — change a track's artist
  // on laptop, homemini reflects it within ~30 sec.
  triggerSync('metadata-edit')

  // 4.5.0-68: refresh the library digest when stats fields change
  // (rating / playCount / skipCount / artist / album / genre / year).
  // Pre-fix the digest was only refreshed on load-tracks + save-library
  // — meaning every star/play/skip during a session went into
  // listenerProfile but the digest's "signature albums" + per-artist
  // breakdown lagged reality until the next library save. AI chat then
  // talked about a snapshot from session start. Throttled to once per
  // ~1.5s so a rapid star-everything-in-an-album doesn't thrash. Reads
  // library.json directly (cheap; bounded).
  const STAT_FIELDS = new Set(['rating', 'playCount', 'skipCount', 'artist', 'album', 'genre', 'year'])
  if (STAT_FIELDS.has(field)) scheduleLibraryDigestRefresh()

  // 4.5.0-82 — per-play event log. lastPlayedAt is saved exactly once
  // per natural track-end (useAudio.ts:1221), so it's the right hook
  // for a one-event-per-play log. The log powers true windowed Top 25
  // counts ("Last Week" actually means "plays in the last 7 days,"
  // not "lifetime plays for tracks last touched in the last 7 days").
  if (field === 'lastPlayedAt') {
    const ts = Number(value)
    if (Number.isFinite(ts) && ts > 0) void appendPlayEvent(trackId, ts)
  }

  // 4.5.0-77 — mirror star state into mobile-stars.json sidecar so
  // the iOS app sees desktop-set stars and vice versa. Mobile already
  // writes its stars to the same file (Brief 054 in JakeTunesMobile);
  // pre-fix the desktop wrote ONLY to metadata-overrides.rating and
  // never to mobile-stars.json, so phone-side stars round-tripped
  // through ratings but desktop-set stars never reached the canonical
  // cross-device file. Now any rating override (this single handler
  // is the funnel for SongsView, ratingMenuEntries, AlbumsView,
  // Cynthia, hover-stars, future callers) updates the sidecar in the
  // same write: rating>0 adds the trackId, rating=0 removes it. The
  // sync script (jaketunes-homemini-sync.sh) replicates the file
  // bidirectionally to homemini, so both backends end up with the
  // same set of starred trackIds.
  if (field === 'rating') {
    // 4.5.0-92 — AWAITED (was `void` fire-and-forget). Pre-fix, when
    // the NAS sidecar write failed (brief unmount, permission glitch),
    // the rating field in metadata-overrides was already saved but
    // the mobile-stars.json sidecar lagged — state diverged silently.
    // Awaiting means the IPC reports failure to the renderer if the
    // sidecar fails, AND the serialized write chain inside
    // writeMobileStarSidecar gets to finish before save-metadata-
    // override returns. The chain itself catches its own errors and
    // logs, so this await never throws — worst case the IPC adds a
    // few ms of NAS round-trip.
    await mobileReadsApi.writeMobileStarSidecar(trackId, Number(value) > 0)
  }

  // 4.5.0-51: artwork-key migration on artist/album edit. When the user
  // changes a track's artist or album via Get Info, the existing JPG
  // file on disk is keyed by the OLD (artist, album) — without this
  // migration the cover orphans and the renderer can't find it under
  // the new tag combo. We copy the index entry to the new key (don't
  // delete the old — other tracks may still need it).
  //
  // 4.5.0-64: now AWAITED (was fire-and-forget) so the renderer's next
  // resolve-artwork IPC sees a consistent index — pre-fix, the modal
  // close → re-render → IPC ran before the migration finished, the IPC
  // returned null, and the renderer cached a negative result, leaving
  // the tile blank. Also registers a pending entry when the source key
  // isn't populated yet (import's extraction still running), so the
  // copy still happens once extraction completes.
  if (field === 'artist' || field === 'album') {
    try {
      // 4.5.0-106: both reads now hit the in-memory caches, no SMB.
      const lib = await libraryCache.get() as { tracks?: Array<Record<string, unknown>> }
      const track = (lib.tracks || []).find(t => t.id === trackId)
      if (track) {
        const overrides = await overridesCache.get()
        const existingOverrideFields = (overrides[String(trackId)] as { fields?: Record<string, string> } | undefined)?.fields || {}
        // Effective values BEFORE this save: library.json + any prior
        // overrides. Important — we want the previous effective artist/
        // album so the migration source key matches what was actually
        // used when the artwork was stored.
        const prevArtist = String(existingOverrideFields.artist ?? track.artist ?? '')
        const prevAlbum = String(existingOverrideFields.album ?? track.album ?? '')
        const newArtist = field === 'artist' ? value : prevArtist
        const newAlbum = field === 'album' ? value : prevAlbum
        if (prevArtist && prevAlbum && newArtist && newAlbum) {
          const oldKey = `${prevArtist.toLowerCase().trim()}|||${prevAlbum.toLowerCase().trim()}`
          const newKey = `${newArtist.toLowerCase().trim()}|||${newAlbum.toLowerCase().trim()}`
          if (oldKey !== newKey) {
            const index = await loadArtworkIndex()
            if (index[newKey]) {
              // Don't clobber an entry under the new key — that key may
              // already hold a different track's good cover. The user
              // edited INTO an existing (artist, album) combo, so they
              // get the cover that combo already had.
              console.log(`[artwork-migrate] "${newKey}" already populated; left untouched`)
            } else if (index[oldKey]) {
              index[newKey] = index[oldKey]
              await saveArtworkIndex(index)
              // 4.5.0-79 — also propagate the user-set LOCK to the new
              // key. Pre-fix the lock stayed on oldKey only; if the
              // user later re-imported a track at newKey, embedded-art
              // extraction would overwrite their custom art because
              // newKey had no lock entry. Keep oldKey locked too (other
              // tracks may still reference that artist/album combo).
              const locks = await loadArtworkLocks()
              if (locks.has(oldKey) && !locks.has(newKey)) {
                await setArtworkLock(newKey, true)
                console.log(`[artwork-migrate] propagated lock "${oldKey}" → "${newKey}"`)
              }
              console.log(`[artwork-migrate] copied "${oldKey}" → "${newKey}" after ${field} edit`)
            } else {
              // 4.5.0-64: source key doesn't exist YET. Race with import's
              // artwork extraction. Register a pending migration so
              // extractAndSaveEmbeddedArtwork mirrors the write into
              // newKey as soon as oldKey lands.
              const set = pendingArtworkMigrations.get(oldKey) ?? new Set<string>()
              set.add(newKey)
              pendingArtworkMigrations.set(oldKey, set)
              console.log(`[artwork-migrate] queued pending "${oldKey}" → "${newKey}" (source not in index yet)`)
            }
          }
        }
      }
    } catch (err) {
      console.warn('[artwork-migrate] failed (continuing):', err instanceof Error ? err.message : err)
    }
  }

  // Brief 020: write user-facing override fields into the audio file's
  // embedded tags so Plex (which reads tags directly, not our override
  // layer) sees the corrected value on its next scan. Fire-and-forget —
  // the override layer is the authoritative source; failing to write
  // the tag is a downstream propagation miss, not a correctness bug.
  // Skipped for analysis fields (bpm/keyRoot/etc.) and stats
  // (playCount/lastPlayedAt/skipCount) per WRITABLE_FIELDS gate.
  if (WRITABLE_FIELDS.has(field)) {
    void (async () => {
      try {
        const raw = await readFile(LIBRARY_PATH, 'utf-8')
        const lib = JSON.parse(raw) as { tracks?: Array<Record<string, unknown>> }
        const track = (lib.tracks || []).find(t => t.id === trackId)
        if (!track) return
        const colonPath = String(track.path || '')
        if (!colonPath) return
        // Fingerprint guard — same identity-gate the renderer uses
        // when applying overrides. If the track at this ID no longer
        // matches the fingerprint the override was saved with, don't
        // touch the file (different track, would write wrong tag).
        if (fingerprint) {
          const trackFp = `${String(track.title || '').toLowerCase().trim()}|${String(track.artist || '').toLowerCase().trim()}|${track.duration || 0}`
          if (trackFp !== fingerprint) {
            console.warn(`[tag-writeback] skipped trackId=${trackId} field=${field} — fingerprint mismatch (track identity changed)`)
            return
          }
        }
        const absPath = colonPathToAbsolute(colonPath, MUSIC_DIR)
        const overrides = augmentPairFields(field, value, track)
        const result = await writeTagsToFile({ audioFilePath: absPath, overrides })
        if (result.ok && result.fieldsWritten.length > 0) {
          console.log(`[tag-writeback] ${trackId} ${field}=${value} → ${absPath}${result.sidecarBackup ? ' (backed up)' : ''}`)
        } else if (!result.ok) {
          console.warn(`[tag-writeback] ${trackId} ${field} failed: ${result.error}`)
        }
      } catch (err) {
        console.warn(`[tag-writeback] hook error for trackId=${trackId} field=${field}:`, err instanceof Error ? err.message : err)
      }
    })()
  }
  })().catch((err) => {
    // 4.5.0-105: outer fire-and-forget block. Any unhandled error from
    // the background work lands here. The renderer has already moved on.
    console.warn(`[save-metadata-override] background work failed trackId=${trackId} field=${field}:`, err instanceof Error ? err.message : err)
  })

  return { ok: true }
}, { refuse: REFUSED_SENDER })

// Brief 020: batch backfill — push every existing override's writable
// fields into the corresponding audio files. Invoked from the
// "Library → Apply Overrides to Files…" menu after the user confirms.
//
// Process:
//   1. Read library.json + metadata-overrides.json from disk
//   2. For each override entry: validate fingerprint match against
//      the current library track; if mismatched, skip (track identity
//      changed). For each WRITABLE_FIELDS value present, build the
//      payload (with pair augmentation for trackNumber/discNumber).
//   3. Hand the list to writeTagsBatch which chunks at concurrency=8
//      and emits progress events.
//   4. Progress events relay to the renderer via
//      'tag-writeback:progress' so the UI can show a live counter.
//
// Returns a summary the renderer can show in the result toast/dialog.
ipc.handle('apply-overrides-batch', async (event) => {
  try {
    // 4.5.0-106: cached reads.
    const lib = await libraryCache.get() as { tracks?: Array<Record<string, unknown>> }
    const overrides = await overridesCache.get() as Record<string, { fp?: string; fields?: Record<string, string> }>
    const tracksById = new Map<number, Record<string, unknown>>()
    for (const t of lib.tracks || []) {
      if (typeof t.id === 'number') tracksById.set(t.id, t)
    }

    // Build the work list. Skip entries with:
    //   - no matching track in library
    //   - fingerprint mismatch (track identity changed since override)
    //   - no writable fields (analysis-only entries are the bulk
    //     of metadata-overrides.json; nothing to push to files)
    const requests: TagWriteRequest[] = []
    let skippedNoTrack = 0
    let skippedFpMismatch = 0
    let skippedNoWritable = 0
    for (const [keyStr, entry] of Object.entries(overrides)) {
      const trackId = Number(keyStr)
      if (!Number.isFinite(trackId)) continue
      const track = tracksById.get(trackId)
      if (!track) { skippedNoTrack++; continue }
      const fields = entry?.fields || {}
      // Filter to writable fields, augment pairs.
      const writable: Record<string, string | number> = {}
      for (const [fname, fval] of Object.entries(fields)) {
        if (WRITABLE_FIELDS.has(fname) && fval !== undefined && fval !== null && fval !== '') {
          writable[fname] = fval
        }
      }
      if (Object.keys(writable).length === 0) { skippedNoWritable++; continue }
      // Pair augmentation — preserve N/M format for trackNumber+trackCount
      // and discNumber+discCount when only one side is in overrides.
      if (writable.trackNumber && !writable.trackCount && track.trackCount) {
        writable.trackCount = String(track.trackCount)
      }
      if (writable.discNumber && !writable.discCount && track.discCount) {
        writable.discCount = String(track.discCount)
      }
      // Fingerprint guard
      const trackFp = `${String(track.title || '').toLowerCase().trim()}|${String(track.artist || '').toLowerCase().trim()}|${track.duration || 0}`
      if (entry.fp && entry.fp !== trackFp) {
        skippedFpMismatch++
        continue
      }
      const colonPath = String(track.path || '')
      if (!colonPath) { skippedNoTrack++; continue }
      const absPath = colonPathToAbsolute(colonPath, MUSIC_DIR)
      requests.push({ audioFilePath: absPath, overrides: writable })
    }

    console.log(`[tag-writeback] batch: ${requests.length} files to update (skipped: ${skippedNoTrack} no-track, ${skippedFpMismatch} fp-mismatch, ${skippedNoWritable} no-writable)`)

    const result = await writeTagsBatch(requests, (p) => {
      // Relay progress to the renderer for the live counter. Best-
      // effort — webContents may be null during shutdown / blur.
      try {
        event.sender.send('tag-writeback:progress', p)
      } catch { /* ignore */ }
    })

    // Brief 016 commit 2: tag writes can change the on-disk file size
    // (mutagen pads/shrinks the tag region by a few bytes to KB). If
    // we don't refresh library.json's cached fileSize, the mobile
    // probe v2 sees a fileSize mismatch and reports drift.
    //
    // Refresh only the tracks we just wrote. The wider library-wide
    // refresh (for pre-existing drift from other causes — likely the
    // historical "Fix iPod Compatibility" re-encode pass which cuts
    // ~515KB per track) is the separate `refresh-file-sizes` IPC.
    const refreshedPaths = new Set(
      result.results.filter(r => r.ok && r.fieldsWritten.length > 0).map(r => r.filePath)
    )
    let fileSizesRefreshed = 0
    if (refreshedPaths.size > 0) {
      fileSizesRefreshed = await refreshLibraryFileSizes((absPath) => refreshedPaths.has(absPath))
    }
    if (fileSizesRefreshed > 0) {
      console.log(`[apply-overrides-batch] refreshed fileSize on ${fileSizesRefreshed} tracks in library.json`)
    }

    return {
      ok: true,
      total: result.total,
      succeeded: result.succeeded,
      failed: result.failed,
      skippedNoTrack,
      skippedFpMismatch,
      skippedNoWritable,
      fileSizesRefreshed,
      // Don't ship the full per-file results array (could be 6k entries) —
      // the summary is enough for the UI. First 10 failures are useful
      // for diagnosis though.
      failures: result.results
        .filter(r => !r.ok)
        .slice(0, 10)
        .map(r => ({ filePath: r.filePath, error: r.error })),
    }
  } catch (err) {
    return {
      ok: false,
      error: safeIpcError(err, 'io-failed'),
    }
  }
}, { refuse: REFUSED_SENDER })

// Brief 016 commit 2: refresh `fileSize` in library.json by stat'ing
// the on-disk file for every track whose absolute audio-file path
// satisfies the predicate. Returns the count of entries actually
// changed.
//
// Read-modify-write — see Decision 8 in Brief 016: this is NOT atomic
// against concurrent save-library / save-playlist writes. The probability
// of collision is low (this fires only after explicit tag write-back or
// from a user-invoked menu item, not in background paths), and the
// failure mode if it collides is a single playlist edit silently
// overwritten. A follow-up brief introduces a real file lock if the
// race ever bites.
//
// Uses the same temp+rename + lastSelfWriteMtimeMs pre-stamp pattern
// as save-library so the fs watcher doesn't fire on our own write.
async function refreshLibraryFileSizes(
  shouldRefresh: (absPath: string) => boolean,
  onProgress?: (p: { scanned: number; refreshed: number; total: number }) => void,
): Promise<number> {
  let libRaw: string
  try {
    libRaw = await readFile(LIBRARY_PATH, 'utf-8')
  } catch (err) {
    console.warn(`[refresh-file-sizes] could not read library.json:`, err instanceof Error ? err.message : err)
    return 0
  }
  const libObj = JSON.parse(libRaw) as { tracks?: Array<Record<string, unknown>>; playlists?: unknown[] }
  const tracks = libObj.tracks || []
  let refreshed = 0
  let scanned = 0
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    const colonPath = String(t.path || '')
    if (!colonPath) continue
    const abs = colonPathToAbsolute(colonPath, MUSIC_DIR)
    scanned++
    if (!shouldRefresh(abs)) {
      if (onProgress && scanned % 200 === 0) onProgress({ scanned, refreshed, total: tracks.length })
      continue
    }
    try {
      const s = await stat(abs)
      const current = typeof t.fileSize === 'number' ? t.fileSize : 0
      if (current !== s.size) {
        ;(t as { fileSize: number }).fileSize = s.size
        refreshed++
      }
    } catch {
      // File missing or unreadable — skip. The audioMissing flag from
      // post-sync verification covers user-visible reporting; this
      // refresh stays read-only-on-skip.
    }
    if (onProgress && scanned % 200 === 0) onProgress({ scanned, refreshed, total: tracks.length })
  }
  if (onProgress) onProgress({ scanned, refreshed, total: tracks.length })
  if (refreshed === 0) return 0

  // Atomic write with watcher pre-stamp — same pattern save-library uses.
  // The pre-stamp before rename closes the race between fsWatch's stat
  // call and our stat() update of lastSelfWriteMtimeMs.
  lastSelfWriteMtimeMs = Date.now()
  const tmp = LIBRARY_PATH + '.partial.json'
  await writeFile(tmp, JSON.stringify(libObj, null, 2))
  const { rename: renameFS } = await import('fs/promises')
  await renameFS(tmp, LIBRARY_PATH)
  try {
    const s = await stat(LIBRARY_PATH)
    lastSelfWriteMtimeMs = Math.round(s.mtimeMs)
  } catch { /* non-fatal */ }
  return refreshed
}

// Brief 016 commit 2: full-library fileSize refresh. Reads every track,
// stats its actual on-disk file, updates library.json.fileSize if the
// stat differs from the cached value. Surfaced via the Library menu
// for one-shot retrofit of pre-existing drift (the 29.7% scan finding
// from Brief 016's diagnostic phase — likely from a historical "Fix
// iPod Compatibility" re-encode pass that cut ~515KB per track).
ipc.handle('refresh-file-sizes', async (event) => {
  try {
    const refreshed = await refreshLibraryFileSizes(
      () => true,
      (p) => {
        try { event.sender.send('refresh-file-sizes:progress', p) } catch { /* ignore */ }
      },
    )
    return { ok: true, refreshed }
  } catch (err) {
    return { ok: false, error: safeIpcError(err, 'unknown') }
  }
}, { refuse: REFUSED_SENDER })


// ── V5 Live Concert Mode ── (extracted to ipc/live-sets-ipc.ts, 6.0 Phase 1)
registerLiveSetsIpc(ipc, {
  getMusicDir: () => MUSIC_DIR,
  liveSetsCache,
  artworkHash,
  loadArtworkIndex,
  saveArtworkIndex,
})

// Artwork IPC extracted to ipc/artwork-ipc.ts (6.0 Phase 1).
registerArtworkIpc(ipc, {
  getMusicDir: () => MUSIC_DIR,
  sendToRenderer,
  getMount: () => detectedIpodMount,
  getMainWindow: () => mainWindow,
  liveSetsCache,
})

ipc.handle('get-track-lyrics', async (_e, trackId: number): Promise<{ ok: boolean; plain?: string; synced?: string; instrumental?: boolean }> => {
  try {
    const store = await lyricsCache.get()
    const rec = store[String(trackId)]
    if (!rec || rec.miss) return { ok: true }
    return { ok: true, plain: rec.plain, synced: rec.synced, instrumental: rec.instrumental }
  } catch {
    return { ok: true }
  }
}, { public: true })


// ── CD Drive Detection & Import ── (extracted to ipc/cd-ipc.ts, 6.0 Phase 1)
registerCdIpc(ipc, {
  getMusicDir: () => MUSIC_DIR,
  getMount: () => detectedIpodMount,
  computeAudioFingerprint,
  enqueueAnalysisForImportedTrack,
  enqueueStreamConvert,
  prewarmAlacCache: (paths) => prewarmAlacCache(paths),
  readStreamSource,
  registerKnownCodec: (path, mtime, codec) => registerKnownCodec(path, mtime, codec),
  sendToRenderer,
})

// ── Audio output + call watch ── (extracted to ipc/audio-output-ipc.ts, 6.0 Phase 1)
registerAudioOutputIpc(ipc, { sendToRenderer })

app.whenReady().then(async () => {
  // Brief 011b: resolve MUSIC_DIR before anything else. IPC handlers and
  // inbox-watcher callbacks can fire as soon as the renderer attaches;
  // they read MUSIC_DIR through closures, so the value must be correct by
  // the time any handler runs. resolveMusicDir falls back to the default
  // if nothing matches — it never throws.
  MUSIC_DIR = await resolveMusicDir()

  // Renovation P1C1: hand the import pipeline its world. Suppliers for the
  // mutable roots; everything Electron-flavoured stays on this side.
  initImportPipeline({
    musicDir: () => MUSIC_DIR,
    libraryPath: () => LIBRARY_PATH,
    defaultImportFormat: async () => {
      const settings = await readAppSettingsAsync()
      return (settings?.library as { defaultImportFormat?: string } | undefined)?.defaultImportFormat
    },
    computeAudioFingerprint,
    setCodecForPath: (abs, codec) => { codecByAbsPath.set(abs, codec) },
    extractEmbeddedArtwork: (pictures, artist, album) =>
      extractAndSaveEmbeddedArtwork(pictures as ParsedPicture[] | undefined, artist, album),
    readStreamSource,
    enqueueStreamConvert: (colonPath, fp, at) => { void enqueueStreamConvert(colonPath, fp, at) },
    enqueueAnalysis: (track) => { enqueueAnalysisForImportedTrack(track) },
    prewarmAlacCache,
    trashItem: (abs) => shell.trashItem(abs),
    emitToRenderer: (channel, payload) => { sendToRenderer(channel, payload) },
  })

  // ── Pass-through eviction (2026-08-15, Jake: "files i download are not
  // stored here"). The laptop STAGES imports; homemini + the NAS keep them.
  // Once homemini's copy of a file hashes byte-identical to ours (which
  // proves both propagation hops — homemini can only have it by pulling
  // from the NAS after our push), the local copy moves to Trash. Gates,
  // tests and the full design rationale live in library-eviction.ts.
  const runEvictionSweep = async (): Promise<SweepResult> => {
    const empty: SweepResult = {
      examined: 0, tooYoung: 0, notInLibrary: 0, notOnHomemini: 0,
      hashMismatch: 0, evicted: 0, evictedBytes: 0, errors: 0,
    }
    if (syncEngine.isSyncInFlight()) {
      console.log('[evict] skipped — iPod sync in flight (copy source must stay)')
      return empty
    }
    const { readdir: rd, stat: st, appendFile: af } = await import('fs/promises')
    const result = await sweepOnce({
      listLocalAudio: async () => {
        const out: Array<{ abs: string; rel: string; mtimeMs: number; sizeBytes: number }> = []
        let fdirs: string[] = []
        try { fdirs = (await rd(MUSIC_DIR)).filter((d) => /^F\d\d$/.test(d)) } catch { return out }
        for (const fd of fdirs) {
          let names: string[] = []
          try { names = await rd(join(MUSIC_DIR, fd)) } catch { continue }
          for (const name of names) {
            if (!/\.(m4a|mp3|aac|alac|aiff|aif|wav)$/i.test(name)) continue
            const abs = join(MUSIC_DIR, fd, name)
            try {
              const info = await st(abs)
              out.push({ abs, rel: `${fd}/${name}`, mtimeMs: info.mtimeMs, sizeBytes: info.size })
            } catch { /* raced away — skip */ }
          }
        }
        return out
      },
      libraryRelPaths: async () => {
        const rels = new Set<string>()
        try {
          const raw = await readFile(LIBRARY_PATH, 'utf-8')
          const lib = JSON.parse(raw) as { tracks?: Array<{ path?: string }> }
          for (const t of lib.tracks || []) {
            const cp = String(t.path || '')
            // Colon-format library path → F##/file, the shape the walk emits.
            const m = cp.match(/:iPod_Control:Music:(F\d\d):([^:]+)$/)
            if (m) rels.add(`${m[1]}/${m[2]}`)
          }
        } catch { /* unreadable library = evict nothing this pass */ }
        return rels
      },
      remoteMd5Batch: async (rels) => {
        // One ssh for the whole batch. Filenames are app-generated
        // (imported_N.ext) — no spaces, no shell hazards; the F-dir/name
        // shape is validated by the walk above.
        const base = 'Music/JakeTunesLibrary/iPod_Control/Music'
        const list = rels.map((r) => `${base}/${r}`).join('\n')
        const { execFile } = await import('child_process')
        const out = await new Promise<string>((resolveP, rejectP) => {
          const child = execFile('ssh',
            ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', 'jakerosenbaumnas@homemini',
              `while IFS= read -r p; do [ -f "$HOME/$p" ] && echo "$p|$(md5 -q "$HOME/$p")"; done`],
            { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout) => err && !stdout ? rejectP(err) : resolveP(String(stdout)))
          child.stdin?.write(list + '\n')
          child.stdin?.end()
        })
        const map = new Map<string, string>()
        for (const line of out.split('\n')) {
          const bar = line.lastIndexOf('|')
          if (bar < 0) continue
          const remotePath = line.slice(0, bar)
          const md5 = line.slice(bar + 1).trim()
          if (remotePath.startsWith(base + '/') && /^[a-f0-9]{32}$/.test(md5)) {
            map.set(remotePath.slice(base.length + 1), md5)
          }
        }
        return map
      },
      trash: (abs) => shell.trashItem(abs),
      journal: async (line) => {
        const { appendFile: append } = await import('fs/promises')
        await append(join(app.getPath('userData'), 'evictions.log'), line + '\n', 'utf-8')
      },
      now: () => Date.now(),
      shouldAbort: () => syncEngine.isSyncInFlight(),
    })
    if (result.evicted > 0 || result.errors > 0) {
      console.log(`[evict] examined=${result.examined} evicted=${result.evicted} (${(result.evictedBytes / 1e6).toFixed(1)}MB) young=${result.tooYoung} noLib=${result.notInLibrary} noRemote=${result.notOnHomemini} mismatch=${result.hashMismatch} errors=${result.errors}`)
    }
    void af
    return result
  }
  // First sweep 5 minutes after boot (let the app settle), then hourly.
  // Batches are bounded, so a large backlog drains gradually by design.
  // sweepOnce() is designed never to throw — these catches are tripwires.
  setTimeout(() => { void runEvictionSweep().catch((err) => console.warn('[eviction] sweep threw (designed impossible):', err)) }, 5 * 60 * 1000)
  setInterval(() => { void runEvictionSweep().catch((err) => console.warn('[eviction] sweep threw (designed impossible):', err)) }, 60 * 60 * 1000)
  ipc.handle('library-evict-sweep', async () => {
    try { return { ok: true, result: await runEvictionSweep() } }
    catch (err) { return { ok: false, error: safeIpcError(err, 'io-failed') } }
  }, { refuse: REFUSED_SENDER })
  console.log(`[library] MUSIC_DIR resolved to: ${MUSIC_DIR}`)
  // Streaming/cache-farm machines (workmini): fail loud at boot if homemini
  // is down, instead of discovering it as "stuck at 0:00" with no error.
  void probeHomeminiReachability()
  // 4.5.0-114 — local SSD is canonical; NAS is async backup mirror only.
  const nasUp = await nasAvailable()
  console.log(`[state] storage mode: ${STATE_IS_NAS ? 'NAS' : 'local-primary'} — dir=${STATE_DIR}${nasUp ? ` (NAS backup mirror at ${NAS_STATE_DIR_PATH})` : ` (NAS backup unavailable — ${NAS_STATE_DIR_PATH} not mounted)`}`)
  // Bug #1 fix — NAS-reconnect watcher. Only arms when we booted into
  // local-fallback. If NAS later becomes reachable, saves get locked
  // to prevent overwriting NAS state with stale in-memory snapshots.
  // The renderer gets `state-save-locked` so it can surface a banner
  // telling the user to restart.
  startNasReconnectWatcher((reason) => {
    try {
      sendToRenderer('state-save-locked', { reason })
    } catch { /* renderer may not be mounted yet — the lock is still active */ }
  })
  // 4.5.0-91 Phase 2.5 — orphaned-edit detection. When the user makes
  // edits while NAS is unmounted (local-fallback mode), those writes
  // go to userData. Next launch with NAS mounted: app reads NAS,
  // ignores the newer local edits, silently overwrites them on next
  // save. This scan compares local-userData mtimes against NAS for
  // each state file. Any file where local is meaningfully newer
  // (>60s gap to filter timestamp jitter) gets logged + recorded in
  // stateConflicts so Settings → Library can surface a "Push local
  // edits to NAS" button rather than auto-overwriting either side.
  // Compare local canonical state against the NAS backup mirror when
  // Synology is reachable — surfaces divergence even in local-primary mode.
  // Non-blocking: SMB stat storm before first paint caused launch beach balls.
  if (nasUp) {
    void autoBackupStateToNas().catch((err) => {
      console.warn('[state] boot auto-backup failed (non-fatal):', err instanceof Error ? err.message : err)
    })
  }
  // 4.5: keep the NAS backup current automatically — re-check + push every 2 min
  // in the background, so local edits (including the nightly brain enrichment)
  // mirror to the NAS without ever surfacing a "go push it" banner.
  setInterval(() => { void autoBackupStateToNas() }, 120_000)
  // 4.5: auto-index new songs into RAG (Jake: "every new song to auto index").
  // Boot + every 30s — embeds anything imported that lacks a vector, so RAG /
  // mixes / chat can use it within seconds, not at the nightly trainer pass.
  void autoIndexNewTracks()
  setInterval(() => { void autoIndexNewTracks() }, 30_000)
  // Brief 122 — warm recommendations.json from homemini/NAS so "Listen to
  // the List" isn't empty when the phone wrote picks the laptop never pulled.
  // Brief 126 — the one-time reset runs FIRST (scrub stray-migration residue
  // from the outbox, drop the frozen legacy tombstone file, force a clean
  // mirror), then the 60s freshness timer keeps every device converged.
  void (async () => {
    await runRecoResetV2IfNeeded()
    await syncRecommendationsToLocal().catch((err) => {
      console.warn('[reco] boot sync failed (non-fatal):', err instanceof Error ? err.message : err)
    })
    startRecoSyncTimer()
  })()

  // 4.4.85: seed the codec-hint map BEFORE the ipod-audio:// protocol
  // handler registers so the very first play in this session can use it.
  // Depends on MUSIC_DIR (resolved just above) for the colon-path -> abs
  // conversion.
  await loadCodecMapFromLibrary()

  // Stage 3: resume any pending stream-conversions from a prior session (a
  // track imported just before quit whose homemini propagation hadn't landed
  // yet). No-op unless streamSource is 'homemini' and the queue is non-empty.
  if ((await readStreamSource()) === 'homemini' && (await readStreamConvertQueue()).length) {
    ensureStreamConvertWorker()
    void runStreamConvertPass(Date.now())
  }

  // 4.5.0-117: one library snapshot per launch (Phase 0 backup/restore).
  // Fire-and-forget; skips an empty library.
  void snapshotLibrary('launch')

  // 4.2.5: bootstrap the cached host preference so the very first
  // prompt build of the session picks the user's chosen persona,
  // not the 'mm' module-default.
  await refreshActiveHostFromSettings()

  // ── Purge renderer caches on version change ──
  // When the user installs a new DMG over an old one, Electron keeps
  // the previous Session Storage + Local Storage from the old
  // renderer. Combined with new main-process code, that stale cache
  // showed up as "library empty" on first launch after an install,
  // forcing the user to quit + relaunch or manually clear session
  // storage. This purge happens BEFORE createWindow so the renderer
  // starts from a clean slate whenever the app binary changed.
  try {
    const versionFile = join(app.getPath('userData'), '.last-version')
    const currentVersion = app.getVersion()
    let prevVersion: string | null = null
    try { prevVersion = (await readFile(versionFile, 'utf-8')).trim() } catch { /* first launch */ }
    if (prevVersion !== currentVersion) {
      console.log(`[launch] version changed (${prevVersion} → ${currentVersion}) — purging renderer cache + stale knowledge caches`)
      const { rm, readdir, unlink } = await import('fs/promises')
      for (const dir of ['Session Storage', 'Local Storage']) {
        await rm(join(app.getPath('userData'), dir), { recursive: true, force: true }).catch((err) => console.warn(`[reset] could not remove ${dir}:`, err?.message ?? err))
      }
      // 4.5.0-72 — also nuke the wiki cache + artist-image .miss
      // tombstones on every version change. Bugs in earlier versions
      // (-66 silently writing extract=null after a transient lookup
      // failure; -65 30-day photo-miss tombstones) poisoned these
      // caches for thousands of artists. Version bumps reset the
      // playing field — real misses repopulate within hours, real
      // hits are still cheap to refetch on first view. Keep JPG hits
      // intact so we don't redownload every artist photo on every
      // build.
      try { await rm(join(app.getPath('userData'), 'wiki-cache'), { recursive: true, force: true }) } catch { /* nothing to clean */ }
      try {
        const aiDir = join(app.getPath('userData'), 'artist-images')
        const entries = await readdir(aiDir).catch(() => [] as string[])
        let purged = 0
        for (const name of entries) {
          if (name.endsWith('.miss')) {
            await unlink(join(aiDir, name)).catch(() => {})
            purged++
          }
        }
        if (purged > 0) console.log(`[launch] purged ${purged} artist-image .miss tombstones`)
      } catch { /* nothing to clean */ }
      // Also nuke the canonical-artist-cache so MB-resolved entries
      // get a fresh look — protects against any wrong-entity picks
      // that got cached in the -66/-71 development window.
      try { await rm(join(app.getPath('userData'), 'canonical-artist-cache'), { recursive: true, force: true }) } catch { /* nothing to clean */ }
      // 4.5.0-74 — also nuke discography-cache. Pre-fix, MB
      // discography responses cached for 7 days included compilation
      // and live release-groups (the secondary-types filter wasn't
      // present until -66). Beatles' "Yesterday and Today" + similar
      // US-comp leaks persisted past the filter ship date because
      // existing cache files were never invalidated. From now on,
      // any version bump re-fetches with the current filter rules.
      try { await rm(join(app.getPath('userData'), 'discography-cache'), { recursive: true, force: true }) } catch { /* nothing to clean */ }
      await writeFile(versionFile, currentVersion, 'utf-8').catch(() => {})
    }
  } catch (err) {
    console.warn('[launch] version-change cache purge failed (non-fatal):', err)
  }

  // Brief 010: restore any queued audio-analysis jobs from disk, then
  // kick the worker. If queue is empty, kicker is a no-op (worker
  // exits immediately on empty queue). If non-empty, worker drains as
  // soon as playback is inactive (the 5-second debounce inside the
  // worker itself handles the gate).
  await loadQueueFromDisk()
  kickAudioAnalysisWorker()

  // Load listener profile for Music Man (sync, tiny file)
  loadListenerProfile()
  // Warm the activity brain context (last iPod sync brief + place weather)
  void loadActivityBrainContext()

  // Serve album artwork images — register before createWindow so the
  // renderer's first paint can resolve album-art:// URLs.
  registerPlaylistCoverProtocol()
  protocol.handle('album-art', async (request) => {
    const url = request.url.replace('album-art://', '')
    const [pathPart, queryPart] = url.split('?')
    const rawHash = decodeURIComponent(pathPart.replace('.jpg', ''))
    // Strip cache-bust suffix (e.g. "abc123_1713100000000" → "abc123")
    const hash = rawHash.replace(/_\d+$/, '')
    // The hash is joined onto the artwork dir below, so it must be one of OUR
    // keys and not a path. Unvalidated, `album-art://..%2F..%2Fsecret.jpg`
    // walks straight out of the cache directory.
    if (!isSafeCacheKey(hash)) {
      console.warn('[album-art] refused key:', hash.slice(0, 80))
      return new Response('Forbidden', { status: 403 })
    }
    // Thumbnail tier (2026-07-08, "art loads sporadically"): grid cells
    // were decoding the FULL cover (median ~400KB, some multi-MB) into
    // 150px tiles, dozens at a time — the pop-in. `?s=NNN` serves a
    // ~15KB thumb, generated once via nativeImage and cached on disk in
    // artwork/thumbs. Full-size stays for heroes / Get Info / export.
    const sMatch = /(?:^|&)s=(\d+)/.exec(queryPart || '')
    const size = sMatch ? Math.min(1024, Math.max(64, parseInt(sMatch[1], 10))) : 0
    const cacheKey = size ? `${hash}@${size}` : hash
    const artHeaders = {
      'Content-Type': 'image/jpeg',
      // Versioned hash in the URL busts browser cache on art change;
      // long max-age makes scroll-back instant within a session.
      'Cache-Control': 'public, max-age=31536000, immutable',
    }
    const cached = getCachedArtBytes(cacheKey)
    if (cached) return new Response(cached, { headers: artHeaders })
    const fullPath = join(getArtworkDir(), `${hash}.jpg`)
    try {
      let data: Buffer
      if (size) {
        const thumbDir = join(getArtworkDir(), 'thumbs')
        const thumbPath = join(thumbDir, `${hash}_${size}.jpg`)
        try {
          data = await readFile(thumbPath)
        } catch {
          // Generate once: decode full art, downscale, persist. Some
          // covers defeat nativeImage (mislabeled PNGs, exotic JPEGs —
          // e.g. a 7.7MB not-actually-a-jpg found in the wild): fall back
          // to serving the ORIGINAL bytes, which Chromium decodes fine —
          // a thumb miss must never 404 art that used to display.
          const full = await readFile(fullPath)
          try {
            const img = nativeImage.createFromBuffer(full)
            if (img.isEmpty()) throw new Error('undecodable art')
            const thumb = img.resize({ width: size, quality: 'good' }).toJPEG(82)
            data = thumb
            await mkdir(thumbDir, { recursive: true }).catch(() => {})
            void writeFile(thumbPath, thumb).catch(() => {})
          } catch {
            data = full
          }
        }
      } else {
        data = await readFile(fullPath)
      }
      // Buffer<ArrayBufferLike> doesn't satisfy BodyInit's stricter
      // ArrayBuffer constraint under the latest @types/node — slice into
      // a fresh ArrayBuffer so the body is unambiguously sized memory
      // backed by a real ArrayBuffer.
      const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      putArtBytes(cacheKey, body)
      return new Response(body, { headers: artHeaders })
    } catch {
      return new Response('Not found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
  })

  // 4.4.40 — Serve cached artist photos. URLs look like
  // `artist-image://{slug}.jpg`. The slug is already filename-safe
  // (artistSlug strips everything except [a-z0-9-]) so we just read
  // from disk; no traversal possible.
  protocol.handle('artist-image', async (request) => {
    const url = request.url.replace('artist-image://', '')
    const raw = decodeURIComponent(url.split('?')[0].replace('.jpg', ''))
    const slug = raw.replace(/[^a-z0-9-]/g, '')
    if (!slug) {
      return new Response('Bad slug', { status: 400 })
    }
    const filePath = join(getArtistImageDir(), `${slug}.jpg`)
    try {
      const data = await readFile(filePath)
      return new Response(data as unknown as BodyInit, {
        headers: {
          'Content-Type': 'image/jpeg',
          // Long cache — slug is unique per artist; disk-side TTL handles refresh
          'Cache-Control': 'public, max-age=604800',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  // Thumbnail pregeneration (2026-07-08): build the 320px tier for every
  // cover once, in the background, so grids never pay a first-scroll
  // generation cost. ~2.4k covers × ~15ms nativeImage decode+resize,
  // spaced 40ms apart ≈ a few gentle minutes, one time; subsequent boots
  // skip existing thumbs in one readdir. Runs well after boot so it never
  // competes with startup.
  setTimeout(() => {
    void (async () => {
      try {
        const artDir = getArtworkDir()
        const thumbDir = join(artDir, 'thumbs')
        await mkdir(thumbDir, { recursive: true })
        const [arts, thumbs] = await Promise.all([readdir(artDir), readdir(thumbDir)])
        const have = new Set(thumbs)
        const todo = arts.filter((f) => /^[^.].*\.jpg$/.test(f) && !have.has(f.replace(/\.jpg$/, '_320.jpg')))
        if (todo.length === 0) return
        console.log(`[art-thumbs] pregenerating ${todo.length} thumbnail(s) in background`)
        let made = 0
        for (const f of todo) {
          try {
            const full = await readFile(join(artDir, f))
            const img = nativeImage.createFromBuffer(full)
            if (!img.isEmpty()) {
              const thumb = img.resize({ width: 320, quality: 'good' }).toJPEG(82)
              await writeFile(join(thumbDir, f.replace(/\.jpg$/, '_320.jpg')), thumb)
              made++
            }
          } catch { /* skip corrupt art */ }
          await new Promise((r) => setTimeout(r, 40))
        }
        console.log(`[art-thumbs] pregeneration done: ${made}/${todo.length}`)
      } catch (err) {
        console.warn('[art-thumbs] pregeneration failed:', err instanceof Error ? err.message : err)
      }
    })()
  }, 25_000)

  // 2026-07-08 — the "it is still spinning" capture: the freeze trap
  // recorded the RENDERER suspended for 114 seconds (heartbeat staircase
  // draining at 02:38:43) while main idled in its event loop. Under
  // memory pressure macOS doesn't just throttle an occluded app (what
  // the 4.2.13 playback-scoped blocker guards during audio) — it
  // SUSPENDS its processes wholesale, and returning to the app reads as
  // a long beachball. A music library app lives half its life covered
  // by other windows: hold an app-LIFETIME suspension blocker. Display
  // sleep is unaffected; this only opts out of App Nap / app suspension.
  //
  // 2026-08-04 — released once the app is genuinely idle.
  //
  // The note above is right that display sleep is unaffected, but stops one
  // line short: 'prevent-app-suspension' is a NoIdleSleep assertion, so it also
  // stops the MACHINE idle-sleeping. On macOS closing the last window does not
  // quit, so JakeTunes could sit windowless holding that assertion for as long
  // as it was left open — found exactly that way: zero windows, nothing
  // playing, the Mac unable to idle-sleep.
  //
  // What this guards is a SUSPENDED RENDERER you come back to. With no window
  // there is no renderer to suspend, so the assertion buys nothing and costs
  // sleep. Released when the last window closes, re-taken on activate.
  startLifetimeSuspensionBlocker()

  // Show the window before heavy startup IO (artwork self-heal, memory
  // loads, ipod-audio handler registration). Splash + library load give
  // us ~3s before playback needs ipod-audio://.
  createWindow()
  registerMediaKeyShortcuts()
  startLibraryWatcher()

  void (async () => {
    try {
      await selfHealUserLockedArtwork()
      const locks = await loadArtworkLocks()
      const idx = await loadArtworkIndex()
      console.log(`[artwork] loaded ${locks.size} user-locked covers · ${Object.keys(idx).length} total index entries · dir=${getArtworkDir()}`)
    } catch (err) {
      console.warn('[artwork] startup load failed:', err)
    }
    // Hand the persona memory its dependencies before the first read.
    initPersonaMemory({ cache: musicmanMemoryCache, userDataDir: app.getPath('userData') })
    await loadMusicManMemory().catch((err) => console.warn('[persona] Music Man memory failed to load (starting blank):', err?.message ?? err))
    await loadCynthiaMemory().catch((err) => console.warn('[persona] Cynthia memory failed to load (starting blank):', err?.message ?? err))
    fetchDiscogsCollection()
  })()

  // Cynthia overhaul — start the background sweep 30s after boot (out of
  // the launch hot path), once the library cache is warm. Idle-gated on
  // playbackActive inside the worker; queue persists across restarts.
  setTimeout(() => {
    void libraryCache.get()
      .then(() => startCynthiaSweep(buildCynthiaSweepHooks()))
      .catch((err) => console.warn('[cynthia-sweep] boot failed:', err instanceof Error ? err.message : err))
  }, 30_000)

  // Play cache (6.0 caches seam, 2026-09-02): the lossless transcode cache
  // is a STATE OBJECT now — src/main/play-cache.ts owns the dir, in-flight
  // coalescing, the codec probe cache and the 20 GB cap (unit-tested there,
  // which this closure never was). Serving policy stays in the ipod-audio://
  // handler below, where the stream-playback-path locks can see it. Local
  // names are kept so the handler and the maintenance IPCs read as before.
  const playCache = createPlayCache({ dir: join(app.getPath('userData'), 'play-cache') })
  // One media load, one byte stream — see play-cache-serve-pin.ts.
  const servePin = createServePin()
  await playCache.ensureDir()
  const PLAY_CACHE = playCache.dir
  const aacCachePath = playCache.cachePathFor
  const cacheNameFor = playCache.entryFor
  prewarmAlacCache = playCache.prewarm
  registerKnownCodec = playCache.registerKnownCodec

  // ── 4.1 Library Maintenance: ALAC cache management ─────────────────
  //
  // Replaces the launch-time `schedulePrewarmFromLibrary` scan. Both are
  // user-initiated from the Library Maintenance modal and run in the
  // foreground with explicit progress reporting so the user knows what
  // they triggered and can cancel.

  // Cancel signal: the renderer can ping `cancel-alac-cache` to stop
  // an in-flight prepare loop early. Set inside the handler, cleared on
  // exit. Single shared flag — only one prepare loop runs at a time.
  let prepareCacheCancelled = false
  ipcMain.on('cancel-alac-cache', () => { prepareCacheCancelled = true })

  ipc.handle('prepare-alac-cache', async (event) => {
    prepareCacheCancelled = false
    const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
    const pathSep = IS_WINDOWS ? '\\' : '/'

    let lib: { tracks?: Array<{ path?: string; title?: string; artist?: string }> }
    try {
      lib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8'))
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
    const tracks = lib.tracks || []
    const total = tracks.length

    // 4-worker pipeline. Each worker pulls the next track index, calls
    // aacCachePath (which ffprobes once per source, codec-caches it,
    // and only spawns ffmpeg for actual ALAC sources whose cache entry
    // is missing or stale), and emits progress. AAC tracks return
    // immediately from aacCachePath without any ffmpeg work — the only
    // unavoidable cost is the per-file ffprobe on first encounter.
    let processed = 0
    let transcoded = 0
    let i = 0

    const worker = async (): Promise<void> => {
      while (i < tracks.length) {
        if (prepareCacheCancelled) return
        const idx = i++
        const t = tracks[idx]
        const colon = t?.path || ''
        if (!colon) {
          processed++
          continue
        }
        const abs = join(LOCAL_MOUNT, colon.replace(/:/g, pathSep))
        const srcStat = await stat(abs).catch(() => null)
        if (!srcStat) {
          processed++
          continue
        }

        // Was the cache already fresh BEFORE this call? Need to know
        // so we can report "transcoded" honestly (not just "had cache").
        // Same naming rule as aacCachePath, or the count lies.
        const { file: cachePath } = cacheNameFor(abs, srcStat.size, srcStat.mtimeMs)
        const cBefore = await stat(cachePath).catch(() => null)
        const wasFresh = !!cBefore && cBefore.size > 0

        const cacheRet = await aacCachePath(abs, srcStat.mtimeMs, srcStat.size).catch(() => null)
        processed++
        if (cacheRet && !wasFresh) transcoded++

        event.sender.send('prepare-alac-cache:progress', {
          processed,
          transcoded,
          total,
          title: t.title || '?',
          artist: t.artist || '?',
        })
      }
    }

    const workers: Promise<void>[] = []
    for (let w = 0; w < 4; w++) workers.push(worker())
    await Promise.all(workers)

    return {
      ok: true,
      processed,
      transcoded,
      total,
      cancelled: prepareCacheCancelled,
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('scan-dead-tracks', async () => {
    try {
      let lib: { tracks?: Array<Record<string, unknown>> }
      lib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8'))
      const tracks = lib.tracks || []
      // Verify against every existing music root (resolved/default/legacy/
      // explicit/iPod), not just the one resolveMusicDir picked — a file under
      // ANY mount keeps the track alive. See candidateMusicMounts.
      const mounts = await candidateMusicMounts()
      const inputs: VerifyTrackInput[] = tracks.map((t) => ({
        id: Number(t.id || 0),
        path: String(t.path || ''),
        duration: Number(t.duration || 0),
        audioFingerprint: typeof t.audioFingerprint === 'string' ? t.audioFingerprint : undefined,
      }))
      const updates = await verifyAndHealTracks(inputs, mounts)
      const deadIds = new Set(updates.filter((u) => u.audioMissing).map((u) => u.id))
      const deadTracks = tracks
        .filter((t) => deadIds.has(Number(t.id)))
        .map((t) => ({
          id: Number(t.id),
          title: String(t.title || ''),
          artist: String(t.artist || ''),
          path: String(t.path || ''),
        }))
      return { ok: true, count: deadTracks.length, tracks: deadTracks.slice(0, 20) }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { public: true })

  ipc.handle('remove-dead-tracks', async (_e) => {
    try {
      const lib: { tracks?: Array<Record<string, unknown>>; playlists?: unknown[] } =
        JSON.parse(await readFile(LIBRARY_PATH, 'utf-8'))
      const tracks = lib.tracks || []
      // Verify across ALL existing music roots — a track is dead only if its
      // audio is absent from every mount (and its fingerprint can't be found).
      const mounts = await candidateMusicMounts()
      const inputs: VerifyTrackInput[] = tracks.map((t) => ({
        id: Number(t.id || 0),
        path: String(t.path || ''),
        duration: Number(t.duration || 0),
        audioFingerprint: typeof t.audioFingerprint === 'string' ? t.audioFingerprint : undefined,
      }))
      const updates = await verifyAndHealTracks(inputs, mounts)
      const deadIds = new Set(updates.filter((u) => u.audioMissing).map((u) => u.id))
      if (deadIds.size === 0) return { ok: true, removed: 0 }

      // ── Environmental safety net (workmini 7,447→7,182 incident) ──
      // The per-track check above is identity-based (exact path + fingerprint),
      // but a wrong/incomplete/unmounted music root makes it fail uniformly and
      // turns a clean-up into a mass silent deletion. Refuse to write when the
      // "missing" signal is untrustworthy. See reconcile-guard.ts.
      let diskAudioCount = 0
      for (const m of mounts) {
        diskAudioCount += (await walkAudioFilesUnder(join(m, 'iPod_Control', 'Music'))).length
      }
      const guard = assessDeadTrackRemoval({
        totalTracks: tracks.length,
        deadCount: deadIds.size,
        mountsChecked: mounts.length,
        diskAudioCount,
      })
      if (!guard.safe) {
        console.warn(`[remove-dead-tracks] REFUSED (${guard.reason}): ${guard.message}`)
        return { ok: false, error: guard.message, reason: guard.reason, deadCount: deadIds.size }
      }

      // Back up library.json before mutating (parity with the CLI twin), then
      // write atomically (tmp + rename) so a torn write can't leave a partial.
      const prevCount = tracks.length
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      try {
        await copyFile(LIBRARY_PATH, `${LIBRARY_PATH}.bak-dead-${stamp}`)
      } catch (e) {
        console.warn('[remove-dead-tracks] backup copy failed (proceeding):', e instanceof Error ? e.message : e)
      }
      lib.tracks = tracks.filter((t) => !deadIds.has(Number(t.id)))
      const removed = prevCount - lib.tracks.length
      const tmp = `${LIBRARY_PATH}.dead-remove.tmp`
      await writeFile(tmp, JSON.stringify(lib, null, 2))
      // Pre-stamp before the rename so the fsWatch handler treats this as our
      // own write (matches save-library's ordering).
      lastSelfWriteMtimeMs = Date.now()
      const { rename: renameFS } = await import('fs/promises')
      await renameFS(tmp, LIBRARY_PATH)
      try {
        const s = await stat(LIBRARY_PATH)
        lastSelfWriteMtimeMs = Math.round(s.mtimeMs)
      } catch { /* non-fatal */ }
      libraryCache.invalidate()
      void mirrorLibraryToNas(lib)
      console.log(`[remove-dead-tracks] removed ${removed} dead track(s) (${prevCount}→${lib.tracks.length}); backup library.json.bak-dead-${stamp}`)
      return { ok: true, removed }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'unknown') }
    }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('prune-alac-cache', async () => {
    // Delete cache entries whose hashed source path doesn't match any
    // current library track. After 4.0.x rounds of import / dedup /
    // path-collision-cleanup, the cache typically has hundreds of
    // orphaned transcodes from tracks that no longer exist in the
    // library. Each entry is ~3-10MB so the savings add up fast.
    const LOCAL_MOUNT = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
    const pathSep = IS_WINDOWS ? '\\' : '/'

    let lib: { tracks?: Array<{ path?: string }> }
    try {
      lib = JSON.parse(await readFile(LIBRARY_PATH, 'utf-8'))
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }

    // Build the set of path hashes still claimed by a library track.
    //
    // ⚠️ TWIN: cacheNameFor() above owns the naming rule. Match on the PATH
    // HASH PREFIX, never on a whole filename — cache files are
    // <pathHash>-<contentTag>.m4a, and an exact-name test written against the
    // old <pathHash>.m4a format silently classifies every single entry as an
    // orphan and wipes the whole 21 GB cache. Prefix matching survives the
    // content tag changing, which is the entire point of the tag.
    //
    // Both roots: a track's audio can live on library.streamRoot (the NAS)
    // rather than locally, and the cache is keyed on whichever path was
    // actually served.
    const roots = [LOCAL_MOUNT]
    const sRoot = await readStreamRoot()
    if (sRoot) roots.push(sRoot)
    const expected = new Set<string>()
    for (const t of (lib.tracks || [])) {
      const colon = t.path || ''
      if (!colon) continue
      for (const r of roots) {
        const abs = join(r, colon.replace(/:/g, pathSep))
        expected.add(createHash('sha1').update(abs).digest('hex').slice(0, 16))
      }
    }

    const { readdir } = await import('fs/promises')
    let entries: string[]
    try {
      entries = await readdir(PLAY_CACHE)
    } catch {
      return { ok: true, pruned: 0, bytesFreed: 0 }
    }

    let pruned = 0
    let bytesFreed = 0
    for (const f of entries) {
      if (!f.endsWith('.m4a') && !f.endsWith('.flac')) continue   // cache holds both eras
      if ([...expected].some((h) => isEntryFor(f, h))) continue
      const fp = join(PLAY_CACHE, f)
      const s = await stat(fp).catch(() => null)
      if (s) bytesFreed += s.size
      await unlink(fp).catch(() => {})
      pruned++
    }
    return { ok: true, pruned, bytesFreed }
  }, { refuse: REFUSED_SENDER })

  // Streaming migration helpers (trackIdForAbsPath / fetchAudioFromHomemini /
  // HOMEMINI_AUDIO_BASE) were hoisted to module scope (near trackFarmPath) so
  // the ingestion-redirect and download/pin paths can share them. See there.

  protocol.handle('ipod-audio', async (request) => {
    const rawPath = decodeURIComponent(request.url.replace('ipod-audio://', ''))
    const playCacheDir = join(app.getPath('userData'), 'play-cache')
    const localMountRoot = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
    const homeminiClient = await isHomeminiPlaybackClientCached()

    // ── homemini FIRST, before any filesystem call ────────────────────────
    // Jake, 2026-08-10: "it doesnt play... NON FUCKING STOP", on a machine
    // where the same track plays one minute and hangs the next.
    //
    // Everything that follows can touch the disk: resolveContainedPath calls
    // realpath(), the streamRoot fallback calls existsSync(), the streamed-
    // track test calls lstat(). On workmini those paths are SYMLINKS into an
    // SMB mount to the house, and that mount wedges — measured, repeatedly:
    // a directory listing took 203 seconds while the app sat in
    // uninterruptible state. Those calls then block in the kernel and the
    // request never returns. It did not matter that the bytes were going to
    // come from homemini anyway; we never got far enough to ask.
    //
    // That is the whole random-looking failure: whether a song plays depends
    // on whether the mount happens to be wedged in that instant, not on the
    // song. It is also why the phone never had this problem — it only ever
    // talks to homemini over HTTP and touches no mount.
    //
    // Engaged when streamSource=homemini OR streamRoot is set (workmini
    // cache-farm). The July 2026 gate that kept streamRoot machines on NAS
    // playback was the hang. trackIdForAbsPath only stats library.json on
    // the LOCAL disk. Nothing here can touch the NAS.
    if (homeminiClient) {
      const streamId = await trackIdForAbsPath(rawPath)
      if (streamId == null) {
        console.warn('[ipod-audio] streaming client but no library id for', rawPath.slice(0, 120))
      } else {
        const wantsFlac = wantsHomeminiFlac(rawPath)
        const early = await fetchAudioFromHomemini(
          streamId, request.headers.get('range'), wantsFlac,
        )
        if (early) return early
        // Homemini miss on FLAC: one more try as raw (AAC .m4a wrongly routed
        // to ?fmt=flac, or homemini flac cache wedged). Raw ALAC still won't
        // decode in Chromium — but AAC will, and that recovers "won't play".
        if (wantsFlac) {
          const rawTry = await fetchAudioFromHomemini(
            streamId, request.headers.get('range'), false,
          )
          if (rawTry) return rawTry
        }
        quietWarn('ipod-audio-homemini-miss',
          `[ipod-audio] homemini miss for id=${streamId} — if this is a brand-new import, ` +
          `homemini's backend may not have reloaded library.json yet (index-sync kickstarts it)`,
        )
      }

      // Homemini missed. Serve ONLY a real local (non-symlink) file.
      // Never realpath / existsSync into streamRoot — those hang on SMB.
      // Lexical containment only; lstat does not follow the link.
      if (
        !isPathInside(rawPath, localMountRoot) &&
        !isPathInside(rawPath, playCacheDir) &&
        !(detectedIpodMount && isPathInside(rawPath, detectedIpodMount))
      ) {
        console.warn('[ipod-audio] refused out-of-root path (streaming client):', rawPath.slice(0, 120))
        return new Response('Forbidden', { status: 403 })
      }
      try {
        const st = await lstat(rawPath)
        if (!mayFollowPlaybackSymlink({ isHomeminiClient: true, isSymlink: st.isSymbolicLink() })) {
          // Symlink would follow into the NAS. Homemini already missed —
          // fail closed with 404 instead of hanging the player on SMB.
          console.warn('[ipod-audio] homemini miss + symlink — refusing SMB follow:', rawPath.slice(0, 120))
          return new Response('Unavailable', { status: 404 })
        }
      } catch {
        return new Response('Not Found', { status: 404 })
      }
      // Real local cache hit — fall through to the local serve path below
      // with resolvedPath = rawPath (no streamRoot rewrite, no realpath).
      let filePath = rawPath
      let ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      try {
        if (ext === '.m4a' || ext === '.alac' || ext === '.mp4') {
          const hint = codecByAbsPath.get(rawPath)
          if (hint === 'alac') {
            const srcStat = await stat(rawPath).catch(() => null)
            if (srcStat) {
              const cached = await aacCachePath(rawPath, srcStat.mtimeMs, srcStat.size).catch(() => null)
              if (cached) {
                filePath = cached
                ext = cached.slice(cached.lastIndexOf('.')).toLowerCase()
              }
            }
          }
        }
      } catch { /* fall through */ }
      {
        const start = servePin.rangeStart(request.headers.get('range'))
        const served = servePin.resolve(rawPath, { kind: 'local', path: filePath }, start, (p) => existsSync(p))
        if (served.kind === 'local' && served.path !== filePath) {
          filePath = served.path
          ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
        }
      }
      const mimeType = MIME_TYPES[ext] || 'audio/mpeg'
      try {
        const fileStat = await stat(filePath)
        const total = fileStat.size
        const rangeHeader = request.headers.get('range')
        if (rangeHeader) {
          const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
          if (m) {
            const start = parseInt(m[1], 10)
            const end = m[2] ? parseInt(m[2], 10) : total - 1
            if (start >= total || end >= total || start > end) {
              return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
            }
            const { createReadStream } = await import('fs')
            const { Readable } = await import('stream')
            const nodeStream = createReadStream(filePath, { start, end })
            return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
              status: 206,
              headers: {
                'Content-Type': mimeType,
                'Content-Length': String(end - start + 1),
                'Content-Range': `bytes ${start}-${end}/${total}`,
                'Accept-Ranges': 'bytes',
                'X-JT-Audio-Source': 'local-cache',
              },
            })
          }
        }
        const { createReadStream } = await import('fs')
        const { Readable } = await import('stream')
        const nodeStream = createReadStream(filePath)
        return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
          status: 200,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(total),
            'Accept-Ranges': 'bytes',
            'X-JT-Audio-Source': 'local-cache',
          },
        })
      } catch (err) {
        console.warn('[ipod-audio] local cache serve failed:', err instanceof Error ? err.message : err)
        return new Response('Not Found', { status: 404 })
      }
    }

    // ── Fully-local machines (MacBook) — original disk path ───────────────
    // CONTAINMENT (2026-08-03, from the Cursor "fortify internal piping" audit).
    // This handler used to hand `rawPath` straight to stat/read: an absolute
    // path taken out of a URL and served verbatim. Anything able to issue an
    // ipod-audio:// URL could read any file the app can read — and the Bandcamp
    // store loads a real remote page in a webview in this same session, so
    // "only our own renderer talks to us" was never actually true.
    //
    // Every legitimate source is listed. streamRoot matters specifically
    // because streamed tracks are SYMLINKS pointing outside the music dir;
    // leaving it out would refuse them and silently break playback on the
    // machine that streams (workmini sets it). See path-safety.ts.
    const contained = await resolveContainedPath(rawPath, [
      MUSIC_DIR,
      playCacheDir,
      detectedIpodMount,
      await readStreamRoot(),
    ])
    if (!contained) {
      console.warn('[ipod-audio] refused out-of-root path:', rawPath.slice(0, 120))
      return new Response('Forbidden', { status: 403 })
    }

    // ── Fall back to library.streamRoot when the local copy isn't there.
    //
    // The renderer only ever builds LOCAL paths — musicRoot + the track's
    // colon path. That is fine while every file has a local copy, and wrong
    // the moment one doesn't. Homemini/streamRoot clients never reach this
    // block — they return above. This path is for fully-local installs that
    // also have a NAS mirror configured for some tracks.
    //
    // Never existsSync here — sync SMB probes beachball the main process.
    let resolvedPath = rawPath
    let localMissing = false
    try { await lstat(rawPath) } catch { localMissing = true }
    if (isPathInside(rawPath, localMountRoot) && localMissing) {
      const alt = await readStreamRoot()
      if (alt) {
        const candidate = join(alt, relative(localMountRoot, rawPath))
        const altOk = await Promise.race([
          lstat(candidate).then(() => true, () => false),
          new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
        ])
        if (altOk) resolvedPath = candidate
      }
    }
    // Evicted-track fallback — pass-through storage trashed the local copy; serve homemini's proven bytes (evicted-playback.ts).
    const evictedServe = (localMissing && resolvedPath === rawPath) ? await serveEvictedFromHomemini(rawPath, request.headers.get('range'), { trackIdForAbsPath, fetchAudioFromHomemini, wantsFlac: wantsHomeminiFlac }) : null
    if (evictedServe) return evictedServe

    let filePath = resolvedPath
    let ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()

    // ── Streaming migration Stage 1 (2026-07-09): stream a NON-LOCAL track
    // from homemini's HTTP audio server instead of reading it off disk. Fires
    // when the on-disk file is a SYMLINK (a "streamed" track — the Stage 2+
    // trigger) OR the JT_STREAM_TEST flag is set (the Stage-1 proof, no files
    // touched). Pulls from homemini (the phone-proven path, served from its own
    // local disk) so flaky SMB never sits on the playback hot path — the exact
    // 2026-07-08 freeze cause. Any homemini failure (timeout/unreachable/miss)
    // falls THROUGH to the local read below — a streamed track with no local
    // bytes then 404s cleanly (surfaced as unavailable) rather than hanging.
    const isAlac = wantsHomeminiFlac(rawPath)
    // ALAC used to be excluded here because homemini served it raw and
    // Chromium cannot decode it. homemini transcodes to FLAC on request now,
    // so every codec takes the same fast path the phone has always used —
    // which is the whole point: 9,273 tracks, no exceptions.
    {
      let streamed = process.env.JT_STREAM_TEST === '1'
      // Homemini clients already returned above. This residual path is for
      // JT_STREAM_TEST on an otherwise-local machine.
      if (!streamed && (await readStreamSourceCached()) === 'homemini') {
        try { streamed = (await lstat(resolvedPath)).isSymbolicLink() } catch { /* real local file */ }
      }
      const pinStart = servePin.rangeStart(request.headers.get('range'))
      const pinnedNow = pinStart > 0 ? servePin.pinned(rawPath) : null
      if (streamed && pinnedNow?.kind !== 'local') {
        const id = await trackIdForAbsPath(rawPath)
        if (id != null) {
          const remote = await fetchAudioFromHomemini(id, request.headers.get('range'), isAlac)
          if (remote) { servePin.resolve(rawPath, { kind: 'remote' }, pinStart, () => true); return remote }
        }
      }
    }

    try {
      // If the source is ALAC, swap in a cached AAC transcode. Silent
      // fallthrough to the raw file if ffmpeg fails — playback may still
      // work for codecs Chromium does support.
      if (ext === '.m4a' || ext === '.alac' || ext === '.mp4') {
        // 4.4.85: prefer the library-side codec hint over ffprobe. AAC
        // files were eating ~200-500 ms per first-play running ffprobe
        // to discover they're already AAC.
        const hint = codecByAbsPath.get(rawPath)
        if (hint) {
          if (hint === 'alac') {
            const srcStat = await stat(resolvedPath).catch(() => null)
            if (srcStat) {
              const cached = await aacCachePath(resolvedPath, srcStat.mtimeMs, srcStat.size).catch(() => null)
              if (cached) {
                filePath = cached
                ext = cached.slice(cached.lastIndexOf('.')).toLowerCase()
              }
            }
          }
          // Non-ALAC codec hint: serve raw, no ffprobe, no transcode.
        } else {
          // Legacy track (no codec field on Track) — fall through to the
          // original ffprobe path, which caches its own answer in
          // memory for this session.
          const srcStat = await stat(resolvedPath).catch(() => null)
          if (srcStat) {
            const cached = await aacCachePath(resolvedPath, srcStat.mtimeMs, srcStat.size).catch(() => null)
            if (cached) {
              filePath = cached
              ext = cached.slice(cached.lastIndexOf('.')).toLowerCase()
            }
          }
        }
      }
    } catch { /* fall through */ }
    {
      const start = servePin.rangeStart(request.headers.get('range'))
      const served = servePin.resolve(rawPath, { kind: 'local', path: filePath }, start, (p) => existsSync(p))
      if (served.kind === 'local' && served.path !== filePath) {
        filePath = served.path
        ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      }
    }
    const mimeType = MIME_TYPES[ext] || 'audio/mpeg'
    try {
      const fileStat = await stat(filePath)
      const total = fileStat.size
      const rangeHeader = request.headers.get('range')

      // 4.2.11: switched from Buffer.alloc + fh.read (entire file into
      // memory) to a true streaming response via createReadStream +
      // Readable.toWeb. The Buffer-based path produced a ~29-second
      // playback cutoff: HTMLAudioElement decodes ~30s ahead, and once
      // it had decoded its window, Electron's main-process Buffer was
      // eligible for GC; if it got collected before the audio element
      // requested more bytes, audio died mid-track. Streaming responses
      // hold the file handle open for the duration of the consumer's
      // read, no buffer to GC.
      const { createReadStream } = await import('fs')
      const { Readable } = await import('stream')

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
        const start = match ? parseInt(match[1], 10) : 0
        const end = match && match[2] ? parseInt(match[2], 10) : total - 1
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total || end >= total || start > end) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
        }
        const chunkSize = end - start + 1
        const nodeStream = createReadStream(filePath, { start, end })
        const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
        return new Response(webStream, {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(chunkSize),
            'Accept-Ranges': 'bytes',
            'X-JT-Audio-Source': 'local',
          },
        })
      }

      const nodeStream = createReadStream(filePath)
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
      return new Response(webStream, {
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
          'X-JT-Audio-Source': 'local',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  const menu = Menu.buildFromTemplate(menuTemplate)
  Menu.setApplicationMenu(menu)
  // Start watching library.json for external modifications so any
  // Python-script edits or out-of-band rewrites propagate into the
  // running UI instead of getting silently overwritten. Fire after
  // createWindow so mainWindow is defined when the watcher emits.
  // (createWindow + startLibraryWatcher run earlier, right after artist-image protocol)

  // ── Bandcamp Store integration (Brief 036 v4) ──
  // Registered after createWindow so mainWindow is live for the embedded
  // WebContentsView mount + the download-router events.
  const libraryRoot = MUSIC_DIR.replace(/[/\\]iPod_Control[/\\]Music$/, '')
  registerBandcampIntegration({
    ipc,
    getMainWindow: () => mainWindow,
    importDownloaded: importDownloadedFiles,
    pendingImportsDir: join(libraryRoot, '_pending-imports'),
  })

  // streamrip download store (replaces the dead embedded web-store views —
  // squid/lucida/dab). Shells out to the `rip` CLI and imports the result
  // through the same pipeline Bandcamp uses, tagged source='streamrip'.
  registerStreamripStore({
    ipc,
    getMainWindow: () => mainWindow,
    importDownloaded: importDownloadedFiles,
  })

  // SCOTUS Archive — Poppy's Supreme Court argument (Beck v. Prupis). A
  // one-of-one exhibit, never part of the music library. askClaude wraps
  // claudeCall so the module stays free of the Anthropic SDK types.
  registerScotusArchive({
    ipc,
    askClaude: async (callKey, system, userText, maxTokens) => {
      const reply = await claudeCall(callKey, {
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userText }],
      })
      const block = reply.content[0]
      return block && block.type === 'text' ? block.text.trim() : ''
    },
  })

  // ── Music Man's Record Store (Brief 037) ──
  // The Phase-1 engine (1a-1e) + Phase-2 UI are wired below. Held OFF for
  // the 4.5.0-111 release (shipping listen-to-the-list only) — the store
  // code ships dormant and the sidebar entry is hidden, so it's
  // unreachable. Flip back to true (+ unhide the Sidebar entry) to resume
  // Phase-2 dev after this DMG goes out.
  const RECORD_STORE_ENABLED = true   // 2026-08-07: Step Inside door on the Record Shop page
  if (RECORD_STORE_ENABLED) {
    // LLM adapter over claudeCall (§3.6 — no new SDK/keys). Returns the
    // assistant text; daily ceiling + cached fallback are handled inside
    // claudeCall, and the engine falls back to heuristics if it throws.
    const recordStoreLlm = async (req: {
      callKey: string; model: string; maxTokens: number; system: string; user: string
    }): Promise<string> => {
      const reply = await claudeCall(req.callKey, {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      })
      const block = reply.content[0]
      return block && block.type === 'text' ? block.text : ''
    }
    registerRecordStoreIntegration({
      ipc,
      userDataDir: app.getPath('userData'),
      getMainWindow: () => mainWindow,
      getTracks: async () => {
        const lib = (await libraryCache.get()) as { tracks?: CandTrack[] }
        return Array.isArray(lib.tracks) ? lib.tracks : []
      },
      getPlayEvents: async () =>
        parsePlayEvents(await readFile(getPlayEventsPath(), 'utf-8').catch(() => '')),
      llm: recordStoreLlm,
      personaCore: MUSIC_MAN_CORE,
    })
  }

  // 4.4.13: Inbox auto-import. Chokidar watches ~/Music2/_inbox for new
  // audio files (Qobuz downloads, manual drops, etc.) and forwards them
  // to the same renderer import queue drag-and-drop uses. Default-on;
  // user toggles via Preferences → Library. Configured AFTER createWindow
  // so the watcher's webContents.send has a window to target.
  configureInboxWatcher(() => mainWindow)
  try {
    const settings = await readAppSettingsAsync()
    const inboxRaw = settings?.inbox as { enabled?: boolean; path?: string } | undefined
    const inboxConfig: InboxConfig = {
      enabled: inboxRaw?.enabled !== false,         // default ON if not set
      path: typeof inboxRaw?.path === 'string' ? inboxRaw.path : '',
    }
    const r = await startOrReconfigureInboxWatcher(inboxConfig)
    if (!r.ok) {
      console.warn('[inbox-watcher] startup failed:', r.error, '(resolved path:', r.path, ')')
    } else {
      console.log(`[inbox-watcher] startup: enabled=${inboxConfig.enabled} path=${r.path}`)
    }
  } catch (err) {
    console.warn('[inbox-watcher] startup threw:', err)
  }

  // 4.4.18: Library sync orchestrator. Replaces the broken launchd
  // agent (Sequoia TCC blocks network-volume access from launchd
  // domain). JakeTunes' main process inherits the user's GUI session
  // permissions, so the same shell script that fails under launchd
  // works fine here. Triggers wired in the import-track /
  // import-tracks / save-metadata-override / save-playlists handlers
  // above; safety net fires every 10 min.
  startSyncOrchestrator(() => mainWindow)

  // Auto-update: check for updates in production
  if (!isDev) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-available', (info) => {
      console.log('Update available:', info.version)
      sendToRenderer('update-status', { status: 'available', version: info.version })
    })
    autoUpdater.on('update-downloaded', (info) => {
      console.log('Update downloaded:', info.version)
      if (mainWindow) {
        sendToRenderer('update-status', { status: 'downloaded', version: info.version })
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Update Ready',
          message: `JakeTunes ${info.version} has been downloaded.`,
          detail: 'It will be installed when you quit the app. Restart now?',
          buttons: ['Restart Now', 'Later'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) {
            sendToRenderer('update-status', { status: 'installing', version: info.version })
            // On macOS, calling quitAndInstall directly from the dialog
            // promise callback can occasionally no-op (app neither quits
            // nor relaunches). Defer to the next tick and pass explicit
            // args so restart-after-install is unambiguous.
            setImmediate(() => {
              try {
                autoUpdater.quitAndInstall(false, true)
              } catch (err) {
                console.error('quitAndInstall failed, forcing relaunch fallback:', err)
                app.relaunch()
                app.exit(0)
              }
            })
          }
        })
      }
    })
    autoUpdater.on('error', (err) => {
      // warn, not log: warn is mirrored into the flight recorder.
      console.warn('Auto-update error:', err.message)
    })
    // Flight-recorder catch #2 (2026-08-21): dir-target builds ship without
    // app-update.yml, so checkForUpdatesAndNotify() threw an UNHANDLED
    // rejection on every boot of a hand-installed build. Gate on the file
    // updater actually needs, and catch the promise — an update check must
    // never be the app's loudest failure.
    const updateManifest = join(process.resourcesPath, 'app-update.yml')
    if (existsSync(updateManifest)) {
      // Check after a short delay to not slow down startup
      setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
          console.warn('Auto-update check failed:', err instanceof Error ? err.message : String(err))
        })
      }, 5000)
    } else {
      console.warn('[updater] skipped: no app-update.yml (unpublished/dir build) — updates arrive by hand-install')
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      startLifetimeSuspensionBlocker()   // a renderer to protect again
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { app.quit(); return }
  // macOS keeps the app alive with no windows. Drop the suspension assertion
  // so an idle app stops holding the machine awake.
  //
  // Two guards, both learned the hard way. The window count dips to zero
  // transiently during startup and this event fires on that dip — releasing
  // there left the app with NO App Nap protection for its whole session, which
  // is the freeze the blocker exists to prevent. So: refuse before the main
  // window has ever been created, and re-check after a beat that the count is
  // still zero rather than trusting the edge.
  if (!mainWindowEverCreated) return
  setTimeout(() => {
    if (BrowserWindow.getAllWindows().length === 0) stopLifetimeSuspensionBlocker()
  }, 2000)
})

// 4.4.13: stop the inbox watcher cleanly on quit. Chokidar holds native
// fs handles + a polling fallback timer; without close() the process
// hangs for a few seconds before Electron force-kills it.
// 4.5: also ping the renderer to fade audio before the process dies.
// Without this, cmd+Q snaps any playing audio mid-waveform → speaker
// pop. We defer the quit once, send 'app-quit-fade', wait 180ms for
// the renderer to ramp Howler volumes to 0, then let the original
// quit proceed. `quittingForFade` guards against re-entry — the second
// 'before-quit' (when we call app.quit() ourselves) bypasses the
// deferral and tears down normally.
let quittingForFade = false
app.on('before-quit', (e) => {
  unregisterMediaKeyShortcuts()
  void stopInboxWatcher().catch(() => { /* shutting down, ignore */ })
  // 4.5.0-106 Phase 2.5: flush any pending NAS writes before we let the
  // process exit. Cache writes are backgrounded, so a fast quit could
  // otherwise lose the last few seconds of edits. Wrapped in a Promise
  // chain that resolves regardless — we don't want quit to hang on a
  // stuck SMB connection.
  void Promise.all([
    overridesCache.flush(),
    mobileStarsCache.flush(),
    listenerProfileCache.flush(),
    musicmanMemoryCache.flush(),
    playlistsCache.flush(),
  ]).catch(() => { /* ignore — quitting */ })
  if (quittingForFade) return
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  e.preventDefault()
  quittingForFade = true
  try { win.webContents.send('app-quit-fade') } catch { /* ignore */ }
  setTimeout(() => app.quit(), 180)
})
