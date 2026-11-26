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
 * This file: the swap itself, the Original, and the fallbacks to a full copy. Shared rig: swap-engine-rig.ts.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, truncate, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { N, SONG_BYTES, type Rig, songName, folder, addSong, makeRig, sync, cardFiles, cardCatalog, assertCardWhole, pathOf, range } from './swap-engine-rig.ts'

describe('swap-only sync on a fake card', () => {
  let r: Rig
  before(async () => { r = await makeRig() })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('first sync: no record of a last sync, so a full copy, and it says why', async () => {
    const res = await sync(r, range(0, N))
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'full')
    assert.match(String(res.fullReason), /no record of what the last sync put/)
    assert.equal(res.copied, N)
    assert.ok(r.events.some((e) => /^Wiping/.test(e.title)))
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.equal(m.format, 2)
    assert.equal(m.status, 'sealed')
    assert.equal(m.tracks.length, N)
    assert.ok(m.tracks.every((t: { size: number; sourceSize: number }) => t.size === SONG_BYTES && t.sourceSize === SONG_BYTES))
    assert.match(String(res.summary), /^Full copy: /)
    await assertCardWhole(r)
  })

  it('unchanged set: no copies, no deletes, the catalog rebuilt and valid', async () => {
    const before = await cardFiles(r.card)
    const dbBefore = await stat(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const res = await sync(r, range(0, N))
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.equal(res.copied, 0)
    assert.equal(res.kept, N)
    assert.deepEqual(res.swap, { out: 0, in: 0, stayed: N, changed: 0 })
    assert.equal(res.summary, `Nothing to swap: all ${N} stayed.`)
    const after = await cardFiles(r.card)
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort())
    for (const [p, b] of before) {
      assert.equal(after.get(p)!.ino, b.ino, `${p} was rewritten`)
      assert.equal(after.get(p)!.mtimeMs, b.mtimeMs, `${p} was rewritten`)
    }
    assert.ok(!r.events.some((e) => /^(Wiping|Removing)/.test(e.title)), 'nothing to remove, no wipe')
    assert.equal(r.events.filter((e) => e.phase === 'copy').length, 0, 'Copy counts only arrivals — none')
    // Rebuilt in full (the writer only stamps the clock's second, so the bytes
    // can come out identical; the write itself is what this proves).
    const dbAfter = await stat(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    assert.ok(dbAfter.mtimeMs > dbBefore.mtimeMs, 'the catalog was rebuilt')
    assert.ok(r.events.some((e) => e.phase === 'db' && e.title === 'iTunesDB written'))
    const { paths } = await cardCatalog(r.card)
    assert.deepEqual(paths.slice().sort(), range(0, N).map(pathOf).sort())
    await assertCardWhole(r)
  })

  it('7 swapped: 7 deletes, 7 copies, the staying files untouched, the catalog is exactly the target', async () => {
    for (let id = 100; id < 107; id++) await addSong(r, id)
    const target = [...range(0, 13), ...range(100, 107)]
    const before = await cardFiles(r.card)
    const res = await sync(r, target)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.deepEqual(res.swap, { out: 7, in: 7, stayed: 13, changed: 0 })
    assert.equal(res.summary, 'Swapped 7 songs: 7 out, 7 in. 13 stayed.')
    assert.equal(res.copied, 7)
    const after = await cardFiles(r.card)
    for (const id of range(0, 13)) {
      const p = pathOf(id)
      assert.equal(after.get(p)!.ino, before.get(p)!.ino, `${p} (staying) was rewritten`)
      assert.equal(after.get(p)!.mtimeMs, before.get(p)!.mtimeMs, `${p} (staying) was rewritten`)
    }
    for (const id of range(13, 20)) assert.ok(!after.has(pathOf(id)), `${id} left`)
    for (const id of range(100, 107)) assert.equal(after.get(pathOf(id))?.size, SONG_BYTES, `${id} arrived`)
    assert.equal(after.size, 20)
    const { paths } = await cardCatalog(r.card)
    assert.deepEqual(paths.slice().sort(), target.map(pathOf).sort())
    await assertCardWhole(r)
    // The strip: Remove (never Wipe), and Copy counts the 7 arrivals only.
    const removing = r.events.filter((e) => /^Removing/.test(e.title))
    assert.ok(removing.length > 0 && removing.every((e) => e.phase === 'copy'))
    assert.ok(!r.events.some((e) => /^Wiping/.test(e.title)))
    assert.ok(r.events.filter((e) => e.phase === 'copy' && !/^Removing/.test(e.title)).every((e) => e.total === 7))
    assert.ok(r.events.some((e) => e.mode === 'swap' && e.summary === res.summary))
    // The backstop's count: one swap that removed 7 songs since the full copy.
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.equal(m.swapsSinceFull, 1)
    assert.equal(m.bytesRemovedSinceFull, 7 * SONG_BYTES)
    // The ledger says what moved.
    const ledger = (await readFile(join(r.state, 'activity-sync-ledger.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l))
    const result = ledger.filter((e) => e.kind === 'result').pop()
    assert.equal(result.mode, 'swap')
    assert.deepEqual(result.swap, { out: 7, in: 7, stayed: 13, changed: 0 })
  })

  it('a song whose library file changed is re-copied (leaves and arrives)', async () => {
    const target = [...range(0, 13), ...range(100, 107)]
    await addSong(r, 5, SONG_BYTES + 512, 0x55)    // re-downloaded: new bytes, new size, same id and path
    const res = await sync(r, target)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.deepEqual(res.swap, { out: 1, in: 1, stayed: 19, changed: 1 })
    assert.match(String(res.summary), /^Swapped 1 song: 1 out, 1 in\. 19 stayed\. 1 of them was re-copied because the library file changed\.$/)
    assert.equal((await cardFiles(r.card)).get(pathOf(5))?.size, SONG_BYTES + 512)
    await assertCardWhole(r)
  })
})

describe('the Original (not list-only, fill-to-N) swaps too', () => {
  let r: Rig
  before(async () => { r = await makeRig() })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })
  it('full first, then a swap of 3', async () => {
    const first = await sync(r, range(0, N), { listOnly: false })
    assert.equal(first.ok, true, first.error)
    assert.equal(first.mode, 'full')
    for (let id = 400; id < 403; id++) await addSong(r, id)
    const res = await sync(r, [...range(0, N - 3), 400, 401, 402], { listOnly: false })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap')
    assert.deepEqual(res.swap, { out: 3, in: 3, stayed: N - 3, changed: 0 })
    assert.equal(res.summary, `Swapped 3 songs: 3 out, 3 in. ${N - 3} stayed.`)
    await assertCardWhole(r)
  })
})

describe('swap-only sync falls back to a full copy whenever the card can’t be proven', () => {
  let r: Rig
  const target = range(0, N)
  before(async () => {
    r = await makeRig()
    const first = await sync(r, target)
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  const expectFull = async (why: RegExp): Promise<void> => {
    const res = await sync(r, target)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'full')
    assert.match(String(res.fullReason), why)
    assert.match(String(res.summary), /^Full copy: /)
    assert.equal(res.copied, N)
    await assertCardWhole(r)
    // and the run after it is a swap again
    const again = await sync(r, target)
    assert.equal(again.mode, 'swap', again.fullReason)
  }

  it('no seal', async () => {
    await unlink(join(r.state, 'ipod-activity-tsa-seal.json'))
    await expectFull(/no seal/)
  })
  it('the card’s catalog is not the one the last sync wrote', async () => {
    // Another writer's catalog: still valid, one character of the iPod's name differs.
    const db = join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB')
    const buf = await readFile(db)
    const at = buf.indexOf(Buffer.from('TestPod', 'utf16le'))
    assert.ok(at > 0)
    buf.write('X', at, 'utf16le')
    await writeFile(db, buf)
    await expectFull(/isn’t the one the last sync wrote/)
  })
  it('a missing file on the card', async () => {
    await unlink(join(r.card, 'iPod_Control', 'Music', folder(3), songName(3)))
    await expectFull(/1 song missing/)
  })
  it('a short file on the card', async () => {
    await truncate(join(r.card, 'iPod_Control', 'Music', folder(4), songName(4)), 100)
    await expectFull(/1 song the wrong size/)
  })
  it('a file the last sync didn’t put there', async () => {
    await mkdir(join(r.card, 'iPod_Control', 'Music', 'F09'), { recursive: true })
    await writeFile(join(r.card, 'iPod_Control', 'Music', 'F09', 'STRAY.m4a'), 'x')
    await expectFull(/1 file the last sync didn’t put there/)
  })
  it('a manifest from an older format', async () => {
    const p = join(r.state, 'last-sync-manifest.json')
    const m = JSON.parse(await readFile(p, 'utf-8'))
    delete m.format
    await writeFile(p, JSON.stringify(m))
    await expectFull(/older JakeTunes/)
  })
  it('a firmware-unsafe catalog (ids out of order), even with a matching record', async () => {
    const db = join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB')
    const buf = await readFile(db)
    // Swap the ids of the first two mhit records, then make the record agree.
    const first = buf.indexOf('mhit', 0, 'latin1')
    const second = buf.indexOf('mhit', first + 4, 'latin1')
    const a = buf.readUInt32LE(first + 0x10)
    buf.writeUInt32LE(buf.readUInt32LE(second + 0x10), first + 0x10)
    buf.writeUInt32LE(a, second + 0x10)
    await writeFile(db, buf)
    const p = join(r.state, 'last-sync-manifest.json')
    const m = JSON.parse(await readFile(p, 'utf-8'))
    const { createHash } = await import('crypto')
    m.catalog = { md5: createHash('md5').update(buf).digest('hex'), bytes: buf.length }
    await writeFile(p, JSON.stringify(m))
    await expectFull(/firmware’s id order/)
  })
  it('more than 70% of the set changing', async () => {
    for (let id = 200; id < 215; id++) await addSong(r, id)
    const big = [...range(0, 5), ...range(200, 215)]      // 15 of 20 arrive = 75%
    const res = await sync(r, big)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'full')
    assert.match(String(res.fullReason), /15 of 20 songs are changing, so a full copy is simpler/)
    await assertCardWhole(r)
    const back = await sync(r, target)    // put the fixture's set back (75% again → full)
    assert.equal(back.ok, true, back.error)
  })
})
