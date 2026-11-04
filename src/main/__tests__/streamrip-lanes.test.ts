/**
 * The desktop's fallback lanes, walked for real (Brief 224, JakeTunesMobile).
 *
 * On 2026-11-04 the log showed both lanes mostly failing: every Bandcamp fetch
 * since 10/22 was a bare `yt-dlp` the app could not find, and every PROVIDER
 * UNAVAILABLE was SoundCloud's dead search telling Jake to check the login.
 *
 * This runs the real `streamrip:download-by-query` handler. Only the outside
 * world is faked: `rip`, `yt-dlp` and `ffprobe` are small scripts, HOME is a temp
 * folder, PATH is shaped like the app's, and fetch answers for Bandcamp's search.
 * A missing program really is a missing program: execFile really says ENOENT.
 */
import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, describe, mock, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { register } from 'node:module'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { HUNG_MS } from './wait-for.ts'

// The store reaches state-dir.ts, which asks electron for userData. The same stub
// the headless scripts use; state-dir reads it once, at import.
const userData = mkdtempSync(join(tmpdir(), 'jt-lanes-userdata-'))
process.env.JT_USER_DATA = userData
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { registerStreamripStore } = await import('../streamrip-store/index.ts')
after(() => rmSync(userData, { recursive: true, force: true }))

// What streamrip 2.1.0 really prints when SoundCloud's search dies (stdout, exit 1,
// no results file), run on the MacBook on 2026-11-04.
const SOUNDCLOUD_CRASH = `│ es/streamrip/client/soundcloud.py:224 in _get_custom_id                      │
│ ❱ 224 │   │   assert url is not None                                         │
╰──────────────────────────────────────────────────────────────────────────────╯
AssertionError
`
const LOCKED_UPLOAD = `│ streamrip/client/soundcloud.py:120 in get_downloadable                        │
╰──────────────────────────────────────────────────────────────────────────────╯
KeyError: 'url'
`
const LOGIN_FAILED = 'streamrip.exceptions.AuthenticationError: Invalid credentials from qobuz\n'

const FAKE_RIP = `#!/bin/sh
echo "rip $*" >> "$FAKE_WORLD/calls.log"
if [ "$1" = "--version" ]; then echo "rip, version 2.1.0"; exit 0; fi
if [ "$1" = "search" ]; then
  # rip search -o <file> -n <n> <source> <type> <query>
  if [ -f "$FAKE_WORLD/search-$6.json" ]; then cp "$FAKE_WORLD/search-$6.json" "$3"; exit 0; fi
  if [ -f "$FAKE_WORLD/search-$6.fails" ]; then cat "$FAKE_WORLD/search-$6.fails"; exit 1; fi
  echo "No search results found for query $8"; exit 0
fi
# rip --folder <dir> --quality 4 --no-db --no-progress id <source> <type> <id>
if [ -f "$FAKE_WORLD/rip-$8.fails" ]; then cat "$FAKE_WORLD/rip-$8.fails"; exit 1; fi
cp "$FAKE_WORLD/audio.bin" "$2/track.flac"
`
// Like the real one, it re-encodes only when told to.
const FAKE_YT_DLP = `#!/bin/sh
echo "yt-dlp $*" >> "$FAKE_WORLD/calls.log"
if [ -f "$FAKE_WORLD/ytdlp.fails" ]; then cat "$FAKE_WORLD/ytdlp.fails" >&2; exit 1; fi
prev=""; tpl=""
for a in "$@"; do [ "$prev" = "-o" ] && tpl="$a"; prev="$a"; done
ext=mp3
case " $* " in *" --audio-format m4a "*) ext=m4a;; esac
cp "$FAKE_WORLD/audio.bin" "$(dirname "$tpl")/00 - Money.$ext"
`
const FAKE_FFPROBE = `#!/bin/sh
cat "$FAKE_WORLD/probe.json"
`

const MONEY = { artist: 'Feedback Revival', title: 'Money', durationMs: 143_000 }
const THE_RIGHT_FILE = { format: { duration: '142.6', tags: { title: 'Money', artist: 'Feedback Revival', album: 'Money' } } }
const THE_WRONG_LENGTH = { format: { duration: '200.0', tags: { title: 'Money', artist: 'Feedback Revival', album: 'Money' } } }
const ON_BANDCAMP = [{ type: 't', name: 'Money', band_name: 'Feedback Revival', item_url_path: 'https://feedbackrevival.bandcamp.com/track/money' }]
const hit = (source: string, id = '1', desc = 'Money by Feedback Revival') => [{ source, media_type: 'track', id, desc }]
// Compare editions: straight to this Bandcamp page, judged against this snapshot.
const THE_EDITION = {
  artist: 'Feedback Revival', album: 'Hell & High Water',
  sourceEdition: {
    provider: 'bandcamp', url: 'https://feedbackrevival.bandcamp.com/album/hell-high-water', title: 'Hell & High Water', artist: 'Feedback Revival',
    tracks: [{ title: 'Money', trackNumber: 1, durationSec: 143 }],
  },
}
const THE_EDITIONS_FILE = { format: { duration: '142.6', tags: { title: 'Money', artist: 'Feedback Revival', album: 'Hell & High Water', track: '1' } } }

let world = ''
let home = ''
let appPath = ''
let warned: string[] = []
let bandcampHits: unknown[] = []
const realFetch = globalThis.fetch
const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }

const put = (name: string, body: string | Uint8Array): void => writeFileSync(join(world, name), body)
// Each fake is written once, run once, and hard-linked into every test's world. A
// brand-new executable's first run is the slow one: macOS checks it, 277 ms against
// 5.5 ms for the next run at load ~290, and one has outlasted the store's 10 s for
// `rip --version` (2026-11-04). The check follows the file: a link is free, a copy pays again.
const fakesDir = mkdtempSync(join(tmpdir(), 'jt-lanes-fakes-'))
after(() => rmSync(fakesDir, { recursive: true, force: true }))
const fakes = new Map<string, string>()
function install(dir: string, name: string, script: string): void {
  mkdirSync(dir, { recursive: true })
  let fake = fakes.get(script)
  if (!fake) {
    fake = join(fakesDir, `fake-${fakes.size}`)
    writeFileSync(fake, script)
    chmodSync(fake, 0o755)
    try {
      execFileSync(fake, ['--version'], { cwd: fakesDir, env: { ...process.env, FAKE_WORLD: fakesDir }, stdio: 'ignore', timeout: HUNG_MS })
    } catch { /* the bad-interpreter fake, or nothing to copy: only the first run counts */ }
    fakes.set(script, fake)
  }
  rmSync(join(dir, name), { force: true })
  linkSync(fake, join(dir, name))
}
const pipxBin = (): string => join(home, '.local', 'bin')
const calls = (program: string): string[] => existsSync(join(world, 'calls.log'))
  ? readFileSync(join(world, 'calls.log'), 'utf-8').split('\n').filter((l) => l.startsWith(`${program} `))
  : []
const fetchArgs = (): string => calls('yt-dlp')[0] ?? ''

interface WalkResult { ok: boolean; imported?: number; outcome?: string; primary?: string; detail?: string; error?: string; matchDesc?: string; alternatives?: Array<{ provider: string }> }

function store() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const imported: string[] = []
  registerStreamripStore({
    ipc: { handle: (channel: string, fn: never) => { handlers.set(channel, fn) } },
    getMainWindow: () => null,
    // The real importer titles a track from its tags, and the album contract checks them.
    importDownloaded: async (paths: string[]) => {
      imported.push(...paths)
      const { title } = JSON.parse(readFileSync(join(world, 'probe.json'), 'utf-8')).format.tags
      return paths.map(() => ({ title }))
    },
    mbThrottle: async () => {},
    mbUserAgent: 'jt-lanes-test',
  } as never)
  return {
    imported,
    walk: async (opts: Record<string, unknown> = MONEY): Promise<WalkResult> =>
      await handlers.get('streamrip:download-by-query')!({}, opts) as WalkResult,
  }
}
const leftoverStaging = (): string[] => readdirSync(process.env.TMPDIR!).filter((n) => n.startsWith('jaketunes-'))

beforeEach(() => {
  world = mkdtempSync(join(tmpdir(), 'jt-lanes-'))
  home = join(world, 'home')
  appPath = join(world, 'app-path')
  mkdirSync(home)
  mkdirSync(appPath)
  mkdirSync(join(world, 'tmp'))
  process.env.HOME = home
  // What index.ts leaves a Finder-opened app with, minus Homebrew (which holds the
  // real yt-dlp on some machines; a test must never find that one).
  process.env.PATH = `${appPath}:/usr/bin:/bin`
  process.env.TMPDIR = join(world, 'tmp')
  process.env.FAKE_WORLD = world
  put('audio.bin', new Uint8Array(100 * 1024))
  put('probe.json', JSON.stringify(THE_RIGHT_FILE))
  install(pipxBin(), 'rip', FAKE_RIP)
  install(appPath, 'ffprobe', FAKE_FFPROBE)
  warned = []
  bandcampHits = []
  mock.method(console, 'warn', (...args: unknown[]) => { warned.push(args.join(' ')) })
  mock.method(console, 'log', () => {})
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes('bandcamp.com/api')) return new Response(JSON.stringify({ auto: { results: bandcampHits } }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('', { status: 404 })
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

describe('Bandcamp: finding yt-dlp', () => {
  test('the app opened normally finds the pipx yt-dlp, with ~/.local/bin nowhere on PATH', async () => {
    assert.ok(!process.env.PATH!.includes('.local'), 'the point of this test: the folder is not on PATH')
    install(pipxBin(), 'yt-dlp', FAKE_YT_DLP)
    bandcampHits = ON_BANDCAMP
    const { walk, imported } = store()
    const r = await walk()
    assert.equal(r.ok, true, r.error)
    assert.equal(r.outcome, 'imported')
    assert.equal(r.matchDesc, 'Money — Feedback Revival (Bandcamp stream)')
    assert.equal(imported.length, 1)
    assert.equal(calls('yt-dlp').length, 1, 'found on the first try')
  })

  test('homemini: yt-dlp from Homebrew, on PATH and not in ~/.local/bin, still works', async () => {
    install(appPath, 'yt-dlp', FAKE_YT_DLP)
    bandcampHits = ON_BANDCAMP
    const { walk, imported } = store()
    const r = await walk()
    assert.equal(r.outcome, 'imported', r.error)
    assert.equal(imported.length, 1)
  })

  test('a real yt-dlp failure keeps its own words, and Bandcamp has no login to send Jake to', async () => {
    install(pipxBin(), 'yt-dlp', FAKE_YT_DLP)
    put('ytdlp.fails', 'ERROR: [Bandcamp] money: Unable to download webpage: HTTP Error 503\n')
    bandcampHits = ON_BANDCAMP
    const r = await store().walk()
    assert.equal(r.outcome, 'provider-failed')
    assert.match(r.detail!, /HTTP Error 503/)
    assert.match(r.detail!, /Check the connection, then Retry\./)
    assert.doesNotMatch(r.detail!, /login/i)
  })

  test('yt-dlp ran and said nothing: still "produced nothing", because that is what happened', async () => {
    install(pipxBin(), 'yt-dlp', FAKE_YT_DLP)
    put('ytdlp.fails', '')
    bandcampHits = ON_BANDCAMP
    const r = await store().walk()
    assert.equal(r.outcome, 'provider-failed')
    assert.match(r.detail!, /Bandcamp fetch produced nothing \(exit 1\)/)
  })
})

describe('Bandcamp: a Mac with no yt-dlp (workmini)', () => {
  test('the song is not on Bandcamp: the missing program costs nothing, so it is not mentioned', async () => {
    const r = await store().walk()
    assert.equal(r.outcome, 'not-found')
    assert.doesNotMatch(r.detail!, /yt-dlp/)
    assert.equal(calls('yt-dlp').length, 0)
  })

  test('the song is on Bandcamp: it says the program is missing, how to get it, and not "produced nothing"', async () => {
    bandcampHits = ON_BANDCAMP
    const { walk, imported } = store()
    const r = await walk()
    assert.equal(r.ok, false)
    assert.equal(r.outcome, 'provider-failed', 'a match was found and could not be fetched; that is what a Retry is for')
    assert.equal(r.primary, 'Download failed')
    assert.match(r.detail!, /yt-dlp isn’t installed on this Mac/)
    assert.match(r.detail!, /Run: pipx install yt-dlp/)
    assert.match(r.detail!, /Fix that, then Retry\./)
    assert.doesNotMatch(r.detail!, /produced nothing/)
    assert.doesNotMatch(r.detail!, /Check the connection/)
    assert.equal(imported.length, 0)
    assert.deepEqual(leftoverStaging(), [], 'the empty staging folder is gone')
    assert.ok(warned.some((l) => l.includes('bandcamp stage: yt-dlp isn’t installed')), 'main.log says so too')
  })

  test('a pipx launcher whose Python is gone is not "not installed": pipx would answer "already installed"', async () => {
    install(pipxBin(), 'yt-dlp', '#!/nonexistent/python3.14\n')
    bandcampHits = ON_BANDCAMP
    const r = await store().walk()
    assert.equal(r.outcome, 'provider-failed')
    assert.match(r.detail!, /yt-dlp is installed but can’t start/)
    assert.match(r.detail!, /Run: pipx reinstall yt-dlp/)
    assert.match(r.detail!, /Fix that, then Retry\./)
    assert.doesNotMatch(r.detail!, /isn’t installed|produced nothing|Check the connection/)
  })

  test('Qobuz refused its candidates and Bandcamp could not be fetched: the verdict stands and the note says what was not tried', async () => {
    put('search-qobuz.json', JSON.stringify(hit('qobuz')))
    put('probe.json', JSON.stringify(THE_WRONG_LENGTH))
    bandcampHits = ON_BANDCAMP
    const r = await store().walk()
    assert.equal(r.outcome, 'exact-not-found')
    assert.match(r.detail!, /Bandcamp has a match that could not be fetched: yt-dlp isn’t installed on this Mac/)
  })

  test('workmini has no rip either: nothing on Bandcamp reads as the program, not as a login problem', async () => {
    rmSync(join(pipxBin(), 'rip'))
    const r = await store().walk()
    assert.equal(r.outcome, 'provider-unavailable')
    assert.match(r.detail!, /streamrip isn’t installed\. Run: pipx install streamrip/)
    assert.match(r.detail!, /Fix that, then Retry\./)
    assert.doesNotMatch(r.detail!, /login/i)
    assert.doesNotMatch(r.detail!, /SoundCloud wasn’t searched/, 'the same reason as Qobuz is not said twice')
  })

  test('workmini has no rip either, and Bandcamp has it: both programs are named', async () => {
    rmSync(join(pipxBin(), 'rip'))
    bandcampHits = ON_BANDCAMP
    const r = await store().walk()
    assert.equal(r.outcome, 'provider-failed')
    assert.match(r.detail!, /yt-dlp isn’t installed/)
    assert.match(r.detail!, /Qobuz wasn’t searched: streamrip isn’t installed/, 'installing only yt-dlp would bring 128k where Qobuz may be lossless')
    assert.doesNotMatch(r.detail!, /login/i)
  })
})

describe('Bandcamp: the file stays what it is', () => {
  test('the MP3 reaches the import as it was served: no re-encode', async () => {
    install(pipxBin(), 'yt-dlp', FAKE_YT_DLP)
    bandcampHits = ON_BANDCAMP
    const { walk, imported } = store()
    const r = await walk()
    assert.equal(r.outcome, 'imported', r.error)
    assert.equal(extname(imported[0]!), '.mp3')
    for (const flag of ['-x', '--extract-audio', '--audio-format', '--audio-quality', '--recode-audio', '--remux-video']) {
      assert.ok(!fetchArgs().split(' ').includes(flag), `yt-dlp was passed ${flag}: ${fetchArgs()}`)
    }
    assert.ok(fetchArgs().includes('--embed-metadata'), 'the judge and the import read the tags this writes')
  })

  test('a locked upload stays refused: --allow-unplayable-formats is never passed, anywhere', async () => {
    install(pipxBin(), 'yt-dlp', FAKE_YT_DLP)
    bandcampHits = ON_BANDCAMP
    await store().walk()
    assert.ok(!fetchArgs().includes('unplayable'), fetchArgs())
    const source = readFileSync(join(import.meta.dirname, '..', 'streamrip-store', 'index.ts'), 'utf-8')
    const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    assert.ok(!code.includes('--allow-unplayable-formats'), 'the flag is in the store’s code')
  })

  test('a 3-second MP3 is a track, not a stub', async () => {
    install(pipxBin(), 'yt-dlp', FAKE_YT_DLP)
    put('audio.bin', new Uint8Array(48 * 1024))   // 3 s at 128k
    bandcampHits = ON_BANDCAMP
    const { walk, imported } = store()
    const r = await walk()
    assert.equal(r.outcome, 'imported', r.error)
    assert.equal(imported.length, 1)
  })

  test('an empty file is still a stub', async () => {
    install(pipxBin(), 'yt-dlp', FAKE_YT_DLP)
    put('audio.bin', new Uint8Array(0))
    bandcampHits = ON_BANDCAMP
    const { walk, imported } = store()
    const r = await walk()
    assert.equal(r.outcome, 'provider-failed')
    assert.equal(imported.length, 0)
  })
})

describe('Compare editions and albums use the same lane', () => {
  test('a chosen Bandcamp edition arrives as the MP3 it was served as, from the pipx yt-dlp', async () => {
    install(pipxBin(), 'yt-dlp', FAKE_YT_DLP)
    put('probe.json', JSON.stringify(THE_EDITIONS_FILE))
    const { walk, imported } = store()
    const r = await walk(THE_EDITION)
    assert.equal(r.outcome, 'imported', r.detail ?? r.error)
    assert.equal(extname(imported[0]!), '.mp3')
    assert.ok(!fetchArgs().split(' ').includes('--audio-format'))
  })

  test('a chosen Bandcamp edition with no yt-dlp says that, not "produced nothing"', async () => {
    const r = await store().walk(THE_EDITION)
    assert.equal(r.outcome, 'provider-failed')
    assert.match(r.detail!, /could not be fetched: yt-dlp isn’t installed on this Mac/)
    assert.doesNotMatch(r.detail!, /produced nothing/)
  })

  test('an album that is nowhere names Qobuz and Bandcamp: albums never go to SoundCloud', async () => {
    const r = await store().walk({ artist: 'Feedback Revival', album: 'Hell & High Water' })
    assert.equal(r.outcome, 'not-found')
    assert.match(r.detail!, /on Qobuz or Bandcamp \(searched/)
    assert.equal(calls('rip').filter((l) => l.includes(' soundcloud ')).length, 0)
  })
})

describe('Bandcamp: a search that did not answer is not "nothing on Bandcamp"', () => {
  const challenged = (): void => {
    globalThis.fetch = (async () => new Response('<!DOCTYPE html><title>Client Challenge</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch
  }

  test('a bot-check page: the verdict stands, Bandcamp is not claimed, and the note says it may still have the song', async () => {
    challenged()
    const r = await store().walk()
    assert.equal(r.outcome, 'not-found')
    assert.match(r.detail!, /on Qobuz or SoundCloud \(searched/)
    assert.match(r.detail!, /Bandcamp wasn’t searched \(a web page instead of results\), so it may still have this\./)
    assert.ok(warned.some((l) => l.includes('bandcamp search: no answer (a web page instead of results)')), 'main.log can count these')
  })

  test('with SoundCloud dead as well, only Qobuz is claimed', async () => {
    challenged()
    put('search-soundcloud.fails', SOUNDCLOUD_CRASH)
    const r = await store().walk()
    assert.equal(r.outcome, 'not-found')
    assert.match(r.detail!, /on Qobuz \(searched/)
  })

  test('an HTTP error and a dropped connection say so too', async () => {
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch
    assert.match((await store().walk()).detail!, /Bandcamp wasn’t searched \(HTTP 503\)/)
    globalThis.fetch = (async () => { throw new Error('fetch failed') }) as typeof fetch
    assert.match((await store().walk()).detail!, /Bandcamp wasn’t searched \(fetch failed\)/)
  })

  test('a real zero stays a real zero', async () => {
    const r = await store().walk()
    assert.equal(r.outcome, 'not-found')
    assert.match(r.detail!, /on Qobuz, Bandcamp or SoundCloud/)
    assert.doesNotMatch(r.detail!, /Bandcamp wasn’t searched/)
    assert.ok(warned.some((l) => l.includes('bandcamp: 0 results')))
  })
})

describe('SoundCloud: a dead lane is the lane’s news, not the song’s verdict', () => {
  test('nothing anywhere: Not found, as if the lane had answered; it does not read as a login problem', async () => {
    const quiet = await store().walk()
    assert.equal(quiet.outcome, 'not-found')
    assert.match(quiet.detail!, /on Qobuz, Bandcamp or SoundCloud/, 'the lane answered, so it may be named')

    put('search-soundcloud.fails', SOUNDCLOUD_CRASH)
    warned = []
    const r = await store().walk()
    assert.equal(r.outcome, quiet.outcome)
    assert.equal(r.primary, quiet.primary)
    assert.doesNotMatch(r.detail!, /Check the connection or the login/)
    assert.doesNotMatch(r.detail!, /in Setup/)
    assert.match(r.detail!, /on Qobuz or Bandcamp \(searched/, 'SoundCloud did not answer, so it is not claimed')
    assert.match(r.detail!, /SoundCloud wasn’t searched: streamrip’s search crashes on what SoundCloud serves now \(AssertionError\)\. That isn’t your connection or your login/)
    assert.ok(warned.some((l) => l.startsWith('[download] NOT FOUND')), `main.log: ${warned.join(' / ')}`)
    assert.ok(!warned.some((l) => l.includes('PROVIDER UNAVAILABLE')))
  })

  test('Qobuz refused what it had: Exact version not found stands', async () => {
    put('search-qobuz.json', JSON.stringify(hit('qobuz')))
    put('probe.json', JSON.stringify(THE_WRONG_LENGTH))
    const quiet = await store().walk()
    assert.equal(quiet.outcome, 'exact-not-found')

    put('search-soundcloud.fails', SOUNDCLOUD_CRASH)
    const r = await store().walk()
    assert.equal(r.outcome, quiet.outcome)
    assert.equal(r.primary, quiet.primary)
    assert.match(r.detail!, /runs 3:20, wanted 2:23/)
    assert.match(r.detail!, /SoundCloud wasn’t searched/)
  })

  test('a real Qobuz outage still is one: it asks for the login', async () => {
    put('search-qobuz.fails', LOGIN_FAILED)
    put('search-soundcloud.fails', SOUNDCLOUD_CRASH)
    const r = await store().walk()
    assert.equal(r.outcome, 'provider-unavailable')
    assert.match(r.detail!, /Invalid credentials from qobuz/)
    assert.match(r.detail!, /Check the connection or the login in Setup, then Retry\./)
    assert.match(r.detail!, /SoundCloud wasn’t searched: streamrip’s search crashes/)
  })

  test('a search that dies in silence names no login: streamrip has none for SoundCloud', async () => {
    put('search-soundcloud.fails', '')
    const r = await store().walk()
    assert.equal(r.outcome, 'not-found')
    assert.match(r.detail!, /SoundCloud wasn’t searched: No results \(exit 1\)\./)
    assert.doesNotMatch(r.detail!, /login/i)
  })

  test('its hits could not be fetched: Not found stands, and the note says why', async () => {
    put('search-soundcloud.json', JSON.stringify(hit('soundcloud', '9')))
    put('rip-soundcloud.fails', LOCKED_UPLOAD)
    const r = await store().walk()
    assert.equal(r.outcome, 'not-found')
    assert.match(r.detail!, /SoundCloud has a match that could not be fetched: KeyError: 'url'\./)
    assert.doesNotMatch(r.detail!, /Check the connection/)
    assert.equal(calls('rip').filter((l) => l.includes(' id soundcloud ')).length, 2, 'stageRip still retries once')
  })

  test('a transfer that dies in silence names no login either', async () => {
    put('search-soundcloud.json', JSON.stringify(hit('soundcloud', '9')))
    put('rip-soundcloud.fails', '')
    const r = await store().walk()
    assert.equal(r.outcome, 'not-found')
    assert.match(r.detail!, /streamrip downloaded nothing \(exit 1\)\./)
    assert.doesNotMatch(r.detail!, /login/i)
  })

  test('a Qobuz transfer that died is not forgotten when SoundCloud runs after it', async () => {
    put('search-qobuz.json', JSON.stringify(hit('qobuz')))
    put('rip-qobuz.fails', 'ClientConnectorError: Cannot connect to host streaming.qobuz.com\n')
    put('search-soundcloud.json', JSON.stringify(hit('soundcloud', '9')))
    put('rip-soundcloud.fails', LOCKED_UPLOAD)
    const r = await store().walk()
    assert.equal(r.outcome, 'provider-failed')
    assert.match(r.detail!, /the transfer failed: ClientConnectorError: Cannot connect to host streaming\.qobuz\.com/)
    assert.match(r.detail!, /Check the connection or the service login, then Retry\./)
    assert.match(r.detail!, /SoundCloud has a match that could not be fetched/)
  })

  test('a file it did deliver is judged like any other: that one may decide the verdict', async () => {
    put('search-soundcloud.json', JSON.stringify(hit('soundcloud', '9')))
    put('probe.json', JSON.stringify(THE_WRONG_LENGTH))
    const r = await store().walk()
    assert.equal(r.outcome, 'exact-not-found')
    assert.deepEqual(r.alternatives?.map((a) => a.provider), ['soundcloud'])
  })

  test('the file it delivers is still imported when the judge says so', async () => {
    put('search-soundcloud.json', JSON.stringify(hit('soundcloud', '9')))
    const { walk, imported } = store()
    const r = await walk()
    assert.equal(r.outcome, 'imported', r.error)
    assert.equal(imported.length, 1)
  })
})
