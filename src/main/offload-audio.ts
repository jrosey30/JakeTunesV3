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
 * A local file is replaced only when decideReplacement says homemini
 * served the same sha1 window computeAudioFingerprint uses. Every
 * replacement is one JSONL line so scripts/offload-rehydrate.ts can
 * pull the bytes back, stopping at the 10 GB free-space floor.
 */

import { createHash } from 'crypto'
import { join } from 'path'
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
  fingerprint: string
  bytes: number
  sentinel: string
}

export interface OffloadDryRunReport {
  count: number
  bytes: number
  /** Decimal GB (bytes / 1e9), one place. */
  gb: number
  alacCount: number
  alacBytes: number
  alacGb: number
  matchingOnHomemini: number
  /** 404, empty body, or sha1 mismatch. Not safe to replace. */
  missingOnHomemini: number
  hashMismatch: number
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

/** sha1 of the first 256KB, same window as computeAudioFingerprint / homeminiServesMatchingBytes. */
export function sha1WindowMatches(storedFingerprint: string | undefined, remotePrefix: Buffer | null): boolean {
  if (!storedFingerprint || !storedFingerprint.startsWith('sha1:')) return false
  if (!remotePrefix || remotePrefix.length <= 0) return false
  const want = storedFingerprint.split('|')[0].slice('sha1:'.length)
  const window = remotePrefix.subarray(0, Math.min(remotePrefix.length, 256 * 1024))
  const got = createHash('sha1').update(window).digest('hex').slice(0, 16)
  return got === want
}

/** The only yes that may drop local bytes. */
export function decideReplacement(
  storedFingerprint: string | undefined,
  remotePrefix: Buffer | null,
): 'replace' | 'keep' {
  return sha1WindowMatches(storedFingerprint, remotePrefix) ? 'replace' : 'keep'
}

export function classifyProbe(
  fingerprint: string | null,
  probe: HomeminiPrefixProbe,
): 'match' | 'missing' | 'mismatch' | 'unreachable' | 'no-fingerprint' {
  if (!fingerprint) return 'no-fingerprint'
  if (probe.transportError) return 'unreachable'
  if (!probe.body || probe.body.length <= 0 || (probe.status !== 200 && probe.status !== 206)) return 'missing'
  return sha1WindowMatches(fingerprint, probe.body) ? 'match' : 'mismatch'
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
    missingOnHomemini: 0,
    hashMismatch: 0,
    needsFingerprint: 0,
    alreadyStreamed: 0,
    notProbed: 0,
    stoppedBecause: null,
  }
}

function finishReport(report: OffloadDryRunReport): OffloadDryRunReport {
  report.gb = Number((report.bytes / 1e9).toFixed(1))
  report.alacGb = Number((report.alacBytes / 1e9).toFixed(1))
  return report
}

export function formatOffloadDryRun(report: OffloadDryRunReport): string {
  const lines = [
    'Offload dry run. No files were changed.',
    `Local files: ${report.count} (${report.gb} GB)`,
    `ALAC: ${report.alacCount} (${report.alacGb} GB)`,
    `Homemini already serves a matching sha1: ${report.matchingOnHomemini}`,
    `Missing on homemini: ${report.missingOnHomemini}`,
    `Hash mismatch (included in missing): ${report.hashMismatch}`,
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

export async function dryRunOffload(opts: {
  tracks: OffloadTrack[]
  lstat: (abs: string) => Promise<StatLike>
  colonToAbs: (colon: string) => string
  hashPrefix: (abs: string, durationMs: number) => Promise<string | null>
  probe: (id: string | number) => Promise<HomeminiPrefixProbe>
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
      fp = await opts.hashPrefix(opts.colonToAbs(colon), Number(t.duration) || 0)
      if (hashPauseMs) await opts.sleep(hashPauseMs)
      if (!fp || !fp.startsWith('sha1:')) {
        report.needsFingerprint++
        continue
      }
    }
    if (t.id == null || t.id === '') {
      report.missingOnHomemini++
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
    if (kind === 'match') report.matchingOnHomemini++
    else if (kind === 'mismatch') {
      report.hashMismatch++
      report.missingOnHomemini++
    } else report.missingOnHomemini++
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

/**
 * Pull logged files back onto the library path. Refuses a write that
 * would leave less than the sync floor free. Refuses bytes whose first
 * 256KB do not match the logged fingerprint.
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
    if (!bytes || bytes.length <= 0 || !sha1WindowMatches(record.fingerprint, bytes)) {
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
