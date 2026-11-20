/**
 * Brief 261: Save goes by the Qobuz id the shop resolved, the way a pasted link
 * does, and walks as before on any doubt.
 *
 * The real `streamrip:download-by-query` handler, with only the outside world
 * faked (the harness of streamrip-lanes.test.ts): `rip` and `ffprobe` are small
 * scripts, HOME is a temp folder holding a streamrip config with a Qobuz login,
 * and fetch answers for Qobuz's track/get and album/get and Apple's lookup.
 */
import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, describe, mock, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { register } from 'node:module'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUNG_MS } from './wait-for.ts'

const userData = mkdtempSync(join(tmpdir(), 'jt-byid-userdata-'))
process.env.JT_USER_DATA = userData
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { registerStreamripStore } = await import('../streamrip-store/index.ts')
after(() => rmSync(userData, { recursive: true, force: true }))

const FAKE_RIP = `#!/bin/sh
echo "rip $*" >> "$FAKE_WORLD/calls.log"
if [ "$1" = "--version" ]; then echo "rip, version 2.1.0"; exit 0; fi
if [ "$1" = "search" ]; then echo "No search results found for query $8"; exit 0; fi
if [ -f "$FAKE_WORLD/rip-$8.fails" ]; then cat "$FAKE_WORLD/rip-$8.fails"; exit 1; fi
cp "$FAKE_WORLD/audio.bin" "$2/track.flac"
`
const FAKE_FFPROBE = `#!/bin/sh
cat "$FAKE_WORLD/probe.json"
`

const MONEY = { artist: 'Feedback Revival', title: 'Money', album: 'Money', durationMs: 143_000 }
const THE_FILE = { format: { duration: '142.6', tags: { title: 'Money', artist: 'Feedback Revival', album: 'Money', track: '1' } } }
const TRACK_GET = { title: 'Money', duration: 143, parental_warning: false, album: { title: 'Money', artist: { name: 'Feedback Revival' } } }
const ALBUM_GET = { title: 'Money', artist: { name: 'Feedback Revival' }, tracks_count: 1, media_count: 1, parental_warning: false, release_date_original: '2020-03-01', tracks: { items: [{ id: 777, title: 'Money', duration: 143, track_number: 1, media_number: 1, streamable: true, performer: { name: 'Feedback Revival' } }] } }
const APPLE_ALBUM = { results: [
  { wrapperType: 'collection', collectionId: 55, collectionName: 'Money', artistName: 'Feedback Revival', trackCount: 1, releaseDate: '2020-03-01T08:00:00Z', collectionExplicitness: 'notExplicit' },
  { wrapperType: 'track', kind: 'song', trackName: 'Money', artistName: 'Feedback Revival', collectionName: 'Money', trackNumber: 1, discNumber: 1, discCount: 1, trackTimeMillis: 143_000, trackExplicitness: 'notExplicit' },
] }

let world = ''
let home = ''
let qobuz: Record<string, unknown> = {}
const realFetch = globalThis.fetch
const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }
const put = (name: string, body: string | Uint8Array): void => writeFileSync(join(world, name), body)

const fakesDir = mkdtempSync(join(tmpdir(), 'jt-byid-fakes-'))
after(() => rmSync(fakesDir, { recursive: true, force: true }))
const fakes = new Map<string, string>()
function install(dir: string, name: string, script: string): void {
  mkdirSync(dir, { recursive: true })
  let fake = fakes.get(script)
  if (!fake) {
    fake = join(fakesDir, `fake-${fakes.size}`)
    writeFileSync(fake, script)
    chmodSync(fake, 0o755)
    try { execFileSync(fake, ['--version'], { cwd: fakesDir, env: { ...process.env, FAKE_WORLD: fakesDir }, stdio: 'ignore', timeout: HUNG_MS }) } catch { /* first run only */ }
    fakes.set(script, fake)
  }
  rmSync(join(dir, name), { force: true })
  linkSync(fake, join(dir, name))
}
const calls = (): string[] => existsSync(join(world, 'calls.log')) ? readFileSync(join(world, 'calls.log'), 'utf-8').split('\n').filter(Boolean) : []
const leftoverStaging = (): string[] => readdirSync(process.env.TMPDIR!).filter((n) => n.startsWith('jaketunes-rip-'))

interface Result { ok: boolean; via?: string; how?: string; fellBack?: string; outcome?: string; error?: string; matchDesc?: string; completion?: string }
function store() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const imported: string[] = []
  registerStreamripStore({
    ipc: { handle: (channel: string, fn: never) => { handlers.set(channel, fn) } },
    getMainWindow: () => null,
    importDownloaded: async (paths: string[]) => {
      imported.push(...paths)
      const { title } = JSON.parse(readFileSync(join(world, 'probe.json'), 'utf-8')).format.tags
      return paths.map(() => ({ title }))
    },
    mbThrottle: async () => {},
    mbUserAgent: 'jt-byid-test',
  } as never)
  return {
    imported,
    save: async (opts: Record<string, unknown>): Promise<Result> => await handlers.get('streamrip:download-by-query')!({}, opts) as Result,
  }
}

beforeEach(() => {
  world = mkdtempSync(join(tmpdir(), 'jt-byid-'))
  home = join(world, 'home')
  mkdirSync(join(home, 'Library', 'Application Support', 'streamrip'), { recursive: true })
  writeFileSync(join(home, 'Library', 'Application Support', 'streamrip', 'config.toml'), '[qobuz]\nuse_auth_token = true\napp_id = "123"\npassword_or_token = "test-token"\n[tidal]\n')
  mkdirSync(join(world, 'app-path'))
  mkdirSync(join(world, 'tmp'))
  process.env.HOME = home
  process.env.PATH = `${join(world, 'app-path')}:/usr/bin:/bin`
  process.env.TMPDIR = join(world, 'tmp')
  process.env.FAKE_WORLD = world
  put('audio.bin', new Uint8Array(100 * 1024))
  put('probe.json', JSON.stringify(THE_FILE))
  install(join(home, '.local', 'bin'), 'rip', FAKE_RIP)
  install(join(world, 'app-path'), 'ffprobe', FAKE_FFPROBE)
  qobuz = { 'track/get?track_id=777': TRACK_GET, 'album/get?album_id=alb1': ALBUM_GET }
  mock.method(console, 'warn', () => {})
  mock.method(console, 'log', () => {})
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const q = u.match(/qobuz\.com\/api\.json\/0\.2\/(.+?)&app_id=/)
    if (q) {
      const body = qobuz[q[1]]
      return body === undefined ? json({ status: 'error', code: 404, message: 'No result matching given argument' }, 404) : json(body)
    }
    if (u.includes('itunes.apple.com/lookup?id=55')) return json(APPLE_ALBUM)
    return new Response('', { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  mock.restoreAll()
  globalThis.fetch = realFetch
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(world, { recursive: true, force: true })
})

describe('a song by id', () => {
  test('goes straight to `rip id qobuz track`, with no search, and imports what the checks pass', async () => {
    const { save, imported } = store()
    const r = await save({ ...MONEY, qobuz: { id: '777', how: 'isrc' } })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.via, 'id')
    assert.equal(r.how, 'isrc')
    assert.equal(imported.length, 1)
    assert.ok(calls().some((c) => c.endsWith('id qobuz track 777')))
    assert.ok(!calls().some((c) => c.startsWith('rip search')), 'no search walk')
    assert.deepEqual(leftoverStaging(), [])
  })

  test('Qobuz’s own length says another recording: nothing downloads by id, and the walk runs', async () => {
    qobuz['track/get?track_id=777'] = { ...TRACK_GET, duration: 200 }
    const { save, imported } = store()
    const r = await save({ ...MONEY, qobuz: { id: '777', how: 'catalog' } })
    assert.equal(r.via, 'walk')
    assert.equal(r.fellBack, 'wrong-recording')
    assert.ok(!calls().some((c) => c.endsWith('id qobuz track 777')), 'never fetched')
    assert.ok(calls().some((c) => c.startsWith('rip search')), 'the walk searched')
    assert.equal(imported.length, 0)
  })

  test('the explicit rule: an explicit row and a copy Qobuz marks clean walks', async () => {
    const { save } = store()
    const r = await save({ ...MONEY, explicitSource: true, qobuz: { id: '777', how: 'catalog' } })
    assert.equal(r.via, 'walk')
    assert.equal(r.fellBack, 'explicit')
    assert.ok(!calls().some((c) => c.endsWith('id qobuz track 777')))
  })

  test('a copy on a compilation walks: the song’s own album is the walk’s to find', async () => {
    qobuz['track/get?track_id=777'] = { ...TRACK_GET, album: { title: 'Now 50', artist: { name: 'Various Artists' } } }
    const r = await store().save({ ...MONEY, album: undefined, qobuz: { id: '777', how: 'catalog' } })
    assert.equal(r.fellBack, 'compilation')
  })

  test('the downloaded file fails the judge: it is thrown away and the walk runs, with no second click', async () => {
    put('probe.json', JSON.stringify({ format: { duration: '200.0', tags: THE_FILE.format.tags } }))
    const { save, imported } = store()
    const r = await save({ ...MONEY, qobuz: { id: '777', how: 'catalog' } })
    assert.equal(r.via, 'walk')
    assert.equal(r.fellBack, 'judge')
    assert.ok(calls().some((c) => c.endsWith('id qobuz track 777')), 'it was fetched')
    assert.equal(imported.length, 0, 'and never imported')
    assert.deepEqual(leftoverStaging(), [])
  })

  test('an id Qobuz no longer has walks', async () => {
    const r = await store().save({ ...MONEY, qobuz: { id: '999', how: 'catalog' } })
    assert.equal(r.fellBack, 'gone')
  })

  test('a row with no clock (Apple’s cleaned one) walks', async () => {
    const r = await store().save({ ...MONEY, cleanedSource: true, qobuz: { id: '777', how: 'catalog' } })
    assert.equal(r.fellBack, 'no-clock')
  })

  test('a path-like id is no plan: the walk, as before', async () => {
    const r = await store().save({ ...MONEY, qobuz: { id: '../777', how: 'catalog' } })
    assert.equal(r.via, 'walk')
    assert.equal(r.fellBack, undefined)
  })
})

describe('an album by id', () => {
  const RECORD = { artist: 'Feedback Revival', album: 'Money', collectionId: 55, trackCount: 1 }
  test('the listing is held to the edition before a byte moves, then the files are', async () => {
    const { save, imported } = store()
    const r = await save({ ...RECORD, qobuz: { id: 'alb1', how: 'preflight' } })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.via, 'id')
    assert.equal(imported.length, 1)
    assert.ok(calls().some((c) => c.endsWith('id qobuz album alb1')))
    assert.ok(!calls().some((c) => c.startsWith('rip search')))
  })

  test('another edition’s listing (more songs) never downloads, and the walk runs', async () => {
    qobuz['album/get?album_id=alb1'] = { ...ALBUM_GET, tracks_count: 2, tracks: { items: [...ALBUM_GET.tracks.items, { id: 778, title: 'Bonus', duration: 100, track_number: 2, media_number: 1, streamable: true }] } }
    const r = await store().save({ ...RECORD, qobuz: { id: 'alb1', how: 'upc' } })
    assert.equal(r.via, 'walk')
    assert.equal(r.fellBack, 'listing')
    assert.ok(!calls().some((c) => c.endsWith('id qobuz album alb1')))
  })

  test('an explicit record and a clean listing walks', async () => {
    const r = await store().save({ ...RECORD, explicitSource: true, qobuz: { id: 'alb1', how: 'catalog' } })
    assert.equal(r.fellBack, 'explicit')
  })
})
