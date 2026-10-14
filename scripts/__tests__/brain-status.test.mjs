// Brief 176 — brain-status.mjs: write/read/age/staleness.
// Run: node --test scripts/__tests__/brain-status.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeStatus, writeBrainStatus, readBrainStatus, statusAgeMs, isStale, STALE_AFTER_MS,
} from '../brain-status.mjs'

const dir = mkdtempSync(join(tmpdir(), 'brain-status-'))
const p = join(dir, 'brain-status.json')

test('write then read round-trips, with at + host stamped', () => {
  const written = writeBrainStatus([p], { ok: true, enrichedThisRun: 3 })
  assert.deepEqual(written, [p])
  const s = readBrainStatus(p)
  assert.equal(s.ok, true)
  assert.equal(s.enrichedThisRun, 3)
  assert.equal(typeof s.at, 'string')
  assert.ok(Number.isFinite(Date.parse(s.at)))
  assert.equal(typeof s.host, 'string')
  // and the raw file is the same JSON
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).ok, true)
})

test('write is best-effort per path: a bad path does not sink the good one', () => {
  const written = writeBrainStatus(['/nonexistent-dir-xyz/brain-status.json', p], { ok: false, error: 'x' })
  assert.deepEqual(written, [p])
  assert.equal(readBrainStatus(p).ok, false)
})

test('read of missing / unparseable / shapeless files returns null', () => {
  assert.equal(readBrainStatus(join(dir, 'nope.json')), null)
  const bad = join(dir, 'bad.json'); writeFileSync(bad, '{not json')
  assert.equal(readBrainStatus(bad), null)
  const shapeless = join(dir, 'shapeless.json'); writeFileSync(shapeless, '{"ok":true}')
  assert.equal(readBrainStatus(shapeless), null)
})

test('age + staleness: fresh is not stale, >26h is, garbage is', () => {
  const now = Date.parse('2026-10-14T12:00:00.000Z')
  const fresh = makeStatus({ ok: true }, new Date(now - 3600 * 1000))
  assert.equal(statusAgeMs(fresh, now), 3600 * 1000)
  assert.equal(isStale(fresh, now), false)
  const old = makeStatus({ ok: true }, new Date(now - STALE_AFTER_MS - 1))
  assert.equal(isStale(old, now), true)
  const edge = makeStatus({ ok: true }, new Date(now - STALE_AFTER_MS))
  assert.equal(isStale(edge, now), false)   // exactly at the line is not beyond it
  assert.equal(statusAgeMs({ at: 'not a date' }, now), null)
  assert.equal(isStale(null, now), true)
  assert.equal(isStale({ at: 'not a date' }, now), true)
})
