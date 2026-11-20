/**
 * An iPod that drops off USB mid-copy (Brief 259, 2026-11-20).
 *
 * Jake's Y2K iPod (a 3G) reset its USB link eight minutes into an Activity
 * Sync: the rest of the copies failed with EIO, and the engine stopped and took
 * the 366 songs it had copied off again. Here the same thing happens to a FAKE
 * card in a temp folder (the swap tests' rig: the real engine, the real
 * catalog writer and validator, only the cold remount stubbed): the card is
 * renamed away mid-copy and the copy throws EIO; a fake clock runs the
 * two-minute wait in no time. Never touches an iPod.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runActivitySync, type ActivitySyncHost, type ActivitySyncResult } from '../ipod-activity-engine.ts'
import {
  DROP_BACK_LINE, OLD_IPOD_PAUSE_EVERY_BYTES, PARTIAL_ON_CARD_FILE, adoptFromPartial, buildPartialOnCard, looksLikeDrop,
  pacesWrites, parsePartialOnCard, sameIpod, waitForSameIpod, type IpodCardIdentity,
} from '../ipod-sync-drop.ts'
import { DROP_KEPT_MARK, syncFailureCopy, syncOutcome } from '../../common/sync-failure-copy.ts'
import { parseCatalogPaths } from '../sync-engine/roundtrip.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const N = 12
const SONG_BYTES = 250_000
const DURATION_MS = 200_000
const MARKER = 'y2kpod-0001'

function emptyTemplate(): Buffer {
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(0, 8)
  const mhsd = Buffer.alloc(96); mhsd.write('mhsd', 0, 'latin1'); mhsd.writeUInt32LE(96, 4); mhsd.writeUInt32LE(96 + 92, 8); mhsd.writeUInt32LE(1, 12)
  const mhbd = Buffer.alloc(104); mhbd.write('mhbd', 0, 'latin1'); mhbd.writeUInt32LE(104, 4); mhbd.writeUInt32LE(104 + 96 + 92, 8); mhbd.writeUInt32LE(1, 20)
  return Buffer.concat([mhbd, mhsd, mhlt])
}

const songName = (id: number) => `S${String(id).padStart(3, '0')}.m4a`
const folder = (id: number) => `F${String(id % 5).padStart(2, '0')}`
const pathOf = (id: number) => `:iPod_Control:Music:${folder(id)}:${songName(id)}`
const ids = Array.from({ length: N }, (_, i) => i)

function marker(id: string): string {
  return JSON.stringify({ version: 1, id, name: 'Y2KPod', color: null, purpose: null, primary: false, createdAt: '2026-11-01T00:00:00.000Z' })
}

interface Rig {
  root: string
  card: string
  state: string
  host: ActivitySyncHost
  library: Map<number, Record<string, unknown>>
  events: Array<{ phase: string; title: string }>
  clock: number
  /** Successful copies onto the card, by card path. */
  writes: Map<string, number>
  /** Drop on this copy attempt (1-based); 0 = never. */
  dropAt: number
  attempts: number
  /** Run while the card is away, on every sleep, with the fake clock. */
  whileAway: (r: Rig) => Promise<void>
  away: string
  /** Where the engine says the iPod is now (setDetectedMount), as production's readIpodDatabase follows. */
  mounted: string | null
}

function readJsonCatalog(card: string): Promise<{ tracks: Array<Record<string, unknown>>; playlists?: unknown[] }> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [join(REPO, 'core', 'db_reader.py'), '--json', join(card, 'iPod_Control', 'iTunes', 'iTunesDB')])
    let out = ''
    py.stdout.on('data', (d: Buffer) => { out += d.toString() })
    py.on('error', reject)
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(`db_reader --json exited ${code}`))
      try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
  })
}

async function makeRig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'jt-ipod-drop-'))
  const lib = join(root, 'lib')
  const card = join(root, 'card')
  const state = join(root, 'state')
  await mkdir(join(card, 'iPod_Control', 'iTunes'), { recursive: true })
  await mkdir(join(card, 'iPod_Control', 'Music'), { recursive: true })
  await mkdir(state, { recursive: true })
  await writeFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'), emptyTemplate())
  await writeFile(join(card, 'iPod_Control', 'jaketunes-device.json'), marker(MARKER))
  const r = {
    root, card, state, library: new Map(), events: [], clock: 1_800_000_000_000,
    writes: new Map(), dropAt: 0, attempts: 0, mounted: null, whileAway: async () => {}, away: join(root, 'card-away'),
  } as unknown as Rig
  for (const id of ids) {
    const dir = join(lib, 'iPod_Control', 'Music', folder(id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, songName(id)), Buffer.alloc(SONG_BYTES, id & 0xff))
    r.library.set(id, {
      id, title: `Song ${id}`, artist: `Band ${String.fromCharCode(65 + (id % 26))}`, album: `Album ${id % 4}`, genre: 'Rock',
      duration: DURATION_MS, codec: 'alac', path: pathOf(id), audioFingerprint: `sha1:${id.toString(16).padStart(8, '0')}|${SONG_BYTES}`,
    })
  }
  r.host = {
    pythonCmd: 'python3',
    pythonHint: '',
    coreScript: (rel) => join(REPO, rel),
    tempDir: root,
    stateDir: state,
    pid: process.pid,
    musicDir: join(lib, 'iPod_Control', 'Music'),
    pathSep: '/',
    isMac: true,
    sendProgress: (p) => { r.events.push({ phase: p.phase, title: p.title }) },
    isCancelled: () => false,
    isStreamedTrackFile: async () => false,
    buildAacMirror: async () => null,
    buildIpodSafeAlacMirror: async () => null,
    readIpodDatabase: () => readJsonCatalog(r.mounted ?? r.card),
    writeJournal: async () => {},
    writeManifest: async (m) => { await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify(m, null, 1)) },
    writeSeal: async (s) => { await writeFile(join(state, 'ipod-activity-tsa-seal.json'), JSON.stringify(s, null, 2)) },
    clearSeal: async () => { await rm(join(state, 'ipod-activity-tsa-seal.json'), { force: true }) },
    writeReport: async () => {},
    getDetectedMount: () => r.card,
    setDetectedMount: (m) => { r.mounted = m },
    probeHomeminiTrack: async () => ({ ok: false, error: 'not in this test' }),
    stageTrack: async () => ({ ok: false, error: 'not in this test', reason: 'other' } as never),
    freeBytes: async () => 500 * 1024 ** 3,
    remountVolume: async (m: string) => ({ ok: true, mountPoint: m }),
    otherIpodMounts: async () => [],
    now: () => r.clock,
    sleep: async (ms) => { r.clock += ms; await r.whileAway(r) },
    copyToCard: async (src, dst) => {
      r.attempts++
      if (r.attempts === r.dropAt) {
        // The USB device resets: the volume vanishes and this write fails.
        await rename(r.card, r.away)
        throw Object.assign(new Error(`EIO: i/o error, copyfile '${src}' -> '${dst}'`), { code: 'EIO' })
      }
      await copyFile(src, dst)
      r.writes.set(dst, (r.writes.get(dst) ?? 0) + 1)
    },
  }
  return r
}

function sync(r: Rig): Promise<ActivitySyncResult> {
  r.events = []
  const tracks = ids.map((id) => ({ ...r.library.get(id)! }))
  return runActivitySync(r.host, { tracks, playlists: [{ name: 'Y2KPod', trackIds: ids }], requestedTarget: N, listOnly: true, ipodName: 'Y2KPod' })
}

async function cardFiles(card: string): Promise<Map<string, { size: number; ino: number; mtimeMs: number }>> {
  const out = new Map<string, { size: number; ino: number; mtimeMs: number }>()
  const music = join(card, 'iPod_Control', 'Music')
  for (const f of await readdir(music).catch(() => [] as string[])) {
    for (const n of await readdir(join(music, f)).catch(() => [] as string[])) {
      const st = await stat(join(music, f, n))
      out.set(`:iPod_Control:Music:${f}:${n}`, { size: st.size, ino: st.ino, mtimeMs: st.mtimeMs })
    }
  }
  return out
}

async function assertCardWhole(card: string, want: number): Promise<void> {
  const files = await cardFiles(card)
  const paths = parseCatalogPaths(await readFile(join(card, 'iPod_Control', 'iTunes', 'iTunesDB'))) || []
  assert.equal(paths.length, want)
  for (const p of paths) assert.equal(files.get(p)?.size, SONG_BYTES, `the catalog names ${p}, which is not on the card at size`)
}

const dropLines = async (state: string) =>
  (await readFile(join(state, 'ipod-drops.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l))

describe('Activity Sync rides out a USB drop', () => {
  it('drops, comes back 10 s later: carries on from the song it was writing, nothing copied twice, sealed', async () => {
    const r = await makeRig()
    try {
      r.dropAt = 6   // five songs confirmed, the sixth is being written
      let before: Map<string, { ino: number; mtimeMs: number }> | null = null
      const goneAt = r.clock
      r.whileAway = async (rr) => {
        if (rr.clock - goneAt >= 10_000 && !before) {
          await rename(rr.away, rr.card)
          before = await cardFiles(rr.card)
        }
      }
      const res = await sync(r)
      assert.equal(res.ok, true, res.error)
      assert.equal(res.copied, N)
      assert.equal(r.attempts, N + 1, 'one failed write, then each song once')
      for (const [dst, n] of r.writes) assert.equal(n, 1, `${dst} copied ${n} times`)
      // The five confirmed before the drop were never rewritten.
      const after = await cardFiles(r.card)
      assert.ok(before)
      for (const [p, b] of before!) {
        if (b.mtimeMs === undefined) continue
        assert.equal(after.get(p)?.ino, b.ino, `${p} was rewritten after the drop`)
      }
      assert.ok(r.events.some((e) => e.title === DROP_BACK_LINE), 'the UI was told it carried on')
      await assertCardWhole(r.card, N)
      const [line] = await dropLines(r.state)
      assert.equal(line.outcome, 'back')
      assert.equal(line.songsDone, 5)
      assert.equal(line.bytesWritten, 5 * SONG_BYTES)
      assert.match(line.file, /Song 5/)
      assert.match(line.error, /^EIO/)
      assert.ok(line.goneSeconds >= 10 && line.goneSeconds < 20, String(line.goneSeconds))
      await assert.rejects(stat(join(r.state, PARTIAL_ON_CARD_FILE)), 'no record of a partial card after a seal')
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('comes back at another /Volumes path: every card path follows it, sealed there', async () => {
    const r = await makeRig()
    try {
      r.dropAt = 4
      const moved = join(r.root, 'card 1')
      let back = false
      r.host.otherIpodMounts = async () => (back ? [moved] : [])
      const goneAt = r.clock
      r.whileAway = async (rr) => {
        if (rr.clock - goneAt >= 6_000 && !back) { await rename(rr.away, moved); back = true }
      }
      const res = await sync(r)
      assert.equal(res.ok, true, res.error)
      assert.equal(res.copied, N)
      await assertCardWhole(moved, N)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('never comes back: the confirmed songs stay, no catalog, and the next sync copies only the rest', async () => {
    const r = await makeRig()
    try {
      r.dropAt = 6
      const res = await sync(r)
      assert.equal(res.ok, false)
      assert.ok(String(res.error).includes(DROP_KEPT_MARK), res.error)
      assert.match(String(res.error), /didn’t come back/)
      const copy = syncFailureCopy(String(res.error))
      assert.equal(copy.happened, 'The iPod disconnected.')
      const partial = JSON.parse(await readFile(join(r.state, PARTIAL_ON_CARD_FILE), 'utf-8'))
      assert.equal(partial.rows.length, 5)
      assert.equal(partial.ipod.markerId, MARKER)
      const [line] = await dropLines(r.state)
      assert.equal(line.outcome, 'never-back')
      assert.ok(line.goneSeconds >= 120)

      // Plugged in again later: the card is as the drop left it (nothing taken off it).
      await rename(r.away, r.card)
      const left = await cardFiles(r.card)
      for (const id of ids.slice(0, 5)) assert.equal(left.get(pathOf(id))?.size, SONG_BYTES)
      assert.deepEqual(parseCatalogPaths(await readFile(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))), [], 'no catalog was written')

      r.dropAt = 0
      r.writes.clear()
      const again = await sync(r)
      assert.equal(again.ok, true, again.error)
      assert.equal(again.mode, 'full')
      assert.equal(again.kept, 5)
      assert.equal(again.copied, N - 5)
      for (const id of ids.slice(0, 5)) {
        assert.ok(!r.writes.has(join(r.card, 'iPod_Control', 'Music', folder(id), songName(id))), `song ${id} copied again`)
      }
      const after = await cardFiles(r.card)
      for (const id of ids.slice(0, 5)) assert.equal(after.get(pathOf(id))?.ino, left.get(pathOf(id))?.ino, `song ${id} rewritten`)
      await assertCardWhole(r.card, N)
      await assert.rejects(stat(join(r.state, PARTIAL_ON_CARD_FILE)), 'the record is gone once sealed')
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a different iPod comes back at the same place: never written to, nothing on it removed', async () => {
    const r = await makeRig()
    try {
      r.dropAt = 6
      const goneAt = r.clock
      let swapped = false
      r.whileAway = async (rr) => {
        if (rr.clock - goneAt >= 4_000 && !swapped) {
          swapped = true
          await writeFile(join(rr.away, 'iPod_Control', 'jaketunes-device.json'), marker('another-ipod-9'))
          await rename(rr.away, rr.card)
        }
      }
      const before = r.attempts
      let filesWhenBack: string[] = []
      const res = await sync(r).finally(async () => { filesWhenBack = [...(await cardFiles(r.card)).keys()].sort() })
      assert.equal(res.ok, false)
      assert.match(String(res.error), /a different iPod came back/)
      assert.equal(syncFailureCopy(String(res.error)).happened, 'A different iPod was plugged in.')
      assert.equal(r.attempts - before, 6, 'no write after the drop')
      // The five confirmed before the drop: still all there (nothing unlinked on the other iPod).
      assert.equal(filesWhenBack.length, 5)
      const [line] = await dropLines(r.state)
      assert.equal(line.outcome, 'other-ipod')
      // The record is for the first iPod; on this one nothing is adopted.
      const rows = parsePartialOnCard(JSON.parse(await readFile(join(r.state, PARTIAL_ON_CARD_FILE), 'utf-8')),
        { markerId: 'another-ipod-9', firewireGuid: null, serial: null, hardware: 'unknown' })
      assert.equal(rows, null)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a card that never stays (drops again and again) stops after three, and keeps what is confirmed', async () => {
    const r = await makeRig()
    try {
      // Every write fails with EIO while the card still answers: the card is "back" at once each time.
      r.host.copyToCard = async () => { r.attempts++; throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }) }
      const res = await sync(r)
      assert.equal(res.ok, false)
      assert.match(String(res.error), /kept disconnecting/)
      assert.ok(String(res.error).includes(DROP_KEPT_MARK))
      assert.equal(r.attempts, 4)
      const lines = await dropLines(r.state)
      assert.deepEqual(lines.map((l) => l.outcome), ['back', 'back', 'back', 'too-many'])
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

describe('the drop rules', () => {
  const id = (markerId: string | null, guid: string | null = null, serial: string | null = null): IpodCardIdentity =>
    ({ markerId, firewireGuid: guid, serial, hardware: 'unknown' })

  it('same iPod only when everything it had before reads the same', () => {
    assert.equal(sameIpod(id('a1b2c3'), id('a1b2c3')), 'same')
    assert.equal(sameIpod(id('a1b2c3', 'G1'), id('a1b2c3', 'G1')), 'same')
    assert.equal(sameIpod(id('a1b2c3', 'G1'), id('a1b2c3', 'G2')), 'other')
    assert.equal(sameIpod(id('a1b2c3'), id('zzzzzz')), 'other')
    assert.equal(sameIpod(id('a1b2c3'), id(null)), 'unreadable', 'still mounting')
    assert.equal(sameIpod(id(null), id(null)), 'unreadable', 'nothing to tell it apart by')
    assert.equal(sameIpod(id(null, 'G1'), id('a1b2c3', 'G1')), 'same', 'a guid alone is an identity')
  })

  it('EIO is the device; ENOENT is the device only when the card is gone', () => {
    assert.equal(looksLikeDrop(Object.assign(new Error('x'), { code: 'EIO' }), true), true)
    assert.equal(looksLikeDrop(Object.assign(new Error('x'), { code: 'ENXIO' }), true), true)
    assert.equal(looksLikeDrop(Object.assign(new Error('x'), { code: 'ENOENT' }), true), false)
    assert.equal(looksLikeDrop(Object.assign(new Error('x'), { code: 'ENOENT' }), false), true)
    assert.equal(looksLikeDrop(Object.assign(new Error('x'), { code: 'ENOSPC' }), true), false)
  })

  it('waits for two same answers in a row, and gives up at two minutes', async () => {
    let t = 0
    const answers = [false, true, true]
    const w = await waitForSameIpod({
      mount: '/V/a', before: id('a1b2c3'),
      read: async () => id('a1b2c3'), present: async () => answers.shift() ?? true,
      now: () => t, sleep: async (ms) => { t += ms },
    })
    assert.deepEqual(w, { back: true, goneMs: 4000, mount: '/V/a' })
    t = 0
    const never = await waitForSameIpod({
      mount: '/V/a', before: id('a1b2c3'), read: async () => id('a1b2c3'), present: async () => false,
      now: () => t, sleep: async (ms) => { t += ms },
    })
    assert.equal(never.back, false)
    assert.equal(never.back === false && never.why, 'timeout')
    assert.ok(never.goneMs >= 120_000)
  })

  it('another iPod elsewhere is ignored; at the old place it ends the wait', async () => {
    let t = 0
    const w = await waitForSameIpod({
      mount: '/V/a', before: id('a1b2c3'), others: async () => ['/V/b'],
      read: async (m) => (m === '/V/b' ? id('ffffff') : id('a1b2c3')), present: async (m) => m === '/V/b' || t >= 6000,
      now: () => t, sleep: async (ms) => { t += ms },
    })
    assert.equal(w.back, true)
    t = 0
    const o = await waitForSameIpod({
      mount: '/V/a', before: id('a1b2c3'), read: async () => id('ffffff'), present: async () => true,
      now: () => t, sleep: async (ms) => { t += ms },
    })
    assert.deepEqual(o, { back: false, goneMs: 0, why: 'other-ipod' })
  })

  it('a file is adopted only as the exact file that was confirmed', () => {
    const row = { id: 7, destPath: pathOf(7), identity: 'fp:abc', size: 100, sourceSize: 100, mtimeMs: 5000 }
    const c = { id: 7, destPath: pathOf(7), identity: 'fp:abc', copySize: 100, sourceSize: 100 }
    assert.equal(adoptFromPartial(c, row, { size: 100, mtimeMs: 5000 }), true)
    assert.equal(adoptFromPartial(c, row, { size: 100, mtimeMs: 5001 }), false, 'rewritten since')
    assert.equal(adoptFromPartial(c, row, { size: 99, mtimeMs: 5000 }), false, 'short')
    assert.equal(adoptFromPartial(c, row, null), false, 'gone')
    assert.equal(adoptFromPartial({ ...c, identity: 'fp:zzz' }, row, { size: 100, mtimeMs: 5000 }), false, 'another song')
    assert.equal(adoptFromPartial({ ...c, copySize: 120 }, row, { size: 100, mtimeMs: 5000 }), false, 'the library file changed')
    const doc = buildPartialOnCard(id('a1b2c3'), [row], 'now')
    assert.equal(parsePartialOnCard(doc, id('a1b2c3'))?.size, 1)
    assert.equal(parsePartialOnCard(doc, id('zzzzzz')), null, 'never for another iPod')
    assert.equal(parsePartialOnCard({ ...doc, rows: [{ ...row, mtimeMs: 0 }] }, id('a1b2c3')), null)
  })

  it('pauses only the old hard-drive iPods', () => {
    for (const hw of ['3g', '4g', 'mini', 'mini-1g', 'mini-2g'] as const) assert.equal(pacesWrites(hw), true, hw)
    for (const hw of ['classic', 'other', 'unknown'] as const) assert.equal(pacesWrites(hw), false, hw)
    assert.ok(OLD_IPOD_PAUSE_EVERY_BYTES >= 100 * 1024 * 1024)
  })

  it('the result screen says the songs stayed, not that the iPod was emptied', () => {
    const o = syncOutcome({
      status: 'failed', seen: 3, step: 'copy', reached: ['prepare', 'wipe', 'copy'], current: 5, total: 12,
      error: `The iPod disconnected during the copy and didn’t come back. ${DROP_KEPT_MARK} (5); the next sync copies only the rest.`,
    } as never)
    assert.equal(o?.changed, 'drop-kept')
    assert.match(String(o?.changedLine), /copies only the rest/)
  })
})
