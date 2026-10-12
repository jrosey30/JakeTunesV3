/**
 * The Genre Iceberg v3 (10/11): genre-led — umbrellas on the tip, subgenres
 * sinking beneath their umbrella; membership from current song tags.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bergLayout, genreCounts, artistsIn, depthOf, umbrellaName, umbrellaGenres, GENRE_DEPTH, UMBRELLAS } from '../../common/genre-iceberg.ts'
import { GENRES } from '../../common/genre-vocab.ts'

const canon = (n: string): string => n.replace(/\s+feat\..*$/i, '').trim()

describe('the shape Jake approved', () => {
  it('seven umbrellas; grunge sits under Rock, Midwest Rap under Hip-Hop, Garage Punk in the abyss', () => {
    assert.deepEqual(UMBRELLAS.map((u) => u.name), ['Rock', 'Pop', 'Hip-Hop', 'Electronic', 'R&B & Soul', 'Country & Folk', 'Jazz & Global'])
    assert.equal(umbrellaName('Grunge'), 'Rock')
    assert.equal(umbrellaName('Post-Punk'), 'Rock', 'Punk lives under Rock')
    assert.equal(umbrellaName('Synth-Pop'), 'Pop', 'New Wave & Synth lives under Pop')
    assert.equal(umbrellaName('Midwest Rap'), 'Hip-Hop')
    assert.equal(depthOf('Garage Punk'), 'Abyss')
    assert.equal(depthOf('Geordie Jazz'), 'Abyss', 'was missing from the table and fell to Below')
    assert.equal(depthOf('Rock'), 'The tip', "the umbrella's own shelf is the peak")
  })
  it('every placed genre is on his list, and nothing from "Other" is on the berg', () => {
    const names = new Set(GENRES.map((g) => g.name))
    for (const g of Object.keys(GENRE_DEPTH)) assert.ok(names.has(g), g)
    assert.equal(umbrellaName('Soundtrack'), undefined)
  })
})

describe('built from current tags', () => {
  const tracks = [
    { artist: 'Nirvana', genre: 'Grunge' }, { artist: 'Nirvana', genre: 'Grunge' }, { artist: 'Pearl Jam', genre: 'Grunge' },
    { artist: 'The Beatles', genre: 'Rock' }, { artist: 'MESH', genre: 'Post-Punk' }, { artist: 'Hans Zimmer', genre: 'Soundtrack' },
    { artist: 'Baby Rose feat. Elmiene', genre: 'Alternative R&B' }, { artist: 'Brand New Thing', genre: 'Some New Genre' },
  ]
  it('only genres he has songs in appear, each under its umbrella at its depth', () => {
    const berg = bergLayout(genreCounts(tracks))
    const rock = berg.find((u) => u.name === 'Rock')!
    assert.equal(rock.shelf, 'Rock')
    assert.deepEqual(rock.layers[1], ['Grunge', 'Post-Punk'].filter((g) => GENRE_DEPTH[g] === 1))
    assert.ok(![...Object.values(rock.layers)].flat().includes('Indie Rock'), 'no songs, not on the berg')
    assert.ok(!berg.some((u) => Object.values(u.layers).flat().includes('Soundtrack')))
  })
  it('re-filing a song moves it', () => {
    const moved = tracks.map((t) => (t.artist === 'MESH' ? { ...t, genre: 'Garage Punk' } : t))
    const rock = bergLayout(genreCounts(moved)).find((u) => u.name === 'Rock')!
    assert.ok(rock.layers[4].includes('Garage Punk'))
  })
  it('artists second: best-known first, feat. folded, then by songs', () => {
    const list = artistsIn(tracks, new Set(['Grunge']), canon, { 'Pearl Jam': 200000, Nirvana: 400000 })
    assert.deepEqual(list.map((a) => a.name), ['Nirvana', 'Pearl Jam'])
    assert.equal(list[0].songs, 2)
    assert.deepEqual(artistsIn(tracks, new Set(['Alternative R&B']), canon, {}).map((a) => a.name), ['Baby Rose'])
    assert.ok(umbrellaGenres('Rock').has('Grunge') && umbrellaGenres('Rock').has('Rock'))
  })
})
