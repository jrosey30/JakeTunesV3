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
import { colonPathToAbs } from '../activity-boardable.ts'
import {
  appendOffloadReplacement,
  readPrefixBody,
  bootOffloadIntent,
  confirmRawHomeminiMatch,
  decideReplacement,
  digestBuffer,
  drainOffloadEnqueue,
  dryRunOffload,
  formatOffloadDryRun,
  hubOffloadActive,
  libraryRootFromMusicDir,
  migrationResumeAction,
  parseReplacementLog,
  planHubSymlinkPlayback,
  rawAudioUrl,
  readOffloadAudioFlag,
  rehydrateBytesOk,
  rehydrateReplacements,
  resolveOffloadLibraryRoot,
  sha1WindowMatches,
  stateForExplicitStart,
  streamConvertRuns,
  urlAsksForTranscode,
  type OffloadEnqueueItem,
  type OffloadMigrationState,
  type OffloadReplacementRecord,
  type OffloadTrack,
} from '../offload-audio.ts'

function fpOf(body: Buffer, duration = 1000): string {
  const hash = createHash('sha1').update(body.subarray(0, Math.min(body.length, 256 * 1024))).digest('hex').slice(0, 16)
  return `sha1:${hash}|${duration}`
}

function fullOf(body: Buffer): string {
  return createHash('sha1').update(body).digest('hex')
}

function streamOf(body: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(body)
      controller.close()
    },
  })
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

describe('replacement requires a full-file sha1 and size', () => {
  test('a shared 256KB prefix is not enough to replace', () => {
    const head = Buffer.alloc(256 * 1024, 7)
    const local = Buffer.concat([head, Buffer.from('local-tail')])
    const remote = Buffer.concat([head, Buffer.from('remote-tail')])
    const fp = fpOf(local)
    assert.equal(sha1WindowMatches(fp, remote), true)
    assert.equal(decideReplacement({
      storedFingerprint: fp,
      remotePrefix: remote.subarray(0, 256 * 1024),
    }), 'keep')
    assert.equal(decideReplacement({
      storedFingerprint: fp,
      remotePrefix: remote.subarray(0, 256 * 1024),
      local: digestBuffer(local),
      remote: digestBuffer(remote),
    }), 'keep')
    assert.equal(decideReplacement({
      storedFingerprint: fp,
      remotePrefix: remote.subarray(0, 256 * 1024),
      local: digestBuffer(local),
      remote: digestBuffer(local),
    }), 'replace')
    assert.equal(fullOf(local).length, 40)
  })

  test('the compared URL is the raw audio body', async () => {
    const body = Buffer.from('stored-alac-bytes')
    const urls: string[] = []
    const match = await confirmRawHomeminiMatch({
      id: 'track 1',
      localAbs: '/library/a.m4a',
      storedFingerprint: fpOf(body),
      audioBase: 'http://homemini:3000/audio',
      fetchPrefix: async (url) => {
        urls.push(url)
        return { transportError: false, status: 206, body }
      },
      openRaw: async (url) => {
        urls.push(url)
        return { ok: true, status: 200, contentLength: body.length, stream: streamOf(body) }
      },
      hashLocal: async () => digestBuffer(body),
    })
    assert.deepEqual(match, { ok: true, fullSha1: fullOf(body), bytes: body.length })
    assert.deepEqual(urls, [
      'http://homemini:3000/audio/track%201',
      'http://homemini:3000/audio/track%201',
    ])
    for (const url of urls) assert.equal(urlAsksForTranscode(url), false)
    assert.equal(rawAudioUrl('http://homemini:3000/audio/', 9), 'http://homemini:3000/audio/9')
    assert.equal(urlAsksForTranscode('http://homemini:3000/audio/9?fmt=flac'), true)
    assert.equal(urlAsksForTranscode('http://homemini:3000/audio/9?fmt=aac&kbps=256'), true)

    let opened = 0
    const transcode = await confirmRawHomeminiMatch({
      id: 9,
      localAbs: '/library/a.m4a',
      storedFingerprint: fpOf(body),
      audioBase: 'http://homemini:3000/audio?fmt=flac',
      fetchPrefix: async () => { opened++; return { transportError: false, status: 206, body } },
      openRaw: async () => { opened++; return { ok: false, transportError: true, status: 0 } },
      hashLocal: async () => digestBuffer(body),
    })
    assert.deepEqual(transcode, { ok: false, reason: 'transcode' })
    assert.equal(opened, 0)

    const src = readFileSync(new URL('../offload-audio.ts', import.meta.url), 'utf8')
    assert.equal(src.includes('fetchAudioFromHomemini'), false)
    assert.equal(src.includes('stream-alac-cache'), false)
    assert.match(src, /urlAsksForTranscode/)

    let pulls = 0
    const capped = await readPrefixBody(new ReadableStream({
      pull(controller) {
        pulls++
        if (pulls > 4) {
          controller.enqueue(Buffer.alloc(100))
          return
        }
        controller.enqueue(Buffer.alloc(100, pulls))
      },
    }), 250)
    assert.equal(capped.length, 250)
    assert.ok(pulls < 8)
  })

  test('prefix mismatch skips the full download; a short body is unreachable', async () => {
    const local = Buffer.from('local-master-window')
    let opened = 0
    const different = await confirmRawHomeminiMatch({
      id: 3,
      localAbs: '/library/a.m4a',
      storedFingerprint: fpOf(local),
      audioBase: 'http://homemini:3000/audio',
      fetchPrefix: async () => ({ transportError: false, status: 206, body: Buffer.from('other-song') }),
      openRaw: async () => { opened++; return { ok: false, transportError: true, status: 0 } },
      hashLocal: async () => digestBuffer(local),
    })
    assert.deepEqual(different, { ok: false, reason: 'different' })
    assert.equal(opened, 0)

    const missing = await confirmRawHomeminiMatch({
      id: 4,
      localAbs: '/library/a.m4a',
      storedFingerprint: fpOf(local),
      audioBase: 'http://homemini:3000/audio',
      fetchPrefix: async () => ({ transportError: false, status: 404, body: null }),
      openRaw: async () => { opened++; return { ok: false, transportError: true, status: 0 } },
      hashLocal: async () => digestBuffer(local),
    })
    assert.deepEqual(missing, { ok: false, reason: 'missing' })
    assert.equal(opened, 0)

    const short = await confirmRawHomeminiMatch({
      id: 5,
      localAbs: '/library/a.m4a',
      storedFingerprint: fpOf(local),
      audioBase: 'http://homemini:3000/audio',
      fetchPrefix: async () => ({ transportError: false, status: 206, body: local }),
      openRaw: async () => ({
        ok: true,
        status: 200,
        contentLength: local.length + 50,
        stream: streamOf(local),
      }),
      hashLocal: async () => digestBuffer(local),
    })
    assert.deepEqual(short, { ok: false, reason: 'unreachable' })

    const reset = await confirmRawHomeminiMatch({
      id: 6,
      localAbs: '/library/a.m4a',
      storedFingerprint: fpOf(local),
      audioBase: 'http://homemini:3000/audio',
      fetchPrefix: async () => ({ transportError: false, status: 206, body: local }),
      openRaw: async () => ({
        ok: true,
        status: 200,
        contentLength: null,
        stream: new ReadableStream({ pull(controller) { controller.error(new Error('reset')) } }),
      }),
      hashLocal: async () => digestBuffer(local),
    })
    assert.deepEqual(reset, { ok: false, reason: 'unreachable' })
  })
})

describe('dry run reports and does not replace', () => {
  test('counts full-hash matches, missing, and different separately', async () => {
    const matchBody = Buffer.from('song-a')
    const localC = Buffer.from('song-c-local')
    const samePrefix = Buffer.from('song-f-prefix')
    const tracks: OffloadTrack[] = [
      { id: 1, path: ':iPod_Control:Music:F00:a.m4a', codec: 'alac', audioFingerprint: fpOf(matchBody) },
      { id: 2, path: ':iPod_Control:Music:F00:b.m4a', codec: 'alac', audioFingerprint: fpOf(Buffer.from('song-b')) },
      { id: 3, path: ':iPod_Control:Music:F00:c.mp3', codec: 'mp3', audioFingerprint: fpOf(localC) },
      { id: 4, path: ':iPod_Control:Music:F00:d.m4a', codec: 'alac' },
      { id: 5, path: ':iPod_Control:Music:F00:e.m4a', codec: 'alac', audioFingerprint: fpOf(Buffer.from('gone')) },
      { id: 6, path: ':iPod_Control:Music:F00:f.m4a', codec: 'alac', audioFingerprint: fpOf(samePrefix) },
    ]
    const sizes: Record<string, number> = {
      ':iPod_Control:Music:F00:a.m4a': 1_500_000_000,
      ':iPod_Control:Music:F00:b.m4a': 500_000_000,
      ':iPod_Control:Music:F00:c.mp3': 2_000_000_000,
      ':iPod_Control:Music:F00:d.m4a': 1000,
      ':iPod_Control:Music:F00:f.m4a': 3_000_000_000,
    }
    const fullCalls: Array<string | number> = []
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
        if (id === 3) return { transportError: false, status: 206, body: Buffer.from('song-c-remote') }
        if (id === 6) return { transportError: false, status: 206, body: samePrefix }
        return { transportError: false, status: 200, body: Buffer.from('present-but-unreadable') }
      },
      confirmFull: async (_abs, id) => {
        fullCalls.push(id)
        if (id === 1) return { kind: 'match', sha1: fullOf(matchBody), bytes: matchBody.length }
        if (id === 6) return { kind: 'different' }
        return { kind: 'unreadable' }
      },
      sleep: async () => {},
      probeBatch: 100,
      pauseMs: 0,
    })
    assert.deepEqual(fullCalls, [1, 4, 6])
    assert.equal(report.count, 5)
    assert.equal(report.bytes, 1_500_000_000 + 500_000_000 + 2_000_000_000 + 1000 + 3_000_000_000)
    assert.equal(report.gb, 7.0)
    assert.equal(report.alacCount, 4)
    assert.equal(report.alacGb, 5.0)
    assert.equal(report.matchingOnHomemini, 1)
    assert.equal(report.matchingBytes, 1_500_000_000)
    assert.equal(report.matchingGb, 1.5)
    assert.equal(report.missingOnHomemini, 1)
    assert.equal(report.missingBytes, 500_000_000)
    assert.equal(report.missingGb, 0.5)
    assert.equal(report.differentOnHomemini, 2)
    assert.equal(report.differentBytes, 5_000_000_000)
    assert.equal(report.differentGb, 5.0)
    assert.equal(report.needsFingerprint, 1)
    assert.equal(report.alreadyStreamed, 1)
    const text = formatOffloadDryRun(report)
    assert.match(text, /full sha1 matches: 1 \(1\.5 GB\)/)
    assert.match(text, /Missing on homemini \(rsync these first\): 1 \(0\.5 GB\)/)
    assert.match(text, /Different on homemini \(kept local\): 2 \(5 GB\)/)
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
      confirmFull: async () => { throw new Error('must not download') },
      sleep: async () => {},
    })
    assert.equal(probes, 1)
    assert.equal(report.missingOnHomemini, 0)
    assert.equal(report.differentOnHomemini, 0)
    assert.equal(report.matchingOnHomemini, 0)
    assert.equal(report.stoppedBecause, 'homemini-unreachable')
    assert.equal(report.notProbed, 2)
    assert.equal(report.count, 2)
  })

  test('a dropped full-body read stops the scan instead of marking the rest missing', async () => {
    const body = Buffer.from('only')
    const tracks: OffloadTrack[] = [
      { id: 1, path: ':a.m4a', codec: 'alac', audioFingerprint: fpOf(body) },
      { id: 2, path: ':b.m4a', codec: 'alac', audioFingerprint: fpOf(body) },
    ]
    let fulls = 0
    const report = await dryRunOffload({
      tracks,
      colonToAbs: (c) => c,
      lstat: async () => fileStat(2_000_000_000),
      hashPrefix: async () => null,
      probe: async () => ({ transportError: false, status: 206, body }),
      confirmFull: async () => {
        fulls++
        return { kind: 'unreachable' }
      },
      sleep: async () => {},
    })
    assert.equal(fulls, 1)
    assert.equal(report.missingOnHomemini, 0)
    assert.equal(report.differentOnHomemini, 0)
    assert.equal(report.stoppedBecause, 'homemini-unreachable')
    assert.equal(report.notProbed, 2)
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
    assert.match(script, /Music2/)
    assert.match(script, /app-settings/)
    assert.doesNotMatch(script, /\$HOME\/Music\/JakeTunesLibrary/)
    assert.doesNotMatch(script, /from '\.\.\/core\//)
  })

  test('rehydrate verifies the full sha1 and stops at the free-space floor', async () => {
    const body = Buffer.from('restored-bytes')
    const record: OffloadReplacementRecord = {
      ts: 't', id: 9, path: ':a.m4a', fingerprint: fpOf(body),
      bytes: body.length, fullSha1: fullOf(body), sentinel: '/.jt-streamed',
    }
    assert.equal(rehydrateBytesOk(record, body), true)
    assert.equal(rehydrateBytesOk({ ...record, fullSha1: undefined }, body), false)
    assert.equal(rehydrateBytesOk({ ...record, bytes: body.length + 1 }, body), false)
    assert.equal(rehydrateBytesOk({ ...record, fullSha1: fullOf(Buffer.from('other')) }, body), false)

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
    const prefixOnly: OffloadReplacementRecord = {
      ...record, id: 10, fullSha1: undefined,
    }
    const ok = await rehydrateReplacements({
      records: [record, prefixOnly],
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

describe('hub library root is Music2', () => {
  test('colon paths resolve under ~/Music2/JakeTunesLibrary', () => {
    const musicDir = '/Users/jake/Music2/JakeTunesLibrary/iPod_Control/Music'
    const root = libraryRootFromMusicDir(musicDir)
    assert.equal(root, '/Users/jake/Music2/JakeTunesLibrary')
    assert.equal(
      colonPathToAbs(':iPod_Control:Music:F00:x.m4a', root, '/'),
      '/Users/jake/Music2/JakeTunesLibrary/iPod_Control/Music/F00/x.m4a',
    )
    const bare = libraryRootFromMusicDir('/Users/jake/Music2')
    assert.equal(bare, '/Users/jake/Music2')
    assert.equal(
      colonPathToAbs(':iPod_Control:Music:F00:x.m4a', bare, '/'),
      '/Users/jake/Music2/iPod_Control/Music/F00/x.m4a',
    )
  })

  test('settings win, then Music2, and an explicit root overrides both', () => {
    const home = '/Users/jake'
    const trees = new Set([
      '/Users/jake/Music2/JakeTunesLibrary/iPod_Control/Music',
      '/Users/jake/Music/JakeTunesLibrary/iPod_Control/Music',
    ])
    const exists = (abs: string) => trees.has(abs)
    assert.equal(resolveOffloadLibraryRoot({
      settingsMusicRoot: '/Users/jake/Music2/JakeTunesLibrary',
      home,
      exists,
    }), '/Users/jake/Music2/JakeTunesLibrary')
    assert.equal(resolveOffloadLibraryRoot({
      settingsMusicRoot: '/Users/jake/Music/JakeTunesLibrary',
      home,
      exists: () => false,
    }), join(home, 'Music2', 'JakeTunesLibrary'))
    assert.equal(resolveOffloadLibraryRoot({
      settingsMusicRoot: '/Users/jake/Music2',
      home,
      exists: (abs) => abs === '/Users/jake/Music2/JakeTunesLibrary/iPod_Control/Music',
    }), '/Users/jake/Music2/JakeTunesLibrary')
    assert.equal(resolveOffloadLibraryRoot({
      home,
      exists: (abs) => abs === '/Users/jake/Music2/JakeTunesLibrary/iPod_Control/Music',
    }), '/Users/jake/Music2/JakeTunesLibrary')
    assert.equal(resolveOffloadLibraryRoot({
      explicit: '/Users/jake/Music2/JakeTunesLibrary/iPod_Control/Music',
      settingsMusicRoot: '/Users/jake/Music/JakeTunesLibrary',
      home,
      exists,
    }), '/Users/jake/Music2/JakeTunesLibrary')
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
    assert.match(index, /confirmRawHomeminiMatch\(/)
    assert.equal(index.includes('homeminiServesMatchingBytes'), false)
    assert.equal(index.includes('bytes=0-262143'), false)
    assert.match(index, /fullSha1: match\.fullSha1/)
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
