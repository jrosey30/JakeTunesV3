/**
 * Brief 167 — staged-save recovery fixtures.
 *
 * Each fixture is the exact failure shape from the brief: the old
 * strictly-more-tracks rule's victims (metadata-only edits, legitimate
 * shrinks) must promote; genuinely stale or torn stages must be
 * discarded — and every outcome carries a reason for the log.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideStagedRecovery, type LibraryFileSnapshot } from '../staged-recovery.ts'

const snap = (over: Partial<LibraryFileSnapshot>): LibraryFileSnapshot => ({
  exists: true, parses: true, trackCount: 100, mtimeMs: 1_000, ...over,
})

test('metadata-only newer candidate promotes (same track count, newer mtime)', () => {
  const d = decideStagedRecovery(snap({ trackCount: 100, mtimeMs: 2_000 }), snap({ trackCount: 100, mtimeMs: 1_000 }))
  assert.equal(d.action, 'promote')
})

test('older candidate is discarded', () => {
  const d = decideStagedRecovery(snap({ trackCount: 150, mtimeMs: 500 }), snap({ trackCount: 100, mtimeMs: 1_000 }))
  assert.equal(d.action, 'discard')
})

test('candidate with the same mtime as live is discarded (not newer)', () => {
  const d = decideStagedRecovery(snap({ mtimeMs: 1_000 }), snap({ mtimeMs: 1_000 }))
  assert.equal(d.action, 'discard')
})

test('unparseable candidate is discarded, even when newer and bigger', () => {
  const d = decideStagedRecovery(snap({ parses: false, trackCount: 0, mtimeMs: 9_999 }), snap({}))
  assert.equal(d.action, 'discard')
  assert.match(d.reason, /does not parse/)
})

test('live unparseable + candidate good promotes, even when candidate is older', () => {
  const d = decideStagedRecovery(snap({ mtimeMs: 500 }), snap({ parses: false, trackCount: 0, mtimeMs: 9_999 }))
  assert.equal(d.action, 'promote')
})

test('live missing + candidate good promotes', () => {
  const d = decideStagedRecovery(snap({}), snap({ exists: false, parses: false, trackCount: 0, mtimeMs: 0 }))
  assert.equal(d.action, 'promote')
})

test('a legitimate shrink that is newer promotes (fewer tracks, later mtime)', () => {
  const d = decideStagedRecovery(snap({ trackCount: 80, mtimeMs: 2_000 }), snap({ trackCount: 100, mtimeMs: 1_000 }))
  assert.equal(d.action, 'promote')
})

test('an empty candidate never promotes', () => {
  const d = decideStagedRecovery(snap({ trackCount: 0, mtimeMs: 2_000 }), snap({ trackCount: 100, mtimeMs: 1_000 }))
  assert.equal(d.action, 'discard')
})

test('a missing candidate leaves everything alone', () => {
  const d = decideStagedRecovery(snap({ exists: false, parses: false, trackCount: 0, mtimeMs: 0 }), snap({}))
  assert.equal(d.action, 'leave')
})
