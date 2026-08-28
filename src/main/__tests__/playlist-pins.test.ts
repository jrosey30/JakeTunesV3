/** Synced pins (2026-08-28) — shape guard, last-writer-wins, IO round-trip. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp } from 'fs/promises'
import { normalizePins, newestPins, loadPins, savePins, MAX_PINS } from '../playlist-pins.ts'

describe('normalizePins', () => {
  test('accepts the real shape and caps at 3 — the sidebar rule', () => {
    const p = normalizePins({ pinnedPlaylists: ['a', 'b', 'c', 'd'], updatedAt: '2026-08-28T00:00:00Z' })
    assert.equal(p?.pinnedPlaylists.length, MAX_PINS)
  })

  test('rejects garbage rather than inventing pins', () => {
    assert.equal(normalizePins({ pinnedPlaylists: 'nope' }), null)
    assert.equal(normalizePins(null), null)
    assert.equal(normalizePins([]), null)
  })

  test('non-string entries are dropped, not coerced', () => {
    const p = normalizePins({ pinnedPlaylists: ['a', 7, null, 'b'], updatedAt: '' })
    assert.deepEqual(p?.pinnedPlaylists, ['a', 'b'])
  })
})

describe('newestPins — Spotify semantics, last change anywhere wins', () => {
  const at = (t: string, ids: string[] = ['x']) => ({ pinnedPlaylists: ids, updatedAt: t })

  test('the newer stamp wins wholesale', () => {
    const win = newestPins(at('2026-08-27T00:00:00Z', ['old']), at('2026-08-28T00:00:00Z', ['new']))
    assert.deepEqual(win?.pinnedPlaylists, ['new'])
  })

  test('a missing side never beats a real one', () => {
    assert.deepEqual(newestPins(null, at('2026-08-28T00:00:00Z'))?.pinnedPlaylists, ['x'])
    assert.deepEqual(newestPins(at('2026-08-28T00:00:00Z'), null)?.pinnedPlaylists, ['x'])
  })

  test('a migrated legacy copy (empty stamp) loses to any real save', () => {
    const win = newestPins(at('', ['legacy']), at('2026-08-28T00:00:00Z', ['saved']))
    assert.deepEqual(win?.pinnedPlaylists, ['saved'])
  })
})

describe('IO round-trip', () => {
  test('save then load preserves pins; a missing file is null, not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pins-'))
    const file = join(dir, 'playlist-pins.json')
    assert.equal(await loadPins(file), null)
    await savePins({ pinnedPlaylists: ['a', 'b'], updatedAt: '2026-08-28T12:00:00Z' }, file)
    assert.deepEqual((await loadPins(file))?.pinnedPlaylists, ['a', 'b'])
  })
})
