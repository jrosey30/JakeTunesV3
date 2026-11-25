/**
 * Jake's edits stay (2026-11-25): "The computer can auto edit upon addition to
 * library but if I edit after, the edit stays." … "Unless I direct the code to
 * auto change something." common/jake-edits-stay.ts and its writers, driven
 * for real: the Cynthia sweep with fake hooks and a real journal on disk, the
 * genre filer's write path with a fake override writer, and the merge rule.
 */
import { after, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRefusals, fieldsMayWrite, landed, mayWriteField, phoneEdit, sameFingerprint, writerOf } from '../../common/jake-edits-stay.ts'
import { createHeldForJake, createJakeEdits, readJournalStrict, type JakeEditLookup } from '../jake-edits-guard.ts'
import { persistGuarded, type GuardedPersistHost } from '../genre-filer-persist.ts'
import { mergeOverrideField } from '../override-merge.ts'
import { emptyUserEdits, recordUserEdit, USER_EDITS_FILE, type UserEditsDoc } from '../../common/user-edits.ts'
import type { FilerTrack } from '../genre-filer.ts'
import type { ProvenanceDoc } from '../genre-provenance.ts'

const userData = mkdtempSync(join(tmpdir(), 'jt-jake-edits-'))
process.env.JT_USER_DATA = userData
after(() => rmSync(userData, { recursive: true, force: true }))
register('./jake-edits-test-hooks.mjs', import.meta.url)

const auto = { by: 'auto' as const }
const his = { v: 'Yacht Rock', at: 1_000, dur: 240_000 }

describe('the rule', () => {
  test('an automatic writer never changes a field Jake set', () => {
    assert.equal(mayWriteField({ writer: auto, edit: his, value: 'Classic Rock', durationMs: 240_000 }), false)
  })
  test('…but may write the same value (putting his choice back is no change)', () => {
    assert.equal(mayWriteField({ writer: auto, edit: his, value: ' Yacht Rock ', durationMs: 240_000 }), true)
  })
  test('songs he never touched are the computer\'s to set (import-time values stay as they are)', () => {
    assert.equal(mayWriteField({ writer: auto, edit: undefined, value: 'Classic Rock' }), true)
    assert.equal(mayWriteField({ writer: auto, edit: [], value: 'Classic Rock' }), true)
  })
  test('the length guard uses the edit sync\'s 2 s slack: within it, the same song', () => {
    assert.equal(mayWriteField({ writer: auto, edit: his, value: 'Classic Rock', durationMs: 241_500 }), false)
    assert.equal(mayWriteField({ writer: auto, edit: his, value: 'Classic Rock', durationMs: 199_000 }), true, 'another length: another song under this id')
  })
  test('any of his records differing holds it (journal and phone)', () => {
    assert.equal(mayWriteField({ writer: auto, edit: [{ v: 'Rock' }, { v: 'Jazz' }], value: 'Rock' }), false)
  })
  test('a write Jake directed may change it', () => {
    assert.equal(mayWriteField({ writer: { by: 'jake', how: 'ruling' }, edit: his, value: 'Classic Rock', durationMs: 240_000 }), true)
    assert.deepEqual(writerOf({ by: 'jake', how: 'check-list' }), { by: 'jake', how: 'check-list' })
    assert.deepEqual(writerOf({ by: 'filer', how: 'evidence' }), auto)
    assert.deepEqual(writerOf(undefined), auto, 'no why (origins, corrections) is automatic')
  })
  test('one write is split field by field; the screen drops exactly the refused writes, once', () => {
    const r = fieldsMayWrite({ writer: auto, fields: { genre: 'Classic Rock', origin: 'USA' }, edit: (f) => (f === 'genre' ? his : undefined), durationMs: 240_000 })
    assert.deepEqual(r, { allowed: { origin: 'USA' }, held: ['genre'] })
    const refusals = createRefusals()
    refusals.add(7, 'genre', 'Classic Rock')
    const u = [{ trackId: 7, field: 'genre', newValue: 'Classic Rock' }, { trackId: 8, field: 'genre', newValue: 'Jazz' }]
    assert.deepEqual(refusals.filter(u), [u[1]])
    assert.deepEqual(refusals.filter(u), u)
  })
  test('a phone edit counts only for its own song (fingerprint, loosely)', () => {
    const phone = { '5': { fp: 'reelin in the years|steely dan|275000', fields: { year: '1972' } } }
    assert.deepEqual(phoneEdit(phone, 5, 'year', 'Reelin In The Years|Steely Dan|274000'), { v: '1972' })
    assert.equal(phoneEdit(phone, 5, 'year', 'something else|someone|275000'), undefined)
    assert.equal(phoneEdit(phone, 5, 'genre', 'reelin in the years|steely dan|275000'), undefined)
    assert.equal(sameFingerprint('a|b|1000', 'A |b|1500'), true)
  })
})

describe('his records: the journal (strictly) and the phone, once per sweep', () => {
  test('a missing journal is no edits; a corrupt one throws (so robots hold back)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jt-journal-'))
    try {
      assert.equal(await readJournalStrict(dir), null)
      writeFileSync(join(dir, USER_EDITS_FILE), '{ torn')
      await assert.rejects(readJournalStrict(dir))
      writeFileSync(join(dir, USER_EDITS_FILE), '{"not":"a journal"}')
      await assert.rejects(readJournalStrict(dir))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('read once per sweep, not once per song', async () => {
    let reads = 0
    let t = 0
    const edits = createJakeEdits({ readJournal: async () => { reads++; return emptyUserEdits(0) }, readPhone: async () => null, now: () => t })
    for (let i = 0; i < 500; i++) await edits.lookup()
    assert.equal(reads, 1)
    t += 31_000
    await edits.lookup()
    assert.equal(reads, 2)
  })
  test('Cynthia\'s guard: a corrupt journal holds every fix', async () => {
    const held = createHeldForJake(createJakeEdits({ readJournal: async () => { throw new Error('torn') }, readPhone: async () => null }), () => {})
    assert.equal(await held(1, 'year', '1999'), true)
  })
})

// ── The real Cynthia sweep, fake hooks, a real journal on disk ────────────
let loads = 0
function track(id: number, title: string, album: string) {
  return { id, title, artist: 'Pink Floyd', album, albumArtist: 'Pink Floyd', trackNumber: id % 10, trackCount: 2, discNumber: 1, discCount: 1, year: 1979, genre: 'Rock', duration: 200_000 }
}
async function sweepOnce(o: { album: string; journal?: UserEditsDoc | 'corrupt'; phone?: Record<string, { fp?: string; fields?: Record<string, string> }> }): Promise<Array<{ id: number; field: string; value: string }>> {
  const dir = mkdtempSync(join(tmpdir(), 'jt-sweep-journal-'))
  if (o.journal === 'corrupt') writeFileSync(join(dir, USER_EDITS_FILE), '{ torn')
  else if (o.journal) writeFileSync(join(dir, USER_EDITS_FILE), JSON.stringify(o.journal))
  const tracks = [track(1, 'Run  Like Hell ', o.album), track(2, 'Hey You', o.album)]
  const applied: Array<{ id: number; field: string; value: string }> = []
  let ticked = false
  mock.timers.enable({ apis: ['setTimeout'] })
  const sweep = await import(`../cynthia-sweep.ts?t=${++loads}`) as typeof import('../cynthia-sweep.ts')
  try {
    await sweep.startCynthiaSweep({
      getAlbums: () => new Map([[sweep.albumKeyOfMain(tracks[0]), { label: o.album, tracks }]]),
      fetchMbRelease: async () => { throw new Error('no network in tests') },
      applyOverride: async (id, field, value) => { applied.push({ id, field, value }) },
      heldForJake: createHeldForJake(createJakeEdits({ readJournal: () => readJournalStrict(dir), readPhone: async () => o.phone ?? null }), () => {}),
      isIdle: () => true,
      sendProgress: (p) => { if (p.currentAlbum !== 'library consistency pass' && p.autoApplied.length === 0) ticked = true },
    })
    const until = Date.now() + 10_000
    while (!ticked && Date.now() < until) await new Promise((r) => setImmediate(r))
    assert.ok(ticked, 'the sweep finished its tick')
  } finally {
    sweep.stopCynthiaSweep()
    mock.timers.reset()
    rmSync(dir, { recursive: true, force: true })
  }
  return applied
}

describe('Cynthia\'s sweep, for real', () => {
  test('control: with no edits of his, the provable fix is applied (the test can see an apply)', async () => {
    const applied = await sweepOnce({ album: 'The Wall A' })
    assert.deepEqual(applied.filter((a) => a.field === 'title'), [{ id: 1, field: 'title', value: 'Run Like Hell' }])
  })
  test('a title Jake set on a Mac is never auto-fixed', async () => {
    const journal = recordUserEdit(emptyUserEdits(0), 1, 'title', 'Run  Like Hell ', 5_000, { dur: 200_000 })
    const applied = await sweepOnce({ album: 'The Wall B', journal })
    assert.deepEqual(applied.filter((a) => a.id === 1 && a.field === 'title'), [])
  })
  test('a title Jake set on the phone is never auto-fixed', async () => {
    const applied = await sweepOnce({ album: 'The Wall C', phone: { '1': { fp: 'run  like hell |pink floyd|200000', fields: { title: 'Run  Like Hell ' } } } })
    assert.deepEqual(applied.filter((a) => a.id === 1 && a.field === 'title'), [])
  })
  test('a journal that can\'t be read holds the fix back', async () => {
    const applied = await sweepOnce({ album: 'The Wall D', journal: 'corrupt' })
    assert.deepEqual(applied, [])
  })
})

// ── The genre filer's write path, with a fake override writer ─────────────
function filerHost(look: JakeEditLookup | 'broken') {
  const persisted: Array<{ id: number; fields: Record<string, string> }> = []
  const journaled: Array<{ id: number; field: string; value: string }> = []
  const provenance: ProvenanceDoc = { tracks: {} } as unknown as ProvenanceDoc
  const logs: string[] = []
  const h: GuardedPersistHost = {
    persist: async (id, fields) => { persisted.push({ id, fields }) },
    recordEdit: async (id, field, value) => { journaled.push({ id, field, value }) },
    updateProvenance: async (m) => { m(provenance) },
    lookup: async () => { if (look === 'broken') throw new Error('torn'); return look },
    refused: createRefusals(),
    log: (m) => logs.push(m),
  }
  return { h, persisted, journaled, provenance, logs }
}
const song: FilerTrack = { id: 9, title: 'Dirty Work', artist: 'Steely Dan', album: "Can't Buy a Thrill", duration: 188_000 } as FilerTrack
const hisGenre: JakeEditLookup = (_id, field) => (field === 'genre' ? [{ v: 'Yacht Rock', dur: 188_000 }] : [])

describe('the genre filer\'s write path, for real', () => {
  test('an automatic pick never reaches the override writer for a field he set; the rest does', async () => {
    const f = filerHost(hisGenre)
    const written = await persistGuarded(f.h, song, { genre: 'Classic Rock', origin: 'USA' }, { by: 'filer', how: 'evidence' })
    assert.deepEqual(f.persisted, [{ id: 9, fields: { origin: 'USA' } }])
    assert.deepEqual(written, { origin: 'USA' })
    assert.equal(landed(written, 'genre'), false, 'not counted or logged as filed')
    assert.deepEqual(f.h.refused.filter([{ trackId: 9, field: 'genre', newValue: 'Classic Rock' }]), [])
  })
  test('nothing at all is written when every field is his', async () => {
    const f = filerHost(hisGenre)
    assert.deepEqual(await persistGuarded(f.h, song, { genre: 'Classic Rock' }, { by: 'filer', how: 'evidence' }), {})
    assert.deepEqual(f.persisted, [])
    assert.deepEqual(f.provenance.tracks, {}, 'no provenance row for a write that did not happen')
  })
  test('his records unreadable: nothing automatic is written', async () => {
    const f = filerHost('broken')
    assert.deepEqual(await persistGuarded(f.h, song, { genre: 'Classic Rock', origin: 'USA' }), {})
    assert.deepEqual(f.persisted, [])
  })
  test('a check-list File (Jake\'s) is written and journaled as his', async () => {
    const f = filerHost(hisGenre)
    await persistGuarded(f.h, song, { genre: 'Classic Rock' }, { by: 'jake', how: 'check-list' })
    assert.deepEqual(f.persisted, [{ id: 9, fields: { genre: 'Classic Rock' } }])
    assert.deepEqual(f.journaled, [{ id: 9, field: 'genre', value: 'Classic Rock' }])
  })
  test('an untouched song is filed as before (import-time behaviour)', async () => {
    const f = filerHost(() => [])
    await persistGuarded(f.h, song, { genre: 'Classic Rock' }, { by: 'filer', how: 'evidence' })
    assert.deepEqual(f.persisted, [{ id: 9, fields: { genre: 'Classic Rock' } }])
    assert.deepEqual(f.journaled, [])
  })
})

describe('the override merge keeps his other fields when he corrects a title', () => {
  test('same length, new title: merge (his genre stays)', () => {
    const o: Record<string, unknown> = { '9': { fp: 'dirty work|steely dan|188000', fields: { genre: 'Yacht Rock', year: '1972' } } }
    mergeOverrideField(o, 9, 'bpm', '120', 'dirty work (remaster)|steely dan|188000')
    assert.deepEqual(o['9'], { fp: 'dirty work (remaster)|steely dan|188000', fields: { genre: 'Yacht Rock', year: '1972', bpm: '120' } })
  })
  test('same length, a different title AND artist: another song (Peg never turns into Blue Monday)', () => {
    // The tempo writer (persistOverrideFields → mergeOverrideField) saving a BPM for a song that now holds id 512.
    const o: Record<string, unknown> = { '512': { fp: 'peg|steely dan|237000', fields: { title: 'Peg', artist: 'Steely Dan', year: '1977', album: 'Aja' } } }
    mergeOverrideField(o, 512, 'bpm', '130', 'blue monday|new order|238400')
    assert.deepEqual(o['512'], { fp: 'blue monday|new order|238400', fields: { bpm: '130' } }, 'nothing of Peg is shown on Blue Monday')
  })
  test('same length, both changed, but the new names are the ones his own override set: his correction, merged', () => {
    const o: Record<string, unknown> = { '7': { fp: 'track 07|unknown artist|200000', fields: { title: 'Dirty Work', artist: 'Steely Dan', genre: 'Yacht Rock' } } }
    mergeOverrideField(o, 7, 'bpm', '120', 'dirty work|steely dan|200000')
    assert.deepEqual(o['7'], { fp: 'dirty work|steely dan|200000', fields: { title: 'Dirty Work', artist: 'Steely Dan', genre: 'Yacht Rock', bpm: '120' } })
  })
  test('a non-Jake writer hitting a mismatched fingerprint with no evidence never restamps his entry', () => {
    const o: Record<string, unknown> = { '3': { fp: 'song a|band a|200000', fields: { genre: 'Jazz' } } }
    mergeOverrideField(o, 3, 'bpm', '90', 'song b|band b|200500')
    assert.deepEqual(o['3'], { fp: 'song b|band b|200500', fields: { bpm: '90' } })
  })
  test('another length: the id names another song, start fresh (the re-parse safeguard)', () => {
    const o: Record<string, unknown> = { '9': { fp: 'dirty work|steely dan|188000', fields: { genre: 'Yacht Rock' } } }
    mergeOverrideField(o, 9, 'bpm', '120', 'other song|someone|301000')
    assert.deepEqual(o['9'], { fp: 'other song|someone|301000', fields: { bpm: '120' } })
  })
})

describe('wiring (the behaviour is above; these pin that the app uses it)', () => {
  const src = (p: string): string => readFileSync(join(import.meta.dirname, '..', p), 'utf8')
  test('the filer writes only through persistGuarded, with his journal and the phone\'s edits', () => {
    const ipc = src('ipc/genre-filer-ipc.ts')
    assert.match(ipc, /persist: \(t, fields, why\) => persistGuarded\(guarded, t, fields, why\)/)
    assert.match(ipc, /createJakeEdits\(\{ readJournal: \(\) => readJournalStrict\(app\.getPath\('userData'\)\), readPhone: async \(\) => \(await host\.phoneOverrides\?\.\(\)\) \?\? null \}\)/)
    assert.match(ipc, /lookup: edits\.lookup/)
    assert.match(ipc, /applied: \(updates\) => \{ const u = refused\.filter\(updates\)/)
  })
  test('Cynthia\'s library-wide pass (60 s after launch, not driven above) asks the very same guard as the per-album path', () => {
    const sweep = src('cynthia-sweep.ts')
    const guard = '&& !(await hooks.heldForJake?.(f.trackId, f.field, f.newValue, Number(track.duration) || undefined, fingerprintOf(track)) ?? false)) {'
    assert.equal(sweep.split(guard).length - 1, 2)
    assert.equal((sweep.match(/await hooks\.applyOverride\(f\.trackId, f\.field, f\.newValue/g) || []).length, 2, 'no third auto path')
  })
  test('Cynthia\'s sweep gets the same records, and the analysis writer merges instead of wiping', () => {
    const index = src('index.ts')
    assert.match(index, /heldForJake: cynthiaHeldForJake,/)
    assert.match(index, /createHeldForJake\(createJakeEdits\(\{ readJournal: \(\) => readJournalStrict\(app\.getPath\('userData'\)\), readPhone: \(\) => mobileMetadataOverridesCache\.get\(\) \}\)\)/)
    const fn = index.slice(index.indexOf('async function persistOverrideFields('), index.indexOf('async function persistOverrideFields(') + 900)
    assert.match(fn, /for \(const \[field, value\] of Object\.entries\(fields\)\) mergeOverrideField\(overrides, trackId, field, value, fingerprint\)/)
    assert.doesNotMatch(fn, /overrides\[key\] = \{ fp: fingerprint \|\| '', fields: \{ \.\.\.fields \} \}/)
  })
})
