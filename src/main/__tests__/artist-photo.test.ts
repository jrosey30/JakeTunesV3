/**
 * Artist photos (2026-10-11): Deezer, identity-confirmed by Jake's own albums
 * or songs; a photo on disk is never hidden by a failed refresh.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { artistSlug, findDeezerArtist, createArtistPhotos } from '../artist-photo.ts'

type Routes = Record<string, unknown>
const fake = (routes: Routes, log: string[] = []) => async (url: string): Promise<unknown> => {
  log.push(url)
  for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return v
  return { data: [] }
}

describe('slugs', () => {
  it('keeps old slugs for Latin names; non-Latin names get their own stable slug, never "unknown"', () => {
    assert.equal(artistSlug('2Pac'), '2pac')
    assert.equal(artistSlug('Sigur Rós'), 'sigur-ros')
    const a = artistSlug('ברי סחרוף'), b = artistSlug('Молчат Дома')
    assert.match(a, /^u-[0-9a-f]{16}$/)
    assert.notEqual(a, b)
    assert.equal(artistSlug('Молчат Дома'), b, 'stable')
    assert.equal(artistSlug(''), 'unknown')
  })
})

describe('which Deezer artist is his', () => {
  it("a namesake never counts: Bristol's Mesh does not have No Fun At All", async () => {
    const r = await findDeezerArtist('MESH', { albums: ['No Fun At All'], titles: ['Violent Peasant'] }, fake({
      'search/artist': { data: [{ id: 1, name: 'Mesh', nb_fan: 6668, picture_xl: 'bristol.jpg' }] },
      'artist/1/albums': { data: [{ title: 'Who Watches Over Me?' }] },
      'artist/1/top': { data: [{ title: 'Taken for Granted' }] },
    }))
    assert.equal(r, null)
  })
  it('the big page wins when its top tracks are his songs (Black Box: album sits on a 1-fan duplicate)', async () => {
    const r = await findDeezerArtist('Black Box', { albums: ['Dreamland (Remastered)'], titles: ['Ride on Time', 'Everybody Everybody'] }, fake({
      'search/artist': { data: [{ id: 2, name: 'Black Box', nb_fan: 1 }, { id: 3, name: 'Black Box', nb_fan: 20469, picture_xl: 'bb.jpg' }] },
      'artist/3/albums': { data: [{ title: 'The Very Best Of' }] },
      'artist/3/top': { data: [{ title: 'Ride On Time' }, { title: 'Everybody Everybody' }] },
      'artist/2/albums': { data: [{ title: 'Dreamland' }] },
    }))
    assert.deepEqual(r, { id: 3, fans: 20469, pic: 'bb.jpg' })
  })
  it('album match, "The" and "&" folded, remaster tags ignored', async () => {
    const r = await findDeezerArtist('Echo & the Bunnymen', { albums: ['Ocean Rain (Remastered)'], titles: [] }, fake({
      'search/artist': { data: [{ id: 9, name: 'Echo and The Bunnymen', nb_fan: 211901, picture_xl: 'echo.jpg' }] },
      'artist/9/albums': { data: [{ title: 'Ocean Rain' }] },
    }))
    assert.equal(r?.id, 9)
  })
  it('someone he does not own yet (a Record Shop card): the biggest exact-name page', async () => {
    const r = await findDeezerArtist('Opus Kink', { albums: [], titles: [] }, fake({ 'search/artist': { data: [{ id: 5, name: 'Opus Kink', nb_fan: 1193, picture_xl: 'ok.jpg' }] } }))
    assert.equal(r?.id, 5)
  })
  it('Deezer down = undefined (ask later), not "no photo"', async () => {
    assert.equal(await findDeezerArtist('Geese', { albums: ['3D Country'], titles: [] }, async () => undefined), undefined)
  })
})

describe('the photo cache', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-photo-'))
    return { root, dir: join(root, 'artist-images'), factsFile: join(root, 'artist-deezer.json') }
  }
  it('never hides a photo already on disk when the refresh fails (the 2Pac bug)', async () => {
    const { root, dir, factsFile } = setup()
    try {
      const photos = createArtistPhotos({ dir, factsFile, owned: async () => ({ albums: ['All Eyez on Me'], titles: [] }), fetchJson: async () => undefined, download: async () => null })
      await photos.get('nobody yet')   // creates the dir
      writeFileSync(join(dir, '2pac.jpg'), 'old photo')
      const old = (Date.now() - 60 * 24 * 3600 * 1000) / 1000
      utimesSync(join(dir, '2pac.jpg'), old, old)
      assert.equal(await photos.get('2Pac'), '2pac', 'stale but shown')
      assert.ok(!existsSync(join(dir, '2pac.miss')), 'no miss written over a real photo')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('a confirmed artist is downloaded once', async () => {
    const { root, dir, factsFile } = setup()
    try {
      const log: string[] = []
      const photos = createArtistPhotos({
        dir, factsFile, owned: async () => ({ albums: ['Getting Killed'], titles: [] }),
        fetchJson: fake({ 'search/artist': { data: [{ id: 7, name: 'Geese', nb_fan: 41000, picture_xl: 'geese.jpg' }] }, 'artist/7/albums': { data: [{ title: 'Getting Killed' }] } }, log),
        download: async (u) => (u === 'geese.jpg' ? Buffer.from('jpeg-bytes') : null),
      })
      assert.equal(await photos.get('Geese'), 'geese')
      assert.equal(readFileSync(join(dir, 'geese.jpg'), 'utf8'), 'jpeg-bytes')
      const calls = log.length
      assert.equal(await photos.get('Geese'), 'geese')
      assert.equal(log.length, calls, 'second ask is the disk cache')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('seeded facts (confirmed earlier) skip the lookup', async () => {
    const { root, dir, factsFile } = setup()
    try {
      writeFileSync(factsFile, JSON.stringify({ 'Fat Dog': { dz: 11, fans: 9000, pic: 'fd.jpg', at: Date.now() } }))
      const log: string[] = []
      const photos = createArtistPhotos({ dir, factsFile, owned: async () => ({ albums: [], titles: [] }), fetchJson: fake({}, log), download: async () => Buffer.from('x') })
      assert.equal(await photos.get('Fat Dog'), 'fat-dog')
      assert.equal(log.length, 0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

