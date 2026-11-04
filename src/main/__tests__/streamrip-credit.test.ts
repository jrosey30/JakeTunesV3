/**
 * Another way of writing an artist's credit (JakeTunesMobile Brief 225).
 *
 * Qobuz files "OMA & SitarNik" as "Oma" and "Richard F." as "F. Richard". recoArtistMatches
 * says no to both, so the desktop refused both songs, the way the phone did. The cases come
 * from the phone's streamripCredit.test.ts, on the desktop's own ranking and judge.
 *
 * The walks at the end run the real `streamrip:download-by-query` handler. Only the outside
 * world is faked: `rip` and `ffprobe` are small scripts, HOME is a temp folder, and fetch
 * answers for Qobuz.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRequestedRecording, verifyCandidate, type CandidateEvidence } from '../exact-recording.ts'
import { otherCredit, rankStreamripCandidates, rankWithArtistAliases, searchTitle, type StreamripSearchHit } from '../streamrip-match.ts'
import { recoArtistMatches } from '../reco-match.ts'

// The store reaches state-dir.ts, which asks electron for userData. The same stub the
// headless scripts use; state-dir reads it once, at import.
const userData = mkdtempSync(join(tmpdir(), 'jt-credit-userdata-'))
process.env.JT_USER_DATA = userData
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { registerStreamripStore } = await import('../streamrip-store/index.ts')
after(() => rmSync(userData, { recursive: true, force: true }))

// The two real failures, as Qobuz and Apple really have them.
const OMA_ROW = { artist: 'OMA & SitarNik', title: 'Rapp Snitch Knishes (Sitar Edition)', album: 'Rapp Snitch Knishes (Sitar Edition)', durationMs: 137_000 }
const OMA_FILE = { provider: 'qobuz', title: 'Rapp Snitch Knishes (Sitar Edition)', artist: 'Oma', album: 'Rapp Snitch Knishes (Sitar Edition)', durationSec: 137 } satisfies CandidateEvidence
const RICHARD_ROW = { artist: 'Richard F.', title: 'Feels Alright (feat. Simonne Cooper) [Vocal Mix]', album: 'Feels Alright (feat. Simonne Cooper)', durationMs: 533_000 }
const RICHARD_FILE = { provider: 'qobuz', title: 'Feels Alright (Vocal Mix)', artist: 'F. Richard', album: 'Feels Alright', durationSec: 533.3 } satisfies CandidateEvidence

describe('otherCredit', () => {
  it('the same words in another order', () => {
    assert.equal(otherCredit('Richard F.', 'F. Richard'), 'order')
    // Both really in Jake's library, each under both orders.
    assert.equal(otherCredit('Eric Faria & Mr Kris', 'Mr. Kris & Eric Faria'), 'order')
    assert.equal(otherCredit('Kompromat, Rebeka Warrior, Vitalic', 'Kompromat, Vitalic, Rebeka Warrior'), 'order')
    assert.equal(otherCredit('RICHARD F.', 'f. richard'), 'order')
    assert.equal(otherCredit('A & B Band', 'B Band, A'), 'order')
    assert.equal(otherCredit('Salt&Pepa', 'Pepa & Salt'), 'order', 'with no spaces')
    assert.equal(otherCredit('Eric Faria,Mr. Kris', 'Mr. Kris & Eric Faria'), 'order', 'with no spaces')
  })
  it('more words, fewer words or other words are not an order', () => {
    assert.equal(otherCredit('Richard F.', 'F. Richard Band'), null)
    assert.equal(otherCredit('Richard F. Band', 'F. Richard'), null)
    assert.equal(otherCredit('Richard F.', 'Richard Feynman'), null)
    assert.equal(otherCredit('Richard F.', 'F. Richards'), null)
  })
  it('the same name is not another way of writing it', () => {
    assert.equal(otherCredit('Richard F.', 'richard f'), null)
    assert.equal(otherCredit('Oma', 'Oma'), null)
  })
  it('one whole name of a joint credit', () => {
    assert.equal(otherCredit('OMA & SitarNik', 'Oma'), 'part')
    assert.equal(otherCredit('LSD, Diplo, Sia, Labrinth', 'Sia'), 'part')
    assert.equal(otherCredit('Matt & Kim', 'Kim'), 'part')
    assert.equal(otherCredit('Polo & Pan', 'Pan'), 'part')
  })
  it('a slash or a plus is inside a name', () => {
    assert.equal(otherCredit('AC/DC', 'AC'), null)
    assert.equal(otherCredit('AC/DC', 'DC'), null)
    assert.equal(otherCredit('C+C Music Factory', 'C Music Factory'), null)
  })
  it('"& the" is one band', () => {
    assert.equal(otherCredit('Sly & the Family Stone', 'Sly'), null)
    assert.equal(otherCredit('Ike & The Sly Band', 'Ike'), null)
    assert.equal(otherCredit('Echo, The Bunnymen', 'Echo'), null)
  })
  it('"Jr." and "Sr." are part of one name', () => {
    assert.equal(otherCredit('Grover Washington, Jr', 'Jr'), null)
    assert.equal(otherCredit('Harry Connick, Jr.', 'Jr'), null)
    assert.equal(otherCredit('Sam Elliot, Sr.', 'Sr'), null)
    assert.equal(otherCredit('Dan, Jrock', 'Dan'), 'part', 'a name that only starts that way is a name')
  })
  it('a lone letter is no name', () => {
    assert.equal(otherCredit('B & Someone', 'B'), null)
    assert.equal(otherCredit('K & Someone', 'K'), null)
  })
  it('someone else, or no joint credit at all', () => {
    assert.equal(otherCredit('OMA & SitarNik', 'Oman'), null)
    assert.equal(otherCredit('OMA & SitarNik', 'Om'), null)
    assert.equal(otherCredit('Oma', 'Oma & SitarNik'), null)
    assert.equal(otherCredit('Oma', 'Omar'), null)
    assert.equal(otherCredit('', 'Oma'), null)
    assert.equal(otherCredit('OMA & SitarNik', ''), null)
  })
  it('there is no spelling rule: one letter apart is another act', () => {
    assert.equal(otherCredit('David Bowie', 'David Zowie'), null)
    assert.equal(otherCredit('The Stems & Live', 'Love'), null)
  })
})

describe('recoArtistMatches is as it was', () => {
  it('still says no to both, which is why the rule exists', () => {
    assert.equal(recoArtistMatches('OMA & SitarNik', 'Oma'), false)
    assert.equal(recoArtistMatches('Richard F.', 'F. Richard'), false)
  })
})

const hit = (desc: string, mediaType = 'track'): StreamripSearchHit => ({ source: 'qobuz', mediaType, id: desc, desc })

describe('ranking a hit under another way of writing the credit', () => {
  const rank = (title: string, artist: string, descs: string[], clocked = false, mediaType: 'track' | 'album' = 'track'): string[] =>
    rankStreamripCandidates(searchTitle(title), artist, descs.map((d) => hit(d, mediaType)), mediaType, [], { clocked }).ranked.map((h) => h.desc)
  const omaHit = 'Rapp Snitch Knishes (Sitar Edition) by Oma'

  it('a part needs a clock', () => {
    assert.deepEqual(rank(OMA_ROW.title, OMA_ROW.artist, [omaHit], true), [omaHit])
    assert.deepEqual(rank(OMA_ROW.title, OMA_ROW.artist, [omaHit], false), [])
  })
  it('a word order does not', () => {
    assert.deepEqual(rank(RICHARD_ROW.title, RICHARD_ROW.artist, ['Feels Alright by F. Richard'], false), ['Feels Alright by F. Richard'])
  })
  it('a summary hides the version, so the name without brackets is enough here', () => {
    assert.deepEqual(rank(RICHARD_ROW.title, RICHARD_ROW.artist, ['Feels Alright by F. Richard'], true), ['Feels Alright by F. Richard'])
    assert.deepEqual(rank(OMA_ROW.title, OMA_ROW.artist, ['Rapp Snitch Knishes by Oma'], true), ['Rapp Snitch Knishes by Oma'])
  })
  it('no credit option, no other name: a whole album holds to the name', () => {
    assert.deepEqual(rankStreamripCandidates(searchTitle(RICHARD_ROW.title), RICHARD_ROW.artist, [hit('Feels Alright by F. Richard')]).ranked, [])
    assert.deepEqual(rankStreamripCandidates('Bliss', 'Richard F.', [hit('Bliss by F. Richard', 'album')], 'album').ranked, [])
  })
  it('an album row: the word order counts, a part has no length to answer to', () => {
    assert.deepEqual(rank('Bliss', 'Richard F.', ['Bliss by F. Richard'], false, 'album'), ['Bliss by F. Richard'])
    assert.deepEqual(rank('Bliss', 'OMA & SitarNik', ['Bliss by Oma'], false, 'album'), [])
  })
  it('a title that only reads like the song is out, under another credit', () => {
    assert.deepEqual(rank('Feels Alright', 'Richard F.', ['Feels Alright Now by F. Richard']), [])
    assert.deepEqual(rank('Breeze', 'Richard F.', ['Breezeblocks by F. Richard']), [])
    assert.deepEqual(rank('Rapp Snitch Knishes', 'OMA & SitarNik', ['Rapp Snitch by Oma'], true), [])
  })
  it('a song under the name itself leaves no room for another name', () => {
    const own = 'Bliss by Oma & SitarNik'
    assert.deepEqual(rank('Bliss', 'OMA & SitarNik', ['Bliss by Oma', own], true), [own])
  })
  it('a stranger cannot take the place of the act’s own labelled cut', () => {
    // This scoring gives only the bare title its bonus, so "Kim" alone would win.
    const own = 'Daylight (Album Version) by Matt & Kim'
    assert.deepEqual(rank('Daylight', 'Matt & Kim', ['Daylight by Kim', own], true), [own])
  })
  it('among other names, the bare title first', () => {
    assert.deepEqual(rank('Bliss', 'Richard F.', ['Bliss (Single Version) by F. Richard', 'Bliss by F. Richard']), ['Bliss by F. Richard', 'Bliss (Single Version) by F. Richard'])
  })
  it('a karaoke take under another credit stays out', () => {
    assert.deepEqual(rank('Bliss', 'Richard F.', ['Bliss (Karaoke Version) by F. Richard']), [])
  })
  it('someone else stays out', () => {
    assert.deepEqual(rank(OMA_ROW.title, OMA_ROW.artist, [`${OMA_ROW.title} by Oman`], true), [])
    assert.deepEqual(rank('Bliss', 'Sly & the Family Stone', ['Bliss by Sly'], true), [])
  })
})

describe('rankWithArtistAliases', () => {
  const never = async (): Promise<string[]> => { throw new Error('MusicBrainz was asked') }

  it('a credit that holds costs no wait on MusicBrainz', async () => {
    const r = await rankWithArtistAliases('Rapp Snitch Knishes', 'OMA & SitarNik', [hit('Rapp Snitch Knishes by Oma')], 'track', never, { clocked: true })
    assert.deepEqual(r.ranked.map((h) => h.desc), ['Rapp Snitch Knishes by Oma'])
    assert.deepEqual(r.aliases, [])
  })
  it('one that does not hold still asks: MusicBrainz may vouch for the name', async () => {
    const asked: string[] = []
    const r = await rankWithArtistAliases('Rapp Snitch Knishes', 'OMA & SitarNik', [hit('Rapp Snitch Knishes by Oma')], 'track', async (a) => { asked.push(a); return ['Oma'] }, { clocked: false })
    assert.deepEqual(asked, ['OMA & SitarNik'])
    assert.deepEqual(r.ranked.map((h) => h.desc), ['Rapp Snitch Knishes by Oma'])
  })
  it('with no credit option the first pass refuses the other name', async () => {
    const r = await rankWithArtistAliases('Bliss', 'Richard F.', [hit('Bliss by F. Richard', 'album')], 'album', async () => [])
    assert.deepEqual(r.ranked, [])
  })
})

describe('the judge on another way of writing the credit', () => {
  const judge = (row: Parameters<typeof buildRequestedRecording>[0], file: CandidateEvidence) => verifyCandidate(buildRequestedRecording(row), file)
  const rejected = (v: ReturnType<typeof judge>, kind: string): void => {
    assert.equal(v.verdict, 'reject', JSON.stringify(v))
    if (v.verdict === 'reject') assert.equal(v.kind, kind, v.reason)
  }

  it('passes the two real files', () => {
    assert.equal(judge(OMA_ROW, OMA_FILE).verdict, 'exact')
    assert.equal(judge(RICHARD_ROW, RICHARD_FILE).verdict, 'exact')
  })
  it('a word order with no clock: an exact title is enough', () => {
    assert.equal(judge({ ...RICHARD_ROW, durationMs: undefined }, RICHARD_FILE).verdict, 'exact')
  })
  it('a part with no clock is refused: nothing vouches for "Oma"', () => {
    rejected(judge({ ...OMA_ROW, durationMs: undefined }, OMA_FILE), 'artist')
  })
  it('a clean row has no clock', () => {
    rejected(judge({ ...OMA_ROW, cleanedSource: true }, OMA_FILE), 'artist')
    assert.equal(judge({ ...RICHARD_ROW, cleanedSource: true }, RICHARD_FILE).verdict, 'exact')
  })
  it('a file with no length of its own has no clock either', () => {
    rejected(judge(OMA_ROW, { ...OMA_FILE, durationSec: null }), 'artist')
    rejected(judge(OMA_ROW, { ...OMA_FILE, durationSec: undefined }), 'artist')
  })
  it('the clock still holds', () => {
    rejected(judge(OMA_ROW, { ...OMA_FILE, durationSec: 240 }), 'duration')
    rejected(judge(RICHARD_ROW, { ...RICHARD_FILE, durationSec: 300 }), 'duration')
  })
  it('the file is held to the whole title: its brackets count', () => {
    assert.equal(judge(RICHARD_ROW, { ...RICHARD_FILE, title: 'Feels Alright (Dub Mix)', durationSec: 533 }).verdict, 'reject')
    assert.equal(judge(RICHARD_ROW, { ...RICHARD_FILE, title: 'Feels Alright', durationSec: 533 }).verdict, 'reject')
    assert.equal(judge(OMA_ROW, { ...OMA_FILE, title: 'Rapp Snitch Knishes (Live)' }).verdict, 'reject')
    assert.equal(judge(OMA_ROW, { ...OMA_FILE, title: 'Rapp Snitch Knishes Reprise' }).verdict, 'reject')
  })
  it('brackets that are no version word still count on a file: part one is not part two', () => {
    const row = { title: 'Bliss (Part One)', artist: 'Richard F.' }
    rejected(judge(row, { provider: 'qobuz', title: 'Bliss (Part Two)', artist: 'F. Richard', album: 'X' }), 'artist')
    assert.equal(judge(row, { provider: 'qobuz', title: 'Bliss (Part One)', artist: 'F. Richard', album: 'X' }).verdict, 'exact')
  })
  it('a title that only reads like the song is refused, by the same name', () => {
    rejected(judge({ title: 'Feels Alright', artist: 'Richard F.' }, { provider: 'qobuz', title: 'Feels Alright Now', artist: 'F. Richard', album: 'X' }), 'artist')
  })
  it('a file with no title tag holds nothing', () => {
    rejected(judge(RICHARD_ROW, { provider: 'qobuz', artist: 'F. Richard', durationSec: 533 }), 'artist')
  })
  it('labels on the request are still labels', () => {
    assert.equal(judge({ title: 'Bliss (feat. Fears)', artist: 'Richard F.' }, { provider: 'qobuz', title: 'Bliss', artist: 'F. Richard', album: 'X' }).verdict, 'exact')
  })
  it('a title with nothing to compare holds nothing', () => {
    assert.equal(judge({ title: '???', artist: 'Richard F.' }, { provider: 'qobuz', title: '!!!', artist: 'F. Richard', album: 'X' }).verdict, 'reject')
    rejected(judge({ title: '???', artist: 'Richard F.' }, { provider: 'qobuz', title: '???', artist: 'F. Richard', album: 'X' }), 'artist')
  })
  it('Qobuz only: Bandcamp and SoundCloud stay as they were', () => {
    for (const provider of ['bandcamp', 'soundcloud'] as const) {
      rejected(judge(OMA_ROW, { ...OMA_FILE, provider }), 'artist')
      rejected(judge(RICHARD_ROW, { ...RICHARD_FILE, provider }), 'artist')
    }
  })
  it('SoundCloud’s own rule is untouched: an uploader, with the artist in the title', () => {
    assert.equal(judge(RICHARD_ROW, { provider: 'soundcloud', title: 'Richard F. - Feels Alright (Vocal Mix)', artist: 'Some Label', durationSec: 533 }).verdict, 'exact')
  })
  it('someone else is still someone else', () => {
    rejected(judge(OMA_ROW, { ...OMA_FILE, artist: 'Oman' }), 'artist')
    rejected(judge(RICHARD_ROW, { ...RICHARD_FILE, artist: 'Frank Richard' }), 'artist')
  })
})

const FAKE_RIP = `#!/bin/sh
echo "rip $*" >> "$FAKE_WORLD/calls.log"
if [ "$1" = "--version" ]; then echo "rip, version 2.1.0"; exit 0; fi
if [ "$1" = "search" ]; then
  # rip search -o <file> -n <n> <source> <type> <query>
  if [ -f "$FAKE_WORLD/search-$6-$7.json" ]; then cp "$FAKE_WORLD/search-$6-$7.json" "$3"; exit 0; fi
  echo "No search results found for query $8"; exit 0
fi
# rip --folder <dir> --quality 4 --no-db --no-progress id <source> <type> <id>
cp "$FAKE_WORLD/audio.bin" "$2/track.flac"
`
const FAKE_FFPROBE = `#!/bin/sh
cat "$FAKE_WORLD/probe.json"
`

describe('walked through the real handler', () => {
  let machine = ''
  let world = ''
  let fetched: string[] = []
  let albumAnswer: unknown = {}
  const realFetch = globalThis.fetch
  const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }

  const put = (name: string, body: string | Uint8Array): void => writeFileSync(join(world, name), body)
  const searchAnswers = (source: string, mediaType: string, descs: string[]): void =>
    put(`search-${source}-${mediaType}.json`, JSON.stringify(descs.map((desc, i) => ({ source, media_type: mediaType, id: String(i + 1), desc }))))
  const fileIs = (f: { title: string; artist: string; album: string; durationSec: number }): void =>
    put('probe.json', JSON.stringify({ format: { duration: String(f.durationSec), tags: { title: f.title, artist: f.artist, album: f.album } } }))
  const fetches = (): string[] => existsSync(join(world, 'calls.log'))
    ? readFileSync(join(world, 'calls.log'), 'utf-8').split('\n').filter((l) => l.startsWith('rip --folder '))
    : []

  interface WalkResult { ok: boolean; outcome?: string; matchDesc?: string; error?: string }
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
      mbUserAgent: 'jt-credit-test',
    } as never)
    return {
      imported,
      walk: async (opts: Record<string, unknown>): Promise<WalkResult> =>
        await handlers.get('streamrip:download-by-query')!({}, opts) as WalkResult,
    }
  }

  // The fakes go in once and run once: a program macOS has not seen can pass the
  // store's 10 s limit on its first run, under load.
  before(() => {
    machine = mkdtempSync(join(tmpdir(), 'jt-credit-'))
    const pipx = join(machine, 'home', '.local', 'bin'), bin = join(machine, 'bin')
    mkdirSync(pipx, { recursive: true })
    mkdirSync(bin)
    writeFileSync(join(pipx, 'rip'), FAKE_RIP)
    writeFileSync(join(bin, 'ffprobe'), FAKE_FFPROBE)
    chmodSync(join(pipx, 'rip'), 0o755)
    chmodSync(join(bin, 'ffprobe'), 0o755)
    const config = join(machine, 'home', 'Library', 'Application Support', 'streamrip')
    mkdirSync(config, { recursive: true })
    writeFileSync(join(config, 'config.toml'), '[qobuz]\napp_id = "1"\npassword_or_token = "not-a-token"\n')
    process.env.HOME = join(machine, 'home')
    process.env.PATH = `${bin}:/usr/bin:/bin`
    process.env.FAKE_WORLD = machine
    writeFileSync(join(machine, 'probe.json'), '{}')
    execFileSync(join(pipx, 'rip'), ['--version'])
    execFileSync(join(bin, 'ffprobe'))
  })
  after(() => {
    process.env.HOME = savedEnv.HOME
    process.env.PATH = savedEnv.PATH
    rmSync(machine, { recursive: true, force: true })
  })

  beforeEach(() => {
    world = mkdtempSync(join(machine, 'world-'))
    mkdirSync(join(world, 'tmp'))
    process.env.TMPDIR = join(world, 'tmp')
    process.env.FAKE_WORLD = world
    put('audio.bin', new Uint8Array(100 * 1024))
    fetched = []
    albumAnswer = {}
    mock.method(console, 'warn', () => {})
    mock.method(console, 'log', () => {})
    globalThis.fetch = (async (url: string | URL) => {
      fetched.push(String(url))
      if (String(url).includes('/album/get')) return new Response(JSON.stringify(albumAnswer), { status: 200 })
      return new Response('', { status: 404 })
    }) as typeof fetch
  })
  afterEach(() => {
    mock.restoreAll()
    globalThis.fetch = realFetch
    if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedEnv.TMPDIR
    rmSync(world, { recursive: true, force: true })
  })

  const OMA_TAGS = { title: OMA_FILE.title, artist: OMA_FILE.artist, album: OMA_FILE.album, durationSec: OMA_FILE.durationSec }
  const RICHARD_TAGS = { title: RICHARD_FILE.title, artist: RICHARD_FILE.artist, album: RICHARD_FILE.album, durationSec: RICHARD_FILE.durationSec }

  it('OMA & SitarNik: the row has a length, so "Oma" is fetched, judged and imported', async () => {
    searchAnswers('qobuz', 'track', ['Rapp Snitch Knishes (Sitar Edition) by Oma'])
    fileIs(OMA_TAGS)
    const { walk, imported } = store()
    const r = await walk(OMA_ROW)
    assert.equal(r.outcome, 'imported', r.error)
    assert.equal(imported.length, 1)
    assert.equal(r.matchDesc, 'Rapp Snitch Knishes (Sitar Edition) by Oma')
  })

  it('the same row with no length: "Oma" is not even fetched', async () => {
    searchAnswers('qobuz', 'track', ['Rapp Snitch Knishes (Sitar Edition) by Oma'])
    fileIs(OMA_TAGS)
    const { walk, imported } = store()
    const r = await walk({ ...OMA_ROW, durationMs: undefined })
    assert.equal(r.ok, false)
    assert.deepEqual(fetches(), [])
    assert.deepEqual(imported, [])
  })

  it('a clean row has no length to hold "Oma" to either', async () => {
    searchAnswers('qobuz', 'track', ['Rapp Snitch Knishes (Sitar Edition) by Oma'])
    fileIs(OMA_TAGS)
    const { walk, imported } = store()
    const r = await walk({ ...OMA_ROW, cleanedSource: true })
    assert.equal(r.ok, false)
    assert.deepEqual(fetches(), [])
    assert.deepEqual(imported, [])
  })

  it('the file is still held to the row: another length stays out of the library', async () => {
    searchAnswers('qobuz', 'track', ['Rapp Snitch Knishes (Sitar Edition) by Oma'])
    fileIs({ ...OMA_TAGS, durationSec: 240 })
    const { walk, imported } = store()
    const r = await walk(OMA_ROW)
    assert.equal(r.outcome, 'exact-not-found')
    assert.equal(fetches().length, 1)
    assert.deepEqual(imported, [])
  })

  it('Richard F.: a summary with no version is fetched, and the tags say which mix it is', async () => {
    searchAnswers('qobuz', 'track', ['Feels Alright by F. Richard'])
    fileIs(RICHARD_TAGS)
    const { walk, imported } = store()
    const r = await walk(RICHARD_ROW)
    assert.equal(r.outcome, 'imported', r.error)
    assert.equal(imported.length, 1)
  })

  it('Richard F.: the word order needs no length', async () => {
    searchAnswers('qobuz', 'track', ['Feels Alright by F. Richard'])
    fileIs(RICHARD_TAGS)
    const r = await store().walk({ ...RICHARD_ROW, durationMs: undefined })
    assert.equal(r.outcome, 'imported', r.error)
  })

  it('Richard F.: another mix under the same summary is refused', async () => {
    searchAnswers('qobuz', 'track', ['Feels Alright by F. Richard'])
    fileIs({ ...RICHARD_TAGS, title: 'Feels Alright (Dub Mix)' })
    const { walk, imported } = store()
    const r = await walk(RICHARD_ROW)
    assert.equal(r.outcome, 'exact-not-found')
    assert.deepEqual(imported, [])
  })

  it('the album door opens on the word order', async () => {
    searchAnswers('qobuz', 'album', ['Feels Alright by F. Richard'])
    albumAnswer = { title: 'Feels Alright', artist: { name: 'F. Richard' }, tracks: { items: [
      { id: 7, title: 'Feels Alright', version: 'Dub Mix', duration: 410 },
      { id: 8, title: 'Feels Alright', version: 'Vocal Mix', duration: 533 },
    ] } }
    fileIs(RICHARD_TAGS)
    const { walk, imported } = store()
    const r = await walk(RICHARD_ROW)
    assert.equal(r.outcome, 'imported', r.error)
    assert.equal(imported.length, 1)
    assert.match(fetches()[0] ?? '', / id qobuz track 8$/)
  })

  it('the album door stays shut on a part: an album row has no length to answer to', async () => {
    searchAnswers('qobuz', 'album', ['Rapp Snitch Knishes (Sitar Edition) by Oma'])
    fileIs(OMA_TAGS)
    const { walk, imported } = store()
    const r = await walk(OMA_ROW)
    assert.equal(r.ok, false)
    assert.equal(fetched.filter((u) => u.includes('/album/get')).length, 0)
    assert.deepEqual(fetches(), [])
    assert.deepEqual(imported, [])
  })

  it('a whole album is left as it was: its own judge holds to the name', async () => {
    searchAnswers('qobuz', 'album', ['Feels Alright by F. Richard'])
    const { walk, imported } = store()
    const r = await walk({ artist: 'Richard F.', album: 'Feels Alright' })
    assert.equal(r.ok, false)
    assert.equal(fetched.filter((u) => u.includes('/album/get')).length, 0)
    assert.deepEqual(fetches(), [])
    assert.deepEqual(imported, [])
  })
})
