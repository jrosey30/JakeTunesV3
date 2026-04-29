// Tests for src/main/library-overrides.ts.
//
// Run via: npm run test:main
// (Internally: node --test --experimental-strip-types src/main/__tests__/*.test.ts)
//
// This file is the regression harness for the postmortem rule:
//   "destructive operations may not gate on text comparison."
// Every override that touches the library MUST be gated on
// audioFingerprint identity. The discard cases below encode that rule
// — any future refactor that lets a fingerprint mismatch through
// will fail at least one of them.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyOverrides,
  readOverridesQueueFile,
  OVERRIDES_QUEUE_VERSION,
  type MergeableTrack,
  type MobileTrackOverride,
} from '../library-overrides.ts'

function track(over: Partial<MergeableTrack> = {}): MergeableTrack {
  return {
    id: 1,
    audioFingerprint: 'sha1:aaaaaaaaaaaa|240000',
    playCount: 0,
    skipCount: 0,
    lastPlayedAt: 0,
    rating: 0,
    ...over,
  }
}

function override(over: Partial<MobileTrackOverride> = {}): MobileTrackOverride {
  return {
    trackId: 1,
    audioFingerprint: 'sha1:aaaaaaaaaaaa|240000',
    queuedAt: 1_700_000_000_000,
    ...over,
  }
}

describe('applyOverrides — happy path', () => {
  test('matching fingerprint applies playCountDelta', () => {
    const result = applyOverrides([track({ playCount: 3 })], [override({ playCountDelta: 1 })])
    assert.equal(result.applied, 1)
    assert.equal(result.tracks[0].playCount, 4)
    assert.deepEqual(result.discarded, [])
    assert.deepEqual(result.appliedTrackIds, [1])
  })

  test('multiple overrides for same track accumulate', () => {
    const result = applyOverrides(
      [track()],
      [
        override({ playCountDelta: 1 }),
        override({ playCountDelta: 1 }),
        override({ playCountDelta: 1 }),
      ],
    )
    assert.equal(result.applied, 3)
    assert.equal(result.tracks[0].playCount, 3)
    assert.deepEqual(result.appliedTrackIds, [1])
  })

  test('lastPlayedAt is max of existing and override', () => {
    const before = track({ lastPlayedAt: 100 })
    const r1 = applyOverrides([before], [override({ lastPlayedAt: 50 })])
    assert.equal(r1.tracks[0].lastPlayedAt, 100, 'older override does not overwrite newer existing')
    const r2 = applyOverrides([before], [override({ lastPlayedAt: 200 })])
    assert.equal(r2.tracks[0].lastPlayedAt, 200, 'newer override wins')
  })

  test('skipCountDelta is additive and survives missing field on track', () => {
    // track without skipCount — should initialize to delta value
    const t: MergeableTrack = { id: 1, audioFingerprint: 'fp', playCount: 0, rating: 0 }
    const r = applyOverrides([t], [override({ audioFingerprint: 'fp', skipCountDelta: 2 })])
    assert.equal(r.tracks[0].skipCount, 2)
  })

  test('rating is last-write-wins (within a single drain)', () => {
    const r = applyOverrides(
      [track({ rating: 3 })],
      [override({ rating: 5 })],
    )
    assert.equal(r.tracks[0].rating, 5)
  })

  test('zero/negative deltas are ignored (no-op)', () => {
    const r = applyOverrides(
      [track({ playCount: 7 })],
      [override({ playCountDelta: 0 }), override({ playCountDelta: -3 })],
    )
    // applied counts both — neither should mutate playCount because
    // the guard inside applyOverrides skips non-positive deltas.
    assert.equal(r.tracks[0].playCount, 7)
  })
})

describe('applyOverrides — identity gate (postmortem rule)', () => {
  test('discards override for unknown trackId', () => {
    const r = applyOverrides([track({ id: 1 })], [override({ trackId: 99 })])
    assert.equal(r.applied, 0)
    assert.equal(r.discarded.length, 1)
    assert.equal(r.discarded[0].reason, 'unknown-trackid')
  })

  test('discards override that has no audioFingerprint', () => {
    const r = applyOverrides(
      [track()],
      // queuedAt is required; rest is intentionally minimal
      [{ trackId: 1, queuedAt: 0, playCountDelta: 1 } as MobileTrackOverride],
    )
    assert.equal(r.applied, 0)
    assert.equal(r.discarded[0].reason, 'fingerprint-missing-on-mobile')
  })

  test('discards override when desktop track has no audioFingerprint', () => {
    const noFpTrack: MergeableTrack = { id: 1, playCount: 0, rating: 0 }
    const r = applyOverrides([noFpTrack], [override()])
    assert.equal(r.applied, 0)
    assert.equal(r.discarded[0].reason, 'fingerprint-missing-on-desktop')
  })

  test('discards override on fingerprint mismatch (the Pink Floyd case)', () => {
    // Same trackId, different binary content — desktop re-imported the
    // album between mobile play and desktop merge. This is the case
    // the verify-repair postmortem warns about: text comparison would
    // accept this; binary identity rejects it.
    const r = applyOverrides(
      [track({ audioFingerprint: 'sha1:bbbbbbbbbbbb|240000' })],
      [override({ audioFingerprint: 'sha1:aaaaaaaaaaaa|240000' })],
    )
    assert.equal(r.applied, 0)
    assert.equal(r.discarded[0].reason, 'fingerprint-mismatch')
  })

  test('mixed batch: applies matches, discards mismatches, no cross-contamination', () => {
    const tracks = [
      track({ id: 1, audioFingerprint: 'fp1', playCount: 0 }),
      track({ id: 2, audioFingerprint: 'fp2', playCount: 0 }),
    ]
    const overrides = [
      override({ trackId: 1, audioFingerprint: 'fp1', playCountDelta: 1 }),
      // mismatch — discarded
      override({ trackId: 2, audioFingerprint: 'fp-WRONG', playCountDelta: 5 }),
      // unknown — discarded
      override({ trackId: 999, audioFingerprint: 'fp-x', playCountDelta: 10 }),
    ]
    const r = applyOverrides(tracks, overrides)
    assert.equal(r.applied, 1)
    assert.equal(r.discarded.length, 2)
    assert.equal(r.tracks[0].playCount, 1)
    assert.equal(r.tracks[1].playCount, 0, 'mismatched override must not touch track 2')
  })
})

describe('readOverridesQueueFile — schema-version contract', () => {
  test('accepts a valid file at current version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-ov-'))
    try {
      const p = join(dir, 'q.json')
      await writeFile(p, JSON.stringify({
        version: OVERRIDES_QUEUE_VERSION,
        deviceId: 'dev-test',
        exportedAt: new Date().toISOString(),
        overrides: [
          { trackId: 1, audioFingerprint: 'fp', queuedAt: 0, playCountDelta: 1 },
        ],
      }))
      const r = await readOverridesQueueFile(p)
      assert.equal(r.ok, true)
      if (r.ok) {
        assert.equal(r.file.deviceId, 'dev-test')
        assert.equal(r.file.overrides.length, 1)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('refuses forward-version file (postmortem rule)', async () => {
    // Per docs/postmortems/2026-04-26-ipod-songcount-counter.md: a
    // newer producer must not silently feed an older consumer fields
    // it doesn't understand. Refuse-and-surface beats silent misread.
    const dir = await mkdtemp(join(tmpdir(), 'jt-ov-'))
    try {
      const p = join(dir, 'q.json')
      await writeFile(p, JSON.stringify({
        version: OVERRIDES_QUEUE_VERSION + 1,
        deviceId: 'dev-test',
        exportedAt: new Date().toISOString(),
        overrides: [],
      }))
      const r = await readOverridesQueueFile(p)
      assert.equal(r.ok, false)
      if (!r.ok) {
        assert.match(r.error, /newer mobile/i)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-ov-'))
    try {
      const p = join(dir, 'q.json')
      await writeFile(p, '{ not valid json')
      const r = await readOverridesQueueFile(p)
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /not valid JSON/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects file missing version field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-ov-'))
    try {
      const p = join(dir, 'q.json')
      await writeFile(p, JSON.stringify({ deviceId: 'x', exportedAt: '', overrides: [] }))
      const r = await readOverridesQueueFile(p)
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /missing version/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects file missing overrides array', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-ov-'))
    try {
      const p = join(dir, 'q.json')
      await writeFile(p, JSON.stringify({
        version: OVERRIDES_QUEUE_VERSION,
        deviceId: 'x',
        exportedAt: '',
      }))
      const r = await readOverridesQueueFile(p)
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /overrides/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects file missing deviceId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-ov-'))
    try {
      const p = join(dir, 'q.json')
      await writeFile(p, JSON.stringify({
        version: OVERRIDES_QUEUE_VERSION,
        exportedAt: '',
        overrides: [],
      }))
      const r = await readOverridesQueueFile(p)
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /deviceId/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reports missing-file errors clearly', async () => {
    const r = await readOverridesQueueFile('/tmp/jt-this-file-must-not-exist-87234.json')
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /couldn't read/i)
  })
})

describe('applyOverrides — purity', () => {
  test('does not mutate the input tracks array', () => {
    const inputs = [track({ playCount: 5 })]
    const snapshot = JSON.parse(JSON.stringify(inputs))
    const r = applyOverrides(inputs, [override({ playCountDelta: 3 })])
    assert.deepEqual(inputs, snapshot, 'input array contents must be unchanged')
    assert.notStrictEqual(r.tracks, inputs, 'returned array must be a new reference')
    assert.notStrictEqual(r.tracks[0], inputs[0], 'returned tracks must be new references')
    assert.equal(r.tracks[0].playCount, 8)
  })

  test('preserves extra fields on input tracks (generic spread)', () => {
    type ExtendedTrack = MergeableTrack & { title: string; artist: string }
    const t: ExtendedTrack = {
      id: 1,
      audioFingerprint: 'fp',
      playCount: 0,
      rating: 0,
      title: 'Another Brick in the Wall, Part 1',
      artist: 'Pink Floyd',
    }
    const r = applyOverrides([t], [override({ audioFingerprint: 'fp', playCountDelta: 1 })])
    assert.equal(r.tracks[0].title, 'Another Brick in the Wall, Part 1')
    assert.equal(r.tracks[0].artist, 'Pink Floyd')
  })
})
