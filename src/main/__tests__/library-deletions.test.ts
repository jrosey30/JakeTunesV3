/**
 * The cases that decide whether user audio survives.
 *
 * The regression these lock down: a path diff treated a MOVED track as a
 * deleted one and unlinked its file while the track was still in the library.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDeletedPaths } from '../library-deletions.ts'

const t = (id: number, path: string) => ({ id, path })

test('a genuinely removed track yields its path', () => {
  const prev = [t(1, ':F01:a.m4a'), t(2, ':F02:b.m4a')]
  const next = [t(1, ':F01:a.m4a')]
  assert.deepEqual(computeDeletedPaths(prev, next), [':F02:b.m4a'])
})

test('a MOVED track is not a deletion (the regression)', () => {
  // Same id, new path — a re-import or sync rewrite. The old file must NOT be
  // unlinked; under the old path-diff this returned [':F02:old.m4a'].
  const prev = [t(7, ':F02:old.m4a')]
  const next = [t(7, ':F31:new.m4a')]
  assert.deepEqual(computeDeletedPaths(prev, next), [])
})

test('a merge orphans a file but we still do not unlink it', () => {
  // Merge/dedupe: id 2 disappears and id 1 is re-pointed at its file, so
  // ':F01:a.m4a' is now unreferenced.
  //
  // We deliberately return NOTHING. id 1 survived, and a surviving track must
  // never cost the user audio — we cannot tell "re-pointed after a dedupe"
  // from "path rewritten by a sync" from here, and one of those readings ends
  // in an irreversible delete. Leaving a reclaimable orphan is the strictly
  // safer error: scripts/recover-orphans.mjs exists precisely to sweep these
  // up deliberately, whereas an unlinked master is gone.
  const prev = [t(1, ':F01:a.m4a'), t(2, ':F02:b.m4a')]
  const next = [t(1, ':F02:b.m4a')]
  assert.deepEqual(computeDeletedPaths(prev, next), [])
})

test('wholesale path rewrite deletes nothing', () => {
  // The nightmare: a normalization pass rewrites every path at once. Old code
  // would have returned all of them and unlinked the entire library.
  const prev = [t(1, ':F01:a.m4a'), t(2, ':F02:b.m4a'), t(3, ':F03:c.m4a')]
  const next = [t(1, '/new/a.m4a'), t(2, '/new/b.m4a'), t(3, '/new/c.m4a')]
  assert.deepEqual(computeDeletedPaths(prev, next), [])
})

test('empty next library still reports real deletions', () => {
  const prev = [t(1, ':F01:a.m4a')]
  assert.deepEqual(computeDeletedPaths(prev, []), [':F01:a.m4a'])
})

test('tracks with no path, and duplicate paths, are handled', () => {
  const prev = [{ id: 1 }, t(2, ':F02:b.m4a'), t(3, ':F02:b.m4a')]
  assert.deepEqual(computeDeletedPaths(prev, []), [':F02:b.m4a'], 'deduped, no undefined')
})

test('string vs number ids still match', () => {
  assert.deepEqual(computeDeletedPaths([{ id: 5, path: ':F05:e.m4a' }], [{ id: '5', path: ':F99:e.m4a' }]), [])
})

test('a track with no id falls back to path comparison', () => {
  // No identity available: the path itself is the only signal, so an absent
  // path counts as removed (matching the old behaviour for id-less rows).
  assert.deepEqual(computeDeletedPaths([{ path: ':F01:a.m4a' }], []), [':F01:a.m4a'])
  assert.deepEqual(computeDeletedPaths([{ path: ':F01:a.m4a' }], [{ path: ':F01:a.m4a' }]), [])
})
