/**
 * Jake's edits stay (2026-11-25): "The computer can auto edit upon addition to
 * library but if I edit after, the edit stays." … "Unless I direct the code to
 * auto change something." common/jake-edits-stay.ts and its three writers.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRefusals, fieldsMayWrite, mayWriteField, writerOf } from '../../common/jake-edits-stay.ts'
import { createHeldForJake } from '../jake-edits-guard.ts'
import { emptyUserEdits, recordUserEdit } from '../../common/user-edits.ts'

const auto = { by: 'auto' as const }
const his = { v: 'Yacht Rock', at: 1_000, dur: 240_000 }

describe('the rule', () => {
  test('an automatic writer never changes a field Jake set', () => {
    assert.equal(mayWriteField({ writer: auto, edit: his, value: 'Classic Rock', durationMs: 240_000 }), false)
  })
  test('…but may write the same value (putting his choice back is no change)', () => {
    assert.equal(mayWriteField({ writer: auto, edit: his, value: ' Yacht Rock ', durationMs: 240_000 }), true)
  })
  test('values on songs he never touched are the computer\'s to set (import-time values stay as they are)', () => {
    assert.equal(mayWriteField({ writer: auto, edit: undefined, value: 'Classic Rock' }), true)
  })
  test('a journal entry under the same id for a song of another length is not his edit of this song', () => {
    assert.equal(mayWriteField({ writer: auto, edit: his, value: 'Classic Rock', durationMs: 199_000 }), true)
  })
  test('a write Jake directed (a ruling, a check-list File, a fix he runs or a rule he turns on) may change it', () => {
    assert.equal(mayWriteField({ writer: { by: 'jake', how: 'ruling' }, edit: his, value: 'Classic Rock', durationMs: 240_000 }), true)
    assert.deepEqual(writerOf({ by: 'jake', how: 'check-list' }), { by: 'jake', how: 'check-list' })
    assert.deepEqual(writerOf({ by: 'filer', how: 'evidence' }), auto)
    assert.deepEqual(writerOf(undefined), auto, 'no why (origins, corrections) is automatic')
  })
  test('one write is split field by field', () => {
    const r = fieldsMayWrite({ writer: auto, fields: { genre: 'Classic Rock', origin: 'USA' }, edit: (f) => (f === 'genre' ? his : undefined), durationMs: 240_000 })
    assert.deepEqual(r, { allowed: { origin: 'USA' }, held: ['genre'] })
  })
  test('the screen drops exactly the refused writes, once', () => {
    const r = createRefusals()
    r.add(7, 'genre', 'Classic Rock')
    const u = [{ trackId: 7, field: 'genre', newValue: 'Classic Rock' }, { trackId: 8, field: 'genre', newValue: 'Jazz' }]
    assert.deepEqual(r.filter(u), [u[1]])
    assert.deepEqual(r.filter(u), u, 'forgotten once the live copy went out')
  })
})

describe('Cynthia\'s sweep asks before it auto-applies', () => {
  test('held when Jake set the field to something else; free otherwise', async () => {
    const doc = recordUserEdit(emptyUserEdits(0), '42', 'year', '1972', 5_000, { dur: 300_000 })
    const held = createHeldForJake(() => '/x', async () => doc)
    assert.equal(await held(42, 'year', '1973', 300_000), true)
    assert.equal(await held(42, 'year', '1972', 300_000), false)
    assert.equal(await held(42, 'album', 'Can\'t Buy a Thrill', 300_000), false)
    assert.equal(await held(43, 'year', '1973', 300_000), false)
  })
})

describe('wiring', () => {
  const src = (p: string): string => readFileSync(join(import.meta.dirname, '..', p), 'utf8')
  test('the genre filer\'s one persist path splits every write before the override writer', () => {
    const ipc = src('ipc/genre-filer-ipc.ts')
    const fn = ipc.slice(ipc.indexOf('async function persistWithProvenance('), ipc.indexOf('/** Writes the stay rule refused'))
    const split = fn.indexOf('fieldsMayWrite({ writer: writerOf(why)')
    assert.ok(split > 0 && split < fn.indexOf('await host.persist(t.id, fields, fp)'), 'split before the write')
    assert.match(fn, /if \(Object\.keys\(fields\)\.length === 0\) return/)
    assert.match(ipc, /applied: \(updates\) => \{ const u = refused\.filter\(updates\)/)
    assert.match(ipc, /persist: \(t, fields, why\) => persistWithProvenance\(host, t, fields, why\)/)
  })
  test('both of Cynthia\'s auto-apply paths ask heldForJake, and index.ts wires it', () => {
    const sweep = src('cynthia-sweep.ts')
    assert.equal((sweep.match(/&& !\(await hooks\.heldForJake\?\.\(f\.trackId, f\.field, f\.newValue, /g) || []).length, 2)
    assert.equal((sweep.match(/await hooks\.applyOverride\(f\.trackId, f\.field, f\.newValue/g) || []).length, 2, 'no third auto path')
    const index = src('index.ts')
    assert.match(index, /heldForJake: cynthiaHeldForJake,/)
    assert.match(index, /const cynthiaHeldForJake = createHeldForJake\(\(\) => app\.getPath\('userData'\)\)/)
  })
})

// Hub adoption (planHubAbsorb) is his own edit from another Mac, newest wins;
// user-edits.test.ts "the hub keeps its own LATER edit (never rolled back)" pins it.
