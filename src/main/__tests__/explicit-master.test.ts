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
import { buildRequestedRecording, flagToJudge, judgeHitsByMeta, verifyCandidate } from '../exact-recording.ts'
import { isQobuzNoSuchItem, NO_EXPLICIT_WARNING, qobuzTrackMetaOf, saysExplicit, titleWithVersion, type QobuzTrackMeta } from '../streamrip-match.ts'

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

    test('it says whether an explicit copy is what it found', () => {
      assert.equal(judge(req(), two, { x: { parentalWarning: true } }).explicitOnQobuz, true)
      assert.equal(judge(req({ explicitSource: true }), two, { x: { parentalWarning: false } }).explicitOnQobuz, false, 'the row says so, Qobuz does not')
    })

    test('what an earlier look found counts: the album door knows what the top hits said', () => {
      const looked = (explicitSeen: boolean) => judgeHitsByMeta(req(), [hit('door', 'Mask Off by Future')], new Map([['door', { parentalWarning: false, albumParentalWarning: true }]]), new Set(), explicitSeen)
      assert.deepEqual(ids(looked(true).refusedClean), ['door'], 'beside an explicit copy, a clean edit')
      assert.equal(looked(true).explicitMaster, true)
      assert.equal(looked(true).explicitOnQobuz, true)
      assert.deepEqual(ids(looked(false).kept), ['door'])
      assert.equal(looked(false).explicitMaster, false)
    })
  })
})

// By the audio, 2026-11-04: Qobuz's copies of "Passin' Me By", "Still Not a Player" and "Baba
// Says Cool for Thought" with no warning are the same as Jake's files, down to the waveform.
describe('flagToJudge: no warning is not censored', () => {
  test('on an album flagged explicit, with no explicit copy beside it, the flag says nothing', () => {
    assert.equal(flagToJudge({ parentalWarning: false, albumParentalWarning: true }, false), undefined)
  })
  test('beside an explicit copy it means a clean edit', () => {
    assert.equal(flagToJudge({ parentalWarning: false, albumParentalWarning: true }, true), false)
  })
  test('on an album with no warning, or with nothing known of the album, it stands', () => {
    assert.equal(flagToJudge({ parentalWarning: false, albumParentalWarning: false }, false), false)
    assert.equal(flagToJudge({ parentalWarning: false }, false), false)
  })
  test('an explicit flag, or none, is left as it is', () => {
    assert.equal(flagToJudge({ parentalWarning: true, albumParentalWarning: true }, false), true)
    assert.equal(flagToJudge({ albumParentalWarning: true }, false), undefined)
    assert.equal(flagToJudge(undefined, false), undefined)
  })
})

// The phone's live check against real Qobuz (Brief 223 §6, 2026-11-04). These answers are
// recorded ones: Paris, Tokyo's own album carries it flagged clean under the version
// "Explicit Album Version", and the only copies flagged explicit are on compilations.
describe('a copy that says it is the explicit cut is not the clean edition', () => {
  const paris = () => buildRequestedRecording({ artist: 'Lupe Fiasco', title: 'Paris, Tokyo', album: "Lupe Fiasco's The Cool" })
  const judge = (r: ReturnType<typeof paris>, hits: ReturnType<typeof hit>[], meta: Record<string, QobuzTrackMeta>) =>
    judgeHitsByMeta(r, hits, new Map(Object.entries(meta)), new Set())
  const ids = (hs: Array<{ id: string }>): string[] => hs.map((h) => h.id)
  const parisHit = (id: string) => hit(id, 'Paris, Tokyo by Lupe Fiasco')

  test('its own name, not any word that holds the letters', () => {
    for (const version of ['Explicit Album Version', 'feat. Nikki Jean   Explicit Album Version', 'album version (EXPLICIT)']) assert.equal(saysExplicit(undefined, version), true, version)
    for (const version of ['Non-Explicit Version', 'Non Explicit', 'Not Explicit', 'not-explicit', 'Inexplicit', 'Explicitly Yours', 'Album Version (Edited)', '', null]) assert.equal(saysExplicit(undefined, version), false, String(version))
    assert.equal(saysExplicit('Song (Non-Explicit Version)'), false)
    assert.equal(saysExplicit(), false)
  })

  test('Paris, Tokyo: the album\'s own copy stays, its clean twin does not', () => {
    const v = judge(paris(), ['own', 'clean', 'comp', 'hits'].map(parisHit), {
      own: { parentalWarning: false, albumParentalWarning: true, version: 'Explicit Album Version', album: "Lupe Fiasco's The Cool" },
      clean: { parentalWarning: false, albumParentalWarning: false, album: "Lupe Fiasco's The Cool" },
      comp: { parentalWarning: true, albumParentalWarning: true, album: 'late night hip-hop' },
      hits: { parentalWarning: false, albumParentalWarning: true, album: '00s Hip Hop Jams' },
    })
    assert.deepEqual(ids(v.kept), ['own', 'comp'])
    assert.deepEqual(ids(v.refusedClean), ['clean', 'hits'])
    assert.equal(v.explicitMaster, true)
  })

  test('a bracket in its title can say so as well as its version', () => {
    const v = judge(paris(), ['own', 'square', 'clean', 'comp'].map(parisHit), {
      own: { parentalWarning: false, title: 'Paris, Tokyo (Explicit)' },
      square: { parentalWarning: false, title: 'Paris, Tokyo [Explicit Version]' },
      clean: { parentalWarning: false, title: 'Paris, Tokyo (Non-Explicit Version)' },
      comp: { parentalWarning: true },
    })
    assert.deepEqual(ids(v.kept), ['own', 'square', 'comp'])
    assert.deepEqual(ids(v.refusedClean), ['clean'])
  })

  test('a song named with the word has said nothing: its clean edit is refused as before', () => {
    const named = buildRequestedRecording({ artist: 'Band', title: 'Explicit Content' })
    const songHit = (id: string) => hit(id, 'Explicit Content by Band')
    const v = judge(named, ['edit', 'labelled', 'master'].map(songHit), {
      edit: { parentalWarning: false, title: 'Explicit Content' },
      labelled: { parentalWarning: false, title: 'Explicit Content (Explicit)' },
      master: { parentalWarning: true, title: 'Explicit Content' },
    })
    assert.deepEqual(ids(v.refusedClean), ['edit'])
    assert.deepEqual(ids(v.kept), ['labelled', 'master'])
    assert.equal(saysExplicit('Explicit Content (Clean Version)'), false)
  })

  test('the name alone proves no master: only one album in the check does this', () => {
    const v = judge(paris(), ['own', 'clean'].map(parisHit), {
      own: { parentalWarning: false, version: 'Explicit Album Version' },
      clean: { parentalWarning: false },
    })
    assert.equal(v.explicitMaster, false)
    assert.deepEqual(ids(v.kept), ['own', 'clean'])
  })

  test('the file faces the same rule, by either name', () => {
    const asked = paris()
    asked.explicit = 'explicit'
    const verdict = (ev: Partial<Parameters<typeof verifyCandidate>[1]>) => verifyCandidate(asked, { provider: 'qobuz', artist: 'Lupe Fiasco', album: "Lupe Fiasco's The Cool", parentalWarning: false, ...ev }).verdict
    assert.equal(verdict({ title: 'Paris, Tokyo (Explicit Album Version)' }), 'exact', 'by the tag')
    assert.equal(verdict({ title: 'Paris, Tokyo', version: 'Explicit Album Version' }), 'exact', 'by the version field')
    assert.equal(verdict({ title: 'Paris, Tokyo' }), 'reject', 'no such word')
    assert.equal(verdict({ title: 'Paris, Tokyo', version: 'Non-Explicit Version' }), 'reject')
    const named = buildRequestedRecording({ artist: 'Band', title: 'Explicit Content' })
    named.explicit = 'explicit'
    assert.equal(verifyCandidate(named, { provider: 'qobuz', artist: 'Band', title: 'Explicit Content', parentalWarning: false }).verdict, 'reject', 'the song\'s own name')
  })
})

describe('labels from Qobuz\'s own version fields: the check found these refused on the phone', () => {
  const verdict = (title: string, artist: string, label: string) => {
    const r = buildRequestedRecording({ artist, title })
    return verifyCandidate(r, { provider: 'qobuz', title: `${title} (${label})`, artist, version: label })
  }
  test('each is the album cut here', () => {
    for (const [title, artist, label] of [
      ['Ups & Downs', 'Snoop Dogg', 'Album Version (Explicit) w/o interlude'],
      ['A Milli', 'Lil Wayne', '2008 Re-mastered Version'],
      ['Pinball Wizard', 'The Who', 'Original Album Version'],
    ]) assert.equal(verdict(title, artist, label).verdict, 'exact', label)
  })
  test('and a clean edit named the same way is still a clean edit', () => {
    assert.deepEqual(verdict('Ups & Downs', 'Snoop Dogg', 'Album Version (Edited) w/o interlude').verdict, 'reject')
  })
})

describe('reading what Qobuz answered', () => {
  test('a track/get answer, field by field', () => {
    assert.deepEqual(qobuzTrackMetaOf({ title: ' Mask Off ', parental_warning: true, duration: 204, version: 'Album Version', album: { title: 'FUTURE', parental_warning: false } }), {
      title: 'Mask Off', parentalWarning: true, albumParentalWarning: false, durationSec: 204, album: 'FUTURE', albumArtist: undefined, version: 'Album Version',
    })
  })

  test('absent or the wrong type stays unknown, never a verdict', () => {
    assert.deepEqual(qobuzTrackMetaOf({ title: 7, parental_warning: 'yes', duration: '204', version: 3, album: { title: 5, parental_warning: 'no' } }), {
      title: undefined, parentalWarning: undefined, albumParentalWarning: undefined, durationSec: undefined, album: undefined, albumArtist: undefined, version: null,
    })
    assert.deepEqual(qobuzTrackMetaOf({}), { title: undefined, parentalWarning: undefined, albumParentalWarning: undefined, durationSec: undefined, album: undefined, albumArtist: undefined, version: null })
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
    assert.equal(r.error, 'Apple lists an explicit cut of this track, but no copy on Qobuz is marked explicit (2 checked). It may be the clean edit, so nothing was imported. Try the album download, or another source.')
    assert.deepEqual(r.alternatives?.map((a) => a.reason), [NO_EXPLICIT_WARNING, NO_EXPLICIT_WARNING])
    assert.equal(NO_EXPLICIT_WARNING, 'has no explicit warning on Qobuz; the explicit record was asked for', 'what Qobuz says, not a claim about the audio')
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

  test("Paris, Tokyo: the album's own \"Explicit Album Version\" comes in, not a compilation's copy (the live check, in its real order)", async () => {
    // Flagged clean, so it was refused beside the compilations' flagged copies, and one of those went in.
    const parisHit = 'Paris, Tokyo by Lupe Fiasco'
    hits('track', ['own', 'clean', 'live', 'comp1', 'comp2', 'comp3', 'hits'].map((id): [string, string] => [id, parisHit]))
    answers.own = { parental_warning: false, duration: 270, version: 'Explicit Album Version', album: { title: "Lupe Fiasco's The Cool", parental_warning: true } }
    answers.clean = { parental_warning: false, duration: 270, album: { title: "Lupe Fiasco's The Cool", parental_warning: false } }
    answers.live = { parental_warning: false, duration: 314, version: 'Live from Miami Beach', album: { title: 'Lupe Fiasco x Nu Deco Ensemble', parental_warning: true } }
    answers.comp1 = { parental_warning: true, duration: 270, album: { title: 'late night hip-hop', parental_warning: true } }
    answers.comp2 = { parental_warning: true, duration: 270, album: { title: 'Cooking Music', parental_warning: true } }
    answers.comp3 = { parental_warning: true, duration: 270, album: { title: 'Coffee Shop Rap', parental_warning: true } }
    answers.hits = { parental_warning: false, duration: 270, album: { title: '00s Hip Hop Jams', parental_warning: true } }
    tags('own', { title: 'Paris, Tokyo (Explicit Album Version)', artist: 'Lupe Fiasco', album: "Lupe Fiasco's The Cool", duration: 270.7 })
    const { walk, importedIds } = store()
    const r = await walk({ artist: 'Lupe Fiasco', title: 'Paris, Tokyo', album: "Lupe Fiasco's The Cool" })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['own'])
    assert.deepEqual(importedIds(), ['own'])
  })

  test('an explicit row whose only explicit copy is flagged clean but says so downloads it', async () => {
    hits('track', [['clean', maskHit], ['own', maskHit]])
    answers.clean = { parental_warning: false, album: { title: 'FUTURE', parental_warning: false } }
    answers.own = { parental_warning: false, version: 'Explicit Album Version', album: { title: 'FUTURE', parental_warning: false } }
    tags('own', { title: 'Mask Off (Explicit Album Version)', artist: 'Future', album: 'FUTURE' })
    const { walk, importedIds } = store()
    const r = await walk({ ...MASK, explicitSource: true })
    assert.equal(r.outcome, 'imported', r.error)
    assert.deepEqual(fetched(), ['own'])
    assert.deepEqual(importedIds(), ['own'])
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

    test('a track through the album door that says it is the explicit cut is taken', async () => {
      hits('track', [['master', maskHit]])
      provenButBroken()
      hits('album', [['alb', 'FUTURE by Future']])
      answers.alb = { title: 'FUTURE', artist: { name: 'Future' }, tracks_count: 1, tracks: { items: [{ id: 'door', title: 'Mask Off', version: 'Explicit Album Version', parental_warning: false, duration: 204 }] } }
      tags('door', { title: 'Mask Off (Explicit Album Version)', artist: 'Future', album: 'FUTURE' })
      const { walk, importedIds } = store()
      await walk({ ...MASK, album: 'FUTURE' })
      assert.deepEqual(importedIds(), ['door'])
    })

    test('with no master the same door is open', async () => {
      hits('album', [['alb', 'FUTURE by Future']])
      answers.alb = { title: 'FUTURE', artist: { name: 'Future' }, tracks_count: 1, tracks: { items: [{ id: 'door', title: 'Mask Off', parental_warning: false, duration: 204 }] } }
      tags('door', maskTags)
      const { walk, importedIds } = store()
      await walk({ ...MASK, album: 'FUTURE' })
      assert.deepEqual(importedIds(), ['door'])
    })

    test('a track that says it is the explicit cut comes in even when the file\'s tag does not say so', async () => {
      hits('track', [['master', maskHit]])
      provenButBroken()
      hits('album', [['alb', 'FUTURE by Future']])
      answers.alb = { title: 'FUTURE', artist: { name: 'Future' }, tracks_count: 1, tracks: { items: [{ id: 'door', title: 'Mask Off', version: 'Explicit Album Version', parental_warning: false, duration: 204 }] } }
      tags('door', maskTags)
      const { walk, importedIds } = store()
      await walk({ ...MASK, album: 'FUTURE' })
      assert.deepEqual(importedIds(), ['door'])
    })

    test('a no-warning hit past the sixth on an album flagged explicit is a clean edit beside a proven master', async () => {
      const clean = ['c1', 'c2', 'c3', 'c4', 'c5']
      hits('track', [['master', maskHit], ...clean.map((id): [string, string] => [id, maskHit]), ['past', maskHit]])
      provenButBroken()
      for (const id of clean) answers[id] = { parental_warning: false, album: { title: 'FUTURE', parental_warning: false } }
      answers.past = { parental_warning: false, album: { title: 'FUTURE', parental_warning: true } }
      tags('past', maskTags)
      const { walk, importedIds } = store()
      await walk(MASK)
      assert.deepEqual(fetched(), ['master', 'past'])
      assert.deepEqual(importedIds(), [])
    })
  })

  // No warning is not censored. The real listing: these three are the same audio as Jake's
  // files (2026-11-04), and Qobuz flags the album explicit and the track not.
  describe('a track with nothing to censor is not refused, wherever the walk finds it', () => {
    const PHARCYDE = { artist: 'The Pharcyde', title: "Passin' Me By", album: 'Bizarre Ride II The Pharcyde', explicitSource: true }
    const passinTags = { title: "Passin' Me By", artist: 'The Pharcyde', album: 'Bizarre Ride II The Pharcyde', duration: 303 }
    const album = (items: unknown[], flag: boolean | undefined = true): Record<string, unknown> => ({ title: 'Bizarre Ride II The Pharcyde', artist: { name: 'The Pharcyde' }, parental_warning: flag, tracks_count: items.length, tracks: { items } })

    test("the album door: Passin' Me By, on an explicit row, with no explicit copy anywhere", async () => {
      hits('album', [['bizarre', 'Bizarre Ride II The Pharcyde by The Pharcyde']])
      answers.bizarre = album([{ id: 'door', title: "Passin' Me By", parental_warning: false, duration: 303 }])
      tags('door', passinTags)
      const { walk, importedIds } = store()
      const r = await walk(PHARCYDE)
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(fetched(), ['door'])
      assert.deepEqual(importedIds(), ['door'])
    })

    test('the album door: the same track on an album with no warning is still refused', async () => {
      hits('album', [['bizarre', 'Bizarre Ride II The Pharcyde by The Pharcyde']])
      answers.bizarre = album([{ id: 'door', title: "Passin' Me By", parental_warning: false, duration: 303 }], false)
      tags('door', passinTags)
      const { walk, importedIds } = store()
      await walk(PHARCYDE)
      assert.deepEqual(fetched(), [])
      assert.deepEqual(importedIds(), [])
    })

    test('the album door: A Bay Bay\'s album lists its Single Version first, and the explicit cut beside it is the one taken', async () => {
      // The real listing, in its order: Qobuz flags the album explicit and the Single Version not.
      hits('album', [['ep', 'A Bay Bay by Hurricane Chris']])
      answers.ep = { title: 'A Bay Bay', artist: { name: 'Hurricane Chris' }, parental_warning: true, tracks_count: 3, tracks: { items: [
        { id: 'single', title: 'A Bay Bay', version: 'Single Version', parental_warning: false, duration: 257 },
        { id: 'instrumental', title: 'A Bay Bay', version: 'Instrumental', parental_warning: false, duration: 252 },
        { id: 'cut', title: 'A Bay Bay', parental_warning: true, duration: 306 },
      ] } }
      tags('cut', { title: 'A Bay Bay', artist: 'Hurricane Chris', album: 'A Bay Bay', duration: 306.9 })
      const { walk, importedIds } = store()
      const r = await walk({ artist: 'Hurricane Chris', title: 'A Bay Bay', album: 'A Bay Bay', explicitSource: true })
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(fetched(), ['cut'])
      assert.deepEqual(importedIds(), ['cut'])
    })

    test('the album door: a clean edit on an explicit album stays out once the top hits proved a master', async () => {
      hits('track', [['master', "Passin' Me By by The Pharcyde"]])
      answers.master = { parental_warning: true, album: { title: 'Bizarre Ride II The Pharcyde', parental_warning: true } }
      tags('master', { ...passinTags, title: "Passin' Me By (Remix)" })
      hits('album', [['bizarre', 'Bizarre Ride II The Pharcyde by The Pharcyde']])
      answers.bizarre = album([{ id: 'door', title: "Passin' Me By", parental_warning: false, duration: 303 }])
      tags('door', passinTags)
      const { walk, importedIds } = store()
      await walk(PHARCYDE)
      assert.deepEqual(fetched(), ['master'])
      assert.deepEqual(importedIds(), [])
    })

    test('the album door still holds a track to the row\'s length, and to what the album says it is', async () => {
      hits('album', [['bizarre', 'Bizarre Ride II The Pharcyde by The Pharcyde']])
      answers.bizarre = album([{ id: 'door', title: "Passin' Me By", parental_warning: true, duration: 357 }])
      tags('door', passinTags)
      const wrongLength = store()
      await wrongLength.walk({ ...PHARCYDE, explicitSource: false, durationMs: 303_500 })
      assert.deepEqual(fetched(), [], 'a length that does not fit')
      answers.bizarre = { ...album([{ id: 'door', title: "Passin' Me By", parental_warning: true, duration: 303 }]), title: 'Bizarre Ride II The Pharcyde (Live at the Roxy)' }
      await store().walk({ ...PHARCYDE, explicitSource: false })
      assert.deepEqual(fetched(), [], 'its real name says live, though the search summary does not')
    })

    // The real names. No album on Qobuz reads as the row's, so the door stayed shut, and a walk
    // with no track hits went on to whatever Bandcamp had under the artist's name.
    test('the album door opens for a row whose album carries Apple\'s stamp', async () => {
      hits('album', [['full', 'Life After Death (2014 Remaster) by The Notorious B.I.G.']])
      answers.full = { title: 'Life After Death', version: '2014 Remastered Edition', artist: { name: 'The Notorious B.I.G.' }, parental_warning: true, tracks_count: 1, tracks: { items: [{ id: 'door', title: "Sky's the Limit (feat. 112)", version: '2014 Remaster', parental_warning: true, duration: 329 }] } }
      tags('door', { title: "Sky's the Limit (feat. 112) (2014 Remaster)", artist: 'The Notorious B.I.G.', album: 'Life After Death', duration: 329.4 })
      const { walk, importedIds } = store()
      const r = await walk({ artist: 'The Notorious B.I.G.', title: "Sky's the Limit (feat. 112) [Amended]", album: 'Life After Death [Amended Version] (2014 Remaster)', durationMs: 277_000, cleanedSource: true })
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(importedIds(), ['door'])
    })

    test('the album door: the row\'s name finds the amended edition, and the explicit one beside it is what comes in', async () => {
      // Qobuz's real summaries. Apple's stamped name reads as the amended "(2014 Remaster)" only.
      const big = 'The Notorious B.I.G.'
      hits('album', [['explicit', `Life After Death (2014 Remastered Edition) by ${big}`], ['deluxe', `Life After Death (25th Anniversary Super Deluxe Ed by ${big}`], ['amended', `Life After Death (2014 Remaster) by ${big}`]])
      const edition = (id: string, version: string, flag: boolean, duration: number): Record<string, unknown> => ({ title: 'Life After Death', version, artist: { name: big }, parental_warning: flag, tracks_count: 1, tracks: { items: [{ id, title: "Sky's the Limit (feat. 112)", version: '2014 Remaster', parental_warning: flag, duration }] } })
      answers.explicit = edition('explicitCut', '2014 Remastered Edition', true, 329)
      answers.deluxe = edition('deluxeCut', '25th Anniversary Super Deluxe Edition', true, 329)
      answers.amended = edition('amendedCut', '2014 Remaster', false, 277)
      tags('explicitCut', { title: "Sky's the Limit (feat. 112) (2014 Remaster)", artist: big, album: 'Life After Death', duration: 329.4 })
      tags('amendedCut', { title: "Sky's the Limit (feat. 112) (2014 Remaster)", artist: big, album: 'Life After Death', duration: 277.1 })
      const { walk, importedIds } = store()
      const r = await walk({ artist: big, title: "Sky's the Limit (feat. 112) [Amended]", album: 'Life After Death [Amended Version] (2014 Remaster)', durationMs: 277_000, cleanedSource: true })
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(fetched(), ['explicitCut'])
      assert.deepEqual(importedIds(), ['explicitCut'])
    })

    test('the album door fetches one track from an album, and two at most', async () => {
      hits('album', ['a', 'b', 'c'].map((id): [string, string] => [id, 'Record by Band']))
      for (const id of ['a', 'b', 'c']) {
        answers[id] = { title: 'Record', artist: { name: 'Band' }, tracks_count: 2, tracks: { items: [{ id: `${id}1`, title: 'Song', parental_warning: true }, { id: `${id}2`, title: 'Song', parental_warning: true }] } }
        for (const n of ['1', '2']) tags(`${id}${n}`, { title: 'Song (Remix)', artist: 'Band', album: 'Record' })
      }
      const r = await store().walk({ artist: 'Band', title: 'Song', album: 'Record' })
      assert.deepEqual(fetched(), ['a1', 'b1'])
      assert.equal(r.ok, false)
    })

    test('the album door reads four editions at most', async () => {
      const ids = ['a', 'b', 'c', 'd', 'e', 'f']
      hits('album', ids.map((id): [string, string] => [id, 'Record by Band']))
      await store().walk({ artist: 'Band', title: 'Song', album: 'Record' })
      assert.equal(qobuzCalls.filter((c) => c.url.includes('album/get')).length, 4)
    })

    test('an edition the row\'s name and the album\'s name both find is read once, and the next one gets its place', async () => {
      const big = 'The Notorious B.I.G.'
      hits('album', [['amended', `Life After Death (2014 Remaster) by ${big}`], ['b', `Life After Death (B) by ${big}`], ['c', `Life After Death (C) by ${big}`], ['d', `Life After Death (D) by ${big}`]])
      await store().walk({ artist: big, title: 'Nasty Boy [Amended]', album: 'Life After Death [Amended Version] (2014 Remaster)', cleanedSource: true })
      const read = qobuzCalls.filter((c) => c.url.includes('album/get')).map((c) => /album_id=([^&]+)/.exec(c.url)?.[1])
      assert.deepEqual([...read].sort(), ['amended', 'b', 'c', 'd'])
    })

    test('the album door prefers the album as the row writes it: a Deluxe row finds the Deluxe', async () => {
      hits('album', [['plain', 'Pink Friday by Nicki Minaj'], ['deluxe', 'Pink Friday (Deluxe Edition) by Nicki Minaj']])
      const onlyOnDeluxe = { id: 'bonus', title: 'Super Bass', parental_warning: true, duration: 200 }
      answers.deluxe = { title: 'Pink Friday (Deluxe Edition)', artist: { name: 'Nicki Minaj' }, parental_warning: true, tracks_count: 1, tracks: { items: [onlyOnDeluxe] } }
      answers.plain = { title: 'Pink Friday', artist: { name: 'Nicki Minaj' }, parental_warning: true, tracks_count: 1, tracks: { items: [{ ...onlyOnDeluxe, id: 'plainCopy' }] } }
      tags('bonus', { title: 'Super Bass', artist: 'Nicki Minaj', album: 'Pink Friday (Deluxe Edition)' })
      tags('plainCopy', { title: 'Super Bass', artist: 'Nicki Minaj', album: 'Pink Friday' })
      const { walk, importedIds } = store()
      await walk({ artist: 'Nicki Minaj', title: 'Super Bass', album: 'Pink Friday (Deluxe Edition)' })
      assert.deepEqual(importedIds(), ['bonus'])
    })

    test('the album door: another act\'s track of that very title is passed over, with no fetch', async () => {
      // The real EP: seven Big Pun tracks that are the remix, and Incubus's "Still Not a Player" last.
      hits('album', [['ep', 'Still Not a Player EP by Big Pun']])
      answers.ep = { title: 'Still Not a Player EP', artist: { name: 'Big Pun' }, parental_warning: true, tracks_count: 2, tracks: { items: [
        { id: 'incubus', title: 'Still Not a Player', parental_warning: false, duration: 254, performer: { name: 'Incubus' } },
        { id: 'pun', title: 'Still Not a Player', parental_warning: false, duration: 236, performer: { name: 'Big Pun' } },
      ] } }
      tags('incubus', { title: 'Still Not a Player', artist: 'Incubus', album: 'Still Not a Player EP', duration: 254 })
      tags('pun', { title: 'Still Not a Player', artist: 'Big Pun', album: 'Still Not a Player EP', duration: 236 })
      const { walk, importedIds } = store()
      const r = await walk({ artist: 'Big Pun', title: 'Still Not a Player', album: 'Still Not a Player EP', explicitSource: true })
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(fetched(), ['pun'])
      assert.deepEqual(importedIds(), ['pun'])
    })

    test('past the sixth: the same track, on an explicit row, with no explicit copy anywhere', async () => {
      const q = "Passin' Me By by The Pharcyde"
      const clean = ['c1', 'c2', 'c3', 'c4', 'c5']
      hits('track', [['silent', q], ...clean.map((id): [string, string] => [id, q]), ['past', q]])
      // Qobuz doesn't answer about the first, so it stays in; it turns out to be something else.
      tags('silent', { ...passinTags, title: "Passin' Me By (Remix)" })
      for (const id of clean) answers[id] = { parental_warning: false, album: { title: '90s Rap', parental_warning: false } }
      answers.past = { parental_warning: false, duration: 303, album: { title: 'Bizarre Ride II The Pharcyde', parental_warning: true } }
      tags('past', passinTags)
      const { walk, importedIds } = store()
      const r = await walk(PHARCYDE)
      assert.equal(r.outcome, 'imported', r.error)
      assert.deepEqual(fetched(), ['silent', 'past'])
      assert.deepEqual(importedIds(), ['past'])
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
    assert.match(r.error ?? '', /^Apple lists an explicit edition of this album, but no copy on Qobuz is marked explicit \(1 checked\)/)
    assert.deepEqual(r.alternatives?.map((a) => a.reason), [NO_EXPLICIT_WARNING])
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
