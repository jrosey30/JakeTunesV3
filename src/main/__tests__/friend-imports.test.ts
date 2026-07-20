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
