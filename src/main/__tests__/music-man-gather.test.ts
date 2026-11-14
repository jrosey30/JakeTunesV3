/**
 * What the app already knows about the thing Jake asks about, read from where
 * it lives (main/music-man-gather.ts). A temp userData folder stands in for
 * the real one; homemini is a function.
 */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMusicManGather, type GatherDeps, type GatherTrack } from '../music-man-gather.ts'
import { profileCacheFile } from '../../common/artist-profile.ts'
import { buildPacket } from '../../common/music-man-packet.ts'

const TRACKS: GatherTrack[] = [
  { id: 12970, title: 'Stalks', artist: 'Twisted Teens', albumArtist: 'Twisted Teens', album: 'The Holy Cross Tigers', year: 2026, genre: 'Garage Punk', subgenre: 'Garage/Psych', subgenreLean: 'Garage-Punk Revival', trackNumber: 1, duration: 167831, playCount: 2, rating: 5, dateAdded: '2026-10-23T00:30:58.682Z', bpm: 138.1, keyRoot: 'D', keyMode: 'major', source: 'streamrip' },
  { id: 14161, title: 'When We First Met', artist: 'Twisted Teens', albumArtist: 'Twisted Teens', album: 'The Holy Cross Tigers', year: 2026, genre: 'Garage Punk', trackNumber: 2, duration: 112985, playCount: 1, starredAt: '1794629340783', dateAdded: '2026-11-06T15:43:44.717Z', source: 'bandcamp', addedVia: 'tiktok' },
  { id: 15193, title: 'is it real?', artist: 'Twisted Teens', album: 'Blame the Clown', year: 2026, trackNumber: 1, playCount: 0 },
  { id: 7, title: 'Marquee Moon', artist: 'Television', album: 'Marquee Moon', year: 1977, playCount: 40 },
]

const PROFILE = {
  version: 1, name: 'Twisted Teens', kind: 'other', oneLiner: 'American rock duo.',
  origin: { place: 'New Orleans, Louisiana', since: '2024' },
  facts: [{ label: 'Labels', value: 'Sub Pop' }], updatedAt: '2026-10-30T02:06:38.658Z',
}

let dir = ''
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jt-mm-gather-'))
  await mkdir(join(dir, 'artist-profiles'))
  await writeFile(join(dir, 'artist-profiles', profileCacheFile('Twisted Teens')), JSON.stringify({ name: 'Twisted Teens', doc: PROFILE, etag: null, confirmedAt: 1 }))
  await writeFile(join(dir, 'brain-descriptors.json'), JSON.stringify({ 12970: { d: 'Fuzzed-out guitars over a galloping beat.', m: 'A breakup, shouted.' } }))
  await writeFile(join(dir, 'album-credits.json'), JSON.stringify({ v: 1, entries: { 'twisted teens|the holy cross tigers|y:2026': { credits: { label: 'Sub Pop Records', released: '2026-11-06' }, at: 1 } } }))
  await writeFile(join(dir, 'album-personnel.json'), JSON.stringify({ v: 2, entries: { 'twisted teens|the holy cross tigers': { people: [{ name: 'RJ Santos', roles: ['steel guitar'], tracks: 3, credits: [] }], trackCount: 13, at: 1 } } }))
  await writeFile(join(dir, 'album-notes.json'), JSON.stringify({ v: 1, blurbs: { 'twisted teens|the holy cross tigers|2026': 'Their third release of 2026.' }, takes: {} }))
  await writeFile(join(dir, 'ipod-lists-cache.json'), JSON.stringify({ lists: [{ id: 'a', name: 'Best of Bandcamp', ids: [12970] }] }))
  await writeFile(join(dir, 'friend-credits.json'), JSON.stringify({ credits: [{ friend: 'Avery', keys: ['stalks|twistedteens'] }] }))
  await writeFile(join(dir, 'artist-tags.json'), JSON.stringify({ 'twisted teens': { tags: ['garage punk', 'country punk'] } }))
  await writeFile(join(dir, 'artist-members.json'), '{ this file is torn')
})
after(async () => { await rm(dir, { recursive: true, force: true }) })

function rig(over: Partial<GatherDeps> = {}) {
  const asked: string[] = []
  const g = createMusicManGather({
    tracks: async () => TRACKS,
    userDataDir: dir,
    hubUrl: 'http://hub',
    fetchImpl: async (url) => {
      asked.push(url)
      if (url.endsWith('/api/top1000')) return { ok: true, status: 200, json: async () => ({ list: [{ id: '12970', rank: 412 }, { id: '7', rank: 3 }] }) }
      return { ok: false, status: 404, json: async () => ({}) }
    },
    today: () => '2026-11-13',
    ...over,
  })
  return { g, asked }
}

describe('gathering for an album page', () => {
  test("everything the app knows reaches the packet: profile, credits, history, the sound, Jake's own data", async () => {
    const { g } = rig({ press: async () => 'Press text.' })
    const input = await g.gather({ kind: 'album', artist: 'Twisted Teens', album: 'The Holy Cross Tigers', year: '2026' }, 7)
    assert.ok(input)
    assert.deepEqual(input.songs.map((s) => s.title), ['Stalks', 'When We First Met'])
    const stalks = input.songs[0]!
    assert.equal(stalks.sound, 'Fuzzed-out guitars over a galloping beat.')
    assert.equal(stalks.mood, 'A breakup, shouted.')
    assert.equal(stalks.top1000, 412)
    assert.deepEqual(stalks.ipods, ['Best of Bandcamp'])
    assert.equal(stalks.sentBy, 'Avery')
    assert.equal(stalks.starred, true)
    assert.equal(stalks.key, 'D major')
    assert.equal(stalks.subgenre, 'Garage/Psych, Garage-Punk Revival')
    assert.equal(input.songs[1]!.starred, true)
    assert.equal(input.songs[1]!.sentBy, 'a link from tiktok')
    assert.equal(input.artist?.oneLiner, 'American rock duo.')
    assert.equal(input.artist?.place, 'New Orleans, Louisiana')
    assert.deepEqual(input.artist?.tags, ['garage punk', 'country punk'])
    assert.equal(input.album?.label, 'Sub Pop Records')
    assert.equal(input.album?.released, '2026-11-06')
    assert.deepEqual(input.album?.people, ['RJ Santos (steel guitar)'])
    assert.equal(input.album?.history, 'Their third release of 2026.')
    assert.equal(input.nowPlaying?.title, 'Marquee Moon')
    assert.equal(input.press, 'Press text.')
    const p = buildPacket(input)
    assert.equal(p.thin, false)
    assert.match(p.text, /In his Top 1000: "Stalks" at #412/)
    assert.match(p.text, /Sent to him by: Avery/)
  })

  test('case and stray space in the page key still find the album', async () => {
    const { g } = rig()
    const input = await g.gather({ kind: 'album', artist: 'twisted teens ', album: 'the holy cross tigers' })
    assert.equal(input?.songs.length, 2)
  })

  test('an album nobody owns is nothing', async () => {
    const { g } = rig()
    assert.equal(await g.gather({ kind: 'album', artist: 'Nobody', album: 'Nothing' }), null)
  })
})

describe('gathering for the other pages', () => {
  test('an artist: every song by them, and their records with plays', async () => {
    const { g } = rig()
    const input = await g.gather({ kind: 'artist', name: 'Twisted Teens' })
    assert.equal(input?.songs.length, 3)
    assert.deepEqual(input?.records, [
      { album: 'The Holy Cross Tigers', year: '2026', songs: 2, plays: 3, history: 'Their third release of 2026.' },
      { album: 'Blame the Clown', year: '2026', songs: 1, plays: 0 },
    ])
  })
  test('a song: its row, its artist and its album', async () => {
    const { g } = rig()
    const input = await g.gather({ kind: 'song', trackId: 12970 }, 12970)
    assert.equal(input?.songs.length, 1)
    assert.equal(input?.artist?.name, 'Twisted Teens')
    assert.equal(input?.album?.label, 'Sub Pop Records')
    assert.equal(input?.nowPlaying?.id, 12970)
    assert.equal(await g.gather({ kind: 'song', trackId: 999 }), null)
  })
  test('a list: its songs in its own order, no artist lookups', async () => {
    const { g, asked } = rig({ press: async () => { throw new Error('a list has no one artist to search for') } })
    const input = await g.gather({ kind: 'list', what: 'playlist', name: 'Road', trackIds: [7, 12970] })
    assert.deepEqual(input?.songs.map((s) => s.id), [7, 12970])
    assert.equal(input?.artist, null)
    assert.ok(asked.every((u) => !u.includes('/api/artist/')))
  })
})

describe('when things are missing or slow', () => {
  test('an artist with no profile on disk is asked of homemini, which puts it on the build list', async () => {
    const { g, asked } = rig()
    const input = await g.gather({ kind: 'artist', name: 'Television' })
    assert.ok(asked.includes('http://hub/api/artist/Television/profile'))
    assert.equal(input?.artist, null)
    assert.equal(buildPacket(input!).thin, true)
  })
  test('homemini away: the packet is built from the disk alone', async () => {
    const { g } = rig({ fetchImpl: async () => { throw new Error('unreachable') } })
    const input = await g.gather({ kind: 'album', artist: 'Twisted Teens', album: 'The Holy Cross Tigers', year: '2026' })
    assert.equal(input?.artist?.oneLiner, 'American rock duo.')
    assert.equal(input?.songs[0]!.top1000, undefined)
  })
  test('a torn file is simply absent', async () => {
    const { g } = rig()
    const input = await g.gather({ kind: 'artist', name: 'Twisted Teens' })
    assert.equal(input?.artist?.members, undefined)
  })
  test('a press search that fails or never answers does not hold the ask', async () => {
    const { g } = rig({ press: async () => { throw new Error('exa down') } })
    const input = await g.gather({ kind: 'artist', name: 'Twisted Teens' })
    assert.equal(input?.press, undefined)
  })
  test('looking harder asks homemini afresh and waits longer on the press', async () => {
    let n = 0
    const { g, asked } = rig({
      press: async () => (++n === 1 ? '' : 'Found on the second look.'),
      fetchImpl: async (url) => {
        asked.push(url)
        return url.includes('/api/artist/') ? { ok: true, status: 200, json: async () => ({ ...PROFILE, name: 'Television', oneLiner: 'American rock band.' }) } : { ok: false, status: 404, json: async () => ({}) }
      },
    })
    const first = await g.gather({ kind: 'album', artist: 'Television', album: 'Marquee Moon' })
    assert.ok(first)
    const again = await g.lookHarder({ kind: 'album', artist: 'Television', album: 'Marquee Moon' }, { ...first, artist: null })
    assert.equal(again.artist?.oneLiner, 'American rock band.')
    assert.equal(again.press, 'Found on the second look.')
  })
})
