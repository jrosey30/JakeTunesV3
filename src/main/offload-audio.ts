/**
 * Hub offload. The MacBook publishes library.json (library.streamSource
 * is empty). library.offloadAudioToHomemini lets THAT machine enqueue
 * stream-convert, play a symlink from homemini by id, and decode streamed
 * ALAC into the bounded cache — without becoming a replica.
 *
 * isHomeminiPlaybackClient stays replica-only (streamSource homemini or
 * streamRoot). Folding offload into that predicate stops the hub
 * publishing library.json and breaks the phone and workmini.
 *
 * The setting does not start the bulk migration. dryRunOffload reports.
 * An explicit start (menu, IPC, or --offload-start) writes
 * offload-migration.json; a later boot resumes that file and does not
 * scan on its own. A replica (streamSource homemini) keeps its own boot
 * scan in index.ts. This module does not call it.
 *
 * A local file is replaced only when the raw homemini body (GET
 * /audio/:id, no fmt= transcode) has the same size and full sha1 as
 * the local file. The 256KB fingerprint is a pre-filter so a mismatch
 * does not download the master. Every replacement is one JSONL line
 * (full sha1 and size) so scripts/offload-rehydrate.ts can pull the
 * bytes back, stopping at the 10 GB free-space floor.
 */

import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { join } from 'path'
import { withCompanionInit } from './hub-companion.ts'
import { isLibraryAlac, type AlacMigrateTrack } from './alac-stream-migrate.ts'
import {
  diskWriteWouldBreachFloor,
  formatFreeSpaceRefuse,
  MATERIALIZE_FREE_FLOOR_BYTES,
} from './ipod-sync-materialize.ts'

export const OFFLOAD_CONVERT_BATCH = 15
export const OFFLOAD_ENQUEUE_BATCH = 40
export const OFFLOAD_ENQUEUE_PAUSE_MS = 500
export const OFFLOAD_HASH_PAUSE_MS = 250
export const OFFLOAD_PROBE_BATCH = 8
export const OFFLOAD_PROBE_PAUSE_MS = 200

export type OffloadBootIntent = 'dry-run' | 'start' | 'resume' | 'none'

export interface OffloadTrack extends AlacMigrateTrack {
  id?: string | number
}

export interface OffloadMigrationState {
  startedAt: string
  phase: 'enqueueing' | 'converting' | 'done'
  /** Next index in library.json track order. Resume continues here. */
  cursor: number
}

export interface OffloadReplacementRecord {
  ts: string
  id: string | number
  path: string
  /** 256KB pre-filter. Not sufficient to delete or restore a master. */
  fingerprint: string
  /** Byte size of the file that was replaced. */
  bytes: number
  /** sha1 of the entire file, 40 hex. Required before a rehydrate write. */
  fullSha1?: string
  sentinel: string
}

export interface FullFileDigest {
  sha1: string
  bytes: number
}

export interface OffloadDryRunReport {
  count: number
  bytes: number
  /** Decimal GB (bytes / 1e9), one place. */
  gb: number
  alacCount: number
  alacBytes: number
  alacGb: number
  /** Full-file sha1 and size matched the raw homemini body. */
  matchingOnHomemini: number
  matchingBytes: number
  matchingGb: number
  /** 404 or empty body. Kept local. Rsync these before Start. */
  missingOnHomemini: number
  missingBytes: number
  missingGb: number
  /** Prefix, size, or full sha1 differs. Kept local. */
  differentOnHomemini: number
  differentBytes: number
  differentGb: number
  needsFingerprint: number
  alreadyStreamed: number
  /** Counted locally, then homemini stopped answering. Not marked missing. */
  notProbed: number
  stoppedBecause: string | null
}

export interface HomeminiPrefixProbe {
  transportError: boolean
  status: number
  body: Buffer | null
}

export function readOffloadAudioFlag(settings: unknown): boolean {
  const lib = (settings as { library?: { offloadAudioToHomemini?: unknown } } | null)?.library
  return lib?.offloadAudioToHomemini === true
}

export function createCachedOffloadReader(
  readSettings: () => Promise<unknown>,
  ttlMs = 5000,
): () => Promise<boolean> {
  let cache: { v: boolean; t: number } | null = null
  return async () => {
    const now = Date.now()
    if (cache && now - cache.t < ttlMs) return cache.v
    let v = false
    try { v = readOffloadAudioFlag(await readSettings()) } catch { v = false }
    cache = { v, t: now }
    return v
  }
}

/** Stream-convert worker, new-import enqueue, and queue resume. */
export function streamConvertRuns(opts: { streamSource: string | null; offload: boolean }): boolean {
  return opts.streamSource === 'homemini' || opts.offload === true
}

/**
 * Hub with the setting, and not already a replica. Replica boot behavior
 * stays on the streamSource === 'homemini' path.
 */
export function hubOffloadActive(opts: { streamSource: string | null; offload: boolean }): boolean {
  return opts.offload === true && opts.streamSource !== 'homemini'
}

export function offloadArgvMode(argv: string[]): 'dry-run' | 'start' | null {
  if (argv.includes('--offload-dry-run')) return 'dry-run'
  if (argv.includes('--offload-start')) return 'start'
  return null
}

export function bootOffloadIntent(
  argv: string[],
  state: OffloadMigrationState | null,
  queueLength: number,
  offload: boolean,
): OffloadBootIntent {
  const flag = offloadArgvMode(argv)
  if (flag === 'dry-run') return 'dry-run'
  if (flag === 'start') return 'start'
  if (!offload) return 'none'
  return migrationResumeAction(state, queueLength) === 'idle' ? 'none' : 'resume'
}

export function migrationResumeAction(
  state: OffloadMigrationState | null,
  queueLength: number,
): 'enqueue' | 'convert' | 'idle' {
  if (!state) return 'idle'
  if (state.phase === 'enqueueing') return 'enqueue'
  if (state.phase === 'converting' && queueLength > 0) return 'convert'
  return 'idle'
}

/** A second Start while a pass is mid-flight continues it. A finished pass starts over. */
export function stateForExplicitStart(
  prev: OffloadMigrationState | null,
  nowIso: string,
  queueLength: number,
): OffloadMigrationState {
  if (prev?.phase === 'enqueueing') return prev
  if (prev?.phase === 'converting' && queueLength > 0) return prev
  return { startedAt: nowIso, phase: 'enqueueing', cursor: 0 }
}

export function parseMigrationState(raw: string): OffloadMigrationState | null {
  try {
    const s = JSON.parse(raw) as OffloadMigrationState
    if (!s || (s.phase !== 'enqueueing' && s.phase !== 'converting' && s.phase !== 'done')) return null
    if (!Number.isFinite(s.cursor) || s.cursor < 0) return null
    return { startedAt: String(s.startedAt || ''), phase: s.phase, cursor: s.cursor }
  } catch {
    return null
  }
}

const FINGERPRINT_WINDOW = 256 * 1024
export const FULL_BODY_TIMEOUT_MS = 10 * 60 * 1000

/** sha1 of the first 256KB, same window as computeAudioFingerprint. Pre-filter only. */
export function sha1WindowMatches(storedFingerprint: string | undefined, remotePrefix: Buffer | null): boolean {
  if (!storedFingerprint || !storedFingerprint.startsWith('sha1:')) return false
  if (!remotePrefix || remotePrefix.length <= 0) return false
  const want = storedFingerprint.split('|')[0].slice('sha1:'.length)
  const window = remotePrefix.subarray(0, Math.min(remotePrefix.length, FINGERPRINT_WINDOW))
  const got = createHash('sha1').update(window).digest('hex').slice(0, 16)
  return got === want
}

export function digestBuffer(bytes: Buffer): FullFileDigest {
  return { sha1: createHash('sha1').update(bytes).digest('hex'), bytes: bytes.length }
}

export function fullBodiesMatch(local: FullFileDigest | null | undefined, remote: FullFileDigest | null | undefined): boolean {
  if (!local || !remote) return false
  return local.bytes > 0
    && local.bytes === remote.bytes
    && /^[0-9a-f]{40}$/.test(local.sha1)
    && local.sha1 === remote.sha1
}

/**
 * Prefix alone is keep. Replace only when the whole bodies match.
 * A stored 256KB fingerprint, when a prefix was fetched, must also match
 * so a shared prefix with a different tail never deletes the master.
 */
export function decideReplacement(opts: {
  storedFingerprint?: string
  remotePrefix?: Buffer | null
  local?: FullFileDigest | null
  remote?: FullFileDigest | null
}): 'replace' | 'keep' {
  if (opts.storedFingerprint?.startsWith('sha1:') && opts.remotePrefix !== undefined) {
    if (!sha1WindowMatches(opts.storedFingerprint, opts.remotePrefix ?? null)) return 'keep'
  }
  return fullBodiesMatch(opts.local, opts.remote) ? 'replace' : 'keep'
}

/** GET /audio/:id with no query. A transcode must not be compared to a master. */
export function rawAudioUrl(base: string, id: string | number): string {
  const root = base.replace(/\/+$/, '')
  return `${root}/${encodeURIComponent(String(id))}`
}

export function urlAsksForTranscode(url: string): boolean {
  return /[?&]fmt=/.test(url)
}

export function libraryRootFromMusicDir(musicDir: string): string {
  return musicDir.replace(/[/\\]iPod_Control[/\\]Music[/\\]?$/, '')
}

export function offloadSettingsPaths(home: string): string[] {
  return [
    join(home, 'Library', 'Application Support', 'JakeTunes', 'app-settings.json'),
    join(home, '.config', 'JakeTunes', 'app-settings.json'),
  ]
}

export function musicRootFromSettings(json: unknown): string | null {
  const root = (json as { library?: { musicRoot?: unknown } } | null)?.library?.musicRoot
  return typeof root === 'string' && root.trim() ? root.trim() : null
}

function ipodTreeExists(root: string, exists: (abs: string) => boolean): boolean {
  const stripped = libraryRootFromMusicDir(root)
  return exists(join(stripped, 'iPod_Control', 'Music'))
}

/**
 * --library-root wins. Otherwise library.musicRoot from app-settings when
 * that iPod tree exists, then ~/Music2/JakeTunesLibrary, then
 * ~/Music/JakeTunesLibrary. The hub rsyncs ~/Music2.
 */
export function resolveOffloadLibraryRoot(opts: {
  explicit?: string | null
  settingsMusicRoot?: string | null
  home: string
  exists: (abs: string) => boolean
}): string {
  const explicit = (opts.explicit || '').trim()
  if (explicit) return libraryRootFromMusicDir(explicit)
  const configured = (opts.settingsMusicRoot || '').trim()
  if (configured && ipodTreeExists(configured, opts.exists)) return libraryRootFromMusicDir(configured)
  const music2 = join(opts.home, 'Music2', 'JakeTunesLibrary')
  if (ipodTreeExists(music2, opts.exists)) return music2
  const music = join(opts.home, 'Music', 'JakeTunesLibrary')
  if (ipodTreeExists(music, opts.exists)) return music
  return music2
}

export type ProbeClass = 'prefix-match' | 'present' | 'missing' | 'mismatch' | 'unreachable'

export function classifyProbe(
  fingerprint: string | null,
  probe: HomeminiPrefixProbe,
): ProbeClass {
  if (probe.transportError) return 'unreachable'
  const served = !!probe.body && probe.body.length > 0 && (probe.status === 200 || probe.status === 206)
  if (!served) return 'missing'
  if (!fingerprint || !fingerprint.startsWith('sha1:')) return 'present'
  return sha1WindowMatches(fingerprint, probe.body) ? 'prefix-match' : 'mismatch'
}

export function emptyDryRunReport(): OffloadDryRunReport {
  return {
    count: 0,
    bytes: 0,
    gb: 0,
    alacCount: 0,
    alacBytes: 0,
    alacGb: 0,
    matchingOnHomemini: 0,
    matchingBytes: 0,
    matchingGb: 0,
    missingOnHomemini: 0,
    missingBytes: 0,
    missingGb: 0,
    differentOnHomemini: 0,
    differentBytes: 0,
    differentGb: 0,
    needsFingerprint: 0,
    alreadyStreamed: 0,
    notProbed: 0,
    stoppedBecause: null,
  }
}

function gbOf(bytes: number): number {
  return Number((bytes / 1e9).toFixed(1))
}

function finishReport(report: OffloadDryRunReport): OffloadDryRunReport {
  report.gb = gbOf(report.bytes)
  report.alacGb = gbOf(report.alacBytes)
  report.matchingGb = gbOf(report.matchingBytes)
  report.missingGb = gbOf(report.missingBytes)
  report.differentGb = gbOf(report.differentBytes)
  return report
}

export function formatOffloadDryRun(report: OffloadDryRunReport): string {
  const lines = [
    'Offload dry run. No files were changed.',
    `Local files: ${report.count} (${report.gb} GB)`,
    `ALAC: ${report.alacCount} (${report.alacGb} GB)`,
    `Homemini full sha1 matches: ${report.matchingOnHomemini} (${report.matchingGb} GB)`,
    `Missing on homemini (rsync these first): ${report.missingOnHomemini} (${report.missingGb} GB)`,
    `Different on homemini (kept local): ${report.differentOnHomemini} (${report.differentGb} GB)`,
    `No fingerprint: ${report.needsFingerprint}`,
    `Already a symlink: ${report.alreadyStreamed}`,
  ]
  if (report.notProbed) lines.push(`Not probed after homemini stopped answering: ${report.notProbed}`)
  if (report.stoppedBecause) lines.push(`Stopped early: ${report.stoppedBecause}`)
  return lines.join('\n')
}

type StatLike = { isSymbolicLink(): boolean; isFile(): boolean; size: number }

async function statOf(
  colon: string,
  lstat: (abs: string) => Promise<StatLike>,
  colonToAbs: (colon: string) => string,
): Promise<StatLike | null> {
  try {
    return await lstat(colonToAbs(colon))
  } catch {
    return null
  }
}

export type FullCompare =
  | { kind: 'match'; sha1: string; bytes: number }
  | { kind: 'different' }
  | { kind: 'missing' }
  | { kind: 'unreachable' }
  | { kind: 'unreadable' }

export async function dryRunOffload(opts: {
  tracks: OffloadTrack[]
  lstat: (abs: string) => Promise<StatLike>
  colonToAbs: (colon: string) => string
  hashPrefix: (abs: string, durationMs: number) => Promise<string | null>
  probe: (id: string | number) => Promise<HomeminiPrefixProbe>
  /** Full raw body vs local file. Called only after the prefix pre-filter passes, or when there is no fingerprint. */
  confirmFull: (abs: string, id: string | number) => Promise<FullCompare>
  sleep: (ms: number) => Promise<void>
  probeBatch?: number
  pauseMs?: number
  hashPauseMs?: number
}): Promise<OffloadDryRunReport> {
  const report = emptyDryRunReport()
  const probeBatch = opts.probeBatch ?? OFFLOAD_PROBE_BATCH
  const pauseMs = opts.pauseMs ?? OFFLOAD_PROBE_PAUSE_MS
  const hashPauseMs = opts.hashPauseMs ?? 0
  let sincePause = 0
  let stop = false
  for (let i = 0; i < opts.tracks.length; i++) {
    const t = opts.tracks[i]
    const colon = String(t.path || '').trim()
    if (!colon) continue
    const st = await statOf(colon, opts.lstat, opts.colonToAbs)
    if (!st) continue
    if (st.isSymbolicLink()) {
      report.alreadyStreamed++
      continue
    }
    if (!st.isFile()) continue
    if (stop) {
      report.notProbed++
      report.count++
      report.bytes += st.size
      if (isLibraryAlac(t)) {
        report.alacCount++
        report.alacBytes += st.size
      }
      continue
    }
    report.count++
    report.bytes += st.size
    if (isLibraryAlac(t)) {
      report.alacCount++
      report.alacBytes += st.size
    }
    let fp = typeof t.audioFingerprint === 'string' && t.audioFingerprint.startsWith('sha1:')
      ? t.audioFingerprint
      : null
    if (!fp) {
      try {
        fp = await opts.hashPrefix(opts.colonToAbs(colon), Number(t.duration) || 0)
      } catch {
        fp = null
      }
      if (hashPauseMs) await opts.sleep(hashPauseMs)
      if (!fp || !fp.startsWith('sha1:')) fp = null
    }
    if (t.id == null || t.id === '') {
      report.missingOnHomemini++
      report.missingBytes += st.size
      continue
    }
    let probe: HomeminiPrefixProbe
    try {
      probe = await opts.probe(t.id)
    } catch {
      probe = { transportError: true, status: 0, body: null }
    }
    const kind = classifyProbe(fp, probe)
    if (kind === 'unreachable') {
      report.stoppedBecause = 'homemini-unreachable'
      report.notProbed++
      stop = true
      continue
    }
    if (kind === 'missing') {
      report.missingOnHomemini++
      report.missingBytes += st.size
    } else if (kind === 'mismatch') {
      report.differentOnHomemini++
      report.differentBytes += st.size
    } else {
      let full: FullCompare
      try {
        full = await opts.confirmFull(opts.colonToAbs(colon), t.id)
      } catch {
        full = { kind: 'unreachable' }
      }
      if (full.kind === 'unreachable') {
        report.stoppedBecause = 'homemini-unreachable'
        report.notProbed++
        stop = true
        continue
      }
      if (full.kind === 'unreadable') report.needsFingerprint++
      else if (full.kind === 'match') {
        report.matchingOnHomemini++
        report.matchingBytes += st.size
      } else if (full.kind === 'missing') {
        report.missingOnHomemini++
        report.missingBytes += st.size
      } else {
        report.differentOnHomemini++
        report.differentBytes += st.size
      }
    }
    sincePause++
    if (sincePause >= probeBatch) {
      await opts.sleep(pauseMs)
      sincePause = 0
    }
  }
  return finishReport(report)
}

export interface OffloadEnqueueItem {
  ipodPath: string
  fingerprint: string
  enqueuedAt: number
}

/**
 * Walk a slice of the library and enqueue real local files. Does not
 * replace anything and does not talk to homemini. Cursor advances across
 * skips so a restart does not rehash the same head forever.
 */
export async function drainOffloadEnqueue(opts: {
  tracks: OffloadTrack[]
  state: OffloadMigrationState
  batchSize?: number
  pauseMs?: number
  hashPauseMs?: number
  lstat: (abs: string) => Promise<StatLike>
  colonToAbs: (colon: string) => string
  hashFile: (abs: string, durationMs: number) => Promise<string | null>
  enqueue: (items: OffloadEnqueueItem[]) => Promise<void>
  saveState: (state: OffloadMigrationState) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
}): Promise<OffloadMigrationState> {
  const batchSize = opts.batchSize ?? OFFLOAD_ENQUEUE_BATCH
  const pauseMs = opts.pauseMs ?? OFFLOAD_ENQUEUE_PAUSE_MS
  const hashPauseMs = opts.hashPauseMs ?? OFFLOAD_HASH_PAUSE_MS
  let state = opts.state
  while (state.phase === 'enqueueing' && state.cursor < opts.tracks.length) {
    const batch: OffloadEnqueueItem[] = []
    let visited = 0
    while (visited < batchSize && state.cursor < opts.tracks.length) {
      const t = opts.tracks[state.cursor]
      state = { ...state, cursor: state.cursor + 1 }
      visited++
      const colon = String(t.path || '').trim()
      if (!colon) continue
      const st = await statOf(colon, opts.lstat, opts.colonToAbs)
      if (!st || st.isSymbolicLink() || !st.isFile()) continue
      let fp = typeof t.audioFingerprint === 'string' && t.audioFingerprint.startsWith('sha1:')
        ? t.audioFingerprint
        : null
      if (!fp) {
        fp = await opts.hashFile(opts.colonToAbs(colon), Number(t.duration) || 0)
        await opts.sleep(hashPauseMs)
      }
      if (!fp || !fp.startsWith('sha1:')) continue
      batch.push({ ipodPath: colon, fingerprint: fp, enqueuedAt: opts.now() })
    }
    if (batch.length) await opts.enqueue(batch)
    if (state.cursor >= opts.tracks.length) state = { ...state, phase: 'converting' }
    await opts.saveState(state)
    if (state.phase === 'enqueueing') await opts.sleep(pauseMs)
  }
  if (state.phase === 'enqueueing' && state.cursor >= opts.tracks.length) {
    state = { ...state, phase: 'converting' }
    await opts.saveState(state)
  }
  return state
}

export function offloadReplacementsPath(userDataDir: string): string {
  return join(userDataDir, 'offload-replacements.jsonl')
}

export function offloadMigrationStatePath(userDataDir: string): string {
  return join(userDataDir, 'offload-migration.json')
}

export function offloadDryRunReportPath(userDataDir: string): string {
  return join(userDataDir, 'offload-dry-run-report.json')
}

export function parseReplacementLog(text: string): OffloadReplacementRecord[] {
  const out: OffloadReplacementRecord[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s) as OffloadReplacementRecord
      if (r && r.path && r.id != null && typeof r.fingerprint === 'string') out.push(r)
    } catch {
      // A torn last line from a crash is skipped. Earlier lines still undo.
    }
  }
  return out
}

export async function appendOffloadReplacement(
  userDataDir: string,
  record: OffloadReplacementRecord,
): Promise<void> {
  const { appendFile, mkdir } = await import('fs/promises')
  const { dirname } = await import('path')
  const file = offloadReplacementsPath(userDataDir)
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify(record) + '\n', 'utf-8')
  } catch (err) {
    console.warn('[offload] replacement log failed:', err instanceof Error ? err.message : err)
  }
}

export interface RehydrateResult {
  restored: number
  skipped: number
  stoppedBecause: string | null
}

/** Full sha1 and size. A 256KB fingerprint, or a log line with no fullSha1, does not write. */
export function rehydrateBytesOk(record: OffloadReplacementRecord, bytes: Buffer): boolean {
  const want = (record.fullSha1 || '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(want)) return false
  if (!Number.isFinite(record.bytes) || record.bytes !== bytes.length || record.bytes <= 0) return false
  return createHash('sha1').update(bytes).digest('hex') === want
}

/**
 * Pull logged files back onto the library path. Refuses a write that
 * would leave less than the sync floor free. Refuses bytes whose size
 * or full sha1 do not match the log.
 */
export async function rehydrateReplacements(opts: {
  records: OffloadReplacementRecord[]
  freeBytes: () => Promise<number>
  fetchFull: (id: string | number) => Promise<Buffer | null>
  currentKind: (record: OffloadReplacementRecord) => Promise<'symlink' | 'file' | 'missing'>
  writeBack: (record: OffloadReplacementRecord, bytes: Buffer) => Promise<void>
  floor?: number
}): Promise<RehydrateResult> {
  const floor = opts.floor ?? MATERIALIZE_FREE_FLOOR_BYTES
  let restored = 0
  let skipped = 0
  for (const record of opts.records) {
    let kind: 'symlink' | 'file' | 'missing'
    try {
      kind = await opts.currentKind(record)
    } catch {
      skipped++
      continue
    }
    if (kind === 'file') {
      skipped++
      continue
    }
    const bytes = await opts.fetchFull(record.id)
    if (!bytes || !rehydrateBytesOk(record, bytes)) {
      skipped++
      continue
    }
    let free = 0
    try {
      free = await opts.freeBytes()
    } catch (err) {
      return {
        restored,
        skipped,
        stoppedBecause: err instanceof Error ? err.message : 'free-space check failed',
      }
    }
    if (diskWriteWouldBreachFloor(free, bytes.length, floor)) {
      return { restored, skipped, stoppedBecause: formatFreeSpaceRefuse(free, floor) }
    }
    await opts.writeBack(record, bytes)
    restored++
  }
  return { restored, skipped, stoppedBecause: null }
}

export async function digestChunks(source: AsyncIterable<Uint8Array>): Promise<FullFileDigest> {
  const hash = createHash('sha1')
  let bytes = 0
  for await (const chunk of source) {
    hash.update(chunk)
    bytes += chunk.byteLength
  }
  return { sha1: hash.digest('hex'), bytes }
}

export async function digestFile(abs: string): Promise<FullFileDigest> {
  return digestChunks(createReadStream(abs))
}

/** 'short' means the body ended before Content-Length, or the read threw. Not a content mismatch. */
export async function digestWebStream(
  stream: ReadableStream<Uint8Array>,
  contentLength: number | null,
): Promise<FullFileDigest | 'short'> {
  const hash = createHash('sha1')
  let bytes = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      if (!step.value || step.value.byteLength === 0) continue
      hash.update(step.value)
      bytes += step.value.byteLength
    }
  } catch (err) {
    console.warn('[offload] raw body read failed:', err instanceof Error ? err.message : err)
    try { await reader.cancel() } catch (cancelErr) {
      console.warn('[offload] raw body cancel failed:', cancelErr instanceof Error ? cancelErr.message : cancelErr)
    }
    return 'short'
  }
  if (contentLength != null && contentLength !== bytes) return 'short'
  return { sha1: hash.digest('hex'), bytes }
}

export type RawOpen =
  | { ok: true; status: number; contentLength: number | null; stream: ReadableStream<Uint8Array> }
  | { ok: false; transportError: boolean; status: number }

export type RawMatch =
  | { ok: true; fullSha1: string; bytes: number }
  | { ok: false; reason: 'missing' | 'different' | 'unreachable' | 'transcode' }

/** Stop after the fingerprint window so a server that ignores Range cannot pull the master into RAM. */
export async function readPrefixBody(stream: ReadableStream<Uint8Array>, limit = FINGERPRINT_WINDOW): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let got = 0
  try {
    while (got < limit) {
      const step = await reader.read()
      if (step.done) break
      if (!step.value || step.value.byteLength === 0) continue
      const take = step.value.subarray(0, limit - got)
      chunks.push(Buffer.from(take))
      got += take.byteLength
    }
  } finally {
    if (got >= limit) {
      try { await reader.cancel() } catch (err) {
        console.warn('[offload] prefix cancel failed:', err instanceof Error ? err.message : err)
      }
    }
  }
  return Buffer.concat(chunks)
}

async function defaultFetchPrefix(url: string): Promise<HomeminiPrefixProbe> {
  if (urlAsksForTranscode(url)) return { transportError: false, status: 0, body: null }
  try {
    const res = await fetch(url, withCompanionInit({
      headers: { Range: 'bytes=0-262143' },
      signal: AbortSignal.timeout(8000),
    }))
    if ((!res.ok && res.status !== 206) || !res.body) {
      return { transportError: false, status: res.status, body: null }
    }
    const body = await readPrefixBody(res.body)
    return { transportError: false, status: res.status, body: body.length ? body : null }
  } catch {
    return { transportError: true, status: 0, body: null }
  }
}

async function defaultOpenRaw(url: string): Promise<RawOpen> {
  if (urlAsksForTranscode(url)) return { ok: false, transportError: false, status: 0 }
  try {
    const res = await fetch(url, withCompanionInit({
      signal: AbortSignal.timeout(FULL_BODY_TIMEOUT_MS),
    }))
    if (res.status === 404) return { ok: false, transportError: false, status: 404 }
    if (!res.ok || !res.body) {
      return { ok: false, transportError: !res.body && res.ok, status: res.status }
    }
    const n = Number(res.headers.get('content-length'))
    return {
      ok: true,
      status: res.status,
      contentLength: Number.isFinite(n) && n > 0 ? n : null,
      stream: res.body,
    }
  } catch {
    return { ok: false, transportError: true, status: 0 }
  }
}

async function compareOpened(
  url: string,
  localAbs: string,
  openRaw: (url: string) => Promise<RawOpen>,
  hashLocal: (abs: string) => Promise<FullFileDigest>,
): Promise<RawMatch> {
  if (urlAsksForTranscode(url)) return { ok: false, reason: 'transcode' }
  let local: FullFileDigest
  try {
    local = await hashLocal(localAbs)
  } catch (err) {
    console.warn('[offload] local hash failed:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'unreachable' }
  }
  let opened: RawOpen
  try {
    opened = await openRaw(url)
  } catch (err) {
    console.warn('[offload] raw open failed:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'unreachable' }
  }
  if (!opened.ok) {
    if (opened.transportError) return { ok: false, reason: 'unreachable' }
    if (opened.status === 404 || opened.status === 204) return { ok: false, reason: 'missing' }
    return { ok: false, reason: opened.status === 0 ? 'unreachable' : 'different' }
  }
  const remote = await digestWebStream(opened.stream, opened.contentLength)
  if (remote === 'short') return { ok: false, reason: 'unreachable' }
  if (remote.bytes <= 0) return { ok: false, reason: 'missing' }
  if (!fullBodiesMatch(local, remote)) return { ok: false, reason: 'different' }
  return { ok: true, fullSha1: remote.sha1, bytes: remote.bytes }
}

/**
 * Identity gate before any local file is replaced. Prefix sha1 is optional
 * and never sufficient. The URL is the raw /audio/:id body.
 */
export async function confirmRawHomeminiMatch(opts: {
  id: string | number
  localAbs: string
  storedFingerprint?: string
  audioBase: string
  fetchPrefix?: (url: string) => Promise<HomeminiPrefixProbe>
  openRaw?: (url: string) => Promise<RawOpen>
  hashLocal?: (abs: string) => Promise<FullFileDigest>
}): Promise<RawMatch> {
  const url = rawAudioUrl(opts.audioBase, opts.id)
  if (urlAsksForTranscode(opts.audioBase) || urlAsksForTranscode(url)) {
    return { ok: false, reason: 'transcode' }
  }
  const fetchPrefix = opts.fetchPrefix ?? defaultFetchPrefix
  const openRaw = opts.openRaw ?? defaultOpenRaw
  const hashLocal = opts.hashLocal ?? digestFile
  if (opts.storedFingerprint?.startsWith('sha1:')) {
    let probe: HomeminiPrefixProbe
    try {
      probe = await fetchPrefix(url)
    } catch {
      probe = { transportError: true, status: 0, body: null }
    }
    const kind = classifyProbe(opts.storedFingerprint, probe)
    if (kind === 'unreachable') return { ok: false, reason: 'unreachable' }
    if (kind === 'missing') return { ok: false, reason: 'missing' }
    if (kind === 'mismatch') return { ok: false, reason: 'different' }
  }
  return compareOpened(url, opts.localAbs, openRaw, hashLocal)
}

export async function compareLocalToRaw(opts: {
  localAbs: string
  id: string | number
  audioBase: string
  openRaw?: (url: string) => Promise<RawOpen>
  hashLocal?: (abs: string) => Promise<FullFileDigest>
}): Promise<FullCompare> {
  const url = rawAudioUrl(opts.audioBase, opts.id)
  if (urlAsksForTranscode(opts.audioBase) || urlAsksForTranscode(url)) return { kind: 'unreachable' }
  let localOk = true
  const match = await compareOpened(
    url,
    opts.localAbs,
    opts.openRaw ?? defaultOpenRaw,
    async (abs) => {
      try {
        return await (opts.hashLocal ?? digestFile)(abs)
      } catch (err) {
        localOk = false
        console.warn('[offload] local hash failed:', err instanceof Error ? err.message : err)
        throw err
      }
    },
  )
  if (!localOk) return { kind: 'unreadable' }
  if (match.ok) return { kind: 'match', sha1: match.fullSha1, bytes: match.bytes }
  if (match.reason === 'missing') return { kind: 'missing' }
  if (match.reason === 'different') return { kind: 'different' }
  return { kind: 'unreachable' }
}

export type HubSymlinkPlan =
  | { action: 'local' }
  | { action: 'homemini-by-id'; alacDecodeCache: boolean }

/**
 * Hub only. A replica never reaches this: it is a homemini client and
 * returns earlier. A real local file stays on disk. A symlink fetches
 * homemini by the id this hub published. ALAC uses the laptop decode
 * cache, not homemini ?fmt=flac and not the raw ALAC bytes.
 */
export function planHubSymlinkPlayback(opts: {
  offload: boolean
  isHomeminiClient: boolean
  isSymlink: boolean
  wantsAlacDecode: boolean
}): HubSymlinkPlan {
  if (opts.isHomeminiClient || !opts.offload || !opts.isSymlink) return { action: 'local' }
  return { action: 'homemini-by-id', alacDecodeCache: opts.wantsAlacDecode }
}

export async function serveHubOffloadSymlink(opts: {
  offload: boolean
  isHomeminiClient: boolean
  isSymlink: () => Promise<boolean>
  wantsAlac: boolean
  range: string | null
  rawPath: string
  trackId: () => Promise<string | number | null>
  serveAlac: (id: string | number, range: string | null) => Promise<Response>
  fetchById: (id: string | number, range: string | null) => Promise<Response | null>
}): Promise<Response | null> {
  if (!opts.offload || opts.isHomeminiClient) return null
  const link = await opts.isSymlink()
  const plan = planHubSymlinkPlayback({
    offload: true,
    isHomeminiClient: false,
    isSymlink: link,
    wantsAlacDecode: opts.wantsAlac,
  })
  if (plan.action === 'local') return null
  const id = await opts.trackId()
  if (id == null) {
    console.warn('[offload] symlink has no library id:', opts.rawPath.slice(0, 120))
    return new Response('Not Found', { status: 404 })
  }
  if (plan.alacDecodeCache) {
    try {
      return await opts.serveAlac(id, opts.range)
    } catch (err) {
      console.warn('[offload] streamed ALAC decode failed:', err instanceof Error ? err.message : err)
      return new Response('Unavailable', { status: 503 })
    }
  }
  const remote = await opts.fetchById(id, opts.range)
  if (remote) return remote
  console.warn(`[offload] homemini miss for symlink id=${id}`)
  return new Response('Unavailable', { status: 404 })
}
