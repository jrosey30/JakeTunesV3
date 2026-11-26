/**
 * Swap-only sync, end to end on a FAKE card in a temp folder (2026-11-07).
 * The real activity engine, the real core/db_reader.py writer, the real
 * conform/contiguity passes and the real itdb_verify.py validator; only the
 * cold remount is stubbed (a temp folder has no device node — and the real
 * one would unmount the Mac's own disk). Never touches an iPod.
 *
 * Jake: "with that sync, it shouldnt wipe the ipod and start the 1000 from
 * scratch, it should just swap out the songs that they are being replaced with".
 *
 * This file: a swap that stops part-way, the fragmentation backstop, sets that don’t fit, plays around a swap. Shared rig: swap-engine-rig.ts.
 */
import { cardFit, cardTooSmall, CARD_FIT_PER_SONG_BYTES } from '../ipod-card-fit.ts'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { unlinkSync } from 'fs'
import { appendFile, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ROUNDTRIP_STATE_FILE, type RoundTripHost } from '../sync-engine/roundtrip.ts'
import { securePlaysBeforeSync } from '../ipod-plays-archive.ts'
import { N, SONG_BYTES, type Rig, songName, folder, addSong, makeRig, sync, cardFiles, cardCatalog, assertCardWhole, pathOf, range } from './swap-engine-rig.ts'

describe('a swap that fails part-way leaves the card whole', () => {
  let r: Rig
  const base = range(0, N)
  before(async () => {
    r = await makeRig()
    for (let id = 100; id < 107; id++) await addSong(r, id)
    const first = await sync(r, base)
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('cancelled mid-copy after removals: the card lists the songs that stayed, all on it; arrivals taken back', async () => {
    let arrivals = 0
    r.onEvent = (e) => { if (e.phase === 'copy' && /^Song 10\d$/.test(e.title)) { arrivals++; if (arrivals === 5) r.cancel = true } }
    const res = await sync(r, [...range(0, 13), ...range(100, 107)])
    r.onEvent = () => {}; r.cancel = false
    assert.equal(res.ok, false)
    assert.equal(res.cancelled, true)
    await assertCardWhole(r)     // the effect first
    assert.match(String(res.error), /still has a working song list of the 13 songs on it/)
    const { paths } = await cardCatalog(r.card)
    assert.deepEqual(paths.slice().sort(), range(0, 13).map(pathOf).sort(), 'the interim catalog: the 13 that stay')
    const files = await cardFiles(r.card)
    assert.deepEqual([...files.keys()].sort(), range(0, 13).map(pathOf).sort(), 'arrivals taken back, leavers gone')
    // The round trip can still map the card: the manifest names its catalog (unsealed).
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.equal(m.status, 'interim')
    assert.equal(m.sealed, false)
    assert.deepEqual(m.tracks.map((t: { destPath: string }) => t.destPath).sort(), range(0, 13).map(pathOf).sort())
    // Next sync can't prove the card: a full copy, and it says why.
    const next = await sync(r, base)
    assert.equal(next.ok, true, next.error)
    assert.equal(next.mode, 'full')
    assert.match(String(next.fullReason), /didn’t finish/)
  })

  it('a pure add that fails before any catalog change: nothing on the iPod changed and the next sync still swaps', async () => {
    // List-only iPod grows by 3; the 2nd arrival's library file vanishes mid-copy.
    for (let id = 300; id < 303; id++) await addSong(r, id)
    const before = await cardFiles(r.card)
    const dbBefore = await readFile(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const sealBefore = await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8')
    // Hooks run inside sendProgress: synchronous, so the engine's next step sees the change.
    r.onEvent = (e) => {
      if (e.phase === 'copy' && e.title === 'Song 300') unlinkSync(join(r.lib, 'iPod_Control', 'Music', folder(301), songName(301)))
    }
    const res = await sync(r, [...base, 300, 301, 302])
    r.onEvent = () => {}
    assert.equal(res.ok, false)
    assert.match(String(res.error), /nothing on it changed, all 20 songs are still there/)
    assert.deepEqual([...(await cardFiles(r.card)).keys()].sort(), [...before.keys()].sort(), 'the copied arrival was taken back')
    assert.equal(Buffer.compare(await readFile(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB')), dbBefore), 0, 'the catalog never changed')
    assert.equal(await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8'), sealBefore, 'the last seal is back')
    await assertCardWhole(r)
    await addSong(r, 301)
    const next = await sync(r, [...base, 300, 301, 302])
    assert.equal(next.ok, true, next.error)
    assert.equal(next.mode, 'swap', next.fullReason)
    assert.deepEqual(next.swap, { out: 0, in: 3, stayed: 20, changed: 0 })
    assert.equal(next.summary, 'Added 3 songs. 20 stayed.')
  })

  it('never catalog a missing file: an arrival that vanishes before the catalog is refused, and the card stays whole', async () => {
    const target = [...range(0, 13), ...range(100, 107)]
    const pre = await sync(r, base)   // back to a sealed 20 first
    assert.equal(pre.ok, true, pre.error)
    let broke = false
    r.onEvent = (e) => {
      if (!broke && e.phase === 'db' && e.title === 'Writing iTunesDB...') {
        broke = true
        unlinkSync(join(r.card, 'iPod_Control', 'Music', folder(104), songName(104)))
      }
    }
    const res = await sync(r, target)
    r.onEvent = () => {}
    assert.equal(broke, true)
    assert.equal(res.ok, false)
    // The effect first: no catalog on the card ever names the vanished file.
    await assertCardWhole(r)
    assert.match(String(res.error), /1 song\(s\) the catalog would list are not on the card/)
    assert.match(String(res.error), /still has a working song list/)
    const { paths } = await cardCatalog(r.card)
    assert.ok(!paths.includes(pathOf(104)), 'the catalog never names the vanished file')
  })
})

describe('a stop before the card is touched keeps the last seal', () => {
  let r: Rig
  before(async () => {
    r = await makeRig()
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })
  it('cancelled during Prepare: nothing touched, the seal stays, and the next Sync swaps', async () => {
    const sealBefore = await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8')
    const manifestBefore = await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8')
    r.onEvent = (e) => { if (e.phase === 'preflight' && /^Preparing:/.test(e.title)) r.cancel = true }
    const res = await sync(r, range(0, N))
    r.onEvent = () => {}; r.cancel = false
    assert.equal(res.cancelled, true)
    assert.match(String(res.error), /nothing on the iPod was touched/)
    assert.equal(await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8'), sealBefore)
    assert.equal(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'), manifestBefore)
    const next = await sync(r, range(0, N))
    assert.equal(next.ok, true, next.error)
    assert.equal(next.mode, 'swap', next.fullReason)
  })
})

describe('the fragmentation backstop, end to end', () => {
  let r: Rig
  before(async () => {
    r = await makeRig()
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
    for (let id = 500; id < 520; id++) await addSong(r, id)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('five swaps that remove songs, then a full copy with a plain reason, then swaps again', async () => {
    let set = range(0, N)
    for (let k = 0; k < 5; k++) {
      set = [...set.filter((id) => id !== k), 500 + k]          // one out, one in
      const res = await sync(r, set)
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', `swap ${k + 1}: ${res.fullReason}`)
    }
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.equal(m.swapsSinceFull, 5)
    assert.equal(m.bytesRemovedSinceFull, 5 * SONG_BYTES)
    // An unchanged sync removes nothing: it still swaps and isn't counted.
    const same = await sync(r, set)
    assert.equal(same.mode, 'swap', same.fullReason)
    assert.equal(JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8')).swapsSinceFull, 5)
    set = [...set.filter((id) => id !== 5), 505]
    const sixth = await sync(r, set)
    assert.equal(sixth.ok, true, sixth.error)
    assert.equal(sixth.mode, 'full')
    assert.match(String(sixth.fullReason), /5 swaps since the last full copy/)
    assert.match(String(sixth.summary), /^Full copy: it’s been 5 swaps/)
    await assertCardWhole(r)
    const after6 = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.deepEqual([after6.swapsSinceFull, after6.bytesRemovedSinceFull], [0, 0])
    set = [...set.filter((id) => id !== 6), 506]
    const next = await sync(r, set)
    assert.equal(next.mode, 'swap', next.fullReason)
  })

  it('removals past 15% of the card since the last full copy: a full copy', async () => {
    r.host.cardCapacityBytes = async () => 20 * SONG_BYTES      // 15% = 3 songs' worth
    try {
      const now = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8')).tracks.map((t: { id: number }) => t.id) as number[]
      const keep = now.slice(4)
      // 4 out = 20% of this card. 3 in, so the set (19 songs) still fits a card of 20 songs' worth:
      // a set that doesn't fit is refused before the card is touched (ipod-card-fit.ts).
      const res = await sync(r, [...keep, 510, 511, 512])
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.match(String(res.fullReason), /would have cleared 2\d% of the iPod/)
      await assertCardWhole(r)
    } finally {
      delete r.host.cardCapacityBytes
    }
  })
})

// Review of PR 413 (2026-11-13): a list can hold 5,000 songs now, and nothing checked
// that a set fits on the card. It copied until the card was full, failed its verify,
// and the stop emptied the card.
describe('a set that doesn’t fit on the card is refused before the card is touched', () => {
  it('a synced card: refused with the numbers; every file, the catalog and the record are as they were', async () => {
    const r = await makeRig()
    try {
      const first = await sync(r, range(0, N))
      assert.equal(first.ok, true, first.error)
      const filesBefore = await cardFiles(r.card)
      const dbPath = join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB')
      const dbBefore = await readFile(dbPath)
      const manifestBefore = await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8')
      const sealBefore = await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8')
      for (const id of range(800, 810)) await addSong(r, id)
      r.host.cardCapacityBytes = async () => 25 * SONG_BYTES
      const res = await sync(r, [...range(0, N), ...range(800, 810)])   // 30 songs onto a card of 25 songs' worth
      assert.equal(res.ok, false)
      assert.equal(String(res.error), '30 songs won’t fit on TestPod. Make the list shorter.')
      assert.equal(res.copied, 0)
      assert.ok(!r.events.some((e) => /^Wiping/.test(String(e.title))), 'nothing was wiped')
      assert.ok(!r.events.some((e) => e.phase === 'copy'), 'nothing was copied')
      const filesAfter = await cardFiles(r.card)
      assert.deepEqual([...filesAfter.keys()].sort(), [...filesBefore.keys()].sort())
      for (const [p, b] of filesBefore) assert.deepEqual(filesAfter.get(p), b, `${p} was touched`)
      assert.ok(dbBefore.equals(await readFile(dbPath)), 'the catalog is byte for byte the last sync’s')
      assert.equal(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'), manifestBefore)
      assert.equal(await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8'), sealBefore)
      // The same set on a card with the room goes on, as a swap: the refusal left nothing behind.
      r.host.cardCapacityBytes = async () => 40 * SONG_BYTES
      const ok = await sync(r, [...range(0, N), ...range(800, 810)])
      assert.equal(ok.ok, true, ok.error)
      assert.equal(ok.mode, 'swap', String(ok.fullReason))
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a first sync (a full copy) onto a card too small: refused, not wiped, nothing written', async () => {
    const r = await makeRig()
    try {
      r.host.cardCapacityBytes = async () => 10 * SONG_BYTES
      const res = await sync(r, range(0, N))
      assert.equal(res.ok, false)
      assert.match(String(res.error), /won’t fit on .+\. Make the list shorter\.$/)
      assert.ok(!r.events.some((e) => /^Wiping/.test(String(e.title))))
      assert.equal((await cardFiles(r.card)).size, 0)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a card whose size can’t be read refuses nothing (as before)', async () => {
    const r = await makeRig()
    try {
      r.host.cardCapacityBytes = async () => null
      const res = await sync(r, range(0, N))
      assert.equal(res.ok, true, res.error)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

describe('cardTooSmall (the rule)', () => {
  const GIB = 1024 ** 3
  it('5,000 lossless songs: fit a 256 GB card, not a 128 GB one, and the refusal names both numbers', () => {
    const sizes = Array.from({ length: 5000 }, () => 30 * 1024 * 1024)   // 146.5 GB
    assert.equal(cardTooSmall(sizes, 238 * GIB, 'punkPod'), null)
    assert.equal(cardTooSmall(sizes, 119 * GIB, 'punkPod'),
      '5,000 songs won’t fit on punkPod. Make the list shorter.')
  })
  it('room is held back for the catalog and the file system: 1% of the card and 4 KB a song', () => {
    assert.deepEqual(cardFit([1000, 1000], 1_000_000), { needBytes: 2000 + 2 * CARD_FIT_PER_SONG_BYTES, roomBytes: 990_000 })
    assert.equal(cardTooSmall([980_000], 1_000_000), null)
    assert.match(String(cardTooSmall([990_000], 1_000_000)), /won’t fit/)
  })
  it('an unknown card size is unknown, never "too small"', () => {
    for (const cap of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(cardTooSmall([5e12], cap), null, String(cap))
  })
  it('a size that isn’t a number counts as nothing, never as not-a-number', () => {
    assert.equal(cardTooSmall([Number.NaN, -5, 100], 1_000_000), null)
  })
})

describe('plays when a swap stops on the catalog step (review of #377)', () => {
  let r: Rig
  const playEvents: Array<{ id: number; count: number }> = []
  let rtHost: RoundTripHost
  before(async () => {
    r = await makeRig()
    rtHost = {
      stateDir: r.state,
      getLibraryTracks: async () => [...r.library.values()].map((t) => ({ id: Number(t.id), playCount: 0 })),
      appendPlayEvents: async (id, count) => { playEvents.push({ id, count }) },
      sendToRenderer: () => {},
      isSyncInFlight: () => false,
    }
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  /** The firmware: one entry per catalog record. It appends to a Play Counts
   *  that is still there, and starts a fresh one when it was retired. */
  const play = async (path: string, n: number): Promise<void> => {
    const pc = join(r.card, 'iPod_Control', 'iTunes', 'Play Counts')
    const { paths } = await cardCatalog(r.card)
    const prior = await readFile(pc).catch(() => null)
    const b = prior && prior.length === 96 + paths.length * 16 ? Buffer.from(prior) : Buffer.alloc(96 + paths.length * 16)
    b.write('mhdp', 0, 'latin1'); b.writeUInt32LE(96, 4); b.writeUInt32LE(16, 8); b.writeUInt32LE(paths.length, 12)
    const i = paths.indexOf(path)
    assert.ok(i >= 0)
    b.writeUInt32LE(b.readUInt32LE(96 + i * 16) + n, 96 + i * 16)
    b.writeUInt32LE(3_900_000_000, 96 + i * 16 + 4)
    await writeFile(pc, b)
  }

  it('a pure-add swap that stops on the contiguity step: new plays on a staying song come home exactly once', async () => {
    await play(pathOf(2), 3)
    const gate1 = await securePlaysBeforeSync(r.card, rtHost, 'Activity Sync')
    assert.equal(gate1.ok, true, gate1.ok ? '' : gate1.error)
    assert.deepEqual(playEvents.splice(0), [{ id: 2, count: 3 }])

    for (let id = 600; id < 603; id++) await addSong(r, id)
    r.host.ensureContiguousDb = async () => ({ ok: false, preallocContig: false, bytes: 0, md5: '', summary: 'forced', error: 'forced for the test' })
    const res = await sync(r, [...range(0, N), 600, 601, 602])
    delete r.host.ensureContiguousDb
    assert.equal(res.ok, false)
    assert.match(String(res.error), /could not be laid down as one piece/)
    assert.match(String(res.error), /nothing on it changed/)

    await play(pathOf(2), 1)                      // one more listen on the same catalog
    const gate2 = await securePlaysBeforeSync(r.card, rtHost, 'Activity Sync')
    assert.equal(gate2.ok, true, gate2.ok ? '' : gate2.error)
    assert.deepEqual(playEvents.splice(0), [{ id: 2, count: 1 }], 'the new listen counts once — not swallowed, not doubled')
  })
})

describe('plays round trip around a swap', () => {
  let r: Rig
  const playEvents: Array<{ id: number; count: number }> = []
  let rtHost: RoundTripHost
  before(async () => {
    r = await makeRig()
    rtHost = {
      stateDir: r.state,
      getLibraryTracks: async () => [...r.library.values()].map((t) => ({ id: Number(t.id), playCount: 0 })),
      appendPlayEvents: async (id, count) => { playEvents.push({ id, count }) },
      sendToRenderer: () => {},
      isSyncInFlight: () => false,
    }
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  /** The firmware's Play Counts: one entry per catalog record, positional. */
  const writePlayCounts = async (playsByPath: Map<string, number>): Promise<void> => {
    const { paths } = await cardCatalog(r.card)
    const b = Buffer.alloc(96 + paths.length * 16)
    b.write('mhdp', 0, 'latin1'); b.writeUInt32LE(96, 4); b.writeUInt32LE(16, 8); b.writeUInt32LE(paths.length, 12)
    paths.forEach((p, i) => {
      b.writeUInt32LE(playsByPath.get(p) || 0, 96 + i * 16)
      b.writeUInt32LE(3_900_000_000, 96 + i * 16 + 4)
    })
    await writeFile(join(r.card, 'iPod_Control', 'iTunes', 'Play Counts'), b)
  }

  it('plays come home before the swap touches anything, and a staying song is never counted twice', async () => {
    // Listening on the iPod: song 2 (stays) 3 plays, song 15 (leaves) 2 plays.
    await writePlayCounts(new Map([[pathOf(2), 3], [pathOf(15), 2]]))
    const gate1 = await securePlaysBeforeSync(r.card, rtHost, 'Activity Sync')
    assert.equal(gate1.ok, true, gate1.ok ? '' : gate1.error)
    assert.deepEqual(playEvents.splice(0).sort((a, b) => a.id - b.id), [{ id: 2, count: 3 }, { id: 15, count: 2 }])

    for (let id = 100; id < 107; id++) await addSong(r, id)
    const res = await sync(r, [...range(0, 13), ...range(100, 107)])
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.equal(await stat(join(r.card, 'iPod_Control', 'iTunes', 'Play Counts')).then(() => true, () => false), false, 'Play Counts retired with the new catalog')

    // The firmware starts a fresh Play Counts against the rebuilt catalog:
    // song 2 (stayed, new position) 1 more play, song 103 (arrived) 4.
    await writePlayCounts(new Map([[pathOf(2), 1], [pathOf(103), 4]]))
    const gate2 = await securePlaysBeforeSync(r.card, rtHost, 'Activity Sync')
    assert.equal(gate2.ok, true, gate2.ok ? '' : gate2.error)
    assert.deepEqual(playEvents.splice(0).sort((a, b) => a.id - b.id), [{ id: 2, count: 1 }, { id: 103, count: 4 }],
      'exactly the new plays: no double count for the staying song, mapped through the swap’s manifest')
    const st = JSON.parse(await readFile(join(r.state, ROUNDTRIP_STATE_FILE), 'utf-8'))
    assert.deepEqual(st.ingested, { 2: 1, 103: 4 })
  })
})

// A loud guard for the test's own assumption: the fake card is a temp folder.
describe('the rig never touches a real iPod', () => {
  it('every card path is under the OS temp dir', async () => {
    const r = await makeRig()
    try {
      assert.ok(r.card.startsWith(tmpdir()) || r.card.startsWith('/private' + tmpdir()), r.card)
      await appendFile(join(r.root, 'probe'), 'x')
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})
