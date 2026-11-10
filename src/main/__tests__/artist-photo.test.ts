/**
 * Artist photos (2026-10-11): Deezer, identity-confirmed by Jake's own albums
 * or songs; a photo on disk is never hidden by a failed refresh.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitFor } from './wait-for.ts'
import { artistSlug, findDeezerArtist, createArtistPhotos, photoMaxAgeMs, PHOTO_MAX_AGE_MS, REFRESH_RETRY_MS } from '../artist-photo.ts'

type Routes = Record<string, unknown>
const fake = (routes: Routes, log: string[] = []) => async (url: string): Promise<unknown> => {
  log.push(url)
  for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return v
  return { data: [] }
}

// get() saves the Deezer facts into this folder in the background, with nothing to wait
// on: a save landing mid-delete is ENOTEMPTY on a busy Mac (2026-11-04). The async rm's
// retries start the delete over, 0 failures in 2,000 tries; rmSync's never list the folder
// again, 302 in 4,000. The save swallows its own failure once the folder is gone.
const removeTemp = (root: string): Promise<void> => rm(root, { recursive: true, force: true, maxRetries: 5 })

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
    } finally { await removeTemp(root) }
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
    } finally { await removeTemp(root) }
  })
  it('seeded facts (confirmed earlier) skip the lookup', async () => {
    const { root, dir, factsFile } = setup()
    try {
      writeFileSync(factsFile, JSON.stringify({ 'Fat Dog': { dz: 11, fans: 9000, pic: 'fd.jpg', at: Date.now() } }))
      const log: string[] = []
      const photos = createArtistPhotos({ dir, factsFile, owned: async () => ({ albums: [], titles: [] }), fetchJson: fake({}, log), download: async () => Buffer.from('x') })
      assert.equal(await photos.get('Fat Dog'), 'fat-dog')
      assert.equal(log.length, 0)
    } finally { await removeTemp(root) }
  })
})


// 2026-11-10 — Jake on the artist page: "artist photos lag". A photo past its
// 30 days was held back until Deezer had been asked again (two searches, an
// album call, the download, all behind one 120 ms queue), so the card and the
// page sat without a picture that was on disk. And 1,399 photos shared one
// fetch date, so they would all have fallen due on the same day.
describe('a photo on disk is returned at once and refreshed behind', () => {
  const DAY = 24 * 3600 * 1000
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'jt-photo-swr-'))
    const dir = join(root, 'artist-images')
    mkdirSync(dir, { recursive: true })
    return { root, dir, factsFile: join(root, 'artist-deezer.json') }
  }
  const age = (file: string, ms: number): void => { const t = (Date.now() - ms) / 1000; utimesSync(file, t, t) }
  const geeseRoutes = { 'search/artist': { data: [{ id: 7, name: 'Geese', nb_fan: 41000, picture_xl: 'geese-new.jpg' }] }, 'artist/7/albums': { data: [{ title: 'Getting Killed' }] } }

  it('an old photo is the answer while Deezer has not answered at all', async () => {
    const { root, dir, factsFile } = setup()
    let release: () => void = () => {}
    const hung = new Promise<void>((r) => { release = r })
    try {
      writeFileSync(join(dir, 'geese.jpg'), 'old photo')
      age(join(dir, 'geese.jpg'), 61 * DAY)
      const photos = createArtistPhotos({
        dir, factsFile, refreshGapMs: 0,
        owned: async () => ({ albums: ['Getting Killed'], titles: [] }),
        fetchJson: async (url) => { await hung; return fake(geeseRoutes)(url) },
        download: async () => Buffer.from('new photo'),
      })
      // Deezer never answers until released below: before 2026-11-10 this get() never came back.
      let answer: string | null | undefined
      void photos.get('Geese').then((a) => { answer = a })
      await waitFor(() => answer !== undefined, 'the photo on disk, with Deezer not answering')
      assert.equal(answer, 'geese', 'returned from disk without waiting for Deezer')
      assert.equal(readFileSync(join(dir, 'geese.jpg'), 'utf8'), 'old photo', 'and still the old photo while the refresh runs')
      release()
      await photos.idle()
      assert.equal(readFileSync(join(dir, 'geese.jpg'), 'utf8'), 'new photo', 'the refresh landed behind the answer')
      assert.ok(!existsSync(join(dir, `geese.jpg.${process.pid}.tmp`)), 'written by rename, nothing left behind')
    } finally { release(); await removeTemp(root) }
  })

  it('what a refresh may replace is unchanged: only the artist his own records confirm, never over nothing', async () => {
    const { root, dir, factsFile } = setup()
    try {
      const downloads: string[] = []
      // Bristol's Mesh is not the MESH of "No Fun At All": identity not confirmed, the photo on disk stands.
      const photos = createArtistPhotos({
        dir, factsFile, refreshGapMs: 0,
        owned: async () => ({ albums: ['No Fun At All'], titles: ['Violent Peasant'] }),
        fetchJson: fake({ 'search/artist': { data: [{ id: 1, name: 'Mesh', nb_fan: 6668, picture_xl: 'bristol.jpg' }] }, 'artist/1/albums': { data: [{ title: 'Who Watches Over Me?' }] }, 'artist/1/top': { data: [{ title: 'Taken for Granted' }] } }),
        download: async (u) => { downloads.push(u); return Buffer.from('a stranger') },
      })
      writeFileSync(join(dir, 'mesh.jpg'), 'his MESH')
      age(join(dir, 'mesh.jpg'), 61 * DAY)
      assert.equal(await photos.get('MESH'), 'mesh')
      await photos.idle()
      assert.equal(readFileSync(join(dir, 'mesh.jpg'), 'utf8'), 'his MESH')
      assert.deepEqual(downloads, [])
      assert.ok(!existsSync(join(dir, 'mesh.miss')), 'and no miss is written over a real photo')
    } finally { await removeTemp(root) }
  })

  it('a photo inside its age is not refreshed, and a refresh that could not finish is not retried for hours', async () => {
    const { root, dir, factsFile } = setup()
    try {
      const log: string[] = []
      let clock = Date.now()
      const photos = createArtistPhotos({ dir, factsFile, refreshGapMs: 0, now: () => clock, owned: async () => ({ albums: [], titles: [] }), fetchJson: async (u) => { log.push(u); return undefined }, download: async () => null })
      writeFileSync(join(dir, 'geese.jpg'), 'photo')
      age(join(dir, 'geese.jpg'), 29 * DAY)
      assert.equal(await photos.get('Geese'), 'geese')
      await photos.idle()
      assert.equal(log.length, 0, 'young: Deezer is not asked')
      age(join(dir, 'geese.jpg'), 61 * DAY)
      for (let i = 0; i < 5; i++) assert.equal(await photos.get('Geese'), 'geese')
      await photos.idle()
      const once = log.length
      assert.ok(once > 0, 'due: asked')
      for (let i = 0; i < 5; i++) await photos.get('Geese')
      await photos.idle()
      assert.equal(log.length, once, 'Deezer was away: not asked again on every look')
      clock += REFRESH_RETRY_MS + 1
      await photos.get('Geese')
      await photos.idle()
      assert.ok(log.length > once, 'asked again once the retry gap has passed')
    } finally { await removeTemp(root) }
  })

  it('the refreshes behind are one at a time, however many photos are due', async () => {
    const { root, dir, factsFile } = setup()
    try {
      const names = Array.from({ length: 12 }, (_, i) => `Band ${i}`)
      for (const n of names) { writeFileSync(join(dir, `${artistSlug(n)}.jpg`), 'old'); age(join(dir, `${artistSlug(n)}.jpg`), 61 * DAY) }
      let running = 0, most = 0, done = 0
      const photos = createArtistPhotos({
        dir, factsFile, refreshGapMs: 0,
        owned: async () => ({ albums: [], titles: [] }),
        fetchJson: async (url) => {
          const m = /q=([^&]+)/.exec(url)
          return { data: [{ id: 1, name: decodeURIComponent(m?.[1] ?? '').replace(/^artist:"|"$/g, ''), nb_fan: 5, picture_xl: 'x.jpg' }] }
        },
        download: async () => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 5)); running--; done++; return Buffer.from('new') },
      })
      const answers = await Promise.all(names.map((n) => photos.get(n)))
      assert.deepEqual(answers, names.map(artistSlug), 'every one answered from disk first')
      await photos.idle()
      assert.equal(done, 12)
      assert.equal(most, 1, 'never two refresh downloads at once')
    } finally { await removeTemp(root) }
  })

  it('photos fetched on the same day do not fall due on the same day', () => {
    const days = new Map<number, number>()
    for (let i = 0; i < 1399; i++) {
      const ms = photoMaxAgeMs(artistSlug(`Artist Number ${i}`))
      assert.ok(ms >= PHOTO_MAX_AGE_MS && ms < 2 * PHOTO_MAX_AGE_MS, 'between 30 and 60 days')
      const d = Math.floor(ms / DAY)
      days.set(d, (days.get(d) ?? 0) + 1)
    }
    assert.ok(Math.max(...days.values()) < 1399 * 0.08, `no day takes more than 8% of them (worst: ${Math.max(...days.values())})`)
    assert.equal(photoMaxAgeMs('geese'), photoMaxAgeMs('geese'), 'and an artist keeps its own date')
  })

  it('known(): which names have a photo on disk, from one folder listing and no network', async () => {
    const { root, dir, factsFile } = setup()
    try {
      const log: string[] = []
      const photos = createArtistPhotos({ dir, factsFile, owned: async () => ({ albums: [], titles: [] }), fetchJson: fake({}, log), download: async () => null })
      writeFileSync(join(dir, 'geese.jpg'), 'x')
      writeFileSync(join(dir, `${artistSlug('Молчат Дома')}.jpg`), 'x')
      writeFileSync(join(dir, 'fat-dog.miss'), '')
      assert.deepEqual(await photos.known(['Geese', 'Fat Dog', 'Молчат Дома', '', 'Nobody']), { Geese: 'geese', 'Молчат Дома': artistSlug('Молчат Дома') })
      assert.equal(log.length, 0)
    } finally { await removeTemp(root) }
  })
})
