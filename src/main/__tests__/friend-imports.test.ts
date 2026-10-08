import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeImportCredits, friendOfNote } from '../friend-imports-core.ts'

const reco = (over: Record<string, unknown>) => ({
  id: 'r1', song: 'Hurricane', artist: 'Luke Combs',
  note: 'from Lorin Bloom · https://open.spotify.com/track/x',
  createdAt: '2026-07-12T00:00:00.000Z', ...over,
})
const track = (over: Record<string, unknown>) => ({
  title: 'Hurricane', artist: 'Luke Combs', dateAdded: '2026-07-15T00:00:00.000Z', ...over,
})
const none = new Set<string>()

describe('friend-imports — computeImportCredits', () => {
  it('credits the friend when the song landed AFTER the reco', () => {
    assert.deepEqual(
      computeImportCredits([reco({})], [track({})], none),
      [{ recoId: 'r1', friend: 'Lorin Bloom' }],
    )
  })

  it('NO credit when Jake already owned the song before it was sent', () => {
    assert.deepEqual(
      computeImportCredits([reco({})], [track({ dateAdded: '2025-01-01T00:00:00.000Z' })], none),
      [],
    )
  })

  it('newest library copy wins (re-import after the reco still counts)', () => {
    const tracks = [track({ dateAdded: '2025-01-01T00:00:00.000Z' }), track({ dateAdded: '2026-07-15T00:00:00.000Z' })]
    assert.equal(computeImportCredits([reco({})], tracks, none).length, 1)
  })

  it('matches via the iTunes-canonical pair when the raw jot was sloppy', () => {
    const r = reco({ song: 'hurricane luke', artist: '', matchedTitle: 'Hurricane', matchedArtist: 'Luke Combs' })
    assert.equal(computeImportCredits([r], [track({})], none).length, 1)
  })

  it('artist-less jots are NEVER text-match-credited', () => {
    const r = reco({ song: 'Hurricane', artist: '', matchedTitle: '', matchedArtist: '' })
    assert.deepEqual(computeImportCredits([r], [track({})], none), [])
  })

  it('albumArtist also indexes the library copy', () => {
    const t = track({ artist: 'Luke Combs feat. Someone', albumArtist: 'Luke Combs' })
    assert.equal(computeImportCredits([reco({})], [t], none).length, 1)
  })

  it('one credit per reco ever (idempotent via the credited ledger)', () => {
    assert.deepEqual(computeImportCredits([reco({})], [track({})], new Set(['r1'])), [])
  })

  it('no friend attribution or no createdAt → no credit', () => {
    assert.deepEqual(computeImportCredits([reco({ note: 'great song' })], [track({})], none), [])
    assert.deepEqual(computeImportCredits([reco({ createdAt: undefined })], [track({})], none), [])
  })
})

describe('friend-imports — friendOfNote (twin of renderer friendOf)', () => {
  it('parses every note shape the add path produces', () => {
    assert.equal(friendOfNote('from Ben'), 'Ben')
    assert.equal(friendOfNote('great tune · from Lorin Bloom · https://x.co'), 'Lorin Bloom')
    assert.equal(friendOfNote('from Sarah · https://x.co'), 'Sarah')
    assert.equal(friendOfNote('texted song link · from 516-555-1234 · https://x.co'), '516-555-1234')
  })

  it('does not false-positive on prose containing "from"', () => {
    assert.equal(friendOfNote('sounds like something from the 80s'), null)
    assert.equal(friendOfNote(undefined), null)
  })
})

// ── Attribution credits (2026-08-28) ─────────────────────────────────
// "lorin should get credit for the latest john mayer song that i
// imported" — the send deduped against a listed row, the row left the
// list, and the old sweep had nothing to look at. Attributions remember
// the send; the same honesty rules decide the credit.
import { computeAttributionCredits, attributionRecoId, attributionKey } from '../friend-imports-core.ts'

it('attribution credit: send on 8/24, library copy arrives 8/25 → +1 (the Til case)', () => {
  const attrs = [{ song: 'Til the Right One Comes', artist: 'John Mayer', friend: 'Lorin Bloom', at: '2026-08-24T21:23:09Z' }]
  const lib = [{ title: 'Til the Right One Comes', artist: 'John Mayer', dateAdded: '2026-08-25T15:00:00Z' }]
  const out = computeAttributionCredits(attrs, lib, new Set(), new Set())
  assert.equal(out.length, 1)
  assert.equal(out[0].friend, 'Lorin Bloom')
  assert.equal(out[0].label, 'Til the Right One Comes — John Mayer')
})

it('owned BEFORE the send earns nothing (the Last Train Home case)', () => {
  const attrs = [{ song: 'Last Train Home', artist: 'John Mayer', friend: 'Lorin Bloom', at: '2026-08-07T04:00:00Z' }]
  const lib = [{ title: 'Last Train Home', artist: 'John Mayer', dateAdded: '2026-08-04T00:00:00Z' }]
  assert.equal(computeAttributionCredits(attrs, lib, new Set(), new Set()).length, 0)
})

it('a pair already credited through the reco ledger never earns twice', () => {
  const attrs = [{ song: 'Moving On and Getting Over', artist: 'John Mayer', friend: 'Lorin Bloom', at: '2026-08-07T04:00:00Z' }]
  const lib = [{ title: 'Moving On and Getting Over', artist: 'John Mayer', dateAdded: '2026-08-07T09:00:00Z' }]
  const covered = new Set([`lorin bloom|${attributionKey({ song: 'Moving On and Getting Over', artist: 'John Mayer' })}`])
  assert.equal(computeAttributionCredits(attrs, lib, new Set(), covered).length, 0)
})

it('already-credited recoId and timeline-less attributions are skipped', () => {
  const a = { song: 'X', artist: 'Y', friend: 'F', at: '2026-08-01T00:00:00Z' }
  const lib = [{ title: 'X', artist: 'Y', dateAdded: '2026-08-02T00:00:00Z' }]
  const done = new Set([String(attributionRecoId(a))])
  assert.equal(computeAttributionCredits([a], lib, done, new Set()).length, 0)
  assert.equal(computeAttributionCredits([{ ...a, at: '' }], lib, new Set(), new Set()).length, 0)
})

it('song without artist never text-match-credits', () => {
  const attrs = [{ song: 'Something', friend: 'F', at: '2026-08-01T00:00:00Z' }]
  const lib = [{ title: 'Something', artist: 'Anyone', dateAdded: '2026-08-02T00:00:00Z' }]
  assert.equal(computeAttributionCredits(attrs, lib, new Set(), new Set()).length, 0)
})
