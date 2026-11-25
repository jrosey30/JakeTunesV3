// V7 ⌘K "Go anywhere": any page, artist, album, playlist, iPod, concert or
// setting by name; Return opens, ⌘Return plays (renderer/goAnywhere.ts).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildGoItems, searchGo, goAction, fold, GO_PAGES, type GoSources } from '../../renderer/goAnywhere.ts'

const src: GoSources = {
  artists: [{ name: 'Beyoncé' }, { name: 'The Beatles' }, { name: 'Beck' }],
  albums: [{ key: 'the beatles|||abbey road', album: 'Abbey Road', artist: 'The Beatles' }, { key: 'beck|||odelay', album: 'Odelay', artist: 'Beck' }],
  playlists: [{ id: 'p1', name: 'Road Trip' }],
  smartPlaylists: [{ id: 'recently-added', name: 'Recently Added' }],
  ipods: [{ playlistId: 'top-1000', name: 'Top 1000' }, { playlistId: 'ipod-list-punk', name: 'punkPod' }],
  concerts: [{ albumKey: 'talking heads|||stop making sense', band: 'Talking Heads', show: 'Stop Making Sense', trackId: 42 }],
}
const items = buildGoItems(src)
const first = (q: string) => searchGo(items, q)[0]

describe('Go anywhere', () => {
  it('finds every kind by name', () => {
    assert.deepEqual(first('songs')!.target, { kind: 'page', view: 'songs' })
    assert.deepEqual(first('beyonce')!.target, { kind: 'artist', name: 'Beyoncé' }, 'accents fold')
    assert.deepEqual(first('abbey')!.target, { kind: 'album', key: 'the beatles|||abbey road' })
    assert.deepEqual(first('road trip')!.target, { kind: 'playlist', id: 'p1', smart: false })
    assert.deepEqual(first('punkpod')!.target, { kind: 'ipod', playlistId: 'ipod-list-punk' })
    assert.deepEqual(first('stop making')!.target, { kind: 'concert', albumKey: 'talking heads|||stop making sense', trackId: 42 })
    assert.deepEqual(first('eq')!.target, { kind: 'setting', tab: 'EQ' })
  })
  it('every word must match; the order of words doesn\'t', () => {
    assert.deepEqual(searchGo(items, 'road beatles').map((i) => i.title), ['Abbey Road'])
    assert.deepEqual(searchGo(items, 'zzz'), [])
    assert.deepEqual(searchGo(items, '   '), [])
  })
  it('the title starting with the words beats them found anywhere', () => {
    assert.equal(first('beck')!.title, 'Beck')
    assert.equal(first('road')!.title, 'Road Trip')
  })
  it('the sidebar\'s own words open the page (Record Shop, Live Concerts) and the ⌘1–⌘6 pages are all here', () => {
    assert.deepEqual(first('record shop')!.target, { kind: 'page', view: 'discovery' })
    assert.deepEqual(first('live albums')!.target, { kind: 'page', view: 'concerts' })
    for (const v of ['home', 'songs', 'albums', 'artists', 'concerts', 'discovery']) assert.ok(GO_PAGES.some((p) => p.view === v), v)
  })
  it('⌘Return plays what can play; a page or a setting only opens', () => {
    assert.equal(goAction(first('abbey')!, true), 'play')
    assert.equal(goAction(first('abbey')!, false), 'open')
    assert.equal(goAction(first('songs')!, true), 'open')
    assert.equal(goAction(first('eq')!, true), 'open')
  })
  it('fold: case, accents, punctuation and "&"', () => {
    assert.equal(fold('Simon & Garfunkel'), 'simon and garfunkel')
    assert.equal(fold('  Beyoncé — 4 '), 'beyonce 4')
  })
})
