// V5 Live Concert Mode — completeness gate unit tests.
// The util is pure renderer-side logic (type-only Track import), so it
// runs fine under the main test harness's strip-types node runner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyLiveSetCompleteness } from '../../renderer/utils/liveSetCompleteness.ts'
import type { Track } from '../../renderer/types.ts'

function mk(overrides: Partial<Track>): Track {
  return {
    id: Math.floor(Math.random() * 1e9),
    title: 't', path: 'p', album: 'a', artist: 'ar', albumArtist: 'ar',
    genre: 'g', year: 2000, duration: 1000, dateAdded: '', playCount: 0,
    trackNumber: 1, trackCount: 1, discNumber: 1, discCount: 1,
    fileSize: 1, rating: 0,
    ...overrides,
  } as Track
}

function album(n: number, opts?: { trackCount?: number | string | 0; disc?: number; discCount?: number | 0; skip?: number[]; dupe?: number }): Track[] {
  const tracks: Track[] = []
  for (let i = 1; i <= n; i++) {
    if (opts?.skip?.includes(i)) continue
    tracks.push(mk({
      title: `Song ${i}`,
      trackNumber: i,
      trackCount: opts?.trackCount === 0 ? '' : (opts?.trackCount ?? n),
      discNumber: opts?.disc ?? 1,
      discCount: opts?.discCount === 0 ? '' : (opts?.discCount ?? 1),
    }))
  }
  if (opts?.dupe) tracks.push(mk({ title: 'Dupe', trackNumber: opts.dupe, trackCount: opts?.trackCount ?? n, discNumber: opts?.disc ?? 1, discCount: opts?.discCount ?? 1 }))
  return tracks
}

// ── Global numbering (unique track numbers across the album) ──

test('complete single-disc album with declared count passes verified', () => {
  const r = verifyLiveSetCompleteness(album(12))
  assert.equal(r.complete, true)
  if (r.complete) { assert.equal(r.total, 12); assert.equal(r.verifiedTotal, true) }
})

test('RAM-style: global 1..N numbering with vinyl-side disc tags 1/2/4 and no counts is COMPLETE (unverified total)', () => {
  // The real-world case that broke gate v1: complete album, globally
  // numbered, disc tags from a boxset edition, zero declared counts.
  const tracks = [
    ...[1, 2, 3, 4, 5, 6].map(i => mk({ title: `S${i}`, trackNumber: i, trackCount: '', discNumber: 1, discCount: '' })),
    ...[7, 8, 9, 10, 11, 12, 13].map(i => mk({ title: `S${i}`, trackNumber: i, trackCount: '', discNumber: 2, discCount: '' })),
    mk({ title: 'Horizon', trackNumber: 14, trackCount: '', discNumber: 4, discCount: '' }),
  ]
  const r = verifyLiveSetCompleteness(tracks)
  assert.equal(r.complete, true)
  if (r.complete) { assert.equal(r.total, 14); assert.equal(r.verifiedTotal, false) }
})

test('global numbering with a mid-album gap fails with the gap named', () => {
  const r = verifyLiveSetCompleteness(album(12, { skip: [5], trackCount: 0 }))
  assert.equal(r.complete, false)
  if (!r.complete) assert.match(r.reason, /track 5/)
})

test('truncated tail fails via declared trackCount', () => {
  // Contiguous 1..7 but the files declare 23 — the case contiguity
  // alone cannot catch.
  const r = verifyLiveSetCompleteness(album(7, { trackCount: 23 }))
  assert.equal(r.complete, false)
  if (!r.complete) assert.match(r.reason, /declare 23 tracks/)
})

test('no declared trackCount → complete SHAPE but unverified total (confirm gate)', () => {
  const r = verifyLiveSetCompleteness(album(9, { trackCount: 0 }))
  assert.equal(r.complete, true)
  if (r.complete) assert.equal(r.verifiedTotal, false)
})

test('extra track beyond the declared count fails (edition mix)', () => {
  const tracks = album(10, { trackCount: 9 })
  const r = verifyLiveSetCompleteness(tracks)
  assert.equal(r.complete, false)
  if (!r.complete) assert.match(r.reason, /more tracks/)
})

test('missing track number on any track fails', () => {
  const tracks = album(5)
  tracks[2] = mk({ ...tracks[2], trackNumber: '' })
  const r = verifyLiveSetCompleteness(tracks)
  assert.equal(r.complete, false)
  if (!r.complete) assert.match(r.reason, /no track number/)
})

test('"N/M" combined tag strings parse', () => {
  const tracks = [1, 2, 3].map(i => mk({ trackNumber: `${i}/3`, trackCount: '3', discNumber: '1/1', discCount: '1' }))
  const r = verifyLiveSetCompleteness(tracks)
  assert.equal(r.complete, true)
  if (r.complete) assert.equal(r.verifiedTotal, true)
})

// ── Per-disc numbering (repeated track numbers ⇒ discs restart at 1) ──

test('complete two-disc album (per-disc numbering, counts declared) passes verified', () => {
  const d1 = album(8, { disc: 1, discCount: 2 })
  const d2 = album(9, { disc: 2, discCount: 2 })
  const r = verifyLiveSetCompleteness([...d1, ...d2])
  assert.equal(r.complete, true)
  if (r.complete) { assert.equal(r.discs, 2); assert.equal(r.total, 17); assert.equal(r.verifiedTotal, true) }
})

test('two-disc set with no declared counts is complete but unverified', () => {
  const d1 = album(8, { disc: 1, discCount: 0, trackCount: 0 })
  const d2 = album(9, { disc: 2, discCount: 0, trackCount: 0 })
  const r = verifyLiveSetCompleteness([...d1, ...d2])
  assert.equal(r.complete, true)
  if (r.complete) assert.equal(r.verifiedTotal, false)
})

test('missing disc 2 of a declared 2-disc set fails', () => {
  // Per-disc mode requires repeated numbers → two discs, one missing,
  // where the remaining discs share numbering: disc 1 + disc 3.
  const d1 = album(4, { disc: 1, discCount: 3, trackCount: 4 })
  const d3 = album(4, { disc: 3, discCount: 3, trackCount: 4 })
  const r = verifyLiveSetCompleteness([...d1, ...d3])
  assert.equal(r.complete, false)
  if (!r.complete) assert.match(r.reason, /disc 2 is missing/)
})

test('per-disc gap fails with disc-scoped reason', () => {
  const d1 = album(6, { disc: 1, discCount: 2, trackCount: 6 })
  const d2 = album(6, { disc: 2, discCount: 2, trackCount: 6, skip: [3] })
  const r = verifyLiveSetCompleteness([...d1, ...d2])
  assert.equal(r.complete, false)
  if (!r.complete) assert.match(r.reason, /track 3 of disc 2/)
})

test('duplicate track number within one disc fails', () => {
  const d1 = album(6, { disc: 1, discCount: 2, trackCount: 6, dupe: 3 })
  const d2 = album(6, { disc: 2, discCount: 2, trackCount: 6 })
  const r = verifyLiveSetCompleteness([...d1, ...d2])
  assert.equal(r.complete, false)
  if (!r.complete) assert.match(r.reason, /#3/)
})

test('declared discCount mismatch fails', () => {
  const d1 = album(5, { disc: 1, discCount: 3, trackCount: 5 })
  const d2 = album(5, { disc: 2, discCount: 3, trackCount: 5 })
  const r = verifyLiveSetCompleteness([...d1, ...d2])
  assert.equal(r.complete, false)
  if (!r.complete) assert.match(r.reason, /declare 3 discs/)
})

test('empty album fails', () => {
  const r = verifyLiveSetCompleteness([])
  assert.equal(r.complete, false)
})
