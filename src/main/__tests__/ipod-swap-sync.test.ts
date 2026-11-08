/**
 * Swap-only iPod sync — the pure rules (ipod-swap-sync.ts), the strip's
 * "Remove" label and result line, the stop note, and the round trip against a
 * rebuilt catalog. The engine end to end, on a fake card, is
 * ipod-swap-engine.test.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SWAP_FULL_EVERY,
  SWAP_MANIFEST_FORMAT,
  SWAP_MAX_REMOVED_SHARE,
  nextSwapHistory,
  swapBackstop,
  catalogIdsAscend,
  fullCopyLine,
  planSwap,
  proveCardForSwap,
  rowsMissingOnCard,
  stayVerdict,
  swapResultLine,
  swapTooBig,
  type CardState,
  type SwapCandidate,
  type SwapManifestRow,
} from '../ipod-swap-sync.ts'
import { IDLE_TIMELINE, applySyncResult, reduceSyncEvent, resultLine, startTimeline, stepLabel } from '../../common/sync-progress-model.ts'
import { swapKeptNote, syncFailureCopy, syncOutcome } from '../../common/sync-failure-copy.ts'
import { ROUNDTRIP_STATE_FILE, startRoundTripGeneration } from '../sync-engine/roundtrip.ts'

const P = (n: number) => `:iPod_Control:Music:F0${n % 10}:S${n}.m4a`
const row = (id: number, over: Partial<SwapManifestRow> = {}): SwapManifestRow => ({
  id, destPath: P(id), identity: `fp:sha1:${id}|1`, size: 1000 + id, sourceSize: 2000 + id, ...over,
})

function fixture(ids = [0, 1, 2, 3]) {
  const rows = ids.map((id) => row(id))
  const manifest = {
    format: SWAP_MANIFEST_FORMAT, syncedAt: 'x', status: 'sealed', sealed: true, count: rows.length,
    catalog: { md5: 'abc', bytes: 4096 },
    swapsSinceFull: 0, bytesRemovedSinceFull: 0,
    tracks: rows,
  }
  const seal = {
    version: 1, sealedAt: 'x', target: rows.length,
    passengers: rows.map((r) => ({ id: r.id, identity: r.identity, destPath: r.destPath, expectedSize: r.size })),
  }
  const card: CardState = {
    catalog: { md5: 'abc', bytes: 4096 },
    catalogIdsAscend: true,
    files: new Map(rows.map((r) => [r.destPath, r.size])),
  }
  return { rows, manifest, seal, card }
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

describe('proveCardForSwap — a swap only on a card that is proven, every no in plain words', () => {
  it('proves a sealed, matching card (library id 0 counts: Lou Reed is id 0)', () => {
    const f = fixture()
    const p = proveCardForSwap(f.manifest, f.seal, f.card)
    assert.equal(p.ok, true)
    if (p.ok) assert.deepEqual([...p.rows.keys()], [0, 1, 2, 3])
  })
  const no = (m: unknown, s: unknown, c: CardState, why: RegExp) => {
    const p = proveCardForSwap(m, s, c)
    assert.equal(p.ok, false)
    if (!p.ok) assert.match(p.why, why)
  }
  it('no record of the last sync', () => {
    const f = fixture()
    no(null, f.seal, f.card, /no record of what the last sync put/)
  })
  it('the last sync did not finish (in-flight / interim / catalogued manifests)', () => {
    const f = fixture()
    for (const status of ['in-flight', 'interim', 'catalogued']) {
      no({ ...f.manifest, status, sealed: false }, f.seal, f.card, /didn’t finish/)
    }
  })
  it('a manifest from an older format (no catalog hash, no sizes)', () => {
    const f = fixture()
    const old = { syncedAt: 'x', status: 'sealed', sealed: true, count: 4, tracks: f.rows.map(({ id, destPath, identity }) => ({ id, destPath, identity })) }
    no(old, f.seal, f.card, /older JakeTunes/)
  })
  it('a manifest that cannot be read', () => {
    const f = fixture()
    no({ ...f.manifest, count: 9 }, f.seal, f.card, /can’t be read/)
    no({ ...f.manifest, tracks: [...f.rows, f.rows[0]] }, f.seal, f.card, /can’t be read/)
    const noHistory: Record<string, unknown> = { ...f.manifest }
    delete noHistory.swapsSinceFull
    no(noHistory, f.seal, f.card, /can’t be read/)
  })
  it('no seal, or a seal that disagrees with the manifest', () => {
    const f = fixture()
    no(f.manifest, null, f.card, /no seal/)
    const s = clone(f.seal); s.passengers[2].identity = 'fp:sha1:other|1'
    no(f.manifest, s, f.card, /disagree/)
    const s2 = clone(f.seal); s2.passengers[1].expectedSize = 5
    no(f.manifest, s2, f.card, /disagree/)
  })
  it('the card’s catalog is missing, or not the one the last sync wrote', () => {
    const f = fixture()
    no(f.manifest, f.seal, { ...f.card, catalog: null }, /can’t be read/)
    no(f.manifest, f.seal, { ...f.card, catalog: { md5: 'zzz', bytes: 4096 } }, /isn’t the one the last sync wrote/)
    no(f.manifest, f.seal, { ...f.card, catalog: { md5: 'abc', bytes: 4097 } }, /isn’t the one the last sync wrote/)
  })
  it('a catalog that breaks the firmware’s id order (firmware-unsafe)', () => {
    const f = fixture()
    no(f.manifest, f.seal, { ...f.card, catalogIdsAscend: false }, /firmware’s id order/)
    no(f.manifest, f.seal, { ...f.card, catalogIdsAscend: null }, /firmware’s id order/)
  })
  it('missing or short files on the card', () => {
    const f = fixture()
    const missing = new Map(f.card.files); missing.delete(P(2))
    no(f.manifest, f.seal, { ...f.card, files: missing }, /1 song missing/)
    const short = new Map(f.card.files); short.set(P(3), 10)
    no(f.manifest, f.seal, { ...f.card, files: short }, /1 song the wrong size/)
  })
  it('files the last sync did not put there; macOS dot files do not count', () => {
    const f = fixture()
    const extra = new Map(f.card.files); extra.set(':iPod_Control:Music:F09:STRANGER.m4a', 5)
    no(f.manifest, f.seal, { ...f.card, files: extra }, /1 file the last sync didn’t put there/)
    const dots = new Map(f.card.files); dots.set(':iPod_Control:Music:F01:._S1.m4a', 4096); dots.set(':iPod_Control:Music:F00:.DS_Store', 6148)
    assert.equal(proveCardForSwap(f.manifest, f.seal, { ...f.card, files: dots }).ok, true)
  })
})

describe('planSwap — identity by fingerprint (or id + exact path) and size, never text', () => {
  const cand = (id: number, over: Partial<SwapCandidate> = {}): SwapCandidate => ({
    id, destPath: P(id), identity: `fp:sha1:${id}|1`, copySize: 1000 + id, sourceSize: 2000 + id, ...over,
  })
  const rows = new Map(fixture().rows.map((r) => [r.id, r]))
  it('stays only when id, card path, fingerprint, copy size and master size all match', () => {
    assert.equal(stayVerdict(cand(1), rows.get(1)), 'stay')
    assert.equal(stayVerdict(cand(9), undefined), 'new')
    assert.equal(stayVerdict(cand(1, { destPath: ':iPod_Control:Music:F09:X.m4a' }), rows.get(1)), 'moved')
    assert.equal(stayVerdict(cand(1, { identity: 'fp:sha1:new|1' }), rows.get(1)), 'identity-changed')
    // No fingerprint yet (a fresh download): id + card path + both sizes known and equal.
    const pathRow = { ...rows.get(1)!, identity: 'path::iPod_Control:Music:F01:S1.m4a' }
    assert.equal(stayVerdict(cand(1, { identity: 'path::iPod_Control:Music:F01:imported_1.m4a' }), pathRow), 'stay', 'the seal keeps the card form of the path; the library form still matches by id + card path + sizes')
    assert.equal(stayVerdict(cand(1, { identity: 'path::iPod_Control:Music:F01:S1.m4a', sourceSize: 0 }), pathRow), 'identity-changed', 'no fingerprint and no master size: nothing vouches')
    assert.equal(stayVerdict(cand(1, { identity: 'path::iPod_Control:Music:F01:S1.m4a', copySize: 5 }), pathRow), 'file-changed')
    assert.equal(stayVerdict(cand(1), pathRow), 'stay', 'the song gained its fingerprint after the sync that put it there')
    assert.equal(stayVerdict(cand(1, { identity: 'path::iPod_Control:Music:F01:S1.m4a' }), rows.get(1)), 'identity-changed', 'a fingerprint on record is never traded for a path')
    assert.equal(stayVerdict(cand(1, { identity: 'id:1' }), { ...rows.get(1)!, identity: 'id:1' }), 'identity-changed', 'an id alone never vouches')
    assert.equal(stayVerdict(cand(1, { copySize: 77 }), rows.get(1)), 'file-changed')
    assert.equal(stayVerdict(cand(1, { copySize: 0 }), rows.get(1)), 'file-changed')
    assert.equal(stayVerdict(cand(1, { sourceSize: 3 }), rows.get(1)), 'file-changed', 'the master changed even if a mirror came out the same size')
  })
  it('a swap of two: two leave, two arrive, the rest stay; a changed file leaves and arrives', () => {
    const plan = planSwap([cand(0), cand(1), cand(8), cand(9)], rows)
    assert.deepEqual([...plan.stay], [0, 1])
    assert.deepEqual(plan.arrive, [8, 9])
    assert.deepEqual(plan.leave.map((r) => r.id), [2, 3])
    assert.deepEqual(plan.changed, [])
    const changed = planSwap([cand(0), cand(1, { sourceSize: 1 }), cand(2), cand(3)], rows)
    assert.deepEqual(changed.arrive, [1])
    assert.deepEqual(changed.leave.map((r) => r.id), [1])
    assert.deepEqual(changed.changed, [1])
  })
  it('more than 70% arriving is a full copy', () => {
    const plan = (n: number) => ({ stay: new Set<number>(), arrive: Array.from({ length: n }, (_, i) => i), leave: [], changed: [] })
    assert.equal(swapTooBig(plan(700), 1000), null)
    assert.match(String(swapTooBig(plan(701), 1000)), /701 of 1,000 songs are changing, so a full copy is simpler/)
  })
})

describe('the fragmentation backstop', () => {
  const GB = 1024 ** 3
  it('after 5 swaps that removed songs, the next one is a full copy', () => {
    assert.equal(SWAP_FULL_EVERY, 5)
    assert.equal(swapBackstop({ swapsSinceFull: 4, bytesRemovedSinceFull: 0 }, 1000, 8 * GB), null)
    assert.match(String(swapBackstop({ swapsSinceFull: 5, bytesRemovedSinceFull: 0 }, 1000, 8 * GB)), /5 swaps since the last full copy/)
  })
  it('once removals since the last full copy pass 15% of the card, a full copy', () => {
    assert.equal(SWAP_MAX_REMOVED_SHARE, 0.15)
    assert.equal(swapBackstop({ swapsSinceFull: 1, bytesRemovedSinceFull: 0.10 * 8 * GB }, 0.04 * 8 * GB, 8 * GB), null)
    assert.match(String(swapBackstop({ swapsSinceFull: 1, bytesRemovedSinceFull: 0.10 * 8 * GB }, 0.06 * 8 * GB, 8 * GB)), /cleared 16% of the iPod/)
    assert.match(String(swapBackstop({ swapsSinceFull: 1, bytesRemovedSinceFull: 0 }, 1000, null)), /size can’t be read/)
  })
  it('a swap that removes nothing makes no holes and is never stopped or counted', () => {
    assert.equal(swapBackstop({ swapsSinceFull: 9, bytesRemovedSinceFull: 99 * GB }, 0, null), null)
    assert.deepEqual(nextSwapHistory({ swapsSinceFull: 2, bytesRemovedSinceFull: 50 }, 0), { swapsSinceFull: 2, bytesRemovedSinceFull: 50 })
  })
  it('a full copy starts the count over; a swap adds to it', () => {
    assert.deepEqual(nextSwapHistory(null, 12345), { swapsSinceFull: 0, bytesRemovedSinceFull: 0 })
    assert.deepEqual(nextSwapHistory({ swapsSinceFull: 2, bytesRemovedSinceFull: 50 }, 25), { swapsSinceFull: 3, bytesRemovedSinceFull: 75 })
  })
})

describe('the words', () => {
  it('result lines', () => {
    assert.equal(swapResultLine(7, 7, 993), 'Swapped 7 songs: 7 out, 7 in. 993 stayed.')
    assert.equal(swapResultLine(1, 1, 999), 'Swapped 1 song: 1 out, 1 in. 999 stayed.')
    assert.equal(swapResultLine(0, 0, 1000), 'Nothing to swap: all 1,000 stayed.')
    assert.equal(swapResultLine(0, 12, 400), 'Added 12 songs. 400 stayed.')
    assert.equal(swapResultLine(3, 0, 397), 'Removed 3 songs. 397 stayed.')
    assert.equal(fullCopyLine('the last sync didn’t finish'), 'Full copy: the last sync didn’t finish.')
  })
})

describe('never catalog a missing file', () => {
  it('names every row whose file is absent, empty or not the proven size', () => {
    const onCard = new Map([[P(1), 1001], [P(2), 0], [P(3), 999]])
    assert.deepEqual(rowsMissingOnCard([
      { id: 1, destPath: P(1), size: 1001 },
      { id: 2, destPath: P(2), size: 1002 },
      { id: 3, destPath: P(3), size: 1003 },
      { id: 4, destPath: P(4), size: 1004 },
    ], onCard), [2, 3, 4])
    assert.deepEqual(rowsMissingOnCard([{ id: 1, destPath: P(1), size: 1001 }], onCard), [])
  })
})

/** A minimal iTunesDB: mhbd → mhsd(1) → mhlt → mhit records with the given ids. */
function tinyCatalog(ids: number[]): Buffer {
  const mhits = ids.map((id) => {
    const b = Buffer.alloc(0x9c)
    b.write('mhit', 0, 'latin1'); b.writeUInt32LE(0x9c, 4); b.writeUInt32LE(0x9c, 8); b.writeUInt32LE(0, 12); b.writeUInt32LE(id, 0x10)
    return b
  })
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(ids.length, 8)
  const body = Buffer.concat([mhlt, ...mhits])
  const mhsd = Buffer.alloc(96); mhsd.write('mhsd', 0, 'latin1'); mhsd.writeUInt32LE(96, 4); mhsd.writeUInt32LE(96 + body.length, 8); mhsd.writeUInt32LE(1, 12)
  const mhbd = Buffer.alloc(104); mhbd.write('mhbd', 0, 'latin1'); mhbd.writeUInt32LE(104, 4); mhbd.writeUInt32LE(104 + 96 + body.length, 8); mhbd.writeUInt32LE(1, 20)
  return Buffer.concat([mhbd, mhsd, body])
}

describe('catalogIdsAscend — the firmware binary-search rule (819 saga)', () => {
  it('true only when mhit ids ascend in record order', () => {
    assert.equal(catalogIdsAscend(tinyCatalog([10000, 10001, 10002])), true)
    assert.equal(catalogIdsAscend(tinyCatalog([10000, 10002, 10001])), false)
    assert.equal(catalogIdsAscend(tinyCatalog([10000, 10000])), false)
    assert.equal(catalogIdsAscend(Buffer.from('not a db')), null)
  })
})

describe('the strip: Remove, and the result line', () => {
  const now = 1_000
  it('a swap run relabels Wipe as Remove and leads its result with what moved', () => {
    let t = startTimeline(now, 1000)
    t = reduceSyncEvent(t, { phase: 'preflight', current: 1000, total: 1000, title: 'Swapping: 7 out, 7 in, 993 stay', mode: 'swap' }, now)
    t = reduceSyncEvent(t, { phase: 'copy', current: 0, total: 7, title: 'Removing 7 songs leaving the iPod…', mode: 'swap' }, now)
    assert.equal(t.step, 'wipe')
    assert.equal(stepLabel('wipe', t), 'Remove')
    t = reduceSyncEvent(t, { phase: 'copy', current: 0, total: 7, title: 'Removing — writing the song list for the songs that stay…', mode: 'swap' }, now)
    assert.equal(t.step, 'wipe', 'the interim catalog stays on the Remove step, never Catalog')
    t = reduceSyncEvent(t, { phase: 'copy', current: 1, total: 7, title: 'Some Song' }, now)
    assert.equal(t.step, 'copy')
    assert.equal(t.total, 7, 'Copy counts only arrivals')
    t = reduceSyncEvent(t, { phase: 'db', current: 0, total: 1, title: 'Writing iTunesDB...' }, now)
    t = reduceSyncEvent(t, { phase: 'verify', current: 1, total: 1, title: 'Sealed', mode: 'swap', summary: 'Swapped 7 songs: 7 out, 7 in. 993 stayed.' }, now)
    t = applySyncResult(t, { ok: true, landed: 1000, target: 1000, sealedOk: true }, now)
    assert.equal(resultLine(t, () => '4:05 PM'), 'Swapped 7 songs: 7 out, 7 in. 993 stayed. All 1,000 verified on the card, 4:05 PM.')
  })
  it('a full run keeps Wipe and its line, and says why', () => {
    let t = startTimeline(now, 1000)
    t = reduceSyncEvent(t, { phase: 'preflight', current: 1000, total: 1000, title: 'Full copy: the last sync didn’t finish.', mode: 'full' }, now)
    t = reduceSyncEvent(t, { phase: 'copy', current: 0, total: 1, title: 'Wiping the iPod for a clean rebuild…', mode: 'full' }, now)
    assert.equal(stepLabel('wipe', t), 'Wipe')
    t = reduceSyncEvent(t, { phase: 'verify', current: 1, total: 1, title: 'Sealed', mode: 'full', summary: 'Full copy: the last sync didn’t finish.' }, now)
    t = applySyncResult(t, { ok: true, landed: 1000, target: 1000, sealedOk: true }, now)
    assert.equal(resultLine(t, () => '4:05 PM'), 'Landed 1,000 of 1,000 — verified on the card, 4:05 PM. Full copy: the last sync didn’t finish.')
  })
  it('an old engine (no mode, no summary) reads exactly as before', () => {
    let t = startTimeline(now, 500)
    t = applySyncResult(t, { ok: true, landed: 500, target: 500, sealedOk: true }, now)
    assert.equal(resultLine(t, () => 'x'), 'Landed 500 of 500 — verified on the card, x')
    assert.equal(stepLabel('wipe'), 'Wipe')
    assert.equal(IDLE_TIMELINE.swap, false)
  })
})

describe('a swap that stops says the iPod still works', () => {
  it('maps the stop to its own claim, never "emptied"', () => {
    const base = { ...startTimeline(1, 1000), status: 'failed' as const, step: 'copy' as const, reached: ['prepare', 'wipe', 'copy'] as Array<'prepare' | 'wipe' | 'copy'>, seen: 5 }
    const kept = syncOutcome({ ...base, error: `Sync cancelled by user ${swapKeptNote(993, false)}` })
    assert.equal(kept?.changed, 'swap-kept')
    assert.match(String(kept?.changedLine), /still plays/)
    const untouched = syncOutcome({ ...base, error: `Sync cancelled by user ${swapKeptNote(1000, true)}` })
    assert.equal(untouched?.changed, 'no')
    assert.equal(untouched?.catalog, 'previous')
  })
  it('the guard’s refusal has plain words', () => {
    assert.equal(syncFailureCopy('2 song(s) the catalog would list are not on the card at their proven size. Not writing a catalog. A — B').stage, 'catalog')
    const removal = syncFailureCopy('The swap’s removal step could not settle the iPod (1 leaving file still there, 0 staying files vanished).')
    assert.equal(removal.stage, 'wipe')
    assert.match(removal.happened, /leaving the iPod could not all be removed/)
  })
})

describe('plays: a new catalog is a new play-count generation', () => {
  // The mapping through a rebuilt catalog (no double count for staying songs) runs end to end in ipod-swap-engine.test.ts.
  it('startRoundTripGeneration restarts the ledger only when the catalog bytes did not move and Play Counts is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-rt-gen-'))
    try {
      const catalog = tinyCatalog([10000])
      const { createHash } = await import('crypto')
      const gen = createHash('sha1').update(catalog).digest('hex')
      assert.equal(await startRoundTripGeneration(dir, catalog, false), 'new-generation')
      await writeFile(join(dir, ROUNDTRIP_STATE_FILE), JSON.stringify({ generation: 'other', snapshot: 's', ingested: { 1: 3 } }))
      assert.equal(await startRoundTripGeneration(dir, catalog, false), 'new-generation', 'a moved sha1 resets by itself in planRoundTrip')
      await writeFile(join(dir, ROUNDTRIP_STATE_FILE), JSON.stringify({ generation: gen, snapshot: 's', ingested: { 1: 3 } }))
      assert.equal(await startRoundTripGeneration(dir, catalog, true), 'kept', 'the old Play Counts still counts against this same catalog')
      assert.equal(await startRoundTripGeneration(dir, catalog, false), 'restarted')
      assert.deepEqual(JSON.parse(await readFile(join(dir, ROUNDTRIP_STATE_FILE), 'utf-8')), { generation: gen, snapshot: '', ingested: {} })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
