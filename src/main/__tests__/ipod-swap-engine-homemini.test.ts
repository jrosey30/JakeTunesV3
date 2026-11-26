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
 * This file: songs that stay, songs staged from homemini, conversion, the ready check, MP3-only iPods. Shared rig: swap-engine-rig.ts.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { onCardByRecord, readCardState, runActivitySync } from '../ipod-activity-engine.ts'
import { N, SONG_BYTES, DURATION_MS, type Rig, folder, addSong, makeRig, sync, cardFiles, cardCatalog, assertCardWhole, pathOf, range } from './swap-engine-rig.ts'

// ── 2026-11-08, the punkPod on a slow relay: an arrival homemini couldn't send
// stopped a whole swap, and four songs with no fingerprint yet were re-copied. ──

/** Evict a song from the Mac: its bytes live only on "homemini" now. */
async function evict(r: Rig, id: number, homemini: Map<number, Buffer>): Promise<void> {
  const p = join(r.lib, String(r.library.get(id)!.path).slice(1).replace(/:/g, '/'))
  homemini.set(id, await readFile(p))
  await unlink(p)
}

/** A homemini that sends what it has, except the ids in `refuse` (fetch failed). */
function wireHomemini(r: Rig, homemini: Map<number, Buffer>, refuse: Set<number>, onFail?: () => void): { fetched: number[] } {
  const seen = { fetched: [] as number[] }
  r.host.probeHomeminiTrack = async (id) => homemini.has(id) ? { ok: true, bytes: homemini.get(id)!.length } : { ok: false, error: 'homemini 404' }
  r.host.stageTrack = async (_colon, id) => {
    if (refuse.has(id) || !homemini.has(id)) { onFail?.(); return { ok: false, error: 'fetch failed', reason: 'fetch' } }
    seen.fetched.push(id)
    const dir = join(r.root, 'stage'); await mkdir(dir, { recursive: true })
    const abs = join(dir, `${id}.m4a`)
    await writeFile(abs, homemini.get(id)!)
    return { ok: true, abs, staged: true, pulled: true, cleanup: async () => { await unlink(abs).catch(() => {}) } }
  }
  return seen
}

describe('a list-only swap with an arrival homemini can’t send', () => {
  let r: Rig
  const homemini = new Map<number, Buffer>()
  before(async () => {
    r = await makeRig()
    for (let id = 700; id < 705; id++) await addSong(r, id)
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('leaves that song off, finishes the swap with N-1, sealed, and says why', async () => {
    for (let id = 700; id < 705; id++) await evict(r, id, homemini)
    const dbBefore = await readFile(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))
    const filesBefore = await cardFiles(r.card)
    let cardAtFail: { db: Buffer } | null = null
    const seen = wireHomemini(r, homemini, new Set([702]), () => {
      cardAtFail = {
        db: Buffer.from(readFileSync(join(r.card, 'iPod_Control', 'iTunes', 'iTunesDB'))),
      }
    })
    const set = [...range(0, N - 5), ...range(700, 705)]          // 5 out, 5 in, one of them unfetchable
    const res = await sync(r, set)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', res.fullReason)
    assert.equal(res.target, N - 1)
    assert.deepEqual(res.swap, { out: 5, in: 4, stayed: N - 5, changed: 0 })
    assert.deepEqual(res.leftOff?.map((l) => [l.id, l.why]), [[702, "homemini couldn't send its audio file"]])
    // Known before anything on the card changed: the old catalog, the old files.
    assert.ok(cardAtFail, 'the failing fetch happened')
    assert.equal(Buffer.compare(cardAtFail!.db, dbBefore), 0, 'the fetch failed while the card still held the last sync’s catalog')
    assert.deepEqual(seen.fetched.sort(), [700, 701, 703, 704], 'every other arrival was fetched ahead')
    // The card: the stays untouched, the 4 that came, the leavers gone.
    const after = await cardFiles(r.card)
    for (const id of range(0, N - 5)) assert.equal(after.get(pathOf(id))!.ino, filesBefore.get(pathOf(id))!.ino, `${id} (staying) was rewritten`)
    assert.deepEqual([...after.keys()].sort(), [...range(0, N - 5), 700, 701, 703, 704].map(pathOf).sort())
    const { paths } = await cardCatalog(r.card)
    assert.deepEqual(paths.slice().sort(), [...range(0, N - 5), 700, 701, 703, 704].map(pathOf).sort())
    await assertCardWhole(r)
    // Sealed with N-1, the ledger names the song left off, and the staged copies are gone.
    const seal = JSON.parse(await readFile(join(r.state, 'ipod-activity-tsa-seal.json'), 'utf-8'))
    assert.equal(seal.target, N - 1)
    const result = (await readFile(join(r.state, 'activity-sync-ledger.jsonl'), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'result').pop()
    assert.deepEqual(result.leftOff.map((l: { id: number; why: string }) => [l.id, l.why]), [[702, "homemini couldn't send its audio file"]])
    assert.equal(result.landed, N - 1)
    assert.deepEqual(await readdir(join(r.root, 'stage')), [], 'every staged arrival was released')
    // When homemini can send it, the next Sync adds it as a swap.
    const again = wireHomemini(r, homemini, new Set())
    const next = await sync(r, set)
    assert.equal(next.ok, true, next.error)
    assert.equal(next.mode, 'swap', next.fullReason)
    assert.deepEqual(next.swap, { out: 0, in: 1, stayed: N - 1, changed: 0 })
    assert.deepEqual(again.fetched, [702], 'the evicted songs on the card stay: only the newcomer is fetched')
    await assertCardWhole(r)
  })
})

describe('a list-only full copy with a song homemini can’t send at copy time', () => {
  it('leaves it off and seals N-1 (never a stopped sync)', async () => {
    const r = await makeRig()
    try {
      const homemini = new Map<number, Buffer>()
      await evict(r, 4, homemini)
      wireHomemini(r, homemini, new Set([4]))
      const res = await sync(r, range(0, N))
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.equal(res.target, N - 1)
      assert.deepEqual(res.leftOff?.map((l) => l.id), [4])
      await assertCardWhole(r)
      assert.ok(!(await cardFiles(r.card)).has(pathOf(4)))
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

describe('songs that stay are not re-copied', () => {
  let r: Rig
  const homemini = new Map<number, Buffer>()
  before(async () => { r = await makeRig() })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('a song evicted from the Mac since the last sync, unchanged, stays', async () => {
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
    for (const id of [3, 8, 13]) await evict(r, id, homemini)
    const seen = wireHomemini(r, homemini, new Set())
    const before = await cardFiles(r.card)
    const res = await sync(r, range(0, N))
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', res.fullReason)
    assert.deepEqual(res.swap, { out: 0, in: 0, stayed: N, changed: 0 })
    assert.equal(res.copied, 0)
    assert.deepEqual(seen.fetched, [], 'nothing fetched from homemini')
    const after = await cardFiles(r.card)
    for (const id of [3, 8, 13]) assert.equal(after.get(pathOf(id))!.ino, before.get(pathOf(id))!.ino)
  })

  it('a fresh download with no fingerprint yet (and a card name unlike its library name) stays', async () => {
    // "imported_14505.m4a" rides as "14505.m4a": the 4 Cramps songs, 2026-11-08.
    const ids = [14505, 14506]
    for (const id of ids) {
      const dir = join(r.lib, 'iPod_Control', 'Music', 'F05')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `imported_${id}.m4a`), Buffer.alloc(SONG_BYTES, id & 0xff))
      r.library.set(id, {
        id, title: `Fresh ${id}`, artist: 'The Cramps', album: 'Bad Music for Bad People', genre: 'Rock',
        duration: DURATION_MS, codec: 'alac', path: `:iPod_Control:Music:F05:imported_${id}.m4a`,
      })
    }
    const set = [...range(0, N), ...ids]
    const add = await sync(r, set)
    assert.equal(add.ok, true, add.error)
    assert.deepEqual(add.swap, { out: 0, in: 2, stayed: N, changed: 0 })
    const m = JSON.parse(await readFile(join(r.state, 'last-sync-manifest.json'), 'utf-8'))
    assert.ok(m.tracks.filter((t: { id: number }) => ids.includes(t.id)).every((t: { identity: string }) => t.identity.startsWith('path:')))
    const before = await cardFiles(r.card)
    const res = await sync(r, set)
    assert.equal(res.ok, true, res.error)
    assert.deepEqual(res.swap, { out: 0, in: 0, stayed: N + 2, changed: 0 }, 'no re-copy for a song with no fingerprint')
    // and once the fingerprint pass reaches them, still no re-copy
    for (const id of ids) r.library.get(id)!.audioFingerprint = `sha1:${id}|${SONG_BYTES}`
    const fp = await sync(r, set)
    assert.equal(fp.ok, true, fp.error)
    assert.deepEqual(fp.swap, { out: 0, in: 0, stayed: N + 2, changed: 0 }, 'gaining a fingerprint is not a change')
    const after = await cardFiles(r.card)
    for (const id of ids) {
      const p = `:iPod_Control:Music:F05:${id}.m4a`
      assert.equal(after.get(p)!.ino, before.get(p)!.ino, `${p} was rewritten`)
    }
    // A real change still re-copies: a new master size at the same path.
    await writeFile(join(r.lib, 'iPod_Control', 'Music', 'F05', `imported_${ids[0]}.m4a`), Buffer.alloc(SONG_BYTES + 64, 1))
    r.library.get(ids[0])!.audioFingerprint = `sha1:${ids[0]}|${SONG_BYTES}`   // fingerprint not refreshed yet
    const changed = await sync(r, set)
    assert.equal(changed.ok, true, changed.error)
    assert.deepEqual(changed.swap, { out: 1, in: 1, stayed: N + 1, changed: 1 })
  })
})

describe('the Original swap with an arrival homemini can’t send', () => {
  it('a reserve takes the seat, fetched-ahead failures never touch the card, N still means N', async () => {
    const r = await makeRig()
    try {
      const first = await sync(r, range(0, N), { listOnly: false })
      assert.equal(first.ok, true, first.error)
      const homemini = new Map<number, Buffer>()
      for (let id = 800; id < 804; id++) await addSong(r, id)
      await evict(r, 801, homemini)
      wireHomemini(r, homemini, new Set([801]))
      const tracks = [...range(0, N - 2), 800, 801].map((id) => ({ ...r.library.get(id)! }))
      const reserve = [802, 803].map((id) => ({ ...r.library.get(id)! }))
      const res = await runActivitySync(r.host, {
        tracks, reserve, playlists: [{ name: 'Top 1000', trackIds: tracks.map((t) => t.id) }],
        requestedTarget: N, listOnly: false, ipodName: 'TestPod',
      })
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', res.fullReason)
      assert.equal(res.target, N)
      assert.equal(res.leftOff, undefined)
      const files = await cardFiles(r.card)
      assert.ok(files.has(pathOf(800)) && files.has(pathOf(802)) && !files.has(pathOf(801)))
      assert.equal(files.size, N)
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

// ── 2026-11-08, follow-up to #381: the homemini probe ran BEFORE the swap
// plan, so on a slow link a probe miss for an evicted song already on the
// card (one that would stay) still left it off. The plan comes first now. ──

/** Probes homemini answers: ok for the ids in `answers`, a timeout for the rest. Records every id asked. */
function wireProbe(r: Rig, homemini: Map<number, Buffer>, answers: (id: number) => boolean): { asked: number[] } {
  const seen = { asked: [] as number[] }
  r.host.probeHomeminiTrack = async (id) => {
    seen.asked.push(id)
    return answers(id) && homemini.has(id) ? { ok: true, bytes: homemini.get(id)!.length } : { ok: false, error: 'timed out after 8000 ms' }
  }
  return seen
}

describe('a list-only swap on a link where homemini’s probe times out', () => {
  let r: Rig
  const homemini = new Map<number, Buffer>()
  before(async () => {
    r = await makeRig()
    for (const id of [950, 951, 960]) await addSong(r, id)
    const first = await sync(r, range(0, N))
    assert.equal(first.ok, true, first.error)
    for (const id of [3, 8, 13]) await evict(r, id, homemini)
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('an evicted song that stays is never probed, stays on the card and in the catalog', async () => {
    wireHomemini(r, homemini, new Set())
    const probe = wireProbe(r, homemini, () => false)
    const before = await cardFiles(r.card)
    const set = [...range(0, N - 2), 950, 951]
    const res = await sync(r, set)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', res.fullReason)
    assert.equal(res.target, N)
    assert.deepEqual(res.swap, { out: 2, in: 2, stayed: N - 2, changed: 0 })
    assert.ok(!res.leftOff?.length, `nothing left off: ${JSON.stringify(res.leftOff)}`)
    assert.deepEqual(probe.asked, [], 'a song that stays is never asked about')
    const after = await cardFiles(r.card)
    for (const id of [3, 8, 13]) assert.equal(after.get(pathOf(id))?.ino, before.get(pathOf(id))!.ino, `${id} stayed untouched`)
    const { paths } = await cardCatalog(r.card)
    for (const id of [3, 8, 13]) assert.ok(paths.includes(pathOf(id)), `${id} is in the catalog`)
    assert.equal(paths.length, N)
    await assertCardWhole(r)
  })

  it('an evicted song that arrives and can’t be probed is left off with the reason; the stays still stay', async () => {
    await evict(r, 960, homemini)
    wireHomemini(r, homemini, new Set())
    const probe = wireProbe(r, homemini, () => false)
    const before = await cardFiles(r.card)
    const set = [...range(0, N - 3), 950, 951, 960]
    const res = await sync(r, set)
    assert.equal(res.ok, true, res.error)
    assert.equal(res.mode, 'swap', res.fullReason)
    assert.equal(res.target, N - 1)
    assert.deepEqual(res.leftOff?.map((l) => [l.id, l.why]), [[960, "homemini couldn't send its audio file"]])
    assert.deepEqual(probe.asked, [960], 'only the arrival is asked about')
    const after = await cardFiles(r.card)
    for (const id of [3, 8, 13]) assert.equal(after.get(pathOf(id))?.ino, before.get(pathOf(id))!.ino, `${id} stayed untouched`)
    assert.ok(!after.has(pathOf(960)))
    assert.deepEqual([...after.keys()].sort(), [...range(0, N - 3), 950, 951].map(pathOf).sort())
    await assertCardWhole(r)
  })
})

describe('a full copy probes every song not on this Mac, as before', () => {
  it('no record of a last sync: the miss is asked about up front and left off', async () => {
    const r = await makeRig()
    try {
      const homemini = new Map<number, Buffer>()
      for (const id of [4, 9]) await evict(r, id, homemini)
      wireHomemini(r, homemini, new Set())
      const probe = wireProbe(r, homemini, (id) => id !== 4)
      const res = await sync(r, range(0, N))
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.equal(res.target, N - 1)
      assert.deepEqual(res.leftOff?.map((l) => [l.id, l.why]), [[4, "homemini couldn't send its audio file"]])
      assert.deepEqual(probe.asked.sort((a, b) => a - b), [4, 9])
      assert.ok(!(await cardFiles(r.card)).has(pathOf(4)))
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a provable card that still gets a full copy (too much changing): the record’s songs are asked about too', async () => {
    const r = await makeRig()
    try {
      const first = await sync(r, range(0, N))
      assert.equal(first.ok, true, first.error)
      for (let id = 900; id < 915; id++) await addSong(r, id)
      const homemini = new Map<number, Buffer>()
      for (const id of [0, 1, 2]) await evict(r, id, homemini)
      wireHomemini(r, homemini, new Set())
      const probe = wireProbe(r, homemini, (id) => id !== 1)
      const res = await sync(r, [...range(0, 5), ...range(900, 915)])   // 75% changing
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.equal(res.target, N - 1)
      assert.deepEqual(res.leftOff?.map((l) => [l.id, l.why]), [[1, "homemini couldn't send its audio file"]])
      assert.deepEqual(probe.asked.sort((a, b) => a - b), [0, 1, 2])
      const files = await cardFiles(r.card)
      assert.ok(files.has(pathOf(0)) && files.has(pathOf(2)) && !files.has(pathOf(1)))
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

// ── 2026-11-08 (after #382): a song not on this Mac that needs converting
// (FLAC, or over the Mini's ceiling) used to be downloaded in full while the
// sync was still planning, even when the last sync's record put it on the card
// and it would stay — and a failed download stopped the sync. A song that
// stays now never needs its bytes. ──

const FLAC_ID = 970
const flacPath = `:iPod_Control:Music:${folder(FLAC_ID)}:S${FLAC_ID}.flac`

async function addFlac(r: Rig): Promise<void> {
  const dir = join(r.lib, 'iPod_Control', 'Music', folder(FLAC_ID))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `S${FLAC_ID}.flac`), Buffer.alloc(SONG_BYTES + 1000, 0x5a))
  r.library.set(FLAC_ID, {
    id: FLAC_ID, title: 'Flac Song', artist: 'Band Z', album: 'Album 0', genre: 'Rock',
    duration: DURATION_MS, codec: 'flac', path: flacPath,
    audioFingerprint: `sha1:${FLAC_ID.toString(16).padStart(8, '0')}|${SONG_BYTES + 1000}`,
  })
  // The ALAC mirror: the same bytes cut to the song size, as a .m4a (the real one is ffmpeg).
  r.host.buildIpodSafeAlacMirror = async (src) => {
    const dir2 = join(r.root, 'mirrors'); await mkdir(dir2, { recursive: true })
    const out = join(dir2, `mirror-${Date.now()}-${Math.random().toString(36).slice(2)}.m4a`)
    await writeFile(out, (await readFile(src)).subarray(0, SONG_BYTES))
    return out
  }
}

/** Production stages a song under its own extension (stageFileName): a FLAC stays .flac. */
function stageKeepsExtension(r: Rig, homemini: Map<number, Buffer>, seen: { fetched: number[] }): void {
  r.host.stageTrack = async (colon, id) => {
    if (!homemini.has(id)) return { ok: false, error: 'fetch failed', reason: 'fetch' }
    seen.fetched.push(id)
    const dir = join(r.root, 'stage'); await mkdir(dir, { recursive: true })
    const abs = join(dir, `${id}${colon.slice(colon.lastIndexOf('.'))}`)
    await writeFile(abs, homemini.get(id)!)
    return { ok: true, abs, staged: true, pulled: true, cleanup: async () => { await unlink(abs).catch(() => {}) } }
  }
}

describe('a song not on this Mac that needs converting', () => {
  it('stays on the card without ever being downloaded', async () => {
    const r = await makeRig()
    try {
      await addFlac(r)
      const set = [...range(0, N - 1), FLAC_ID]
      const first = await sync(r, set)
      assert.equal(first.ok, true, first.error)
      const homemini = new Map<number, Buffer>()
      await evict(r, FLAC_ID, homemini)
      const fetch = wireHomemini(r, homemini, new Set())
      const probe = wireProbe(r, homemini, () => true)
      const before = await cardFiles(r.card)
      const cardPath = [...before.keys()].find((p) => p.includes(`S${FLAC_ID}`))!
      assert.ok(cardPath, 'the first sync put the mirror on the card')
      const res = await sync(r, set)
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', res.fullReason)
      assert.deepEqual(fetch.fetched, [], 'a song that stays is never downloaded')
      assert.deepEqual(probe.asked, [], 'a song that stays is never asked about')
      assert.ok(!res.leftOff?.length, JSON.stringify(res.leftOff))
      const after = await cardFiles(r.card)
      assert.equal(after.get(cardPath)?.ino, before.get(cardPath)!.ino, 'the mirror on the card is untouched')
      assert.ok((await cardCatalog(r.card)).paths.includes(cardPath), 'and in the catalog')
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('a staying song whose download would fail no longer stops the sync', async () => {
    const r = await makeRig()
    try {
      await addFlac(r)
      const set = [...range(0, N - 1), FLAC_ID]
      assert.equal((await sync(r, set)).ok, true)
      const homemini = new Map<number, Buffer>()
      await evict(r, FLAC_ID, homemini)
      wireHomemini(r, homemini, new Set([FLAC_ID]))   // homemini can't send it
      const res = await sync(r, set, { listOnly: false })
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'swap', res.fullReason)
      assert.ok((await cardCatalog(r.card)).paths.some((p) => p.includes(`S${FLAC_ID}`)))
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })

  it('must move after all (a full copy): fetched and converted then, before the card changes', async () => {
    const r = await makeRig()
    try {
      await addFlac(r)
      assert.equal((await sync(r, [...range(0, N - 1), FLAC_ID])).ok, true)
      for (let id = 900; id < 915; id++) await addSong(r, id)
      const homemini = new Map<number, Buffer>()
      await evict(r, FLAC_ID, homemini)
      const fetch = wireHomemini(r, homemini, new Set())
      wireProbe(r, homemini, () => true)
      stageKeepsExtension(r, homemini, fetch)
      const res = await sync(r, [...range(0, 4), ...range(900, 915), FLAC_ID])   // most of the set changes
      assert.equal(res.ok, true, res.error)
      assert.equal(res.mode, 'full')
      assert.deepEqual(fetch.fetched, [FLAC_ID], 'fetched once, to convert it')
      const files = await cardFiles(r.card)
      const onCard = [...files.keys()].find((p) => p.includes(`S${FLAC_ID}`))
      assert.ok(onCard && onCard.endsWith('.m4a'), `the mirror is on the card: ${onCard}`)
      assert.equal(files.get(onCard!)!.size, SONG_BYTES)
      await assertCardWhole(r)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

describe('the Device page’s ready check: what is on the card by the record', () => {
  it('a song evicted from this Mac but on the card by the last sync needs nothing; a new one does', async () => {
    const r = await makeRig()
    try {
      await addFlac(r)
      await addSong(r, 980)
      const set = [...range(0, N - 1), FLAC_ID]
      assert.equal((await sync(r, set)).ok, true)
      const homemini = new Map<number, Buffer>()
      for (const id of [3, FLAC_ID, 980]) await evict(r, id, homemini)
      const readState = async (f: string) => JSON.parse(await readFile(join(r.state, f), 'utf-8'))
      const tracks = [...r.library.values()]
      const onCard = onCardByRecord([3, FLAC_ID, 980], tracks, await readState('last-sync-manifest.json'), await readState('ipod-activity-tsa-seal.json'), await readCardState(r.card))
      assert.deepEqual([...onCard.keys()].sort((a, b) => a - b), [3, FLAC_ID], '980 was never synced: it would have to be fetched')
      // An unsealed record proves nothing.
      assert.equal(onCardByRecord([3], tracks, await readState('last-sync-manifest.json'), null, await readCardState(r.card)).size, 0)
    } finally {
      await rm(r.root, { recursive: true, force: true })
    }
  })
})

// Gen 1 plays MP3 only (2026-11-24, Jake: "sync my ipod playlists as they are to AAC/high
// end mp3 only for those 3 ipods"). The engine puts the MP3 mirror on the card under .mp3,
// and a song with no MP3 stays off rather than going on as a file Gen 1 can't play.
describe('an iPod that plays MP3 only', () => {
  let r: Rig
  const asked: Array<{ kbps: number; codec: string | undefined }> = []
  before(async () => {
    r = await makeRig()
    r.host.buildAacMirror = async (src, kbps, codec) => {
      asked.push({ kbps, codec })
      const id = Number(/S(\d+)\.m4a$/.exec(src)?.[1])
      if (id === 3) return null                          // a damaged file: no MP3 can be made
      const out = join(r.root, `mirror-${id}.mp3`)
      await writeFile(out, Buffer.alloc(SONG_BYTES + 1000, id & 0xff))
      return out
    }
  })
  after(async () => { await rm(r.root, { recursive: true, force: true }) })

  it('copies MP3 mirrors as .mp3 and leaves off the song it could not convert', async () => {
    const ids = range(0, 6)
    const tracks = ids.map((id) => ({ ...r.library.get(id)! }))
    const res = await runActivitySync(r.host, {
      tracks, playlists: [{ name: 'Gen 1', trackIds: ids }], requestedTarget: ids.length,
      listOnly: true, ipodName: 'Gen 1',
      convertOptions: { enabled: true, targetKbps: 320, codec: 'mp3' },
    })
    assert.equal(res.ok, true, res.error)
    assert.ok(asked.every((a) => a.kbps === 320 && a.codec === 'mp3'), JSON.stringify(asked))
    assert.deepEqual((res.unconvertible ?? []).map((u) => u.id), [3])
    const { paths } = await cardCatalog(r.card)
    assert.equal(paths.length, 5)
    assert.ok(paths.every((p) => p.endsWith('.mp3')), paths.join(', '))
    const files = await cardFiles(r.card)
    assert.ok([...files.keys()].every((p) => !p.endsWith('.m4a')), 'no AAC or ALAC on a Gen 1')
    for (const [, f] of files) assert.equal(f.size, SONG_BYTES + 1000, "the mirror went on, not the master")
  })

  it('the next sync of the same list moves nothing', async () => {
    const ids = range(0, 6)
    const tracks = ids.map((id) => ({ ...r.library.get(id)! }))
    const res = await runActivitySync(r.host, {
      tracks, playlists: [{ name: 'Gen 1', trackIds: ids }], requestedTarget: ids.length,
      listOnly: true, ipodName: 'Gen 1',
      convertOptions: { enabled: true, targetKbps: 320, codec: 'mp3' },
    })
    assert.equal(res.ok, true, res.error)
    assert.equal(res.copied, 0)
    const { paths } = await cardCatalog(r.card)
    assert.ok(paths.length === 5 && paths.every((p) => p.endsWith('.mp3')), paths.join(', '))
  })
})
