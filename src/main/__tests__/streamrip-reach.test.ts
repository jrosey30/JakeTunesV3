/**
 * A row refused while the right file sits on Qobuz (2026-11-05).
 *
 * A row with no length now gets Apple's, so a wrong file that used to land is refused. On three real
 * rows the right copy was on Qobuz and the walk could not reach it:
 *   - Underworld's 705 s "Born Slippy" is the 23rd hit. Hits past the sixth got no question, and each
 *     cost one of three fetches.
 *   - Qobuz's album search answers nothing for "(Super Deluxe)", and the album door asked once.
 *   - Parklife prints "Girls & Boys" (the phone's Brief 231, and the door has read it since). Apple's
 *     lengths still read the two as different words.
 * And one thing asking about every hit would have broken: a compilation far down the hits, flagged
 * explicit, threw out The Pharcyde's own album.
 *
 * Every search, answer and Apple row below is the real one, saved 2026-11-05 and cut down to what the
 * walk reads: fixtures/qobuz-walks.json. The real `streamrip:download-by-query` handler runs. Only the
 * outside world is faked: `rip` and `ffprobe` are small scripts, HOME is a temp folder, and fetch
 * answers from the fixture. A file is tagged the way streamrip tags it, as a real fetch of these rows did.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { albumSearchNames } from '../streamrip-match.ts'
import { expectedRuntimes } from '../exact-recording.ts'

const userData = mkdtempSync(join(tmpdir(), 'jt-reach-userdata-'))
process.env.JT_USER_DATA = userData
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { registerStreamripStore } = await import('../streamrip-store/index.ts')
after(() => rmSync(userData, { recursive: true, force: true }))

interface QobuzTrack { title: string; version: string | null; duration: number; album: { title: string; version: string | null }; performer: { name: string } }
interface QobuzAlbum { title: string; version: string | null; artist: { name: string }; tracks: { items: Array<{ id: number; title: string; version: string | null; duration: number; performer: { name: string } }> } }
interface RealWalk {
  row: { artist: string; title: string; album: string }
  apple: unknown[]
  /** "track|<query>" or "album|<query>": every hit Qobuz's search answered, in its order. */
  searches: Record<string, Array<[id: string, desc: string]>>
  qobuz: Record<string, QobuzTrack | QobuzAlbum | 'gone'>
}
const WALKS = JSON.parse(readFileSync(new URL('./fixtures/qobuz-walks.json', import.meta.url), 'utf8')) as Record<string, RealWalk>

describe('albumSearchNames: what to ask Qobuz for an album', () => {
  test('the name, then the name with every bracket gone', () => {
    assert.deepEqual(albumSearchNames('Second Toughest in the Infants (Super Deluxe) [Remastered]'), ['Second Toughest in the Infants (Super Deluxe)', 'Second Toughest in the Infants'])
    assert.deepEqual(albumSearchNames('Armed & Extremely Dangerous (Remixes)'), ['Armed & Extremely Dangerous (Remixes)', 'Armed & Extremely Dangerous'])
  })

  test('Apple’s labels are gone from the first ask already', () => {
    assert.deepEqual(albumSearchNames('Running From the Sun (feat. Eamon) [Remixes] - Single'), ['Running From the Sun [Remixes]', 'Running From the Sun'])
    assert.deepEqual(albumSearchNames('Got to Release - Single'), ['Got to Release'])
    assert.deepEqual(albumSearchNames('The News - EP'), ['The News'])
  })

  test('a name with nothing to drop is asked once', () => {
    assert.deepEqual(albumSearchNames('Parklife'), ['Parklife'])
    assert.deepEqual(albumSearchNames('Life After Death (2014 Remastered Edition)'), ['Life After Death'])
  })
})

describe('expectedRuntimes reads "&" and "and" as one word, in a title and on an album', () => {
  const row = (title: string, album: string, durationSec: number) => ({ title, artist: 'New Order', album, durationSec })
  // Apple's real rows: it lists this album both ways.
  const AGE = [row('Age of Consent', 'Power, Corruption & Lies', 315.3), row('Age of Consent', 'Power, Corruption and Lies', 316.2)]

  test('Age of Consent: the album either way is the album', () => {
    assert.deepEqual(expectedRuntimes({ title: 'Age of Consent', artist: 'New Order', album: 'Power, Corruption & Lies' }, AGE).map((r) => r.sec), [315.3, 316.2])
    assert.deepEqual(expectedRuntimes({ title: 'Age of Consent', artist: 'New Order', album: 'Power, Corruption and Lies' }, AGE).map((r) => r.sec), [315.3, 316.2])
    assert.deepEqual(expectedRuntimes({ title: 'Age of Consent', artist: 'New Order', album: 'Power, Corruption' }, AGE), [])
  })

  // Apple's real row. The row Jake's jot resolves to says "and", and it had no length.
  const SHAKE = { title: 'Shake & Tremble', artist: 'Django Django', album: 'Born Under Saturn', durationSec: 259.216 }

  test('Shake and Tremble: the title either way is the song', () => {
    assert.deepEqual(expectedRuntimes({ title: 'Shake and Tremble', artist: 'Django Django' }, [SHAKE]).map((r) => r.sec), [259.216])
    assert.deepEqual(expectedRuntimes({ title: 'Shake & Tremble', artist: 'Django Django' }, [{ ...SHAKE, title: 'Shake and Tremble' }]).map((r) => r.sec), [259.216])
    assert.deepEqual(expectedRuntimes({ title: 'Shake and Tremble (Hear Me)', artist: 'Django Django' }, [SHAKE]).map((r) => r.sec), [259.216], 'a subtitle Apple dropped')
    assert.deepEqual(expectedRuntimes({ title: 'Shake & Tremble (Hear Me)', artist: 'Django Django' }, [{ ...SHAKE, title: 'Shake and Tremble' }]).map((r) => r.sec), [259.216], 'and the other way round')
    assert.deepEqual(expectedRuntimes({ title: 'Shake and Tremble', artist: 'Django Django' }, [{ ...SHAKE, title: 'Tremble' }]), [])
  })

  test('the exact title still beats one with its subtitle gone, however either is written', () => {
    const subtitled = { ...SHAKE, title: 'Shake & Tremble (Hear Me)', durationSec: 300 }
    assert.deepEqual(expectedRuntimes({ title: 'Shake and Tremble (Hear Me)', artist: 'Django Django' }, [subtitled, { ...SHAKE, title: 'Shake and Tremble' }]).map((r) => r.sec), [300])
    assert.deepEqual(expectedRuntimes({ title: 'Shake & Tremble (Hear Me)', artist: 'Django Django' }, [{ ...subtitled, title: 'Shake and Tremble (Hear Me)' }, SHAKE]).map((r) => r.sec), [300])
  })

  test('a clean row of the song, written either way, and nobody knows its length', () => {
    const clean = { ...SHAKE, title: 'Shake & Tremble (Hear Me)', cleaned: true }
    assert.deepEqual(expectedRuntimes({ title: 'Shake and Tremble', artist: 'Django Django' }, [SHAKE, clean]), [])
  })
})

// ── The real handler, in a fake world ───────────────────────────────────────

const FAKE_RIP = `#!/bin/sh
echo "rip $*" >> "$FAKE_WORLD/calls.log"
if [ "$1" = "--version" ]; then echo "rip, version 2.1.0"; exit 0; fi
if [ "$1" = "search" ]; then
  # rip search -o <file> -n <n> <source> <type> <query>
  n=$(printf %s "$8" | cksum | cut -d' ' -f1)
  if [ -f "$FAKE_WORLD/search-$7-$n.json" ]; then cp "$FAKE_WORLD/search-$7-$n.json" "$3"; exit 0; fi
  echo "No search results found for query $8"; exit 0
fi
# rip --folder <dir> --quality 4 --no-db --no-progress id <source> <type> <id>
cp "$FAKE_WORLD/audio.bin" "$2/\${10}-1.flac"
`
const FAKE_FFPROBE = `#!/bin/sh
for f; do :; done
b=$(basename "$f"); b=\${b%.*}
cat "$FAKE_WORLD/probe-\${b%-*}.json"
`

interface WalkResult { ok: boolean; outcome?: string; matchDesc?: string; error?: string; detail?: string; alternatives?: Array<{ provider: string; desc: string; reason: string }> }

describe('walked through the real handler', () => {
  const home = mkdtempSync(join(tmpdir(), 'jt-reach-home-'))
  const appPath = join(home, 'app-path')
  after(() => rmSync(home, { recursive: true, force: true }))
  let world = ''
  let apple: unknown[] = []
  let qobuz: Record<string, unknown> = {}
  let asked: string[] = []
  let atOnce = 0
  let mostAtOnce = 0
  const realFetch = globalThis.fetch
  const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }

  const put = (name: string, body: string | Uint8Array): void => writeFileSync(join(world, name), body)
  const install = (dir: string, name: string, script: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), script)
    chmodSync(join(dir, name), 0o755)
  }
  const calls = (): string[] => existsSync(join(world, 'calls.log')) ? readFileSync(join(world, 'calls.log'), 'utf-8').split('\n') : []
  const ripped = (): string[] => calls().filter((l) => l.startsWith('rip --folder')).map((l) => l.split(' ').at(-1)!)
  const searched = (type: string): string[] => calls().filter((l) => l.startsWith('rip search')).map((l) => l.split(' ')).filter((w) => w[7] === type).map((w) => w.slice(8).join(' '))
  const trackQuestions = (): string[] => asked.filter((u) => u.includes('/track/get'))
  /** A search answered only for this very query. A query nobody listed answers nothing, as Qobuz does. */
  const answerSearch = (type: string, query: string, rows: Array<[string, string]>): void => {
    if (rows.length === 0) return
    const n = execFileSync('cksum', { input: query }).toString().split(' ')[0]
    put(`search-${type}-${n}.json`, JSON.stringify(rows.map(([id, desc]) => ({ source: 'qobuz', media_type: type, id, desc }))))
  }
  const fileTags = (id: string, t: { title: string; artist: string; album: string; duration: number }): void =>
    put(`probe-${id}.json`, JSON.stringify({ format: { duration: String(t.duration), tags: { title: t.title, artist: t.artist, album: t.album } } }))
  /** How streamrip writes a name: "title (version)", unless the title already says it. */
  const named = (title: string, version: string | null): string => version && !title.includes(version) ? `${title} (${version})` : title

  /** The whole outside world of one real row, every file tagged the way streamrip tags it. */
  function realWorld(name: string): RealWalk['row'] {
    const w = WALKS[name]!
    apple = w.apple
    qobuz = w.qobuz
    for (const [key, rows] of Object.entries(w.searches)) {
      const [type, query] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
      answerSearch(type!, query!, rows)
    }
    for (const [id, a] of Object.entries(w.qobuz)) {
      if (a === 'gone') continue
      if ('performer' in a) fileTags(id, { title: named(a.title, a.version), artist: a.performer.name, album: named(a.album.title, a.album.version), duration: a.duration })
      else for (const t of a.tracks.items) fileTags(String(t.id), { title: named(t.title, t.version), artist: t.performer.name, album: named(a.title, a.version), duration: t.duration })
    }
    return w.row
  }

  function store() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
    const imported: string[] = []
    registerStreamripStore({
      ipc: { handle: (channel: string, fn: never) => { handlers.set(channel, fn) } },
      getMainWindow: () => null,
      importDownloaded: async (paths: string[]) => { imported.push(...paths); return paths.map(() => ({ title: 'x' })) },
      mbThrottle: async () => {},
      mbUserAgent: 'jt-reach-test',
    } as never)
    return {
      importedIds: (): string[] => imported.map((p) => p.split('/').at(-1)!.replace(/-\d+\.\w+$/, '')),
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
    writeFileSync(join(cfg, 'config.toml'), '[qobuz]\nuse_auth_token = true\npassword_or_token = "NOT-A-TOKEN"\napp_id = "APP1"\n')
    const warm = { env: { ...process.env, FAKE_WORLD: home }, timeout: 120_000, stdio: 'ignore' as const }
    execFileSync(join(home, '.local', 'bin', 'rip'), ['--version'], warm)
    writeFileSync(join(home, 'probe-warm.json'), '{}')
    execFileSync(join(appPath, 'ffprobe'), [join(home, 'warm-1.flac')], warm)
  })

  beforeEach(() => {
    world = mkdtempSync(join(tmpdir(), 'jt-reach-'))
    mkdirSync(join(world, 'tmp'))
    process.env.HOME = home
    process.env.PATH = `${appPath}:/usr/bin:/bin`
    process.env.TMPDIR = join(world, 'tmp')
    process.env.FAKE_WORLD = world
    put('audio.bin', new Uint8Array(100 * 1024))
    apple = []
    qobuz = {}
    asked = []
    atOnce = 0
    mostAtOnce = 0
    mock.method(console, 'warn', () => {})
    mock.method(console, 'log', () => {})
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      if (u.includes('itunes.apple.com')) return json({ results: apple })
      if (u.includes('qobuz.com/api.json')) {
        asked.push(u)
        atOnce++
        mostAtOnce = Math.max(mostAtOnce, atOnce)
        await new Promise((r) => setImmediate(r))
        atOnce--
        const id = decodeURIComponent(/_id=([^&]+)/.exec(u)?.[1] ?? '')
        if (qobuz[id] === 'gone') return json({ status: 'error', code: 404, message: 'No result matching given argument' }, 404)
        return qobuz[id] === undefined ? json({ status: 'error' }, 500) : json(qobuz[id])
      }
      return json({}, 404)
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

  describe('every hit of a song is asked about before any is fetched', () => {
    const SLIPPY = 'Underworld - Born Slippy .NUXX (Remastered)'

    test('Born Slippy: the 705 s cut is the 23rd hit, and the album’s own copy comes in', async () => {
      const { walk, importedIds } = store()
      const r = await walk(realWorld(SLIPPY))
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(importedIds(), ['28265336'], 'the Super Deluxe the row names')
      assert.deepEqual(ripped(), ['28265297', '28265336'], 'the radio edits and the 456 s cut cost no fetch; the Deluxe is held')
      assert.equal(trackQuestions().length, 25)
    })

    test('Points of Authority: the three fetches went on Linkin Park’s own "One Step Closer", and one of those came in', async () => {
      const { walk, importedIds } = store()
      const r = await walk(realWorld('JAY-Z & Linkin Park - Points of Authority / 99 Problems / One Step Closer'))
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(importedIds(), ['2571246'], 'the 296 s cut on Collision Course')
      assert.deepEqual(ripped(), ['2571246'])
    })

    test('Bad and Boujee: the album’s explicit cut, not the first compilation Qobuz lists', async () => {
      const { walk, importedIds } = store()
      const r = await walk(realWorld('Migos - Bad and Boujee (feat. Lil Uzi Vert)'))
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(importedIds(), ['150889698'], '343 s on Culture')
      assert.deepEqual(ripped(), ['150889698'])
    })

    test('six questions at a time', async () => {
      await store().walk(realWorld(SLIPPY))
      assert.equal(trackQuestions().length, 25)
      assert.equal(mostAtOnce, 6)
    })

    test('Qobuz down: one burst nobody answers ends the asking, and the file is judged as it always was', async () => {
      const row = realWorld(SLIPPY)
      qobuz = {}
      const { walk, importedIds } = store()
      const r = await walk(row)
      assert.equal(trackQuestions().length, 6, 'nineteen more would each wait out the same timeout')
      assert.equal(ripped().length, 3)
      assert.deepEqual(importedIds(), [], 'the first three hits are a radio edit, the 456 s cut and a live cut')
      assert.equal(r.ok, false)
    })

    test('six hits gone from the catalog are six answers, and the seventh is asked about', async () => {
      const row = realWorld(SLIPPY)
      const answers = qobuz
      const ranked = WALKS[SLIPPY]!.searches['track|Underworld Born Slippy .NUXX']!.map(([id]) => id)
      const firstSix = ranked.filter((id) => answers[id] !== 'gone' && (answers[id] as QobuzTrack).title === 'Born Slippy (Nuxx)').slice(0, 6)
      qobuz = { ...answers, ...Object.fromEntries(firstSix.map((id) => [id, 'gone'])) }
      const { walk, importedIds } = store()
      await walk(row)
      assert.equal(trackQuestions().length, 25)
      assert.deepEqual(importedIds(), ['28265336'])
    })

    test('a whole album still asks about six hits', async () => {
      const albums = Array.from({ length: 8 }, (_, i): [string, string] => [`alb${i}`, `Parklife by Blur`])
      answerSearch('album', 'Blur Parklife', albums)
      await store().walk({ artist: 'Blur', album: 'Parklife' })
      const ids = new Set(asked.filter((u) => u.includes('/album/get')).map((u) => /album_id=([^&]+)/.exec(u)?.[1]))
      assert.equal(ids.size, 6)
    })
  })

  describe('a compilation proves nothing about the recording', () => {
    const PASSIN = "The Pharcyde - Passin' Me By"

    test('Passin’ Me By: the one copy flagged explicit is another recording on HIP-HOP 50, and the album’s own comes in', async () => {
      const { walk, importedIds } = store()
      const r = await walk(realWorld(PASSIN))
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(importedIds(), ['19131130'], '303 s on Bizarre Ride II, the same audio as Jake’s file')
      assert.deepEqual(ripped(), ['19131130'])
    })

    test('a flag on the artist’s own album still proves it: the album’s copy with no warning is refused', async () => {
      const row = realWorld(PASSIN)
      const hip = qobuz['226443696'] as QobuzTrack & { album: { artist: { name: string } } }
      qobuz = { ...qobuz, 226443696: { ...hip, album: { ...hip.album, artist: { name: 'The Pharcyde' } } } }
      const { walk, importedIds } = store()
      await walk(row)
      assert.deepEqual(importedIds(), ['226443696'])
    })
  })

  describe('"&" and "and"', () => {
    test('Girls and Boys: all 21 hits are the 259 s edit, none costs a fetch, and Parklife’s "Girls & Boys" comes in through the door', async () => {
      const { walk, importedIds } = store()
      const r = await walk(realWorld('Blur - Girls and Boys'))
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(importedIds(), ['19201325'])
      assert.deepEqual(ripped(), ['19201325'])
      assert.deepEqual(searched('album'), ['Blur Parklife'])
    })

    test('when nothing lands, one edit on twenty compilations is one line on the Refused list', async () => {
      const row = realWorld('Blur - Girls and Boys')
      qobuz = Object.fromEntries(Object.entries(qobuz).filter(([, a]) => a === 'gone' || 'performer' in a))
      const { walk, importedIds } = store()
      const r = await walk(row)
      assert.deepEqual(importedIds(), [])
      const lines = (r.alternatives ?? []).map((a) => `${a.desc} ${a.reason}`)
      assert.ok(lines.length > 0)
      assert.equal(new Set(lines).size, lines.length, lines.join('\n'))
    })
  })

  describe('the album door asks twice', () => {
    const DUB = 'First Choice - Armed & Extremely Dangerous (Full Intention Dub)'

    test('First Choice: "(Remixes)" answers nothing, and the album without it holds the song', async () => {
      const { walk, importedIds } = store()
      const r = await walk(realWorld(DUB))
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(searched('album'), ['First Choice Armed & Extremely Dangerous (Remixes)', 'First Choice Armed & Extremely Dangerous'])
      assert.deepEqual(importedIds(), ['440379531'])
    })

    test('Born Slippy, if the song search had missed it: "(Super Deluxe)" answers nothing, and the album without it holds the 705 s cut', async () => {
      const row = realWorld('Underworld - Born Slippy .NUXX (Remastered)')
      rmSync(join(world, `search-track-${execFileSync('cksum', { input: 'Underworld Born Slippy .NUXX' }).toString().split(' ')[0]}.json`))
      const { walk, importedIds } = store()
      const r = await walk(row)
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(searched('album'), ['Underworld Second Toughest in the Infants (Super Deluxe)', 'Underworld Second Toughest in the Infants'])
      assert.deepEqual(importedIds(), ['28265336'])
    })

    test('a first ask that finds the album is the only ask', async () => {
      const row = realWorld('Underworld - Born Slippy .NUXX (Remastered)')
      rmSync(join(world, `search-track-${execFileSync('cksum', { input: 'Underworld Born Slippy .NUXX' }).toString().split(' ')[0]}.json`))
      answerSearch('album', 'Underworld Second Toughest in the Infants (Super Deluxe)', WALKS['Underworld - Born Slippy .NUXX (Remastered)']!.searches['album|Underworld Second Toughest in the Infants']!)
      await store().walk(row)
      assert.deepEqual(searched('album'), ['Underworld Second Toughest in the Infants (Super Deluxe)'])
    })
  })
})
