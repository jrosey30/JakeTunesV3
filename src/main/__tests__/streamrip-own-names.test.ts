/**
 * Two wrong refusals, on the rows that found them (JakeTunesMobile Brief 236): a band's own name,
 * and an artist's own album. Hits and answers are what Qobuz and Apple really said on 2026-11-05.
 *
 * The walks at the end run the real `streamrip:download-by-query` handler. Only the outside world
 * is faked: `rip` and `ffprobe` are small scripts, HOME is a temp folder, and fetch answers for
 * Qobuz and Apple.
 *
 * ⚠️ TWIN: JakeTunesMobile/backend/src/util/__tests__/streamripOwnNames.test.ts, the same cases on the phone.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRequestedAlbum, verifyAlbumCandidate } from '../album-identity.ts'
import { buildRequestedRecording, expectedRuntimes, judgeHitsByMeta, verifyCandidate, type AppleSongRow, type CandidateEvidence } from '../exact-recording.ts'
import { hitsByAnotherName, isCompilationCopy, isCoverRelease, rankStreamripCandidates, type QobuzTrackMeta, type StreamripSearchHit } from '../streamrip-match.ts'
import { artistOrAlias, recoArtistMatches, sameArtistName } from '../reco-match.ts'
import { dedupeSuggestions } from '../../renderer/listen-to-the-list/store.ts'
import { recoToQueueResult } from '../../renderer/listen-to-the-list/ltlDownload.ts'

// The store reaches state-dir.ts, which asks electron for userData. The same stub the
// headless scripts use; state-dir reads it once, at import.
const userData = mkdtempSync(join(tmpdir(), 'jt-own-names-userdata-'))
process.env.JT_USER_DATA = userData
register('../../../scripts/concert/electron-hooks.mjs', import.meta.url)
const { registerStreamripStore } = await import('../streamrip-store/index.ts')
after(() => rmSync(userData, { recursive: true, force: true }))

const hit = (id: string, desc: string): StreamripSearchHit => ({ source: 'qobuz', mediaType: 'track', id, desc })
type Row = Parameters<typeof buildRequestedRecording>[0]
const judge = (row: Row, file: CandidateEvidence) => verifyCandidate(buildRequestedRecording(row), file)
const reason = (v: ReturnType<typeof judge>): string => (v.verdict === 'exact' ? '' : v.reason)
const judged = (row: Row, hits: StreamripSearchHit[], meta: Record<string, QobuzTrackMeta>) =>
  judgeHitsByMeta(buildRequestedRecording(row), hits, new Map(Object.entries(meta)), new Set())

// Listen List row 104, Qobuz track 8753747 and the one row Apple lists for it.
const WATER = { title: "Even When the Water's Cold", artist: '!!!', album: 'Thr!!!er' }
const WATER_FILE = { provider: 'qobuz', title: "Even When The Water's Cold", artist: '!!!', album: 'Thr!!!er', albumArtist: '!!!', durationSec: 227 } satisfies CandidateEvidence
const WATER_ROW: AppleSongRow = { title: "Even When the Water's Cold", artist: '!!!', album: 'Thr!!!er', durationSec: 227.1 }
const WATER_META: QobuzTrackMeta = { title: "Even When The Water's Cold", album: 'Thr!!!er', albumArtist: '!!!', durationSec: 227, parentalWarning: false, albumParentalWarning: false, version: null }

// Two jots with no album, and Qobuz's tracks 243437261 and 243437265.
const COVERS_ALBUM = 'On Top of The Covers (Live from The Sun Rose)'
const THATS_LIFE = { title: "That's Life (Live)", artist: 'T-Pain' }
const THATS_LIFE_FILE = { provider: 'qobuz', title: "That's Life (Live)", artist: 'T-Pain', album: COVERS_ALBUM, albumArtist: 'T-Pain', durationSec: 296 } satisfies CandidateEvidence
const THATS_LIFE_META: QobuzTrackMeta = { title: "That's Life", version: 'Live', album: COVERS_ALBUM, albumArtist: 'T-Pain', durationSec: 296, parentalWarning: true, albumParentalWarning: true }
const NEVER_TOO_MUCH = { title: 'Never Too Much (Live)', artist: 'T-Pain' }
const NEVER_TOO_MUCH_META: QobuzTrackMeta = { title: 'Never Too Much', version: 'Live', album: COVERS_ALBUM, albumArtist: 'T-Pain', durationSec: 68, parentalWarning: true, albumParentalWarning: true }

describe('a name with no letters to fold is compared as written', () => {
  it('the band is itself', () => {
    assert.equal(sameArtistName('!!!', '!!!'), true)
    assert.equal(sameArtistName(' !!! ', '!!!'), true)
    assert.equal(recoArtistMatches('!!!', '!!!'), true)
    assert.equal(recoArtistMatches('+/-', '+/-'), true)
    assert.equal(artistOrAlias('!!!', '!!!'), true)
  })
  it('and nobody else', () => {
    for (const [a, b] of [['!!!', '???'], ['!!!', '!!!!'], ['!!!', ''], ['', '!!!'], ['!!!', 'Radiohead'], ['Radiohead', '!!!']] as const) {
      assert.equal(sameArtistName(a, b), false, `${a} / ${b}`)
      assert.equal(recoArtistMatches(a, b), false, `${a} / ${b}`)
    }
    assert.equal(artistOrAlias('!!!', '???'), false)
  })
  it('an empty name is no name, however many spaces it has', () => {
    assert.equal(sameArtistName('', ''), false)
    assert.equal(sameArtistName('  ', '  '), false)
    assert.equal(recoArtistMatches('', ''), false)
    assert.equal(recoArtistMatches('  ', '  '), false)
  })
  it('no letters means no containment: four marks do not hold three', () => {
    assert.equal(recoArtistMatches('!!!!', '!!!!!'), false)
    assert.equal(recoArtistMatches('----', '-----'), false)
  })
  it('a name with letters goes on as it did', () => {
    assert.equal(sameArtistName('Sigur Rós', 'SIGUR ROS'), true)
    assert.equal(sameArtistName('T-Pain', 't pain'), true)
    assert.equal(sameArtistName('Rihanna', 'Rihanna & Calvin Harris'), false, 'the same name, not a name that contains it')
    assert.equal(recoArtistMatches('Rihanna', 'Rihanna & Calvin Harris'), true)
    assert.equal(recoArtistMatches('Sia', 'Asia'), false, 'under four letters only whole')
  })
})

describe('the Listen List twin of the rule', () => {
  const onList = (artist: string): boolean => dedupeSuggestions(
    [{ song: "Even When the Water's Cold", artist }] as never,
    [{ song: "Even When the Water's Cold", artist: '!!!' }] as never,
  ).length === 0
  it('a band with no letters is already on the list', () => assert.equal(onList('!!!'), true))
  it('and nobody else is', () => assert.equal(onList('???'), false))
})

describe('"Even When the Water\'s Cold" by !!!', () => {
  it('the file passes, and so does what Qobuz says about it', () => {
    assert.equal(judge(WATER, WATER_FILE).verdict, 'exact')
    const v = judged(WATER, [hit('8753747', "Even When The Water's Cold by !!!")], { 8753747: WATER_META })
    assert.deepEqual(v.wrongRecording, [])
    assert.deepEqual(v.kept.map((h) => h.id), ['8753747'])
  })
  it('someone else with no letters is refused', () => {
    const v = judge(WATER, { ...WATER_FILE, artist: '???' })
    assert.equal(v.verdict, 'reject')
    assert.match(reason(v), /by “\?\?\?”, not !!!/)
  })
  it('ranks the band and only the band, and asks MusicBrainz nothing', () => {
    const own = hit('own', "Even When the Water's Cold by !!!"), other = hit('other', "Even When the Water's Cold by ???")
    assert.deepEqual(rankStreamripCandidates(WATER.title, '!!!', [other, own]).ranked.map((h) => h.id), ['own'])
    assert.equal(hitsByAnotherName(WATER.title, '!!!', [own]), false)
    assert.equal(hitsByAnotherName(WATER.title, '!!!', [other]), true)
  })
  it('the band\'s own album is no compilation', () => {
    assert.equal(isCompilationCopy(WATER, { albumArtist: '!!!' }), false)
    assert.equal(isCompilationCopy(WATER, { albumArtist: '???' }), true)
    assert.equal(isCompilationCopy(WATER, { albumArtist: 'Various Artists' }), true)
  })
  it('Apple\'s row for the band sets the clock, and a stranger\'s does not', () => {
    const lengths = (rows: AppleSongRow[]): number[] => expectedRuntimes(WATER, rows).map((r) => r.sec)
    assert.deepEqual(lengths([WATER_ROW]), [227.1])
    assert.deepEqual(lengths([{ ...WATER_ROW, artist: '???', durationSec: 300 }]), [])
    const v = judge({ ...WATER, runtimes: [{ sec: 227.1, tolSec: 5 }] }, { ...WATER_FILE, durationSec: 300 })
    assert.equal(v.verdict, 'reject')
    assert.match(reason(v), /runs 5:00/)
  })
  it('the whole album is the band\'s too', () => {
    const req = buildRequestedAlbum({ artist: '!!!', title: 'Thr!!!er' })
    const album = (artist: string) => verifyAlbumCandidate(req, { provider: 'qobuz', desc: `Thr!!!er by ${artist}`, title: 'Thr!!!er', artist, trackCount: 9 })
    assert.notEqual(album('!!!').verdict, 'reject')
    const other = album('???')
    assert.equal(other.verdict === 'reject' && other.kind, 'artist')
  })
})

describe('an album of the artist\'s own can say "covers"', () => {
  it('both of Jake\'s, by name', () => {
    assert.equal(isCoverRelease(COVERS_ALBUM, 'T-Pain', 'T-Pain'), false)
    assert.equal(isCoverRelease('Under Cover', 'Ozzy Osbourne', 'Ozzy Osbourne'), false)
    assert.equal(isCoverRelease('Covers', '!!!', '!!!'), false, 'a name with no letters is a name')
  })
  it('it takes the whole name', () => {
    assert.equal(isCoverRelease(COVERS_ALBUM, 'T-Pain Tribute Band', 'T-Pain'), true)
    assert.equal(isCoverRelease('The Beatles Covers', 'The Beatles Revival Band', 'The Beatles'), true, 'the artist test lets this name through')
    assert.equal(isCoverRelease('Covers', '???', '!!!'), true)
    assert.equal(isCoverRelease(COVERS_ALBUM, 'Various Artists', 'T-Pain'), true)
  })
  it('with no credit to read, nothing has changed', () => {
    assert.equal(isCoverRelease(COVERS_ALBUM, undefined, 'T-Pain'), true)
    assert.equal(isCoverRelease(COVERS_ALBUM, '', 'T-Pain'), true)
    assert.equal(isCoverRelease(COVERS_ALBUM, '', ''), true, 'nor does no name count as the same name')
    assert.equal(isCoverRelease(COVERS_ALBUM, 'T-Pain', ''), true)
  })
  it('a real tribute album stays one, under any credit', () => {
    const lullaby = 'Collide With the Night Sky: Lullaby covers of Pierce the Veil songs'
    assert.equal(isCoverRelease(lullaby, 'Sparrow Sleeps', 'Pierce the Veil'), true)
    assert.equal(isCoverRelease('We Found Love (Rihanna feat. Calvin Harris Tribute) - Single', 'Power Star', 'Rihanna'), true)
  })
  it('asked for by that act\'s own name, it is what was asked for', () => {
    assert.equal(isCoverRelease('Collide With the Night Sky: Lullaby covers of Pierce the Veil songs', 'Sparrow Sleeps', 'Sparrow Sleeps'), false)
  })
  it('every other word still counts on the artist\'s own album', () => {
    for (const album of [
      'Southern By The Grace Of God: Lynyrd Skynyrd Tribute Tour 1987',
      'Tribute',
      'Karaoke Hits',
      'Covers in the Style of Rihanna',
      'Rihanna Covers (Karaoke Version)',
      'Backing Track Covers',
      'The Cover Band',
      'Cover Version',
      'Instrumental Version',
    ]) assert.equal(isCoverRelease(album, 'Rihanna', 'Rihanna'), true, album)
  })
  it('both spellings of the word, in any case, whole words only', () => {
    for (const album of ['COVERS', 'covers', 'Cover', 'Greatest Covers Vol. 2', 'Covers, Covers, Covers']) assert.equal(isCoverRelease(album, 'Band', 'Band'), false, album)
    assert.equal(isCoverRelease('Discover', 'Someone Else', 'Band'), false, 'never was one')
  })
  it('an album with no such word was never one', () => {
    assert.equal(isCoverRelease('Talk That Talk', 'Rihanna', 'Rihanna'), false)
    assert.equal(isCoverRelease('Talk That Talk', 'Someone Else', 'Rihanna'), false)
  })
})

describe('T-Pain\'s two songs, through the judge', () => {
  it('both files pass', () => {
    assert.equal(judge(THATS_LIFE, THATS_LIFE_FILE).verdict, 'exact')
    assert.equal(judge(NEVER_TOO_MUCH, { provider: 'qobuz', title: 'Never Too Much (Live)', artist: 'T-Pain', album: COVERS_ALBUM, albumArtist: 'T-Pain', durationSec: 68 }).verdict, 'exact')
  })
  it('both pass on what Qobuz says, before a byte moves', () => {
    const one = judged(THATS_LIFE, [hit('243437261', "That's Life by T-Pain")], { 243437261: THATS_LIFE_META })
    assert.deepEqual(one.wrongRecording, [])
    assert.deepEqual(one.kept.map((h) => h.id), ['243437261'])
    assert.deepEqual(judged(NEVER_TOO_MUCH, [hit('243437265', 'Never Too Much by T-Pain')], { 243437265: NEVER_TOO_MUCH_META }).kept.map((h) => h.id), ['243437265'])
  })
  it('a file that doesn\'t say who the album is by is refused, as it was', () => {
    assert.match(reason(judge(THATS_LIFE, { ...THATS_LIFE_FILE, albumArtist: undefined })), /cover or tribute release/)
    assert.match(reason(judge(THATS_LIFE, { ...THATS_LIFE_FILE, albumArtist: '' })), /cover or tribute release/)
  })
  it('a hit Qobuz gives no album credit for is refused, as it was', () => {
    const { albumArtist: _, ...noCredit } = THATS_LIFE_META
    assert.deepEqual(judged(THATS_LIFE, [hit('243437261', "That's Life by T-Pain")], { 243437261: noCredit }).kept, [])
  })
  it('the album\'s word doesn\'t let the wrong cut through: a plain request is not the live one', () => {
    const live = judge({ title: 'Buy U a Drank', artist: 'T-Pain' }, { provider: 'qobuz', title: 'Buy U A Drank (Live)', artist: 'T-Pain', album: COVERS_ALBUM, albumArtist: 'T-Pain' })
    assert.equal(live.verdict, 'reject')
    assert.match(reason(live), /live/i)
    const long = judge({ ...THATS_LIFE, runtimes: [{ sec: 296.2, tolSec: 5 }] }, { ...THATS_LIFE_FILE, durationSec: 400 })
    assert.match(reason(long), /runs 6:40/)
  })
  it('someone else on the album is still someone else', () => {
    assert.equal(judge({ title: "That's Life", artist: 'Frank Sinatra' }, { ...THATS_LIFE_FILE, title: "That's Life" }).verdict, 'reject')
  })
})

// Listen List rows 219 and 60: what Jake jotted, and what Apple's match made of it. Both albums are
// credited to the act the match names, so only who was asked for tells them from T-Pain's.
const SPARROW_ALBUM = 'Collide With the Night Sky: Lullaby covers of Pierce the Veil songs'
const SPARROW_REC = { song: 'Floral & Fading', artist: 'Pierce the Veil', album: 'Misadventures', matchedTitle: 'Floral and Fading', matchedArtist: 'Sparrow Sleeps', matchedAlbum: SPARROW_ALBUM }
const SPARROW_ROW = { title: 'Floral and Fading', artist: 'Sparrow Sleeps', album: SPARROW_ALBUM }
const SPARROW_FILE = { provider: 'qobuz', title: 'Floral and Fading', artist: 'Sparrow Sleeps', album: SPARROW_ALBUM, albumArtist: 'Sparrow Sleeps', durationSec: 232 } satisfies CandidateEvidence
const SPARROW_META: QobuzTrackMeta = { title: 'Floral and Fading', album: SPARROW_ALBUM, albumArtist: 'Sparrow Sleeps', durationSec: 232, parentalWarning: false, albumParentalWarning: false, version: null }
const EIGHT_D_ROW = { title: "It's Called: Freefall (8D Audio)", artist: '8waves', album: '8D Audios of Popular Covers Vol. 7' }
const EIGHT_D_FILE = { provider: 'qobuz', title: "It's Called: Freefall (8D Audio)", artist: '8waves', album: '8D Audios Of Popular Covers Vol. 7', albumArtist: '8waves', durationSec: 149 } satisfies CandidateEvidence

describe('who was asked for, not who Apple matched', () => {
  it('a Listen List row sends the artist it names, whatever the match says', () => {
    const d = recoToQueueResult({ id: 'r', createdAt: '2026-11-05T04:14:15Z', ...SPARROW_REC } as never)
    assert.equal(d.kind, 'queue')
    if (d.kind !== 'queue') return
    assert.equal(d.result.askedArtist, 'Pierce the Veil')
    const none = recoToQueueResult({ id: 'r', createdAt: '2026-11-05T04:14:15Z', song: 'Song', matchedTitle: 'Song', matchedArtist: 'Band' } as never)
    assert.equal(none.kind === 'queue' && none.result.askedArtist, '', 'a row that names nobody asked for nobody')
  })
  it('the lullaby album stays out of the row that asked for Pierce the Veil', () => {
    assert.match(reason(judge({ ...SPARROW_ROW, askedArtist: 'Pierce the Veil' }, SPARROW_FILE)), /tribute release/)
  })
  it('so does the 8D album, for Rainbow Kitten Surprise', () => {
    assert.match(reason(judge({ ...EIGHT_D_ROW, askedArtist: 'Rainbow Kitten Surprise' }, EIGHT_D_FILE)), /tribute release/)
  })
  it('a row with no artist of its own vouches for nobody\'s album', () => {
    assert.match(reason(judge({ ...THATS_LIFE, askedArtist: '' }, THATS_LIFE_FILE)), /tribute release/)
    assert.match(reason(judge({ ...THATS_LIFE, askedArtist: '   ' }, THATS_LIFE_FILE)), /tribute release/)
  })
  it('asked for by name, T-Pain and that act are what was asked for', () => {
    assert.equal(judge({ ...THATS_LIFE, askedArtist: ' T-Pain ' }, THATS_LIFE_FILE).verdict, 'exact')
    assert.equal(judge({ ...THATS_LIFE, askedArtist: 't pain' }, THATS_LIFE_FILE).verdict, 'exact')
    assert.equal(judge({ ...SPARROW_ROW, askedArtist: 'Sparrow Sleeps' }, SPARROW_FILE).verdict, 'exact')
  })
  it('a row Jake clicked is asked for by its own artist', () => {
    assert.equal(judge(SPARROW_ROW, SPARROW_FILE).verdict, 'exact')
    assert.equal(buildRequestedRecording(SPARROW_ROW).askedArtist, undefined)
  })
  it('Qobuz\'s answer goes the same way, before a byte moves', () => {
    const hits = [hit('239857231', 'Floral and Fading by Sparrow Sleeps')]
    assert.deepEqual(judged({ ...SPARROW_ROW, askedArtist: 'Pierce the Veil' }, hits, { 239857231: SPARROW_META }).kept, [])
    assert.deepEqual(judged({ ...SPARROW_ROW, askedArtist: 'Sparrow Sleeps' }, hits, { 239857231: SPARROW_META }).kept.map((h) => h.id), ['239857231'])
  })
})

describe('a real tribute hit, through the judge', () => {
  const WANT = { title: 'We Found Love', artist: 'Rihanna' }
  const FILE = { provider: 'qobuz', title: 'We Found Love', artist: 'Rihanna' } satisfies CandidateEvidence
  it('a stranger\'s album is refused for its word, whatever the file says it is called', () => {
    assert.match(reason(judge(WANT, { ...FILE, album: 'We Found Love (Rihanna Tribute) - Single', albumArtist: 'Power Star' })), /\(tribute\)/)
    assert.match(reason(judge(WANT, { ...FILE, album: 'Rihanna Covers', albumArtist: 'Power Star' })), /tribute release/)
  })
  it('credited to the artist, "tribute" and "karaoke" are refused all the same', () => {
    assert.match(reason(judge(WANT, { ...FILE, album: 'Tribute to Rihanna', albumArtist: 'Rihanna' })), /tribute release/)
    assert.match(reason(judge(WANT, { ...FILE, album: 'Karaoke Hits', albumArtist: 'Rihanna' })), /\(karaoke\)/)
    assert.match(reason(judge(WANT, { ...FILE, album: 'In the Style of Rihanna', albumArtist: 'Rihanna' })), /tribute release/)
  })
  it('a lane with no catalogue writes its own credits, so its album names stand', () => {
    for (const provider of ['bandcamp', 'soundcloud'] as const) {
      assert.match(reason(judge(THATS_LIFE, { ...THATS_LIFE_FILE, provider })), /tribute release/, provider)
    }
  })
  it('asking for a cover by name goes on as it did', () => {
    assert.equal(judge({ title: 'Song (Cover)', artist: 'Band' }, { provider: 'qobuz', title: 'Song (Cover)', artist: 'Band', album: 'Rihanna Covers', albumArtist: 'Someone Else' }).verdict, 'exact')
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
  let answers: Record<string, QobuzTrackMeta & { artist?: string }> = {}
  const realFetch = globalThis.fetch
  const savedEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }

  const put = (name: string, body: string | Uint8Array): void => writeFileSync(join(world, name), body)
  const searchAnswers = (hits: Array<[id: string, desc: string]>): void =>
    put('search-qobuz-track.json', JSON.stringify(hits.map(([id, desc]) => ({ source: 'qobuz', media_type: 'track', id, desc }))))
  /** What ffprobe reads off the file. `album_artist` left out: a file that doesn't say. */
  const fileIs = (f: { title: string; artist: string; album: string; albumArtist?: string; durationSec: number }): void => {
    const tags = { title: f.title, artist: f.artist, album: f.album, ...(f.albumArtist !== undefined ? { album_artist: f.albumArtist } : {}) }
    put('probe.json', JSON.stringify({ format: { duration: String(f.durationSec), tags } }))
  }
  const fetches = (): string[] => existsSync(join(world, 'calls.log'))
    ? readFileSync(join(world, 'calls.log'), 'utf-8').split('\n').filter((l) => l.startsWith('rip --folder '))
    : []

  interface WalkResult { ok: boolean; outcome?: string; matchDesc?: string; error?: string; detail?: string }
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
      mbUserAgent: 'jt-own-names-test',
    } as never)
    return {
      imported,
      walk: async (opts: Record<string, unknown>): Promise<WalkResult> =>
        await handlers.get('streamrip:download-by-query')!({}, opts) as WalkResult,
    }
  }

  before(() => {
    machine = mkdtempSync(join(tmpdir(), 'jt-own-names-'))
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
    answers = {}
    mock.method(console, 'warn', () => {})
    mock.method(console, 'log', () => {})
    globalThis.fetch = (async (url: string | URL) => {
      const asked = /\/track\/get\?track_id=([^&]+)/.exec(String(url))?.[1]
      const m = asked ? answers[asked] : undefined
      if (!m) return new Response('', { status: 404 })
      return new Response(JSON.stringify({
        title: m.title, version: m.version ?? null, duration: m.durationSec, parental_warning: m.parentalWarning,
        album: { title: m.album, parental_warning: m.albumParentalWarning, artist: { name: m.albumArtist } },
      }), { status: 200 })
    }) as typeof fetch
  })
  afterEach(() => {
    mock.restoreAll()
    globalThis.fetch = realFetch
    if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedEnv.TMPDIR
    rmSync(world, { recursive: true, force: true })
  })

  const WATER_TAGS = { title: "Even When The Water's Cold", artist: '!!!', album: 'Thr!!!er', albumArtist: '!!!', durationSec: 227 }
  const LIFE_TAGS = { title: "That's Life (Live)", artist: 'T-Pain', album: COVERS_ALBUM, albumArtist: 'T-Pain', durationSec: 296 }

  it('!!!: the band\'s song lands', async () => {
    searchAnswers([['8753747', "Even When The Water's Cold by !!!"]])
    answers = { 8753747: WATER_META }
    fileIs(WATER_TAGS)
    const { walk, imported } = store()
    const r = await walk({ ...WATER, durationMs: 227_067 })
    assert.equal(r.outcome, 'imported', `${r.error} ${r.detail}`)
    assert.equal(imported.length, 1)
    assert.equal(fetches().length, 1)
  })

  it('!!!: another band with no letters is never fetched', async () => {
    searchAnswers([['1', "Even When The Water's Cold by ???"]])
    answers = { 1: { ...WATER_META, albumArtist: '???' } }
    fileIs({ ...WATER_TAGS, artist: '???', albumArtist: '???' })
    const { walk, imported } = store()
    const r = await walk({ ...WATER, durationMs: 227_067 })
    assert.equal(r.ok, false)
    assert.deepEqual(fetches(), [])
    assert.deepEqual(imported, [])
  })

  it('T-Pain: the artist\'s own album lands, on what Qobuz says and what the file says', async () => {
    searchAnswers([['243437261', "That's Life by T-Pain"]])
    answers = { 243437261: THATS_LIFE_META }
    fileIs(LIFE_TAGS)
    const { walk, imported } = store()
    const r = await walk(THATS_LIFE)
    assert.equal(r.outcome, 'imported', `${r.error} ${r.detail}`)
    assert.equal(imported.length, 1)
  })

  it('T-Pain: Qobuz gave no answer, and the file\'s tag still names T-Pain', async () => {
    searchAnswers([['243437261', "That's Life by T-Pain"]])
    fileIs(LIFE_TAGS)
    const { walk, imported } = store()
    const r = await walk(THATS_LIFE)
    assert.equal(r.outcome, 'imported', `${r.error} ${r.detail}`)
    assert.equal(imported.length, 1)
  })

  it('T-Pain: a file that doesn\'t say who the album is by stays out of the library', async () => {
    searchAnswers([['243437261', "That's Life by T-Pain"]])
    answers = { 243437261: THATS_LIFE_META }
    fileIs({ ...LIFE_TAGS, albumArtist: undefined })
    const { walk, imported } = store()
    const r = await walk(THATS_LIFE)
    assert.equal(r.ok, false)
    assert.equal(fetches().length, 1)
    assert.deepEqual(imported, [])
  })

  it('Apple matched the row to a lullaby act: Pierce the Veil\'s row does not get its tribute', async () => {
    searchAnswers([['239857231', 'Floral and Fading by Sparrow Sleeps']])
    answers = { 239857231: SPARROW_META }
    fileIs({ title: SPARROW_FILE.title, artist: SPARROW_FILE.artist, album: SPARROW_FILE.album, albumArtist: SPARROW_FILE.albumArtist, durationSec: SPARROW_FILE.durationSec })
    const { walk, imported } = store()
    const r = await walk({ ...SPARROW_ROW, askedArtist: 'Pierce the Veil' })
    assert.equal(r.ok, false)
    assert.deepEqual(fetches(), [])
    assert.deepEqual(imported, [])
    const asked = store()
    assert.equal((await asked.walk({ ...SPARROW_ROW, askedArtist: 'Sparrow Sleeps' })).outcome, 'imported', 'asked for by name, it lands')
  })

  it('the name the row gave reaches the file\'s own judge too', async () => {
    searchAnswers([['243437261', "That's Life by T-Pain"]])
    fileIs(LIFE_TAGS)
    const { walk, imported } = store()
    const r = await walk({ ...THATS_LIFE, askedArtist: 'Pierce the Veil' })
    assert.equal(r.ok, false)
    assert.equal(fetches().length, 1, 'Qobuz gave no answer, so it is fetched')
    assert.deepEqual(imported, [])
  })

  it('a stranger\'s covers album is never fetched, for all that its title reads the same', async () => {
    searchAnswers([['1', "That's Life by T-Pain"]])
    answers = { 1: { ...THATS_LIFE_META, albumArtist: 'T-Pain Tribute Band' } }
    fileIs({ ...LIFE_TAGS, albumArtist: 'T-Pain Tribute Band' })
    const { walk, imported } = store()
    const r = await walk(THATS_LIFE)
    assert.equal(r.ok, false)
    assert.deepEqual(fetches(), [])
    assert.deepEqual(imported, [])
  })
})
