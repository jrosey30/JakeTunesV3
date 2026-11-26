/**
 * Brief 266, suspect 2 (a): one song's AAC conversion fails while Apple's encoder is there.
 * buildAacMirror used to return null, which the activity engine reads as "nothing to
 * convert", so the lossless master went onto the AAC iPod with only a console.warn. Now the
 * failure is thrown (AacConvertFailedError) and the song is left off and named in leftOff,
 * like a song with no MP3 or no iPod-safe ALAC.
 *
 * The real engine on a fake card in a temp folder (the landed-record test's rig).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AacConvertFailedError, AacEncoderMissingError } from '../aac-mirror-recipe.ts'
import { runActivitySync, type ActivitySyncHost } from '../ipod-activity-engine.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const N = 6
const BAD = 3
const MASTER_BYTES = 1_000_000
const MIRROR_BYTES = 250_000
const DURATION_MS = 200_000

function emptyTemplate(): Buffer {
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(0, 8)
  const mhsd = Buffer.alloc(96); mhsd.write('mhsd', 0, 'latin1'); mhsd.writeUInt32LE(96, 4); mhsd.writeUInt32LE(96 + 92, 8); mhsd.writeUInt32LE(1, 12)
  const mhbd = Buffer.alloc(104); mhbd.write('mhbd', 0, 'latin1'); mhbd.writeUInt32LE(104, 4); mhbd.writeUInt32LE(104 + 96 + 92, 8); mhbd.writeUInt32LE(1, 20)
  return Buffer.concat([mhbd, mhsd, mhlt])
}
function readCatalogJson(dbPath: string): Promise<{ tracks: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [join(REPO, 'core', 'db_reader.py'), '--json', dbPath])
    let out = ''
    py.stdout.on('data', (d: Buffer) => { out += d.toString() })
    py.on('error', reject)
    py.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`db_reader --json ${code}`))))
  })
}

describe('the real activity engine: one song whose AAC conversion fails', () => {
  let root: string, lib: string, card: string, state: string, mirrors: string
  let host: ActivitySyncHost
  let failWith: (src: string) => Error | null = () => null
  const tracks: Array<Record<string, unknown>> = []
  const sync = () => runActivitySync(host, {
    tracks: tracks.map((t) => ({ ...t })), playlists: [{ name: 'Nano', trackIds: tracks.map((t) => t.id) }],
    requestedTarget: tracks.length, listOnly: true, ipodName: 'Nano',
    convertOptions: { enabled: true, targetKbps: 256, codec: 'aac' },
  })
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'b266-aac-fails-'))
    lib = join(root, 'lib'); card = join(root, 'card'); state = join(root, 'state'); mirrors = join(root, 'cache')
    for (const d of [join(card, 'iPod_Control', 'iTunes'), join(card, 'iPod_Control', 'Music'), state, mirrors]) await mkdir(d, { recursive: true })
    await writeFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'), emptyTemplate())
    for (let id = 1; id <= N; id++) {
      const f = `F${String(id % 3).padStart(2, '0')}`
      await mkdir(join(lib, 'iPod_Control', 'Music', f), { recursive: true })
      await writeFile(join(lib, 'iPod_Control', 'Music', f, `M${id}.m4a`), Buffer.alloc(MASTER_BYTES, id))
      tracks.push({ id, title: `Song ${id}`, artist: `Band ${id}`, album: 'A', genre: 'Rock', duration: DURATION_MS, codec: 'alac',
        path: `:iPod_Control:Music:${f}:M${id}.m4a`, audioFingerprint: `sha1:${id.toString(16).padStart(16, '0')}|${DURATION_MS}` })
    }
    host = {
      pythonCmd: 'python3', pythonHint: '', coreScript: (rel) => join(REPO, rel), tempDir: root, stateDir: state, pid: process.pid,
      musicDir: join(lib, 'iPod_Control', 'Music'), pathSep: '/', isMac: true, sendProgress: () => {}, isCancelled: () => false,
      isStreamedTrackFile: async () => false,
      // A stand-in for buildAacMirror: a smaller file per master, or the thrown failure the real one now gives.
      buildAacMirror: async (src) => {
        const err = failWith(src)
        if (err) throw err
        const out = join(mirrors, src.split('/').pop()!)
        await writeFile(out, Buffer.alloc(MIRROR_BYTES, 7))
        return out
      },
      buildIpodSafeAlacMirror: async () => null,
      readIpodDatabase: () => readCatalogJson(join(card, 'iPod_Control', 'iTunes', 'iTunesDB')),
      writeJournal: async () => {},
      writeManifest: async (m) => { await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify(m)) },
      writeSeal: async (s) => { await writeFile(join(state, 'ipod-activity-tsa-seal.json'), JSON.stringify(s)) },
      clearSeal: async () => {},
      writeReport: async () => {},
      getDetectedMount: () => card, setDetectedMount: () => {},
      probeHomeminiTrack: async () => ({ ok: false, error: 'not in this test' }),
      stageTrack: async () => ({ ok: false, error: 'not in this test', reason: 'other' } as never),
      freeBytes: async () => 500 * 1024 ** 3,
      remountVolume: async (m: string) => ({ ok: true, mountPoint: m }),
    }
  })
  after(async () => { await rm(root, { recursive: true, force: true }) })

  it('is left off and named; no lossless master goes on the card; the rest land', async () => {
    failWith = (src) => (src.endsWith(`M${BAD}.m4a`) ? new AacConvertFailedError(src, new Error('afconvert exited 1')) : null)
    const res = await sync()
    failWith = () => null
    assert.equal(res.ok, true, res.error)
    assert.equal(res.copied, N - 1)

    // Named, with a reason the Device page reads as "couldn't be converted" (leftOffKind 'damaged').
    const off = res.leftOff ?? []
    assert.deepEqual(off.map((l) => l.id), [BAD])
    assert.match(off[0].why, /converted/)

    // Nothing master-sized on the card: the master was never copied in its place.
    const onCard: Array<{ name: string; size: number }> = []
    for (const f of await readdir(join(card, 'iPod_Control', 'Music'))) {
      for (const n of await readdir(join(card, 'iPod_Control', 'Music', f))) {
        onCard.push({ name: n, size: (await stat(join(card, 'iPod_Control', 'Music', f, n))).size })
      }
    }
    assert.equal(onCard.length, N - 1)
    assert.deepEqual(onCard.filter((c) => c.size >= MASTER_BYTES), [], 'no lossless master went on the card')

    // The iPod's own song list doesn't carry it either.
    const db = await readCatalogJson(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    assert.ok(!db.tracks.some((t) => t.title === `Song ${BAD}`), 'not in the iPod catalog')
    assert.equal(db.tracks.length, N - 1)

    // And in sync history (the ledger the Device page reads).
    const lines = (await readFile(join(state, 'activity-sync-ledger.jsonl'), 'utf-8')).trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]) as { leftOff?: Array<{ id: number; t?: string; why?: string }> }
    assert.deepEqual((last.leftOff ?? []).map((l) => l.id), [BAD])
    assert.equal(last.leftOff![0].t, `Song ${BAD}`)
  })

  it('an encoder check that timed out is said as a timeout, never "isn\'t available"', async () => {
    // Stamped newer than its mirror so the landed record doesn't keep it without converting.
    const f = String(tracks[0].path).replace(/:/g, '/')
    await writeFile(join(lib, f), Buffer.alloc(MASTER_BYTES + 1, 2))
    failWith = (src) => new AacEncoderMissingError(src, 'unknown')
    const res = await sync()
    failWith = () => null
    assert.equal(res.ok, false)
    assert.match(String(res.error), /didn't answer in time/)
    assert.doesNotMatch(String(res.error), /isn't available/)
  })
})
