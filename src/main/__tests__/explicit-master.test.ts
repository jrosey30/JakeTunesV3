/**
 * Only this recording can prove an explicit master exists.
 *
 * The clean-version gate asked whether ANY top hit was flagged explicit, and when one
 * was it refused every hit flagged clean. So a live cut threw out the studio copies, and
 * a Deluxe threw out the edition Jake picked. main.log, all failed downloads:
 *   "Can't You Hear Me Knocking"   explicit-first: kept 1, refused clean 5   (2026-11-01)
 *   "I Got Friends"                explicit-first: kept 2, refused clean 1   (2026-10-22)
 *   "Ants From Up There"           explicit-first: kept 1, refused clean 1   (2026-10-31)
 *   "Fancy Footwork"               explicit-first: kept 1, refused clean 1   (2026-10-12)
 *
 * The walk tests run the real `streamrip:download-by-query` handler. Only the outside
 * world is faked: `rip` and `ffprobe` are small scripts, HOME is a temp folder, and fetch
 * answers for Qobuz. The flags in these worlds are what the log and Brief 221 §7 imply:
 * nobody has asked Qobuz, so the real flags on these exact tracks are not known.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRequestedRecording, judgeHitsByMeta } from '../exact-recording.ts'
import { isQobuzNoSuchItem, qobuzTrackMetaOf, titleWithVersion, type QobuzTrackMeta } from '../streamrip-match.ts'

// The store reaches state-dir.ts, which asks electron for userData. The same stub the
// headless scripts use; state-dir reads it once, at import.
const userData = mkdtempSync(join(tmpdir(), 'jt-explicit-userdata-'))
process.env.JT_USER_DATA = userData
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { registerStreamripStore } = await import('../streamrip-store/index.ts')
after(() => rmSync(userData, { recursive: true, force: true }))

const hit = (id: string, desc: string) => ({ id, desc })

describe('judgeHitsByMeta: what Qobuz says, before a byte moves', () => {
  const req = (over: Parameters<typeof buildRequestedRecording>[0] = {}) => buildRequestedRecording({ artist: 'Future', title: 'Mask Off', ...over })
  const judge = (r: ReturnType<typeof req>, hits: ReturnType<typeof hit>[], meta: Record<string, QobuzTrackMeta>, gone: string[] = []) =>
    judgeHitsByMeta(r, hits, new Map(Object.entries(meta)), new Set(gone))
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => hit(id, 'Mask Off by Future'))
  const ids = (hs: Array<{ id: string }>): string[] => hs.map((h) => h.id)

  test('Mask Off: five identical summaries, told apart by what Qobuz says', () => {
    const v = judge(req({ durationMs: 204_000 }), five, {
      a: { parentalWarning: false, durationSec: 204, album: 'FUTURE' },
      b: { parentalWarning: true, durationSec: 258, album: 'Mask Off', version: 'Remix' },
      c: { parentalWarning: true, durationSec: 258, album: 'FUTURE' },
      d: { parentalWarning: true, durationSec: 204, album: 'FUTURE', version: 'Album Version' },
    }, ['e'])
    assert.deepEqual(ids(v.kept), ['d'], 'the explicit album cut')
    assert.deepEqual(ids(v.refusedClean), ['a'], 'the clean edit')
    assert.deepEqual(v.wrongRecording.map((r) => r.hit.id), ['b', 'c'], 'a version by name, a version by its clock')
    assert.deepEqual(ids(v.gone), ['e'])
    assert.equal(v.explicitMaster, true)
  })

  test('another recording cannot prove a master: live by version, live by album, a remix, a show, a cover act', () => {
    const song = () => req()
    for (const other of [
      { parentalWarning: true, version: 'Live' },
      { parentalWarning: true, album: 'Live at the Forum' },
      { parentalWarning: true, version: 'Savage Gary Remix' },
      { parentalWarning: true, album: 'Later... with Jools Holland' },
      { parentalWarning: true, album: 'Mask Off (Future Tribute)' },
    ] satisfies QobuzTrackMeta[]) {
      const v = judge(song(), [hit('other', 'Mask Off by Future'), hit('real', 'Mask Off by Future')], { other, real: { parentalWarning: false, album: 'FUTURE' } })
      assert.deepEqual(ids(v.kept), ['real'], JSON.stringify(other))
      assert.deepEqual(v.wrongRecording.map((r) => r.hit.id), ['other'], JSON.stringify(other))
      assert.equal(v.explicitMaster, false, JSON.stringify(other))
      assert.deepEqual(v.refusedClean, [])
    }
  })

  test('a length that fits nothing cannot prove one either, and a row with no length does not ask', () => {
    const hits = [hit('long', 'Mask Off by Future'), hit('real', 'Mask Off by Future')]
    const meta = { long: { parentalWarning: true, durationSec: 258 }, real: { parentalWarning: false, durationSec: 204 } }
    assert.equal(judge(req({ durationMs: 204_000 }), hits, meta).explicitMaster, false)
    assert.equal(judge(req(), hits, meta).explicitMaster, true)
  })

  test('a version the request named is this recording', () => {
    const v = judge(req({ title: 'Mask Off (Remix)' }), [hit('r', 'Mask Off by Future'), hit('c', 'Mask Off by Future')], {
      r: { parentalWarning: true, version: 'Remix', album: 'Mask Off (Remix)' },
      c: { parentalWarning: false, version: 'Remix', album: 'Mask Off (Remix)' },
    })
    assert.deepEqual(ids(v.kept), ['r'])
    assert.deepEqual(ids(v.refusedClean), ['c'])
  })

  test('the whole title decides, not the summary streamrip cut at 50 characters', () => {
    const remix = "Don't Stop 'Til You Get Enough (Gigamesh Remix Short Edit)"
    const v = judge(req({ artist: 'Michael Jackson', title: remix }), [hit('1', `${remix.slice(0, 50)} by Michael Jackson`)], { 1: { title: remix, album: 'Remixed' } })
    assert.deepEqual(ids(v.kept), ['1'])
    assert.deepEqual(v.wrongRecording, [])
  })

  test('with no title in the answer, the summary\'s; the version goes in either way', () => {
    const v = judge(req(), [hit('1', 'Mask Off by Future')], { 1: { version: 'Live' } })
    assert.match(v.wrongRecording[0]?.verdict.reason ?? '', /Mask Off \(Live\)/)
  })

  test('no answer passes through unjudged, and proves nothing', () => {
    const v = judge(req(), five, {})
    assert.deepEqual(ids(v.kept), ids(five))
    assert.equal(v.explicitMaster, false)
  })

  test('a gone hit proves nothing, flag or no flag', () => {
    const v = judge(req(), [hit('a', 'Mask Off by Future'), hit('b', 'Mask Off by Future')], { a: { parentalWarning: true }, b: { parentalWarning: false } }, ['a'])
    assert.deepEqual(ids(v.gone), ['a'])
    assert.deepEqual(ids(v.kept), ['b'])
    assert.equal(v.explicitMaster, false)
  })

  describe('the explicit axis', () => {
    const two = [hit('x', 'Mask Off by Future'), hit('y', 'Mask Off by Future')]

    test('a record with no explicit edition anywhere still downloads', () => {
      const v = judge(req(), two, { x: { parentalWarning: false }, y: { parentalWarning: false } })
      assert.deepEqual(ids(v.kept), ['x', 'y'])
      assert.deepEqual(v.refusedClean, [])
      assert.equal(v.explicitMaster, false)
    })

    test('an explicit row refuses every clean hit, and the caller fails loudly', () => {
      const v = judge(req({ explicitSource: true }), two, { x: { parentalWarning: false }, y: { parentalWarning: false } })
      assert.deepEqual(v.kept, [])
      assert.deepEqual(ids(v.refusedClean), ['x', 'y'])
      assert.equal(v.explicitMaster, true)
    })

    test('a hit nobody flagged stays either way', () => {
      const v = judge(req(), [...two, hit('z', 'Mask Off by Future')], { x: { parentalWarning: false }, y: { parentalWarning: true }, z: {} })
      assert.deepEqual(ids(v.kept), ['y', 'z'])
      assert.deepEqual(ids(v.refusedClean), ['x'])
    })

    test('a clean request is not refused for being clean', () => {
      const v = judge(req({ cleanRequested: true }), two, { x: { parentalWarning: false }, y: { parentalWarning: true } })
      assert.equal(v.explicitMaster, false)
      assert.deepEqual(ids(v.kept), ['x', 'y'])
    })

    test('A Bay Bay: a clean edit on an explicit album, beside an explicit copy on Qobuz, is refused', () => {
      const v = judge(req({ artist: 'Hurricane Chris', title: 'A Bay Bay' }), [hit('single', 'A Bay Bay by Hurricane Chris'), hit('album', 'A Bay Bay by Hurricane Chris')], {
        single: { parentalWarning: false, albumParentalWarning: true, version: 'Single Version', album: '51/50 Ratchet' },
        album: { parentalWarning: true, albumParentalWarning: true, album: '51/50 Ratchet' },
      })
      assert.deepEqual(ids(v.refusedClean), ['single'])
      assert.deepEqual(ids(v.kept), ['album'])
      assert.deepEqual(v.nothingToCensor, [])
    })

    test('Express Yourself: flagged clean on an explicit album, and only the row says explicit: nothing to censor', () => {
      const v = judge(req({ artist: 'N.W.A', title: 'Express Yourself', explicitSource: true }), [hit('edited', 'Express Yourself by N.W.A'), hit('album', 'Express Yourself by N.W.A')], {
        edited: { parentalWarning: false, albumParentalWarning: false, album: 'Straight Outta Compton' },
        album: { parentalWarning: false, albumParentalWarning: true, album: 'Straight Outta Compton' },
      })
      assert.deepEqual(ids(v.kept), ['album'])
      assert.deepEqual(ids(v.nothingToCensor), ['album'])
      assert.deepEqual(ids(v.refusedClean), ['edited'])
    })

    test('with no master at all, a clean flag on an explicit album needs no excuse', () => {
      const v = judge(req(), two, { x: { parentalWarning: false, albumParentalWarning: true } })
      assert.deepEqual(v.nothingToCensor, [])
      assert.deepEqual(ids(v.kept), ['x', 'y'])
    })

    test('a clean flag with no album flag is refused: nobody said otherwise', () => {
      const v = judge(req({ explicitSource: true }), two, { x: { parentalWarning: false }, y: { parentalWarning: false, albumParentalWarning: false } })
      assert.deepEqual(ids(v.refusedClean), ['x', 'y'])
    })
  })
})

describe('reading what Qobuz answered', () => {
  test('a track/get answer, field by field', () => {
    assert.deepEqual(qobuzTrackMetaOf({ title: ' Mask Off ', parental_warning: true, duration: 204, version: 'Album Version', album: { title: 'FUTURE', parental_warning: false } }), {
      title: 'Mask Off', parentalWarning: true, albumParentalWarning: false, durationSec: 204, album: 'FUTURE', version: 'Album Version',
    })
  })

  test('absent or the wrong type stays unknown, never a verdict', () => {
    assert.deepEqual(qobuzTrackMetaOf({ title: 7, parental_warning: 'yes', duration: '204', version: 3, album: { title: 5, parental_warning: 'no' } }), {
      title: undefined, parentalWarning: undefined, albumParentalWarning: undefined, durationSec: undefined, album: undefined, version: null,
    })
    assert.deepEqual(qobuzTrackMetaOf({}), { title: undefined, parentalWarning: undefined, albumParentalWarning: undefined, durationSec: undefined, album: undefined, version: null })
  })

  test('only Qobuz\'s own words mean the item is gone', () => {
    assert.equal(isQobuzNoSuchItem({ status: 'error', code: 404, message: 'No result matching given argument' }), true)
    assert.equal(isQobuzNoSuchItem({ message: 'Route not found' }), false)
    assert.equal(isQobuzNoSuchItem({}), false)
    assert.equal(isQobuzNoSuchItem(null), false)
    assert.equal(isQobuzNoSuchItem({ message: 7 }), false)
  })

  test('streamrip writes the version into the title unless the title already says it', () => {
    assert.equal(titleWithVersion('We Found Love', 'Chuckie Extended Remix'), 'We Found Love (Chuckie Extended Remix)')
    assert.equal(titleWithVersion('We Found Love (Chuckie Extended Remix)', 'Chuckie Extended Remix'), 'We Found Love (Chuckie Extended Remix)')
    assert.equal(titleWithVersion('We Found Love', null), 'We Found Love')
    assert.equal(titleWithVersion('We Found Love', undefined), 'We Found Love')
    assert.equal(titleWithVersion('We Found Love', '  '), 'We Found Love')
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
n=1
[ -f "$FAKE_WORLD/files-$id" ] && n=$(cat "$FAKE_WORLD/files-$id")
i=1
while [ "$i" -le "$n" ]; do cp "$FAKE_WORLD/audio.bin" "$2/$id-$i.flac"; i=$((i+1)); done
`
// Each hit's files carry that hit's tags.
const FAKE_FFPROBE = `#!/bin/sh
for f; do :; done
b=$(basename "$f" .flac)
cat "$FAKE_WORLD/probe-\${b%-*}.json"
`

/** What Qobuz answers for an id: the JSON, or how it fails to answer. */
type Answer = Record<string, unknown> | 'gone' | 'timeout' | 'gateway' | 'server error'

// The programs live once for the whole file and each runs once before any test. macOS can
// stall the first run of a new executable for seconds, past the 10 s the store gives `rip
// --version`, and the walk then reports streamrip missing: a test that fails at random.
const home = mkdtempSync(join(tmpdir(), 'jt-explicit-home-'))
const appPath = join(home, 'app-path')
after(() => rmSync(home, { recursive: true, force: true }))

let world = ''
let answers: Record<string, Answer> = {}
let qobuzCalls: Array<{ url: string; init?: RequestInit }> = []
const realFetch = globalThis.fetch
const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }

const put = (name: string, body: string | Uint8Array): void => writeFileSync(join(world, name), body)
function install(dir: string, name: string, script: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), script)
  chmodSync(join(dir, name), 0o755)
}
/** The ids `rip` was told to fetch, in order. */
const fetched = (): string[] => (existsSync(join(world, 'calls.log')) ? readFileSync(join(world, 'calls.log'), 'utf-8').split('\n') : [])
  .filter((l) => l.startsWith('rip --folder'))
  .map((l) => l.split(' ').at(-1)!)
const hits = (type: 'track' | 'album', rows: Array<[id: string, desc: string]>): void =>
  put(`search-qobuz-${type}.json`, JSON.stringify(rows.map(([id, desc]) => ({ source: 'qobuz', media_type: type, id, desc }))))
const tags = (id: string, t: { title: string; artist: string; album: string; duration?: number }): void =>
  put(`probe-${id}.json`, JSON.stringify({ format: { duration: String(t.duration ?? 200), tags: { title: t.title, artist: t.artist, album: t.album } } }))

interface WalkResult { ok: boolean; imported?: number; outcome?: string; error?: string; matchDesc?: string; alternatives?: Array<{ provider: string; desc: string; reason: string }> }

function store() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const imported: string[] = []
  registerStreamripStore({
    ipc: { handle: (channel: string, fn: never) => { handlers.set(channel, fn) } },
    getMainWindow: () => null,
    importDownloaded: async (paths: string[]) => {
      imported.push(...paths)
      return paths.map((p) => {
        const id = p.split('/').at(-1)!.replace(/-\d+\.flac$/, '')
        return { title: JSON.parse(readFileSync(join(world, `probe-${id}.json`), 'utf-8')).format.tags.title }
      })
    },
    mbThrottle: async () => {},
    mbUserAgent: 'jt-explicit-test',
  } as never)
  const importedIds = (): string[] => imported.map((p) => p.split('/').at(-1)!.replace(/-\d+\.flac$/, ''))
  return {
    importedIds,
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
  execFileSync(join(appPath, 'ffprobe'), [join(home, 'warm-1.flac')], { ...warm, env: { ...warm.env, FAKE_WORLD: home } })
})

beforeEach(() => {
  world = mkdtempSync(join(tmpdir(), 'jt-explicit-'))
  mkdirSync(join(world, 'tmp'))
  process.env.HOME = home
  process.env.PATH = `${appPath}:/usr/bin:/bin`
  process.env.TMPDIR = join(world, 'tmp')
  process.env.FAKE_WORLD = world
  put('audio.bin', new Uint8Array(100 * 1024))
  answers = {}
  qobuzCalls = []
  mock.method(console, 'warn', () => {})
  mock.method(console, 'log', () => {})
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (u.includes('qobuz.com/api.json')) {
      qobuzCalls.push({ url: u, init })
      const id = /_id=([^&]+)/.exec(u)?.[1] ?? ''
      const answer = answers[decodeURIComponent(id)]
      if (answer === undefined || answer === 'server error') return json({ status: 'error' }, 500)
      if (answer === 'timeout') throw new DOMException('timed out', 'TimeoutError')
      if (answer === 'gateway') return new Response('<html>Not Found</html>', { status: 404 })
      if (answer === 'gone') return json({ status: 'error', code: 404, message: 'No result matching given argument' }, 404)
      return json(answer)
    }
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

describe('the walk, a song: the failures in main.log', () => {
  const STONES = { artist: 'The Rolling Stones', title: "Can't You Hear Me Knocking", durationMs: 434_600 }
  const stonesHit = "Can't You Hear Me Knocking by The Rolling Stones"
  const studioTags = { title: "Can't You Hear Me Knocking", artist: 'The Rolling Stones', album: 'Sticky Fingers', duration: 434 }

  test("Can't You Hear Me Knocking: a live cut's flag throws out nothing, and costs no fetch", async () => {
    // kept 1, refused clean 5, and then three live cuts staged and refused (2026-11-01).
    const ids = ['live1', 'studio1', 'studio2', 'studio3', 'studio4', 'studio5', 'live2', 'live3']
    hits('track', ids.map((id) => [id, stonesHit]))
    answers.live1 = { parental_warning: true, version: 'Live', duration: 502, album: { title: 'Flashpoint' } }
    for (const id of ['studio1', 'studio2', 'studio3', 'studio4', 'studio5']) answers[id] = { parental_warning: false, duration: 434, album: { title: 'Sticky Fingers' } }
    tags('studio1', studioTags)
    const { walk, importedIds } = store()
    const r = await walk(STONES)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['studio1'])
    assert.deepEqual(importedIds(), ['studio1'])
  })

  test('wrong recordings cost no try: the studio copy is reached with every hit before it live', async () => {
    // The walk fetches three. Before, these three filled it, whatever the flags said.
    const ids = ['liveA', 'liveB', 'liveC', 'studio']
    hits('track', ids.map((id) => [id, stonesHit]))
    answers.liveA = { parental_warning: false, version: 'Live', album: { title: 'Flashpoint' } }
    answers.liveB = { parental_warning: true, album: { title: 'Live at the Checkerboard Lounge' } }
    answers.liveC = { parental_warning: true, duration: 502, album: { title: 'Live Licks (Live Licks Tour, 2009 Remast. Digital Version)' } }
    answers.studio = { parental_warning: false, duration: 434, album: { title: 'Sticky Fingers' } }
    tags('studio', studioTags)
    const { walk, importedIds } = store()
    const r = await walk(STONES)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['studio'])
    assert.deepEqual(importedIds(), ['studio'])
  })

  test('I Got Friends: a remix and a live version do not refuse the album cut', async () => {
    // kept 2, refused clean 1, and then the remix and the live version staged and refused (2026-10-22).
    hits('track', [['remix', 'I Got Friends by Warmduscher'], ['audiotree', 'I Got Friends by Warmduscher'], ['album', 'I Got Friends by Warmduscher']])
    answers.remix = { parental_warning: true, version: 'Savage Gary Remix', album: { title: 'I Got Friends (Remixes)' } }
    answers.audiotree = { parental_warning: true, version: 'Audiotree Live version', album: { title: 'Warmduscher on Audiotree Live' } }
    answers.album = { parental_warning: false, album: { title: 'Whale City' } }
    tags('album', { title: 'I Got Friends', artist: 'Warmduscher', album: 'Whale City' })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'Warmduscher', title: 'I Got Friends' })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['album'])
    assert.deepEqual(importedIds(), ['album'])
  })

  test('everything another recording: no fetch at all, and the verdict says what it found', async () => {
    hits('track', [['a', 'Song by Band'], ['b', 'Song by Band']])
    answers.a = { parental_warning: true, version: 'Live' }
    answers.b = { parental_warning: false, version: 'Club Remix' }
    const r = await store().walk({ artist: 'Band', title: 'Song' })
    assert.deepEqual(fetched(), [])
    assert.equal(r.outcome, 'exact-not-found')
    assert.deepEqual(r.alternatives?.map((a) => a.reason), ['is tagged “Song (Live)” (live)', 'is tagged “Song (Club Remix)” (club)'])
  })

  test('a long title the summary cut at 50 characters is not refused for it', async () => {
    const remix = "Don't Stop 'Til You Get Enough (Gigamesh Remix Short Edit)"
    hits('track', [['1', `${remix.slice(0, 50)} by Michael Jackson`]])
    answers['1'] = { title: remix, album: { title: 'Off the Wall (Remixed)' } }
    tags('1', { title: remix, artist: 'Michael Jackson', album: 'Off the Wall (Remixed)' })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'Michael Jackson', title: remix })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(importedIds(), ['1'])
  })
})

describe('the walk, a song: what the gate is still for', () => {
  const MASK = { artist: 'Future', title: 'Mask Off' }
  const maskHit = 'Mask Off by Future'
  const maskTags = { title: 'Mask Off', artist: 'Future', album: 'FUTURE' }

  test("Sky's the Limit: the edit has clean-looking tags at Apple's [Amended] length, and only its flag tells (Brief 221 §7)", async () => {
    const q = "Sky's the Limit (feat. 112) by The Notorious B.I.G."
    hits('track', [['44738489', q], ['18916878', q]])
    answers['44738489'] = { parental_warning: false, duration: 277, album: { title: 'Life After Death' } }
    answers['18916878'] = { parental_warning: true, duration: 329, album: { title: 'Life After Death' } }
    tags('18916878', { title: "Sky's the Limit (feat. 112)", artist: 'The Notorious B.I.G.', album: 'Life After Death', duration: 329.4 })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'The Notorious B.I.G.', title: "Sky's the Limit (feat. 112) [Amended]", durationMs: 277_100, cleanedSource: true })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['18916878'])
    assert.deepEqual(importedIds(), ['18916878'])
  })

  test('a record with no explicit edition anywhere still downloads', async () => {
    hits('track', [['a', maskHit], ['b', maskHit]])
    answers.a = answers.b = { parental_warning: false, album: { title: 'FUTURE' } }
    tags('a', maskTags)
    const { walk, importedIds } = store()
    assert.equal((await walk(MASK)).outcome, 'imported')
    assert.deepEqual(importedIds(), ['a'])
  })

  test('an explicit row with every hit clean fails loudly, and nothing moves', async () => {
    hits('track', [['a', maskHit], ['b', maskHit]])
    answers.a = answers.b = { parental_warning: false, album: { title: 'FUTURE', parental_warning: false } }
    const r = await store().walk({ ...MASK, explicitSource: true })
    assert.deepEqual(fetched(), [])
    assert.equal(r.outcome, 'exact-not-found')
    assert.match(r.error ?? '', /only carries the CLEAN edition of this track \(2 candidates refused\)/)
    assert.deepEqual(r.alternatives?.map((a) => a.reason), ['is the clean edition; the explicit record was asked for', 'is the clean edition; the explicit record was asked for'])
  })

  test("Express Yourself: an explicit row, and the track on the explicit album has nothing to censor", async () => {
    hits('track', [['edited', 'Express Yourself by N.W.A'], ['album', 'Express Yourself by N.W.A']])
    answers.edited = { parental_warning: false, album: { title: 'Straight Outta Compton', parental_warning: false } }
    answers.album = { parental_warning: false, album: { title: 'Straight Outta Compton', parental_warning: true } }
    tags('album', { title: 'Express Yourself', artist: 'N.W.A', album: 'Straight Outta Compton' })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'N.W.A', title: 'Express Yourself', explicitSource: true })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['album'], 'the edited album is refused before a byte, and the file is not refused after')
    assert.deepEqual(importedIds(), ['album'])
  })

  test('A Bay Bay: beside an explicit copy, the clean Single Version on the same album is refused', async () => {
    hits('track', [['single', 'A Bay Bay by Hurricane Chris'], ['album', 'A Bay Bay by Hurricane Chris']])
    answers.single = { parental_warning: false, version: 'Single Version', album: { title: '51/50 Ratchet', parental_warning: true } }
    answers.album = { parental_warning: true, album: { title: '51/50 Ratchet', parental_warning: true } }
    tags('album', { title: 'A Bay Bay', artist: 'Hurricane Chris', album: '51/50 Ratchet' })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'Hurricane Chris', title: 'A Bay Bay' })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['album'])
    assert.deepEqual(importedIds(), ['album'])
  })

  describe('once an explicit master is proven, the rest of the walk knows', () => {
    const provenButBroken = (): void => {
      // The master arrives as something else, so the walk goes looking further.
      answers.master = { parental_warning: true, album: { title: 'FUTURE' } }
      tags('master', { title: 'Mask Off (Remix)', artist: 'Future', album: 'FUTURE' })
    }

    test('a clean hit past the sixth, which nothing had asked about, is refused on its flag', async () => {
      const clean = ['c1', 'c2', 'c3', 'c4', 'c5']
      hits('track', [['master', maskHit], ...clean.map((id): [string, string] => [id, maskHit]), ['past', maskHit]])
      provenButBroken()
      for (const id of clean) answers[id] = { parental_warning: false, album: { title: 'FUTURE' } }
      answers.past = { parental_warning: false, album: { title: 'FUTURE' } }
      tags('past', maskTags)
      const { walk, importedIds } = store()
      const r = await walk(MASK)
      assert.deepEqual(fetched(), ['master', 'past'])
      assert.deepEqual(importedIds(), [])
      assert.equal(r.ok, false)
    })

    test('and so is a clean track through the album door', async () => {
      hits('track', [['master', maskHit]])
      provenButBroken()
      hits('album', [['alb', 'FUTURE by Future']])
      answers.alb = { title: 'FUTURE', artist: { name: 'Future' }, tracks_count: 1, tracks: { items: [{ id: 'door', title: 'Mask Off', parental_warning: false, duration: 204 }] } }
      tags('door', maskTags)
      const { walk, importedIds } = store()
      await walk({ ...MASK, album: 'FUTURE' })
      assert.deepEqual(fetched(), ['master'], 'the door found nothing it could take')
      assert.deepEqual(importedIds(), [])
    })

    test('with no master the same door is open', async () => {
      hits('album', [['alb', 'FUTURE by Future']])
      answers.alb = { title: 'FUTURE', artist: { name: 'Future' }, tracks_count: 1, tracks: { items: [{ id: 'door', title: 'Mask Off', parental_warning: false, duration: 204 }] } }
      tags('door', maskTags)
      const { walk, importedIds } = store()
      await walk({ ...MASK, album: 'FUTURE' })
      assert.deepEqual(importedIds(), ['door'])
    })
  })
})

describe('the walk: what a metadata failure means', () => {
  const SONG = { artist: 'Band', title: 'Song' }
  const songTags = { title: 'Song', artist: 'Band', album: 'Record' }
  const twoHits = (): void => hits('track', [['first', 'Song by Band'], ['second', 'Song by Band']])

  test("Qobuz's own 404 is skipped with no fetch", async () => {
    twoHits()
    answers.first = 'gone'
    answers.second = { album: { title: 'Record' } }
    tags('second', songTags)
    const { walk, importedIds } = store()
    assert.equal((await walk(SONG)).outcome, 'imported')
    assert.deepEqual(fetched(), ['second'])
    assert.deepEqual(importedIds(), ['second'])
  })

  test('a dead id costs no try: the walk still fetches three', async () => {
    hits('track', [['dead1', 'Song by Band'], ['dead2', 'Song by Band'], ['ok1', 'Song by Band'], ['ok2', 'Song by Band'], ['ok3', 'Song by Band']])
    answers.dead1 = answers.dead2 = 'gone'
    answers.ok1 = answers.ok2 = answers.ok3 = { album: { title: 'Record' } }
    for (const id of ['ok1', 'ok2', 'ok3']) tags(id, { ...songTags, title: 'Song (Remix)' })
    await store().walk(SONG)
    assert.deepEqual(fetched(), ['ok1', 'ok2', 'ok3'])
  })

  for (const [what, answer] of [['a timeout', 'timeout'], ['a 500', 'server error'], ["a gateway's 404", 'gateway']] as const) {
    test(`${what} on one id while another answers is no answer, not a dead id: it still gets its turn`, async () => {
      twoHits()
      answers.first = answer
      answers.second = { album: { title: 'Record' } }
      tags('first', songTags)
      const { walk, importedIds } = store()
      assert.equal((await walk(SONG)).outcome, 'imported')
      assert.deepEqual(fetched(), ['first'])
      assert.deepEqual(importedIds(), ['first'])
    })
  }

  test('Qobuz down altogether: the walk goes on unjudged', async () => {
    twoHits()
    tags('first', songTags)
    const { walk, importedIds } = store()
    assert.equal((await walk(SONG)).outcome, 'imported')
    assert.deepEqual(importedIds(), ['first'])
  })

  test('the token goes in a header, never a URL, and never follows a redirect', async () => {
    twoHits()
    answers.first = { album: { title: 'Record' } }
    answers.second = { album: { title: 'Record' } }
    tags('first', songTags)
    await store().walk({ ...SONG, album: 'Record' })
    assert.ok(qobuzCalls.length > 0)
    for (const { url, init } of qobuzCalls) {
      assert.ok(!url.includes('SECRET-TOKEN'), url)
      assert.equal((init?.headers as Record<string, string>)['X-User-Auth-Token'], 'SECRET-TOKEN')
      assert.equal(init?.redirect, 'error')
      assert.ok(init?.signal instanceof AbortSignal)
    }
  })
})

describe('the walk, a record: only this edition proves a clean one is censored', () => {
  const editionWorld = (rows: Array<{ id: string; title: string; n: number; flag?: boolean; artist?: string }>): void => {
    hits('album', rows.map((r) => [r.id, `${r.title} by ${r.artist ?? 'Black Country, New Road'}`]))
    for (const r of rows) {
      const artist = r.artist ?? 'Black Country, New Road'
      answers[r.id] = { title: r.title, artist: { name: artist }, tracks_count: r.n, media_count: 1, parental_warning: r.flag }
      put(`files-${r.id}`, String(r.n))
      tags(r.id, { title: 'A Track', artist, album: r.title })
    }
  }
  const ANTS = { artist: 'Black Country, New Road', album: 'Ants From Up There', trackCount: 10 }

  test('Ants From Up There: a Deluxe flagged explicit does not throw out the 10 tracks Jake picked', async () => {
    // kept 1, refused clean 1, and the kept Deluxe then failed the contract: 19 tracks, he picked 10 (2026-10-31).
    editionWorld([
      { id: 'deluxe', title: 'Ants From Up There (Deluxe)', n: 19, flag: true },
      { id: 'plain', title: 'Ants From Up There', n: 10, flag: false },
    ])
    const { walk, importedIds } = store()
    const r = await walk(ANTS)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['plain'])
    assert.equal(importedIds().length, 10)
    assert.ok(importedIds().every((id) => id === 'plain'))
  })

  test('the same count flagged explicit IS this edition: the edited twin is refused (Watch the Throne)', async () => {
    editionWorld([
      { id: 'edited', title: 'Watch the Throne', n: 12, flag: false, artist: 'JAY-Z' },
      { id: 'explicit', title: 'Watch the Throne', n: 12, flag: true, artist: 'JAY-Z' },
    ])
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'JAY-Z', album: 'Watch the Throne', trackCount: 12 })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['explicit'])
    assert.ok(importedIds().every((id) => id === 'explicit'))
  })

  test('a contract that cannot tell keeps the flag\'s word', async () => {
    editionWorld([
      { id: 'edited', title: 'Ants From Up There', n: 10, flag: false },
      { id: 'explicit', title: 'Ants From Up There', n: 10, flag: true },
    ])
    await store().walk({ artist: 'Black Country, New Road', album: 'Ants From Up There' })
    assert.ok(!fetched().includes('edited'), 'no track count anywhere, so the flagged edition still vouches')
  })

  test('a wrong edition is still refused from its listing, with no fetch, and said so', async () => {
    editionWorld([
      { id: 'deluxe', title: 'Ants From Up There (Deluxe)', n: 19 },
      { id: 'plain', title: 'Ants From Up There', n: 10 },
    ])
    const r = await store().walk(ANTS)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['plain'])
    const nothing = await store().walk({ ...ANTS, trackCount: 12 })
    assert.equal(nothing.outcome, 'exact-not-found')
    assert.deepEqual(nothing.alternatives?.map((a) => a.reason).sort(), ['has 10 tracks; the edition you picked has 12', 'has 19 tracks; the edition you picked has 12'])
  })

  test("an edition whose own version field says Live is not this edition, and its flag proves nothing", async () => {
    editionWorld([
      { id: 'live', title: 'Ants From Up There', n: 10, flag: true },
      { id: 'plain', title: 'Ants From Up There', n: 10, flag: false },
    ])
    answers.live = { ...(answers.live as Record<string, unknown>), version: 'Live' }
    const r = await store().walk(ANTS)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['plain'])
  })

  test("a flag the first ask missed still counts when the walk reads the listing", async () => {
    editionWorld([
      { id: 'slow', title: 'Ants From Up There', n: 10, flag: false },
      { id: 'explicit', title: 'Ants From Up There', n: 10, flag: true },
    ])
    let calls = 0
    const inner = globalThis.fetch
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('album_id=slow') && calls++ === 0) throw new DOMException('timed out', 'TimeoutError')
      return inner(url, init)
    }) as typeof fetch
    const r = await store().walk({ ...ANTS, explicitSource: true })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['explicit'], 'an explicit row, and its listing says clean: no fetch')
  })

  test('nothing flagged: nothing refused', async () => {
    editionWorld([{ id: 'plain', title: 'Ants From Up There', n: 10, flag: false }])
    const r = await store().walk(ANTS)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['plain'])
  })

  test('an explicit row with only clean editions fails loudly', async () => {
    editionWorld([{ id: 'plain', title: 'Ants From Up There', n: 10, flag: false }])
    const r = await store().walk({ ...ANTS, explicitSource: true })
    assert.deepEqual(fetched(), [])
    assert.match(r.error ?? '', /only carries the CLEAN edition of this album \(1 candidate refused\)/)
  })

  test('an explicit row keeps the explicit edition, and refuses the clean one before a byte', async () => {
    editionWorld([
      { id: 'edited', title: 'Ants From Up There', n: 10, flag: false },
      { id: 'explicit', title: 'Ants From Up There', n: 10, flag: true },
    ])
    const r = await store().walk({ ...ANTS, explicitSource: true })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['explicit'])
  })

  test("an album Qobuz's own 404 says is gone is skipped, and takes no part", async () => {
    editionWorld([
      { id: 'dead', title: 'Ants From Up There', n: 10, flag: true },
      { id: 'plain', title: 'Ants From Up There', n: 10, flag: false },
    ])
    answers.dead = 'gone'
    const { walk } = store()
    const r = await walk(ANTS)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['plain'])
  })

  test('a gone album with an explicit row is skipped too', async () => {
    editionWorld([
      { id: 'dead', title: 'Ants From Up There', n: 10, flag: true },
      { id: 'explicit', title: 'Ants From Up There', n: 10, flag: true },
    ])
    answers.dead = 'gone'
    const r = await store().walk({ ...ANTS, explicitSource: true })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['explicit'])
  })

  test('a timeout on an album is no answer: it still gets its turn', async () => {
    editionWorld([
      { id: 'slow', title: 'Ants From Up There', n: 10 },
      { id: 'other', title: 'Ants From Up There', n: 10, flag: false },
    ])
    let calls = 0
    const answered = answers.slow!
    const inner = globalThis.fetch
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      // The first ask about it times out; the walk's own listing then answers.
      if (String(url).includes('album_id=slow') && calls++ === 0) throw new DOMException('timed out', 'TimeoutError')
      answers.slow = answered
      return inner(url, init)
    }) as typeof fetch
    const r = await store().walk(ANTS)
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['slow'])
  })
})
