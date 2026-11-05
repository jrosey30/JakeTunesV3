/**
 * A download goes on the song's real album (JakeTunesMobile Brief 231).
 *
 * Jake, 2026-11-05: "can girls and boys by blur not be on the album 90's rock albums??? it needs
 * its real album associated with it". The phone's log showed how; the desktop had the same holes
 * and one more: it imported the held compilation without trying the album door at all.
 *
 * Walks the real `streamrip:download-by-query` handler. Only the outside world is faked: `rip` and
 * `ffprobe` are small scripts, HOME is a temp folder, and fetch answers for Qobuz, MusicBrainz (with
 * its real answers: fixtures/real-album-musicbrainz.json) and the Cover Art Archive.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { albumFirst, isCompilationCopy, onWantedAlbum, qobuzTrackMetaOf, rankStreamripCandidates, realAlbumTags, spelledOutAnd, titleMatches, type QobuzTrackMeta } from '../streamrip-match.ts'
import { buildRequestedRecording, verifyCandidate } from '../exact-recording.ts'
import type { ImportRowTags } from '../import-pipeline.ts'
import type { MbRecording, RealAlbum } from '../../common/real-album.ts'

const userData = mkdtempSync(join(tmpdir(), 'jt-realalbum-userdata-'))
process.env.JT_USER_DATA = userData
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { registerStreamripStore } = await import('../streamrip-store/index.ts')
after(() => rmSync(userData, { recursive: true, force: true }))

const MB_ANSWERS = JSON.parse(readFileSync(new URL('./fixtures/real-album-musicbrainz.json', import.meta.url), 'utf8')) as Record<string, MbRecording[]>

// ── The rules ───────────────────────────────────────────────────────────────

describe('"&" is "and"', () => {
  it('spells it out, for comparing only', () => {
    assert.equal(spelledOutAnd('Girls & Boys'), 'Girls and Boys')
    assert.equal(spelledOutAnd("Rock 'n' Roll"), 'Rock and Roll')
    assert.equal(spelledOutAnd('Nina'), 'Nina', 'an N inside a word is a letter')
  })

  it('the door, the ranking and the judge read the album\'s title as the request', () => {
    assert.equal(titleMatches('Girls and Boys', 'Girls & Boys'), true)
    assert.equal(titleMatches('Girls & Boys', 'Girls and Boys'), true)
    assert.equal(titleMatches('Girls and Boys', 'Boys'), false)
    const hit = (desc: string) => ({ source: 'qobuz', mediaType: 'track', id: desc, desc })
    assert.deepEqual(rankStreamripCandidates('Girls and Boys', 'Blur', [hit('Girls & Boys by Blur')], 'track').ranked.map((h) => h.desc), ['Girls & Boys by Blur'])
    const req = buildRequestedRecording({ artist: 'Blur', title: 'Girls and Boys', album: 'Parklife', durationMs: 291_000 })
    const v = verifyCandidate(req, { provider: 'qobuz', title: 'Girls & Boys', artist: 'Blur', album: 'Parklife', durationSec: 291 })
    assert.equal(v.verdict, 'exact')
    assert.ok(v.verdict === 'exact' && v.albumMatches)
  })

  it('an album can be written either way too', () => {
    assert.equal(onWantedAlbum('Armed and Extremely Dangerous', 'Armed & Extremely Dangerous'), true)
    assert.equal(onWantedAlbum('Parklife', "90's Rock Anthems"), false)
    assert.equal(onWantedAlbum('Parklife', 'Parklife (2012 Remaster)'), true)
    assert.equal(onWantedAlbum('Boots', 'Boots (Deluxe)'), true)
    assert.equal(onWantedAlbum('', 'Anything'), true)
    assert.equal(onWantedAlbum('Parklife', undefined), true)
  })
})

describe('a copy on a compilation', () => {
  it('Qobuz says who the album is by', () => {
    assert.equal(qobuzTrackMetaOf({ album: { title: 'x', artist: { name: 'Various Artists' } } }).albumArtist, 'Various Artists')
    assert.equal(qobuzTrackMetaOf({ album: { title: 'x', artist: { name: 7 } } }).albumArtist, undefined)
    assert.equal(qobuzTrackMetaOf({}).albumArtist, undefined)
  })

  it('Various Artists, or anybody else\'s album', () => {
    const want = { artist: 'Blur' }
    for (const albumArtist of ['Various Artists', 'various', 'VA', 'V.A.', 'DJ Somebody']) assert.equal(isCompilationCopy(want, { albumArtist }), true, albumArtist)
  })

  it('not the artist\'s own, however the credit is written, and not without an answer', () => {
    assert.equal(isCompilationCopy({ artist: 'Blur' }, { albumArtist: 'BLUR' }), false)
    assert.equal(isCompilationCopy({ artist: 'The English Beat', artistAliases: ['The Beat'] }, { albumArtist: 'The Beat' }), false)
    assert.equal(isCompilationCopy({ artist: 'OMA & SitarNik' }, { albumArtist: 'Oma' }), false)
    assert.equal(isCompilationCopy({ artist: 'Blur' }, undefined), false)
    assert.equal(isCompilationCopy({ artist: 'Blur' }, {}), false)
  })

  const meta = new Map<string, QobuzTrackMeta>([
    ['comp', { album: "90's Rock Anthems", albumArtist: 'Various Artists' }],
    ['other', { album: 'Blur: The Best Of', albumArtist: 'Blur' }],
    ['album', { album: 'Parklife', albumArtist: 'Blur' }],
  ])
  const hits = [{ id: 'comp' }, { id: 'other' }, { id: 'album' }]

  it('walks last: the album, another of the artist\'s, then the compilation', () => {
    const o = albumFirst({ artist: 'Blur', album: 'Parklife' }, hits, meta)
    assert.deepEqual(o.walk.map((h) => h.id), ['album', 'other', 'comp'])
    assert.deepEqual([...o.offAlbum].sort(), ['comp', 'other'])
  })

  it('with no album to look for, it is still off the album, and the rest are not', () => {
    const o = albumFirst({ artist: 'Blur', album: '' }, hits, meta)
    assert.deepEqual(o.walk.map((h) => h.id), ['other', 'album', 'comp'])
    assert.deepEqual([...o.offAlbum], ['comp'])
  })

  it('a row that names that very compilation gets it', () => {
    const o = albumFirst({ artist: 'Blur', album: "90's Rock Anthems" }, hits, meta)
    assert.equal(o.walk[0]?.id, 'comp')
  })
})

describe('what the row says when the copy is from the wrong album', () => {
  const real: RealAlbum = {
    album: 'Parklife', year: 1994, trackNumber: 1, trackCount: 16, discNumber: 1, title: 'Girls & Boys', durationSec: 290.8,
    releaseGroupId: 'rg', realAlbums: ['Parklife'], lateAlbum: false, confidence: 'high',
  }
  const want = { title: 'Girls and Boys', artist: 'Blur', album: 'Parklife', durationSec: 291, durationTolSec: 5 }
  const comp = { durationSec: 291, meta: { album: "90's Rock Anthems", albumArtist: 'Various Artists' } }

  it('MusicBrainz and the clock agree: the album, its numbers, its title as printed, its cover', () => {
    assert.deepEqual(realAlbumTags(want, real, comp), {
      album: 'Parklife', albumArtist: 'Blur', year: 1994, trackNumber: 1, trackCount: 16, discNumber: 1, title: 'Girls & Boys',
      coverUrls: ['https://coverartarchive.org/release-group/rg/front-500'],
    })
  })

  it('nothing vouches: the file\'s tags stand', () => {
    assert.equal(realAlbumTags(want, real, { ...comp, durationSec: 400 }), null, 'the clock says it is something else')
    assert.equal(realAlbumTags(want, real, { meta: comp.meta }), null, 'no length')
    assert.equal(realAlbumTags({ ...want, album: '' }, real, comp), null, 'no album')
    assert.equal(realAlbumTags({ ...want, album: 'Live at Leeds', durationSec: 0 }, real, comp), null, 'MusicBrainz named another album')
    const noClock = { ...want, durationSec: 0 }
    assert.equal(realAlbumTags(noClock, { ...real, confidence: 'low' }, comp)?.album, 'Parklife', 'the album\'s own clock')
    assert.equal(realAlbumTags(noClock, { ...real, confidence: 'low' }, { ...comp, durationSec: 259 }), null)
    assert.equal(realAlbumTags(noClock, { ...real, confidence: 'low', lateAlbum: true }, comp), null, 'a late album is never named')
  })

  it('no MusicBrainz: the row can name its album over a compilation, at its length, and never over the artist\'s own', () => {
    assert.deepEqual(realAlbumTags(want, null, comp), { album: 'Parklife', albumArtist: 'Blur', coverUrls: [] })
    assert.equal(realAlbumTags({ ...want, durationSec: 0 }, null, comp), null, 'no clock')
    assert.equal(realAlbumTags(want, null, { durationSec: 291, meta: { albumArtist: 'Blur' } }), null)
    assert.equal(realAlbumTags(want, null, { durationSec: 291 }), null, 'nor over one nobody has placed')
    assert.equal(realAlbumTags(want, real, { durationSec: 291, meta: { albumArtist: 'Blur' } })?.album, 'Parklife', 'MusicBrainz can, though')
  })
})

// ── The real handler, in a fake world ───────────────────────────────────────

const FAKE_RIP = `#!/bin/sh
echo "rip $*" >> "$FAKE_WORLD/calls.log"
if [ "$1" = "--version" ]; then echo "rip, version 2.1.0"; exit 0; fi
if [ "$1" = "search" ]; then
  # rip search -o <file> -n <n> <source> <type> <query>
  if [ -f "$FAKE_WORLD/search-$6-$7.json" ]; then cp "$FAKE_WORLD/search-$6-$7.json" "$3"; exit 0; fi
  echo "No search results found for query $8"; exit 0
fi
# rip --folder <dir> --quality 4 --no-db --no-progress id <source> <type> <id>
id="\${10}"
cp "$FAKE_WORLD/audio.bin" "$2/$id-1.flac"
`
const FAKE_FFPROBE = `#!/bin/sh
for f; do :; done
b=$(basename "$f" .flac)
cat "$FAKE_WORLD/probe-\${b%-*}.json"
`

type Answer = Record<string, unknown> | 'gone'
const home = mkdtempSync(join(tmpdir(), 'jt-realalbum-home-'))
const appPath = join(home, 'app-path')
after(() => rmSync(home, { recursive: true, force: true }))

let world = ''
let answers: Record<string, Answer> = {}
let musicBrainz: MbRecording[] | 'down' = []
let musicBrainzAsked: string[] = []
let coverUp = true
const realFetch = globalThis.fetch
const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }

const put = (name: string, body: string | Uint8Array): void => writeFileSync(join(world, name), body)
function install(dir: string, name: string, script: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), script)
  chmodSync(join(dir, name), 0o755)
}
const ripCalls = (): string[] => (existsSync(join(world, 'calls.log')) ? readFileSync(join(world, 'calls.log'), 'utf-8').split('\n') : [])
const fetched = (): string[] => ripCalls().filter((l) => l.startsWith('rip --folder')).map((l) => l.split(' ').at(-1)!)
const albumSearches = (): string[] => ripCalls().filter((l) => l.startsWith('rip search') && l.includes(' qobuz album ')).map((l) => l.split(' qobuz album ')[1]!)
const hits = (type: 'track' | 'album', rows: Array<[id: string, desc: string]>): void =>
  put(`search-qobuz-${type}.json`, JSON.stringify(rows.map(([id, desc]) => ({ source: 'qobuz', media_type: type, id, desc }))))

/** One hit: what Qobuz says about it, and the tags on its file. */
function copy(id: string, t: { title: string; artist: string; album: string; by?: string; duration: number }): void {
  answers[id] = { id, title: t.title, duration: t.duration, parental_warning: false, version: null, album: { title: t.album, ...(t.by ? { artist: { name: t.by } } : {}) } }
  put(`probe-${id}.json`, JSON.stringify({ format: { duration: String(t.duration), tags: { title: t.title, artist: t.artist, album: t.album } } }))
}
/** An album page on Qobuz, its tracks with their own files. */
function albumPage(id: string, title: string, artist: string, tracks: Array<{ id: string; title: string; duration: number }>): void {
  answers[id] = {
    id, title, artist: { name: artist }, parental_warning: false,
    tracks_count: tracks.length, media_count: 1,
    tracks: { items: tracks.map((t, i) => ({ id: t.id, title: t.title, duration: t.duration, track_number: i + 1, media_number: 1, parental_warning: false, streamable: true, performer: { name: artist } })) },
  }
  for (const t of tracks) put(`probe-${t.id}.json`, JSON.stringify({ format: { duration: String(t.duration), tags: { title: t.title, artist, album: title } } }))
}

interface WalkResult { ok: boolean; imported?: number; outcome?: string; error?: string; matchDesc?: string }

function store() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const imports: Array<{ id: string; rowTags?: ImportRowTags }> = []
  registerStreamripStore({
    ipc: { handle: (channel: string, fn: never) => { handlers.set(channel, fn) } },
    getMainWindow: () => null,
    importDownloaded: async (paths: string[], _source?: string, _addedVia?: string, rowTags?: ImportRowTags) => {
      for (const p of paths) imports.push({ id: p.split('/').at(-1)!.replace(/-\d+\.flac$/, ''), rowTags })
      return paths.map((p) => {
        const id = p.split('/').at(-1)!.replace(/-\d+\.flac$/, '')
        return { title: JSON.parse(readFileSync(join(world, `probe-${id}.json`), 'utf-8')).format.tags.title }
      })
    },
    mbThrottle: async () => {},
    mbUserAgent: 'jt-realalbum-test',
  } as never)
  return {
    imports,
    walk: async (opts: Record<string, unknown>): Promise<WalkResult> => {
      const r = await handlers.get('streamrip:download-by-query')!({}, opts) as WalkResult
      assert.deepEqual(readdirSync(process.env.TMPDIR!).filter((n) => n.startsWith('jaketunes-')), [], 'staging must not outlive the walk')
      return r
    },
  }
}

before(() => {
  install(join(home, '.local', 'bin'), 'rip', FAKE_RIP)
  install(appPath, 'ffprobe', FAKE_FFPROBE)
  const cfg = join(home, 'Library', 'Application Support', 'streamrip')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'config.toml'), '[qobuz]\nuse_auth_token = true\npassword_or_token = "SECRET-TOKEN"\napp_id = "APP1"\n')
  const warm = { env: { ...process.env, FAKE_WORLD: home }, timeout: 120_000, stdio: 'ignore' as const }
  execFileSync(join(home, '.local', 'bin', 'rip'), ['--version'], warm)
  writeFileSync(join(home, 'probe-warm.json'), '{}')
  execFileSync(join(appPath, 'ffprobe'), [join(home, 'warm-1.flac')], warm)
})

beforeEach(() => {
  world = mkdtempSync(join(tmpdir(), 'jt-realalbum-'))
  mkdirSync(join(world, 'tmp'))
  process.env.HOME = home
  process.env.PATH = `${appPath}:/usr/bin:/bin`
  process.env.TMPDIR = join(world, 'tmp')
  process.env.FAKE_WORLD = world
  put('audio.bin', new Uint8Array(100 * 1024))
  answers = {}
  musicBrainz = []
  musicBrainzAsked = []
  coverUp = true
  mock.method(console, 'warn', () => {})
  mock.method(console, 'log', () => {})
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (u.includes('qobuz.com/api.json')) {
      const id = /_id=([^&]+)/.exec(u)?.[1] ?? ''
      const answer = answers[decodeURIComponent(id)]
      if (answer === undefined) return json({ status: 'error' }, 500)
      if (answer === 'gone') return json({ status: 'error', code: 404, message: 'No result matching given argument' }, 404)
      return json(answer)
    }
    if (u.includes('musicbrainz.org/ws/2/recording')) {
      musicBrainzAsked.push(u)
      if (musicBrainz === 'down') throw new TypeError('fetch failed')
      return json({ count: musicBrainz.length, recordings: musicBrainz })
    }
    if (u.includes('coverartarchive.org')) return coverUp ? new Response(new Uint8Array(4096).fill(7), { status: 200 }) : new Response('', { status: 404 })
    if (u.includes('bandcamp.com/api')) return json({ auto: { results: [] } })
    return json({ results: [] })
  }) as typeof fetch
})

afterEach(() => {
  mock.restoreAll()
  globalThis.fetch = realFetch
  process.env.HOME = savedEnv.HOME
  process.env.PATH = savedEnv.PATH
  if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = savedEnv.TMPDIR
  rmSync(world, { recursive: true, force: true })
})

describe('Girls and Boys, walked', () => {
  const BLUR = { artist: 'Blur', title: 'Girls and Boys', album: 'Parklife', durationMs: 291_200 }
  // The names and ids are the real ones (Qobuz's first hits for the song are all compilations).
  function theCompilations(): void {
    hits('track', [['175845990', 'Girls and Boys by Blur'], ['summerbbq', 'Girls and Boys by Blur'], ['britpop', 'Girls and Boys by Blur']])
    copy('175845990', { title: 'Girls and Boys', artist: 'Blur', album: "90's Rock Anthems", by: 'Various Artists', duration: 291 })
    copy('summerbbq', { title: 'Girls and Boys', artist: 'Blur', album: 'Summer BBQ', by: 'Various Artists', duration: 291 })
    copy('britpop', { title: 'Girls and Boys', artist: 'Blur', album: 'Britpop Bangers', by: 'Various Artists', duration: 291 })
  }
  function theAlbumsDoor(): void {
    hits('album', [['0825646261857', 'Parklife by Blur']])
    albumPage('0825646261857', 'Parklife', 'Blur', [{ id: '19201325', title: 'Girls & Boys', duration: 291 }, { id: '19201326', title: 'Tracy Jacks', duration: 262 }])
  }
  beforeEach(() => { musicBrainz = MB_ANSWERS['Blur - Girls and Boys']! })

  it('the held compilation waits, and the door brings in the album\'s own copy', async () => {
    theCompilations(); theAlbumsDoor()
    const { walk, imports } = store()
    const r = await walk(BLUR)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(imports.map((i) => i.id), ['19201325'])
    assert.equal(imports[0]!.rowTags, undefined, 'its own tags name the album already')
    assert.deepEqual(fetched(), ['175845990', '19201325'], 'one compilation in hand, and the rest are not fetched')
  })

  it('MusicBrainz down: the door still works, on the row\'s word', async () => {
    theCompilations(); theAlbumsDoor()
    musicBrainz = 'down'
    const { walk, imports } = store()
    await walk(BLUR)
    assert.deepEqual(imports.map((i) => i.id), ['19201325'])
    assert.equal(musicBrainzAsked.length, 2, 'once more, then the row')
  })

  it('a row that names no album looks for the real one', async () => {
    theCompilations(); theAlbumsDoor()
    const { walk, imports } = store()
    await walk({ artist: 'Blur', title: 'Girls and Boys', durationMs: 291_200 })
    assert.deepEqual(imports.map((i) => i.id), ['19201325'])
    assert.deepEqual(albumSearches(), ['Blur Parklife'])
  })

  it('a row on a compilation looks for the real album too', async () => {
    theCompilations(); theAlbumsDoor()
    const { walk, imports } = store()
    await walk({ ...BLUR, album: "90's Rock Anthems" })
    assert.deepEqual(imports.map((i) => i.id), ['19201325'])
    assert.deepEqual(albumSearches(), ['Blur Parklife'], 'the compilation is in hand already')
  })

  it('the album never turns up: the compilation\'s copy, on the real album\'s row, with the album\'s cover', async () => {
    theCompilations()
    const { walk, imports } = store()
    const r = await walk(BLUR)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(imports.map((i) => i.id), ['175845990'])
    const tags = imports[0]!.rowTags!
    assert.equal(tags.album, 'Parklife')
    assert.equal(tags.albumArtist, 'Blur')
    assert.equal(tags.year, 1994)
    assert.equal(tags.trackNumber, 1)
    assert.equal(tags.trackCount, 16)
    assert.equal(tags.title, 'Girls & Boys')
    assert.equal(tags.cover?.length, 4096)
  })

  it('no cover to be had: the row names the album and has no cover, not the compilation\'s', async () => {
    theCompilations()
    coverUp = false
    const { walk, imports } = store()
    await walk(BLUR)
    assert.equal(imports[0]!.rowTags!.album, 'Parklife')
    assert.equal(imports[0]!.rowTags!.cover, undefined)
  })

  it('MusicBrainz down and no album: the row names its album over a compilation at its length', async () => {
    theCompilations()
    musicBrainz = 'down'
    const { walk, imports } = store()
    await walk(BLUR)
    assert.deepEqual(imports[0]!.rowTags, { album: 'Parklife', albumArtist: 'Blur', coverUrls: [], cover: undefined })
  })

  it('no witness at all: the file\'s own tags stand, and the song still arrives', async () => {
    theCompilations()
    musicBrainz = 'down'
    const { walk, imports } = store()
    await walk({ artist: 'Blur', title: 'Girls and Boys', album: 'Parklife' })
    assert.deepEqual(imports.map((i) => i.id), ['175845990'])
    assert.equal(imports[0]!.rowTags, undefined)
  })

  it('a row that names no album, with MusicBrainz down: the song still arrives, as it says', async () => {
    theCompilations()
    musicBrainz = 'down'
    const { walk, imports } = store()
    const r = await walk({ artist: 'Blur', title: 'Girls and Boys' })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(imports.map((i) => i.id), ['175845990'])
    assert.equal(imports[0]!.rowTags, undefined)
  })
})

describe('the real names', () => {
  it('Read My Mind, no album named, MusicBrainz down: the artist\'s own album before Direct Hits', async () => {
    musicBrainz = 'down'
    hits('track', [['direct', 'Read My Mind by The Killers'], ['sams', 'Read My Mind by The Killers']])
    copy('direct', { title: 'Read My Mind', artist: 'The Killers', album: 'Direct Hits', by: 'Various Artists', duration: 246 })
    copy('sams', { title: 'Read My Mind', artist: 'The Killers', album: "Sam's Town", by: 'The Killers', duration: 246 })
    const { walk, imports } = store()
    await walk({ artist: 'The Killers', title: 'Read My Mind' })
    assert.deepEqual(imports.map((i) => i.id), ['sams'])
    assert.deepEqual(fetched(), ['sams'])
  })

  it('You\'re Going Down on Rock Workout, no clock: Qobuz says Various Artists, so Tri-Polar', async () => {
    musicBrainz = MB_ANSWERS["Sick Puppies - You're Going Down"]!
    hits('track', [['rock', "You're Going Down by Sick Puppies"], ['tri', "You're Going Down by Sick Puppies"]])
    copy('rock', { title: "You're Going Down", artist: 'Sick Puppies', album: 'Rock Workout', by: 'Various Artists', duration: 187 })
    copy('tri', { title: "You're Going Down", artist: 'Sick Puppies', album: 'Tri-Polar', by: 'Sick Puppies', duration: 187 })
    const { walk, imports } = store()
    await walk({ artist: 'Sick Puppies', title: "You're Going Down", album: 'Rock Workout' })
    assert.deepEqual(imports.map((i) => i.id), ['tri'])
    assert.deepEqual(fetched(), ['tri'])
  })

  it('and when Qobuz has only that one: it arrives, filed on Tri-Polar by the album\'s clock', async () => {
    musicBrainz = MB_ANSWERS["Sick Puppies - You're Going Down"]!
    hits('track', [['rock', "You're Going Down by Sick Puppies"]])
    copy('rock', { title: "You're Going Down", artist: 'Sick Puppies', album: 'Rock Workout', by: 'Various Artists', duration: 187 })
    const { walk, imports } = store()
    await walk({ artist: 'Sick Puppies', title: "You're Going Down", album: 'Rock Workout' })
    assert.deepEqual(imports.map((i) => i.id), ['rock'])
    assert.equal(imports[0]!.rowTags?.album, 'Tri-Polar')
  })

  it('Drift Away on Ultimate Collection: the 1973 album, not 2004\'s re-recording', async () => {
    musicBrainz = MB_ANSWERS['Dobie Gray - Drift Away']!
    hits('track', [['uc', 'Drift Away by Dobie Gray'], ['73', 'Drift Away by Dobie Gray']])
    copy('uc', { title: 'Drift Away', artist: 'Dobie Gray', album: 'Ultimate Collection:  Dobie Gray', by: 'Dobie Gray', duration: 237 })
    copy('73', { title: 'Drift Away', artist: 'Dobie Gray', album: 'Drift Away', by: 'Dobie Gray', duration: 238 })
    const { walk, imports } = store()
    await walk({ artist: 'Dobie Gray', title: 'Drift Away', album: 'Ultimate Collection: Dobie Gray', durationMs: 237_500 })
    assert.deepEqual(imports.map((i) => i.id), ['73'])
  })

  it('Hit the Road Jack on True Genius: out in 1961, on no album until reissues, so the row stands', async () => {
    musicBrainz = MB_ANSWERS['Ray Charles - Hit the Road Jack']!
    hits('track', [['true', 'Hit the Road Jack by Ray Charles']])
    copy('true', { title: 'Hit the Road Jack', artist: 'Ray Charles', album: 'True Genius', by: 'Ray Charles', duration: 120 })
    const { walk, imports } = store()
    await walk({ artist: 'Ray Charles', title: 'Hit the Road Jack', album: 'True Genius', durationMs: 119_900 })
    assert.deepEqual(imports.map((i) => i.id), ['true'])
    assert.equal(imports[0]!.rowTags, undefined)
    assert.deepEqual(albumSearches(), [])
  })

  it('a late album never takes over, even from a row Qobuz calls a compilation', async () => {
    musicBrainz = MB_ANSWERS['Ray Charles - Hit the Road Jack']!
    hits('track', [['va', 'Hit the Road Jack by Ray Charles']])
    copy('va', { title: 'Hit the Road Jack', artist: 'Ray Charles', album: 'Rhythm & Blues Forever', by: 'Various Artists', duration: 120 })
    const { walk, imports } = store()
    await walk({ artist: 'Ray Charles', title: 'Hit the Road Jack', album: 'Rhythm & Blues Forever', durationMs: 119_900 })
    assert.deepEqual(imports.map((i) => i.id), ['va'])
    assert.equal(imports[0]!.rowTags, undefined)
    assert.deepEqual(albumSearches(), [])
  })

  it('with a copy in hand, the row\'s compilation is not searched for: it is that copy', async () => {
    musicBrainz = MB_ANSWERS['Dobie Gray - Drift Away']!
    hits('track', [['uc', 'Drift Away by Dobie Gray']])
    copy('uc', { title: 'Drift Away', artist: 'Dobie Gray', album: 'Ultimate Collection: Dobie Gray', by: 'Dobie Gray', duration: 237 })
    const { walk, imports } = store()
    await walk({ artist: 'Dobie Gray', title: 'Drift Away', album: 'Ultimate Collection: Dobie Gray', durationMs: 237_500 })
    assert.deepEqual(imports.map((i) => i.id), ['uc'])
    assert.equal(imports[0]!.rowTags?.album, 'Drift Away')
    assert.deepEqual(albumSearches(), ['Dobie Gray Drift Away'])
  })

  it('a hit past the sixth, which only then says it is a compilation, is held when the row names no album', async () => {
    musicBrainz = 'down'
    const comps = ['a', 'b', 'c', 'd', 'e', 'f']
    hits('track', [...comps, 'late', 'own'].map((id): [string, string] => [id, 'Read My Mind by The Killers']))
    for (const id of comps) copy(id, { title: 'Read My Mind', artist: 'The Killers', album: `Hits ${id}`, by: 'Various Artists', duration: 246 })
    copy('late', { title: 'Read My Mind', artist: 'The Killers', album: 'Direct Hits', by: 'Various Artists', duration: 246 })
    copy('own', { title: 'Read My Mind', artist: 'The Killers', album: "Sam's Town", by: 'The Killers', duration: 246 })
    const { walk, imports } = store()
    await walk({ artist: 'The Killers', title: 'Read My Mind' })
    assert.deepEqual(imports.map((i) => i.id), ['own'])
    assert.deepEqual(fetched(), ['late', 'own'])
  })

  it('These Boots: Start Walkin\' is held, and Boots is the row', async () => {
    musicBrainz = MB_ANSWERS["Nancy Sinatra - These Boots Are Made for Walkin'"]!
    hits('track', [['walkin', "These Boots Are Made for Walkin' by Nancy Sinatra"]])
    copy('walkin', { title: "These Boots Are Made for Walkin'", artist: 'Nancy Sinatra', album: "Start Walkin' 1965-1976", by: 'Nancy Sinatra', duration: 165 })
    const { walk, imports } = store()
    await walk({ artist: 'Nancy Sinatra', title: "These Boots Are Made for Walkin'", album: 'Boots', durationMs: 165_000 })
    assert.deepEqual(imports.map((i) => i.id), ['walkin'])
    assert.equal(imports[0]!.rowTags?.album, 'Boots')
    assert.equal(imports[0]!.rowTags?.trackNumber, 5)
    assert.deepEqual(albumSearches(), ['Nancy Sinatra Boots'])
  })

  it('We Found Love: the row\'s album is real, and the album cut comes straight in', async () => {
    musicBrainz = MB_ANSWERS['Rihanna - We Found Love']!
    hits('track', [['album', 'We Found Love by Rihanna']])
    copy('album', { title: 'We Found Love', artist: 'Rihanna', album: 'Talk That Talk', by: 'Rihanna', duration: 215 })
    const { walk, imports } = store()
    await walk({ artist: 'Rihanna', title: 'We Found Love (feat. Calvin Harris)', album: 'Talk That Talk', durationMs: 215_200 })
    assert.deepEqual(imports.map((i) => i.id), ['album'])
    assert.equal(imports[0]!.rowTags, undefined)
    assert.deepEqual(albumSearches(), [])
  })

  it('Humming on a single: the album the song is on', async () => {
    musicBrainz = MB_ANSWERS['Turnover - Humming']!
    hits('track', [['single', 'Humming by Turnover'], ['pv', 'Humming by Turnover']])
    copy('single', { title: 'Humming', artist: 'Turnover', album: 'Humming', by: 'Turnover', duration: 238 })
    copy('pv', { title: 'Humming', artist: 'Turnover', album: 'Peripheral Vision', by: 'Turnover', duration: 238 })
    const { walk, imports } = store()
    await walk({ artist: 'Turnover', title: 'Humming', album: 'Humming - Single', durationMs: 238_500 })
    assert.deepEqual(imports.map((i) => i.id), ['pv'])
  })

  it('Humming with MusicBrainz down: the artist\'s own album is kept as it says, over the row', async () => {
    musicBrainz = 'down'
    hits('track', [['pv', 'Humming by Turnover']])
    copy('pv', { title: 'Humming', artist: 'Turnover', album: 'Peripheral Vision', by: 'Turnover', duration: 238 })
    const { walk, imports } = store()
    await walk({ artist: 'Turnover', title: 'Humming', album: 'Humming - Single', durationMs: 238_500 })
    assert.deepEqual(imports.map((i) => i.id), ['pv'])
    assert.equal(imports[0]!.rowTags, undefined, 'the single is not better than the album')
  })

  it('a live album on the row is what the row asked for', async () => {
    musicBrainz = MB_ANSWERS['Blur - Girls and Boys']!
    hits('track', [['live', 'Girls and Boys by Blur']])
    copy('live', { title: 'Girls and Boys', artist: 'Blur', album: 'Live at Wembley', by: 'Blur', duration: 291 })
    const { walk, imports } = store()
    await walk({ artist: 'Blur', title: 'Girls and Boys', album: 'Live at Wembley', durationMs: 291_000 })
    assert.deepEqual(imports.map((i) => i.id), ['live'])
    assert.equal(imports[0]!.rowTags, undefined)
    assert.deepEqual(albumSearches(), [])
  })

  it('the real album\'s door finds nothing and the search found nothing: the row\'s album is still a way in', async () => {
    musicBrainz = MB_ANSWERS['Dobie Gray - Drift Away']!
    put('search-qobuz-album.json', JSON.stringify([{ source: 'qobuz', media_type: 'album', id: 'uc', desc: 'Ultimate Collection: Dobie Gray by Dobie Gray' }]))
    albumPage('uc', 'Ultimate Collection: Dobie Gray', 'Dobie Gray', [{ id: 'u', title: 'Drift Away', duration: 237 }])
    const { walk, imports } = store()
    const r = await walk({ artist: 'Dobie Gray', title: 'Drift Away', album: 'Ultimate Collection: Dobie Gray', durationMs: 237_500 })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(imports.map((i) => i.id), ['u'])
    assert.equal(imports[0]!.rowTags?.album, 'Drift Away', 'and the row says the album it really came from')
    assert.deepEqual(albumSearches(), ['Dobie Gray Drift Away', 'Dobie Gray Ultimate Collection: Dobie Gray'])
  })
})

describe('an album request is not a song request', () => {
  it('asks MusicBrainz nothing', async () => {
    musicBrainz = MB_ANSWERS['Blur - Girls and Boys']!
    const { walk } = store()
    await walk({ artist: 'Blur', album: 'Parklife' })
    assert.deepEqual(musicBrainzAsked, [])
  })
})
