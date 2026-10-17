import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeImportBatch, playOrderForImport } from '../../common/import-toast.ts'

describe('the "Added to your library" toast', () => {
  it('an empty burst shows nothing', () => {
    assert.equal(summarizeImportBatch([]), null)
  })

  it('one track names the track and carries its id', () => {
    assert.deepEqual(summarizeImportBatch([{ id: 41, title: 'Cups', artist: 'D-Stone', album: 'Cups' }]), {
      message: "Added 'Cups' to your library", trackIds: [41],
    })
  })

  it('a track with no title still reads as a sentence', () => {
    assert.equal(summarizeImportBatch([{ id: 7 }])?.message, 'Added track to your library')
  })

  it('an album burst headlines the album and carries every id in arrival order', () => {
    const s = summarizeImportBatch([
      { id: 3, title: 'Road to Nowhere', album: 'Little Creatures' },
      { id: 1, title: 'And She Was', album: 'Little Creatures' },
      { id: 2, title: 'Give Me Back My Name', album: 'Little Creatures' },
    ])
    assert.deepEqual(s, { message: "Added 3 tracks from 'Little Creatures' to your library", trackIds: [3, 1, 2] })
  })

  it('two purchases in one window: the bigger album wins the headline, both play', () => {
    const s = summarizeImportBatch([
      { id: 1, album: 'A' }, { id: 2, album: 'B' }, { id: 3, album: 'B' },
    ])
    assert.equal(s?.message, "Added 3 tracks from 'B' to your library")
    assert.deepEqual(s?.trackIds, [1, 2, 3])
  })

  it('no album anywhere falls back to "your purchase"', () => {
    assert.equal(summarizeImportBatch([{ id: 1 }, { id: 2 }])?.message, 'Added 2 tracks from your purchase to your library')
  })

  it('events without a real id count toward the message but never into the queue; repeats collapse', () => {
    const s = summarizeImportBatch([{ id: 5, album: 'X' }, { album: 'X' }, { id: 5, album: 'X' }, { id: Number.NaN, album: 'X' }])
    assert.equal(s?.message, "Added 4 tracks from 'X' to your library")
    assert.deepEqual(s?.trackIds, [5])
  })
})

describe('what a click on the toast plays, in what order', () => {
  it('one album with track numbers plays as the record runs — disc, then track', () => {
    const got = playOrderForImport([
      { id: 'c', album: 'Sandinista!', discNumber: 2, trackNumber: 1 },
      { id: 'b', album: 'Sandinista!', discNumber: 1, trackNumber: '2' },
      { id: 'a', album: 'sandinista! ', discNumber: '1', trackNumber: 1 },
    ])
    assert.deepEqual(got.map((t) => t.id), ['a', 'b', 'c'])
  })

  it('missing disc numbers read as disc 1', () => {
    const got = playOrderForImport([
      { id: 'b', album: 'X', trackNumber: 2 },
      { id: 'a', album: 'X', trackNumber: 1, discNumber: '' },
    ])
    assert.deepEqual(got.map((t) => t.id), ['a', 'b'])
  })

  it('a mixed burst keeps arrival order — no invented tracklist', () => {
    const tracks = [
      { id: 'x', album: 'A', trackNumber: 3 },
      { id: 'y', album: 'B', trackNumber: 1 },
    ]
    assert.deepEqual(playOrderForImport(tracks).map((t) => t.id), ['x', 'y'])
  })

  it('one song without a track number keeps arrival order for the lot', () => {
    const tracks = [
      { id: 'x', album: 'A', trackNumber: 3 },
      { id: 'y', album: 'A', trackNumber: '' },
      { id: 'z', album: 'A', trackNumber: 1 },
    ]
    assert.deepEqual(playOrderForImport(tracks).map((t) => t.id), ['x', 'y', 'z'])
  })

  it('never drops or duplicates a track, and never mutates its input', () => {
    const tracks = [{ id: 'b', album: 'A', trackNumber: 2 }, { id: 'a', album: 'A', trackNumber: 1 }]
    const got = playOrderForImport(tracks)
    assert.equal(got.length, 2)
    assert.deepEqual(tracks.map((t) => t.id), ['b', 'a'])
  })
})
