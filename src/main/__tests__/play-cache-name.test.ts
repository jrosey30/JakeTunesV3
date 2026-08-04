import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pathHashFor,
  playCacheName,
  isEntryFor,
  legacyPlayCacheName,
} from '../play-cache-name.ts'

const SRC = '/Users/j/Music2/JakeTunesLibrary/iPod_Control/Music/F20/imported_4870.m4a'

test('same file version always resolves to the same entry', () => {
  assert.equal(playCacheName(SRC, 46_800_000, 1_777_000_000_000),
               playCacheName(SRC, 46_800_000, 1_777_000_000_000))
})

test('an OLDER replacement still misses the cache', () => {
  // The regression. A Bandcamp zip restores the archive's original timestamps,
  // so the good file that replaces a bad one can be months older than the
  // cache entry standing in for it. Under the old `cache.mtime >= src.mtime`
  // test that entry read as fresh and the app kept serving the bad audio.
  const cached = playCacheName(SRC, 46_800_000, 1_777_000_000_000)
  const replacedWithOlderFile = playCacheName(SRC, 47_000_000, 1_745_000_000_000)
  assert.notEqual(replacedWithOlderFile, cached)
})

test('a same-size re-encode still misses the cache', () => {
  const a = playCacheName(SRC, 46_800_000, 1_777_000_000_000)
  const b = playCacheName(SRC, 46_800_000, 1_778_000_000_000)
  assert.notEqual(a, b)
})

test('sub-millisecond mtime jitter does not thrash the cache', () => {
  // Some filesystems hand back fractional milliseconds that vary per stat.
  // Rounding keeps that from re-transcoding a file on every single play.
  assert.equal(playCacheName(SRC, 100, 1_777_000_000_000.4),
               playCacheName(SRC, 100, 1_777_000_000_000.2))
})

test('different sources never collide', () => {
  const other = SRC.replace('imported_4870', 'imported_4872')
  assert.notEqual(pathHashFor(SRC), pathHashFor(other))
})

test('every entry for a source shares the path-hash prefix', () => {
  const h = pathHashFor(SRC)
  assert.ok(isEntryFor(playCacheName(SRC, 1, 1), h))
  assert.ok(isEntryFor(playCacheName(SRC, 2, 2), h))
  // Legacy entries too — the pruner must not read them as orphans.
  assert.ok(isEntryFor(legacyPlayCacheName(SRC), h))
})

test('the pruner keeps live entries and drops foreign ones', () => {
  // Guards the exact shape of the prune bug: an equality test against one name
  // format marks every entry in the other format an orphan and wipes the cache.
  const live = new Set([pathHashFor(SRC)])
  const keep = [playCacheName(SRC, 46_800_000, 1_777_000_000_000), legacyPlayCacheName(SRC)]
  for (const f of keep) assert.ok(live.has(f.slice(0, 16)), `${f} must survive`)

  const orphan = playCacheName('/Users/j/Music2/gone.m4a', 1, 1)
  assert.ok(!live.has(orphan.slice(0, 16)))
})
