/**
 * Hub offload is not the replica role. streamSource stays empty, so the
 * MacBook keeps publishing library.json. The setting does not start the
 * bulk migration.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'crypto'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'
import { isHomeminiPlaybackClient } from '../stream-playback.ts'
import { libraryPublishTargets } from '../../common/replica-library-push.ts'
import { MATERIALIZE_FREE_FLOOR_BYTES } from '../ipod-sync-materialize.ts'
import {
  appendOffloadReplacement,
  bootOffloadIntent,
  decideReplacement,
  drainOffloadEnqueue,
  dryRunOffload,
  formatOffloadDryRun,
  hubOffloadActive,
  migrationResumeAction,
  parseReplacementLog,
  planHubSymlinkPlayback,
  readOffloadAudioFlag,
  rehydrateReplacements,
  sha1WindowMatches,
  stateForExplicitStart,
  streamConvertRuns,
  type OffloadEnqueueItem,
  type OffloadMigrationState,
  type OffloadReplacementRecord,
  type OffloadTrack,
} from '../offload-audio.ts'

function fpOf(body: Buffer, duration = 1000): string {
  const hash = createHash('sha1').update(body).digest('hex').slice(0, 16)
  return `sha1:${hash}|${duration}`
}

function fileStat(size: number) {
  return {
    isSymbolicLink: () => false,
    isFile: () => true,
    size,
  }
}

const linkStat = { isSymbolicLink: () => true, isFile: () => false, size: 0 }

describe('offload does not make the hub a replica', () => {
  test('a missing setting is off, and offload is not a homemini client', () => {
    assert.equal(readOffloadAudioFlag(null), false)
    assert.equal(readOffloadAudioFlag({}), false)
    assert.equal(readOffloadAudioFlag({ library: {} }), false)
    assert.equal(readOffloadAudioFlag({ library: { offloadAudioToHomemini: false } }), false)
    assert.equal(readOffloadAudioFlag({ library: { offloadAudioToHomemini: true } }), true)
    const client = isHomeminiPlaybackClient({ streamSource: null, streamRoot: null })
    assert.equal(client, false)
    assert.deepEqual(libraryPublishTargets(client), { nas: true, hub: true })
    assert.equal(hubOffloadActive({ streamSource: null, offload: true }), true)
    assert.equal(hubOffloadActive({ streamSource: 'homemini', offload: true }), false)
    const playback = readFileSync(new URL('../stream-playback.ts', import.meta.url), 'utf8')
    assert.equal(playback.includes('offloadAudioToHomemini'), false)
  })

  test('stream-convert runs for the hub setting and still runs for a replica', () => {
    assert.equal(streamConvertRuns({ streamSource: null, offload: false }), false)
    assert.equal(streamConvertRuns({ streamSource: null, offload: true }), true)
    assert.equal(streamConvertRuns({ streamSource: 'homemini', offload: false }), true)
  })

  test('the setting alone does not start a migration; a recorded start resumes', () => {
    const started: OffloadMigrationState = { startedAt: 't', phase: 'enqueueing', cursor: 4 }
    assert.equal(bootOffloadIntent([], null, 0, true), 'none')
    assert.equal(bootOffloadIntent([], started, 0, false), 'none')
    assert.equal(bootOffloadIntent(['--offload-dry-run'], null, 0, false), 'dry-run')
    assert.equal(bootOffloadIntent(['--offload-start'], null, 0, false), 'start')
    assert.equal(bootOffloadIntent([], started, 0, true), 'resume')
    assert.equal(migrationResumeAction({ startedAt: 't', phase: 'converting', cursor: 9 }, 3), 'convert')
    assert.equal(migrationResumeAction({ startedAt: 't', phase: 'converting', cursor: 9 }, 0), 'idle')
    assert.equal(migrationResumeAction(null, 12), 'idle')
    const mid = stateForExplicitStart(started, 'later', 0)
    assert.equal(mid.cursor, 4)
    const again = stateForExplicitStart({ startedAt: 't', phase: 'done', cursor: 9 }, 'later', 0)
    assert.equal(again.cursor, 0)
    assert.equal(again.phase, 'enqueueing')
  })
})

describe('hub symlink playback fetches homemini by id', () => {
  test('a real file stays local; a symlink uses homemini, and ALAC uses the decode cache', () => {
    assert.deepEqual(planHubSymlinkPlayback({
      offload: true, isHomeminiClient: false, isSymlink: false, wantsAlacDecode: true,
    }), { action: 'local' })
    assert.deepEqual(planHubSymlinkPlayback({
      offload: false, isHomeminiClient: false, isSymlink: true, wantsAlacDecode: true,
    }), { action: 'local' })
    assert.deepEqual(planHubSymlinkPlayback({
      offload: true, isHomeminiClient: true, isSymlink: true, wantsAlacDecode: true,
    }), { action: 'local' })
    assert.deepEqual(planHubSymlinkPlayback({
      offload: true, isHomeminiClient: false, isSymlink: true, wantsAlacDecode: false,
    }), { action: 'homemini-by-id', alacDecodeCache: false })
    assert.deepEqual(planHubSymlinkPlayback({
      offload: true, isHomeminiClient: false, isSymlink: true, wantsAlacDecode: true,
    }), { action: 'homemini-by-id', alacDecodeCache: true })
  })
})

describe('replacement requires a sha1 match', () => {
  test('homemini bytes must match the local window before a replace', () => {
    const body = Buffer.from('local-master-window')
    const fp = fpOf(body)
    assert.equal(sha1WindowMatches(fp, body), true)
    assert.equal(decideReplacement(fp, body), 'replace')
    assert.equal(decideReplacement(fp, Buffer.from('other-song')), 'keep')
    assert.equal(decideReplacement(fp, null), 'keep')
    assert.equal(decideReplacement(undefined, body), 'keep')
  })
})

describe('dry run reports and does not replace', () => {
  test('counts bytes, matches, and misses', async () => {
    const matchBody = Buffer.from('song-a')
    const missBody = Buffer.from('song-c-remote')
    const localC = Buffer.from('song-c-local')
    const tracks: OffloadTrack[] = [
      { id: 1, path: ':iPod_Control:Music:F00:a.m4a', codec: 'alac', audioFingerprint: fpOf(matchBody) },
      { id: 2, path: ':iPod_Control:Music:F00:b.m4a', codec: 'alac', audioFingerprint: fpOf(Buffer.from('song-b')) },
      { id: 3, path: ':iPod_Control:Music:F00:c.mp3', codec: 'mp3', audioFingerprint: fpOf(localC) },
      { id: 4, path: ':iPod_Control:Music:F00:d.m4a', codec: 'alac' },
      { id: 5, path: ':iPod_Control:Music:F00:e.m4a', codec: 'alac', audioFingerprint: fpOf(Buffer.from('gone')) },
    ]
    const sizes: Record<string, number> = {
      ':iPod_Control:Music:F00:a.m4a': 1_500_000_000,
      ':iPod_Control:Music:F00:b.m4a': 500_000_000,
      ':iPod_Control:Music:F00:c.mp3': 10_000_000,
      ':iPod_Control:Music:F00:d.m4a': 1000,
    }
    let replaced = 0
    const report = await dryRunOffload({
      tracks,
      colonToAbs: (c) => c,
      lstat: async (abs) => {
        if (abs.endsWith('e.m4a')) return linkStat
        if (!sizes[abs]) throw new Error('missing')
        return fileStat(sizes[abs])
      },
      hashPrefix: async () => null,
      probe: async (id) => {
        if (id === 1) return { transportError: false, status: 206, body: matchBody }
        if (id === 2) return { transportError: false, status: 404, body: null }
        if (id === 3) return { transportError: false, status: 206, body: missBody }
        replaced++
        return { transportError: false, status: 200, body: Buffer.from('nope') }
      },
      sleep: async () => {},
      probeBatch: 100,
      pauseMs: 0,
    })
    assert.equal(replaced, 0)
    assert.equal(report.count, 4)
    assert.equal(report.bytes, 1_500_000_000 + 500_000_000 + 10_000_000 + 1000)
    assert.equal(report.gb, 2.0)
    assert.equal(report.alacCount, 3)
    assert.equal(report.matchingOnHomemini, 1)
    assert.equal(report.missingOnHomemini, 2)
    assert.equal(report.hashMismatch, 1)
    assert.equal(report.needsFingerprint, 1)
    assert.equal(report.alreadyStreamed, 1)
    assert.match(formatOffloadDryRun(report), /matching sha1: 1/)
    assert.match(formatOffloadDryRun(report), /Missing on homemini: 2/)
  })

  test('an unreachable homemini is not counted as missing', async () => {
    const body = Buffer.from('only')
    const tracks: OffloadTrack[] = [
      { id: 1, path: ':a.m4a', codec: 'alac', audioFingerprint: fpOf(body) },
      { id: 2, path: ':b.m4a', codec: 'alac', audioFingerprint: fpOf(body) },
    ]
    let probes = 0
    const report = await dryRunOffload({
      tracks,
      colonToAbs: (c) => c,
      lstat: async () => fileStat(10),
      hashPrefix: async () => null,
      probe: async () => {
        probes++
        return { transportError: true, status: 0, body: null }
      },
      sleep: async () => {},
    })
    assert.equal(probes, 1)
    assert.equal(report.missingOnHomemini, 0)
    assert.equal(report.matchingOnHomemini, 0)
    assert.equal(report.stoppedBecause, 'homemini-unreachable')
    assert.equal(report.notProbed, 2)
    assert.equal(report.count, 2)
  })
})

describe('explicit enqueue is throttled and resumable', () => {
  test('a batch pauses, and a restart continues at the cursor', async () => {
    const body = Buffer.from('queued')
    const fp = fpOf(body)
    const tracks: OffloadTrack[] = [
      { id: 1, path: ':a.m4a', codec: 'alac', audioFingerprint: fp },
      { id: 2, path: ':b.m4a', codec: 'alac' },
      { id: 3, path: ':c.m4a', codec: 'alac', audioFingerprint: fp },
    ]
    const queued: OffloadEnqueueItem[] = []
    let pauses = 0
    let saved: OffloadMigrationState | null = null
    const state = await drainOffloadEnqueue({
      tracks,
      state: { startedAt: 't', phase: 'enqueueing', cursor: 0 },
      batchSize: 1,
      pauseMs: 5,
      hashPauseMs: 0,
      colonToAbs: (c) => c,
      lstat: async (abs) => abs.endsWith('b.m4a') ? linkStat : fileStat(10),
      hashFile: async () => { throw new Error('symlink must not be hashed') },
      enqueue: async (items) => { queued.push(...items) },
      saveState: async (s) => { saved = s },
      sleep: async () => { pauses++ },
      now: () => 1,
    })
    assert.equal(state.phase, 'converting')
    assert.equal(queued.length, 2)
    assert.equal(queued[0].ipodPath, ':a.m4a')
    assert.equal(queued[1].ipodPath, ':c.m4a')
    assert.ok(pauses >= 2)
    assert.ok(saved)

    const second: OffloadEnqueueItem[] = []
    await drainOffloadEnqueue({
      tracks,
      state: { startedAt: 't', phase: 'enqueueing', cursor: 1 },
      batchSize: 10,
      pauseMs: 0,
      hashPauseMs: 0,
      colonToAbs: (c) => c,
      lstat: async () => fileStat(10),
      hashFile: async () => fp,
      enqueue: async (items) => { second.push(...items) },
      saveState: async () => {},
      sleep: async () => {},
      now: () => 2,
    })
    assert.deepEqual(second.map((i) => i.ipodPath), [':b.m4a', ':c.m4a'])
  })
})

describe('undo log and free-space floor', () => {
  test('a replacement round-trips through JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-offload-'))
    const record: OffloadReplacementRecord = {
      ts: '2026-10-09T00:00:00.000Z',
      id: 16,
      path: ':iPod_Control:Music:F00:a.m4a',
      fingerprint: 'sha1:abcdabcdabcdabcd|1000',
      bytes: 42,
      sentinel: '/library/.jt-streamed',
    }
    await appendOffloadReplacement(dir, record)
    const parsed = parseReplacementLog(await readFile(join(dir, 'offload-replacements.jsonl'), 'utf-8'))
    assert.deepEqual(parsed, [record])
    const script = readFileSync(new URL('../../../scripts/offload-rehydrate.ts', import.meta.url), 'utf8')
    assert.match(script, /rehydrateReplacements/)
    assert.doesNotMatch(script, /from '\.\.\/core\//)
  })

  test('rehydrate stops when the write would cross the floor, and writes when it fits', async () => {
    const body = Buffer.from('restored-bytes')
    const record: OffloadReplacementRecord = {
      ts: 't', id: 9, path: ':a.m4a', fingerprint: fpOf(body), bytes: body.length, sentinel: '/.jt-streamed',
    }
    let writes = 0
    const blocked = await rehydrateReplacements({
      records: [record],
      freeBytes: async () => MATERIALIZE_FREE_FLOOR_BYTES,
      fetchFull: async () => body,
      currentKind: async () => 'symlink',
      writeBack: async () => { writes++ },
    })
    assert.equal(writes, 0)
    assert.equal(blocked.restored, 0)
    assert.match(blocked.stoppedBecause || '', /free disk/)

    const written: Buffer[] = []
    const ok = await rehydrateReplacements({
      records: [record, { ...record, id: 10, fingerprint: 'sha1:0000000000000000|1' }],
      freeBytes: async () => MATERIALIZE_FREE_FLOOR_BYTES + body.length + 1,
      fetchFull: async () => body,
      currentKind: async () => 'symlink',
      writeBack: async (_r, bytes) => { written.push(bytes) },
    })
    assert.equal(ok.stoppedBecause, null)
    assert.equal(ok.restored, 1)
    assert.equal(ok.skipped, 1)
    assert.equal(written.length, 1)
  })
})

describe('index wires hub offload without the replica boot scan', () => {
  test('publish stays on the replica gate, and the ALAC boot scan stays streamSource-only', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const scanAt = index.indexOf('await planLocalAlacMigration')
    assert.ok(scanAt > 0)
    const beforeScan = index.slice(Math.max(0, scanAt - 1200), scanAt)
    assert.match(beforeScan, /readStreamSource\(\)\) !== 'homemini'/)
    assert.match(index, /bootHubOffload\(/)
    assert.match(index, /serveHubOffloadSymlink\(/)
    assert.match(index, /streamConvertRuns\(/)
    const handler = index.slice(index.indexOf("protocol.handle('ipod-audio'"))
    const serveAt = handler.indexOf('serveHubOffloadSymlink')
    const containedAt = handler.indexOf('await resolveContainedPath')
    assert.ok(serveAt > 0 && containedAt > serveAt, 'hub symlink fetch must run before realpath')
    assert.match(index, /setBlocksHubLibraryPublish/)
    assert.match(index, /libraryPublishTargets\(await isHomeminiPlaybackClientCached\(\)\)/)
  })
})
