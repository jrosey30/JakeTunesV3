/**
 * The iPod ad page (2026-11-14; Jake approved the mock: "Yeah that'll do").
 *
 *   • the words (common/ipod-ad.ts): the headline and where it breaks, the copy
 *     line with its singulars, the grey line that leaves out what isn't known
 *   • the drawing's colours for every model in every colour
 *   • Headline…: on disk before homemini is asked, shown at once, sent later when
 *     homemini is away or older than the field, dropped only when the list is gone
 *     (main/ipod-headlines.ts, main/ipod-list-client.ts, main/ipod-lists-gather.ts)
 *   • a homemini that doesn't send the new fields changes nothing
 *   • the page is wired: the ad in the list's own scroller, Headline… beside Rename…
 *   • the story under the ad (2026-11-24): homemini's, read, kept, shown; never written here
 *
 * No homemini here: fetch is a fake.
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adCopy, adCounts, adHeadline, adLegal, homeminiCounts, checkHeadline, cleanHeadline, cleanStory, countArtists, headlineLines, headlineSizePx, hoursWords,
  ipodDrawingColors, ipodModelWords, ipodScreenTitle, storyParagraphs, syncedDateWords,
  HEADLINE_FULL_PX, HEADLINE_MAX, HEADLINE_MIN_PX, STORY_MAX, TOP_1000_DEFAULT_HEADLINE,
} from '../../common/ipod-ad.ts'
import { IPOD_COLORS, IPOD_MODELS, ipodColorHex } from '../../common/ipod-covers.ts'
import { parseIpodList, type IpodList } from '../../common/ipod-list-doc.ts'
import {
  createTop1000HeadlineRemote, flushPendingHeadlines, localTop1000Headline, readPendingHeadlines, readTop1000Headline, setHeadline,
  PENDING_FILE, TOP1000_HEADLINE_KEY, type HeadlineSend,
} from '../ipod-headlines.ts'
import { createIpodListClient } from '../ipod-list-client.ts'
import { gatherIpodLists, ipodListsCachePath } from '../ipod-lists-gather.ts'
import { buildDeviceMarker } from '../../common/ipod-identity.ts'
import type { FetchLike } from '../top1000-client.ts'

const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'ipod-ad-')); dirs.push(d); return d }

const PUNK_ID = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
const Y2K_ID = '842f4c4f-1111-4222-8333-444455556666'
const now = '2026-11-14T00:00:00.000Z'
const list = (id: string, name: string, ids: number[], extra: Partial<IpodList> = {}): IpodList => ({
  id, name, purpose: null, cap: 1000, ids, adds: [], removed: [], updatedAt: now, brain: { enabled: true, perDay: 1 }, ...extra,
})

/** A fake homemini: answers each request with `status`, records what was asked. */
function fakeHomemini(status: number | 'down', body: unknown = {}) {
  const seen: Array<{ url: string; method: string; body: unknown }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, method: String(init?.method ?? 'GET'), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (status === 'down') throw new Error('connect ECONNREFUSED')
    return { ok: status === 200, status, json: async () => body }
  }
  return { seen, fetchImpl }
}
const quiet = () => undefined

describe('the headline (common/ipod-ad.ts)', () => {
  it('is the list\'s own when it has one', () => {
    assert.equal(adHeadline({ headline: 'Louder than it looks.', name: 'punkPod' }), 'Louder than it looks.')
    assert.equal(adHeadline({ headline: '  The Eighties. Singles only. ', name: "1980's" }), 'The Eighties. Singles only.')
  })
  it('with none, is the name followed by a full stop (never two)', () => {
    assert.equal(adHeadline({ name: 'punkPod' }), 'punkPod.')
    assert.equal(adHeadline({ headline: null, name: ' Y2K ' }), 'Y2K.')
    assert.equal(adHeadline({ headline: undefined, name: 'What?' }), 'What?')
    assert.equal(adHeadline({ name: 'Vol. 2.' }), 'Vol. 2.')
    assert.equal(adHeadline({ name: '' }), '')
  })
  it('a headline that breaks the rules counts as none', () => {
    assert.equal(adHeadline({ headline: 'x'.repeat(HEADLINE_MAX + 1), name: 'punkPod' }), 'punkPod.')
    assert.equal(adHeadline({ headline: 'two\nlines', name: 'punkPod' }), 'punkPod.')
    assert.equal(adHeadline({ headline: '   ', name: 'punkPod' }), 'punkPod.')
  })
  it('the Top 1000 with none: "The thousand that made it."', () => {
    assert.equal(adHeadline({ name: 'Top 1000', top1000: true }), TOP_1000_DEFAULT_HEADLINE)
    assert.equal(adHeadline({ headline: null, name: 'The Thousand', top1000: true }), 'The thousand that made it.')
    assert.equal(adHeadline({ headline: 'Every one a keeper.', name: 'Top 1000', top1000: true }), 'Every one a keeper.')
  })
  it('Headline…: 1 to 60 characters on one line; empty or null clears it', () => {
    assert.deepEqual(checkHeadline('  Louder than it looks. '), { ok: true, headline: 'Louder than it looks.' })
    assert.deepEqual(checkHeadline('x'.repeat(HEADLINE_MAX)), { ok: true, headline: 'x'.repeat(HEADLINE_MAX) })
    assert.deepEqual(checkHeadline(''), { ok: true, headline: null })
    assert.deepEqual(checkHeadline('   '), { ok: true, headline: null })
    assert.deepEqual(checkHeadline(null), { ok: true, headline: null })
    const long = checkHeadline('x'.repeat(HEADLINE_MAX + 1))
    assert.equal(long.ok, false)
    assert.match((long as { error: string }).error, /60 characters \(this is 61\)/)
    assert.deepEqual(checkHeadline('a\nb'), { ok: false, error: 'Keep it to one line.' })
    assert.equal(checkHeadline(7).ok, false)
    assert.equal(cleanHeadline('ok.'), 'ok.')
    assert.equal(cleanHeadline(''), null)
    assert.equal(cleanHeadline(undefined), null)
    assert.equal(cleanHeadline('x'.repeat(61)), null)
  })
})

describe('where the headline breaks, and how big it is set', () => {
  it('two sentences break between them', () => {
    assert.deepEqual(headlineLines('The Eighties. Singles only.'), ['The Eighties.', 'Singles only.'])
    assert.deepEqual(headlineLines('Ten years. No skips.'), ['Ten years.', 'No skips.'])
    assert.deepEqual(headlineLines('Small labels. Plenty of room.'), ['Small labels.', 'Plenty of room.'])
  })
  it('one sentence breaks at the space nearest its middle', () => {
    assert.deepEqual(headlineLines('Louder than it looks.'), ['Louder than', 'it looks.'])
    assert.deepEqual(headlineLines('The thousand that made it.'), ['The thousand', 'that made it.'])
    assert.deepEqual(headlineLines('After midnight, mostly.'), ['After midnight,', 'mostly.'])
    assert.deepEqual(headlineLines('Period correct.'), ['Period', 'correct.'])
  })
  it('a short one stays on one line; never more than two lines', () => {
    assert.deepEqual(headlineLines('punkPod.'), ['punkPod.'])
    assert.deepEqual(headlineLines("1980's."), ["1980's."])
    assert.deepEqual(headlineLines('Best of Bandcamp.'), ['Best of', 'Bandcamp.'])
    assert.deepEqual(headlineLines('Supercalifragilisticexpialidocious.'), ['Supercalifragilisticexpialidocious.'])
    assert.deepEqual(headlineLines(''), [])
    assert.equal(headlineLines('One. Two. Three. Four.').length, 2)
  })
  it('sentences too uneven for two good lines break at the middle instead', () => {
    const lines = headlineLines('Three chords, two minutes and nobody asked for a solo. Ever.')
    assert.equal(lines.length, 2)
    assert.ok(Math.abs(lines[0].length - lines[1].length) <= 8, lines.join(' / '))
    assert.equal(lines.join(' '), 'Three chords, two minutes and nobody asked for a solo. Ever.')
  })
  it('the size comes from the longest line: full size up to 20 characters, smaller past it, never under the floor', () => {
    assert.equal(headlineSizePx(['Louder than', 'it looks.']), HEADLINE_FULL_PX)
    assert.equal(headlineSizePx(['x'.repeat(20)]), HEADLINE_FULL_PX)
    assert.equal(headlineSizePx(['x'.repeat(31)]), 40)
    assert.equal(headlineSizePx(['x'.repeat(60)]), HEADLINE_MIN_PX)
    assert.equal(headlineSizePx([]), HEADLINE_FULL_PX)
    // every headline the rules allow fits the column: line length times size stays under the full line's
    for (let len = 1; len <= HEADLINE_MAX; len++) {
      const size = headlineSizePx(['x'.repeat(len)])
      if (size > HEADLINE_MIN_PX) assert.ok(len * size <= 20 * HEADLINE_FULL_PX, `${len} characters at ${size}px`)
    }
  })
})

describe('the copy line', () => {
  it('"<N> songs by <M> artists." with the right singulars and thousands', () => {
    assert.equal(adCopy(834, 200), '834 songs by 200 artists.')
    assert.equal(adCopy(1000, 458), '1,000 songs by 458 artists.')
    assert.equal(adCopy(1, 1), '1 song by 1 artist.')
    assert.equal(adCopy(2, 1), '2 songs by 1 artist.')
    assert.equal(adCopy(5, 0), '5 songs.')
    assert.equal(adCopy(0, 0), 'No songs yet.')
  })
  it('homemini\'s two counts are used only when it sends both; otherwise this Mac counts both (never one of each)', () => {
    const local = { songs: 834, artists: 200 }
    assert.deepEqual(adCounts(local, { songCount: 834, artistCount: 199 }), { songs: 834, artists: 199 })
    assert.deepEqual(adCounts(local, { songCount: 0, artistCount: 0 }), { songs: 0, artists: 0 })
    // one without the other: neither is used
    assert.deepEqual(adCounts(local, { artistCount: 199 }), local)
    assert.deepEqual(adCounts(local, { songCount: 840 }), local)
    assert.deepEqual(adCounts(local, { songCount: 840, artistCount: null }), local)
    assert.deepEqual(adCounts(local, {}), local)
    assert.deepEqual(adCounts(local, null), local)
    for (const bad of [-1, 1.5, '199', Number.NaN]) {
      assert.deepEqual(adCounts(local, { songCount: bad, artistCount: 199 }), local)
      assert.deepEqual(adCounts(local, { songCount: 834, artistCount: bad }), local)
    }
    assert.deepEqual(homeminiCounts({ songCount: 1000, artistCount: 458, name: 'Top 1000' } as never), { songCount: 1000, artistCount: 458 })
    assert.equal(homeminiCounts({ songCount: 1000 }), null)
  })
  it('artists are counted once, whatever their case, by the key the app gives', () => {
    const tracks = [{ artist: 'Wire' }, { artist: 'wire ' }, { artist: 'The Cramps' }, { artist: '' }, { artist: null }, {}]
    assert.equal(countArtists(tracks), 2)
    assert.equal(countArtists([{ artist: 'Wham!' }, { artist: 'Wham! feat. George' }], (a) => a.split(' feat.')[0]), 1)
    assert.equal(countArtists([]), 0)
  })
})

describe('the grey line', () => {
  const at = new Date('2026-11-14T12:00:00')
  it('says everything it knows', () => {
    assert.equal(
      adLegal({ name: 'punkPod', model: 'mini', color: 'red', songs: 834, cap: 1000, durationMs: 42.6 * 3_600_000, lastSyncedAt: '2026-11-08T13:15:00', now: at }),
      'punkPod. iPod mini, red. 834 of 1,000 songs, 42.6 hours. Last synced Nov 8.',
    )
    assert.equal(
      adLegal({ name: "1980's", model: '3g', color: 'purple', songs: 195, cap: 1000, durationMs: 14.4 * 3_600_000, now: at }),
      "1980's. iPod, third generation, purple. 195 of 1,000 songs, 14.4 hours.",
    )
  })
  it('leaves out what it doesn\'t know: no cap, no time, no sync date, no model, a colour with no name', () => {
    assert.equal(adLegal({ name: 'punkPod', model: 'mini', color: 'red', songs: 834, now: at }), 'punkPod. iPod mini, red. 834 songs.')
    assert.equal(adLegal({ name: 'punkPod', model: 'mini', color: '#12ab34', songs: 1, cap: null, durationMs: 0, now: at }), 'punkPod. iPod mini. 1 song.')
    assert.equal(adLegal({ name: 'punkPod', songs: 0, now: at }), 'punkPod.')
    assert.equal(adLegal({ name: 'punkPod', model: 'default', color: null, songs: 3, cap: 5000, durationMs: 9 * 60_000, lastSyncedAt: 'not a date', now: at }), 'punkPod. iPod. 3 of 5,000 songs, 9 minutes.')
    // a cap under the count is a stale cap: not said
    assert.equal(adLegal({ name: 'A', model: 'classic', color: 'blue', songs: 1200, cap: 1000, now: at }), 'A. iPod classic, blue. 1,200 songs.')
  })
  it('the model in words, the hours, the date', () => {
    assert.deepEqual(IPOD_MODELS.map(ipodModelWords), ['iPod mini', 'iPod classic', 'iPod, third generation', 'iPod'])
    assert.equal(hoursWords(68.3 * 3_600_000), '68.3 hours')
    assert.equal(hoursWords(3_600_000), '1 hour')
    assert.equal(hoursWords(2 * 3_600_000), '2.0 hours')
    assert.equal(hoursWords(32 * 60_000), '32 minutes')
    assert.equal(hoursWords(60_000), '1 minute')
    assert.equal(hoursWords(0), '')
    assert.equal(hoursWords(Number.NaN), '')
    assert.equal(syncedDateWords('2026-11-08T13:15:00', at), 'Nov 8')
    assert.equal(syncedDateWords('2025-12-31T13:15:00', at), 'Dec 31, 2025')
    assert.equal(syncedDateWords(null, at), '')
    assert.equal(syncedDateWords('', at), '')
  })
})

describe('the drawn iPod\'s colours (model and colour to fills)', () => {
  const HEX = /^#[0-9a-f]{6}$/
  it('every model in every named colour, and in a custom one, gets a whole set of fills', () => {
    for (const model of IPOD_MODELS) {
      for (const color of [...IPOD_COLORS.map((c) => c.name), '#12ab34']) {
        const c = ipodDrawingColors(model, color)
        assert.equal(c.model, model)
        assert.equal(c.body, ipodColorHex(color), `${model} ${color}`)
        assert.match(c.glyph, HEX)
        if (c.wheel !== null) assert.match(c.wheel, HEX)
        if (c.hub !== null) assert.match(c.hub, HEX)
      }
    }
  })
  it('a colour JakeTunes doesn\'t know is drawn silver', () => {
    for (const bad of [null, undefined, 'teal', '#12', 'rgb(1,2,3)']) assert.equal(ipodDrawingColors('mini', bad as string | null).body, '#d5d7da')
  })
  it('the mini: white wheel and button, marks in the case\'s colour (darkened on a pale case)', () => {
    const red = ipodDrawingColors('mini', 'red')
    assert.deepEqual([red.wheel, red.hub, red.glyph], [null, null, ipodColorHex('red')])
    const silver = ipodDrawingColors('mini', 'silver')
    assert.equal(silver.wheel, null)
    assert.notEqual(silver.glyph, silver.body)
    assert.ok(parseInt(silver.glyph.slice(1, 3), 16) < parseInt(silver.body.slice(1, 3), 16), 'darker than the case, so it reads on the white wheel')
  })
  it('the third generation: one colour all over, red-orange marks', () => {
    const p = ipodDrawingColors('3g', 'purple')
    assert.deepEqual([p.wheel, p.hub, p.glyph], [p.body, p.body, '#ff7646'])
  })
  it('the classic: white wheel, button in the case\'s colour; a dark case has a dark wheel', () => {
    const blue = ipodDrawingColors('classic', 'blue')
    assert.deepEqual([blue.wheel, blue.hub], [null, blue.body])
    const black = ipodDrawingColors('classic', 'black')
    assert.notEqual(black.wheel, null)
    assert.equal(black.glyph, '#d4d4d8')
  })
  it('the default iPod: white wheel on a colour, grey wheel with white marks on silver, dark wheel on black', () => {
    const orange = ipodDrawingColors('default', 'orange')
    assert.deepEqual([orange.wheel, orange.hub, orange.glyph], ['#f3f3f4', orange.body, '#b9bbc0'])
    const silver = ipodDrawingColors('default', 'silver')
    assert.equal(silver.glyph, '#ffffff')
    assert.ok(parseInt(silver.wheel!.slice(1, 3), 16) < parseInt(silver.body.slice(1, 3), 16))
    const black = ipodDrawingColors('default', 'black')
    assert.equal(black.hub, black.body)
    assert.ok(parseInt(black.wheel!.slice(1, 3), 16) > parseInt(black.body.slice(1, 3), 16))
    // yellow is pale but a colour: it keeps the white wheel
    assert.equal(ipodDrawingColors('default', 'yellow').wheel, '#f3f3f4')
  })
  it('the screen\'s title bar holds the name, cut when it is long', () => {
    assert.equal(ipodScreenTitle('punkPod'), 'punkPod')
    assert.equal(ipodScreenTitle('Best of Bandcamp'), 'Best of Bandcamp')
    assert.equal(ipodScreenTitle('A very long name for an iPod list'), 'A very long name…')
  })
})

describe('homemini\'s list carries the headline (common/ipod-list-doc.ts)', () => {
  it('homemini\'s counts are read when they are whole numbers, and absent otherwise', () => {
    const l = parseIpodList({ ...list(PUNK_ID, 'punkPod', [1]), songCount: 834, artistCount: 199 })
    assert.equal(l?.songCount, 834)
    assert.equal(l?.artistCount, 199)
    const bad = parseIpodList({ ...list(PUNK_ID, 'punkPod', [1]), songCount: -1, artistCount: '199' })
    assert.ok(bad)
    assert.equal('songCount' in bad, false)
    assert.equal('artistCount' in bad, false)
  })
  it('a good headline is read; none, or a bad one, is simply absent and the list still parses', () => {
    assert.equal(parseIpodList({ ...list(PUNK_ID, 'punkPod', [1]), headline: 'Louder than it looks.' })?.headline, 'Louder than it looks.')
    const none = parseIpodList(list(PUNK_ID, 'punkPod', [1]))
    assert.ok(none)
    assert.equal('headline' in none, false)
    for (const bad of [null, 7, '', 'x'.repeat(61), 'a\nb']) {
      const l = parseIpodList({ ...list(PUNK_ID, 'punkPod', [1]), headline: bad })
      assert.ok(l, `a list with headline ${JSON.stringify(bad)} still parses`)
      assert.equal('headline' in l, false)
    }
  })
})

describe('Headline…: the write (main/ipod-headlines.ts)', () => {
  it('is on disk before homemini is asked', async () => {
    const stateDir = tmp()
    // every time homemini is asked, what is on disk at that moment
    const onDiskWhenAsked: unknown[] = []
    const send: HeadlineSend = async () => {
      let disk: unknown = 'nothing on disk'
      try { disk = JSON.parse(readFileSync(join(stateDir, PENDING_FILE), 'utf-8')) } catch { /* nothing on disk: recorded as such */ }
      onDiskWhenAsked.push(disk)
      return 'done'
    }
    const r = await setHeadline({ stateDir, send }, PUNK_ID, ' Louder than it looks. ')
    assert.deepEqual(r, { ok: true, headline: 'Louder than it looks.', homemini: 'saved' })
    assert.deepEqual(onDiskWhenAsked, [{ [PUNK_ID]: 'Louder than it looks.' }])
    assert.deepEqual(await readPendingHeadlines(stateDir), {}, 'homemini has it: nothing waits')
  })
  it('homemini away: it waits on disk, says "later", and goes on the next flush', async () => {
    const stateDir = tmp()
    const r = await setHeadline({ stateDir, send: async () => 'retry', warn: quiet }, PUNK_ID, 'Louder than it looks.')
    assert.deepEqual(r, { ok: true, headline: 'Louder than it looks.', homemini: 'later' })
    assert.deepEqual(await readPendingHeadlines(stateDir), { [PUNK_ID]: 'Louder than it looks.' })
    const sent: Array<[string, string | null]> = []
    assert.equal(await flushPendingHeadlines(stateDir, async (k, h) => { sent.push([k, h]); return 'done' }), 'sent')
    assert.deepEqual(sent, [[PUNK_ID, 'Louder than it looks.']])
    assert.deepEqual(await readPendingHeadlines(stateDir), {})
    assert.equal(await flushPendingHeadlines(stateDir, async () => 'done'), 'none')
  })
  it('a send that throws is a send that didn\'t happen: the headline still waits', async () => {
    const stateDir = tmp()
    const r = await setHeadline({ stateDir, send: async () => { throw new Error('boom') }, warn: quiet }, PUNK_ID, 'Still here.')
    assert.equal(r.ok && r.homemini, 'later')
    assert.deepEqual(await readPendingHeadlines(stateDir), { [PUNK_ID]: 'Still here.' })
  })
  it('empty clears it: null waits and null is what homemini is sent', async () => {
    const stateDir = tmp()
    const sent: Array<string | null> = []
    assert.deepEqual(await setHeadline({ stateDir, send: async () => 'retry', warn: quiet }, PUNK_ID, '  '), { ok: true, headline: null, homemini: 'later' })
    assert.deepEqual(await readPendingHeadlines(stateDir), { [PUNK_ID]: null })
    await flushPendingHeadlines(stateDir, async (_k, h) => { sent.push(h); return 'done' })
    assert.deepEqual(sent, [null])
  })
  it('a list homemini doesn\'t have: dropped and said so, never retried', async () => {
    const stateDir = tmp()
    const r = await setHeadline({ stateDir, send: async () => 'drop', warn: quiet }, PUNK_ID, 'Gone.')
    assert.deepEqual(r, { ok: false, error: 'homemini has no list for this iPod.' })
    assert.deepEqual(await readPendingHeadlines(stateDir), {})
  })
  it('a headline that breaks the rules is refused before anything is written or sent', async () => {
    const stateDir = tmp()
    let asked = 0
    const send: HeadlineSend = async () => { asked++; return 'done' }
    assert.equal((await setHeadline({ stateDir, send }, PUNK_ID, 'x'.repeat(61))).ok, false)
    assert.equal((await setHeadline({ stateDir, send }, PUNK_ID, 'a\nb')).ok, false)
    assert.deepEqual(await setHeadline({ stateDir, send }, 'no', 'Fine.'), { ok: false, error: 'No list.' })
    assert.deepEqual(await setHeadline({ stateDir, send }, null, 'Fine.'), { ok: false, error: 'No list.' })
    assert.equal(asked, 0)
    assert.deepEqual(await readPendingHeadlines(stateDir), {})
  })
  it('changed again while one was in flight: the newer one is sent next, in the same turn', async () => {
    const stateDir = tmp()
    await setHeadline({ stateDir, send: async () => 'retry', warn: quiet }, PUNK_ID, 'First.')
    const sent: Array<string | null> = []
    const out = await flushPendingHeadlines(stateDir, async (_k, h) => {
      sent.push(h)
      // Jake types a new one while the first is on its way
      if (h === 'First.') writeFileSync(join(stateDir, PENDING_FILE), JSON.stringify({ [PUNK_ID]: 'Second.' }))
      return 'done'
    })
    assert.equal(out, 'sent')
    assert.deepEqual(sent, ['First.', 'Second.'])
    assert.deepEqual(await readPendingHeadlines(stateDir), {})
  })
  it('one list\'s flush leaves another\'s waiting; a file with junk in it loses only the junk', async () => {
    const stateDir = tmp()
    writeFileSync(join(stateDir, PENDING_FILE), JSON.stringify({ [PUNK_ID]: 'A.', [Y2K_ID]: 'B.', '../etc': 'x', [`${Y2K_ID}x`]: 9, top1000: null }))
    assert.deepEqual(await readPendingHeadlines(stateDir), { [PUNK_ID]: 'A.', [Y2K_ID]: 'B.', top1000: null })
    await flushPendingHeadlines(stateDir, async () => 'done', PUNK_ID)
    assert.deepEqual(await readPendingHeadlines(stateDir), { [Y2K_ID]: 'B.', top1000: null })
  })
})

/**
 * A homemini whose answers come back only when the test lets them. It applies
 * a headline when the answer is sent (the moment its write lands), so the
 * order answers come back in is the order homemini ends up in.
 */
function gatedHomemini(answer: (key: string, headline: string | null) => 'done' | 'retry' | 'drop' = () => 'done') {
  const inFlight: Array<{ key: string; headline: string | null; release: () => void }> = []
  const applied = new Map<string, string | null>()
  const send: HeadlineSend = (key, headline) => new Promise((resolve) => {
    inFlight.push({
      key, headline,
      release: () => {
        const out = answer(key, headline)
        if (out === 'done') applied.set(key, headline)
        resolve(out)
      },
    })
  })
  return { send, inFlight, applied }
}
const tick = () => new Promise((r) => setImmediate(r))

describe('Headline… under overlap (review of PR 419)', () => {
  it('a retry still on its way can\'t land after a newer headline: homemini ends on the newer one', { timeout: 60_000 }, async () => {
    const stateDir = tmp()
    // "Older" waits: homemini was away.
    await setHeadline({ stateDir, send: async () => 'retry', warn: quiet }, PUNK_ID, 'Older.')
    const hub = gatedHomemini()
    // The 5-minute retry is mid-send with "Older".
    const retry = flushPendingHeadlines(stateDir, hub.send, undefined, quiet)
    while (hub.inFlight.length === 0) await tick()
    // Jake types "Newer".
    const save = setHeadline({ stateDir, send: hub.send, warn: quiet }, PUNK_ID, 'Newer.')
    // homemini answers the newest request first, as a slow first request lets it.
    let settledAll = false
    void Promise.all([retry, save]).then(() => { settledAll = true })
    while (!settledAll) {
      const next = hub.inFlight.pop()
      if (next) next.release()
      await tick()
    }
    assert.equal(hub.applied.get(PUNK_ID), 'Newer.', 'homemini ends on what Jake typed last')
    assert.deepEqual(await save, { ok: true, headline: 'Newer.', homemini: 'saved' })
    assert.deepEqual(await readPendingHeadlines(stateDir), {})
  })

  it('a retry that fails after a newer one was sent never puts the old line back on the waiting list', { timeout: 60_000 }, async () => {
    const stateDir = tmp()
    await setHeadline({ stateDir, send: async () => 'retry', warn: quiet }, PUNK_ID, 'Older.')
    const hub = gatedHomemini((_k, h) => (h === 'Older.' ? 'retry' : 'done'))
    const retry = flushPendingHeadlines(stateDir, hub.send, undefined, quiet)
    while (hub.inFlight.length === 0) await tick()
    const save = setHeadline({ stateDir, send: hub.send, warn: quiet }, PUNK_ID, 'Newer.')
    let settledAll = false
    void Promise.all([retry, save]).then(() => { settledAll = true })
    while (!settledAll) {
      const next = hub.inFlight.shift()
      if (next) next.release()
      await tick()
    }
    // "Older" was refused (retry); "Newer" is still owed or sent, never "Older" again.
    const left = await readPendingHeadlines(stateDir)
    assert.ok(!Object.values(left).includes('Older.'), JSON.stringify(left))
    // one more flush settles it on the newer line
    await flushPendingHeadlines(stateDir, async (k, h) => { hub.applied.set(k, h); return 'done' })
    assert.equal(hub.applied.get(PUNK_ID), 'Newer.')
  })

  it('200 runs of two lists saved at once, with the list read and the retry flushing beside them: nothing torn, nothing thrown, nothing owed lost', { timeout: 60_000 }, async () => {
    const problems = { torn: 0, saveThrew: 0, flushThrew: 0, wiped: 0, wrongFinal: 0 }
    for (let run = 0; run < 200; run++) {
      const stateDir = tmp()
      const applied = new Map<string, string | null>()
      // List A's homemini is away this run (every send is 'retry'); B's answers after a random wait.
      const send: HeadlineSend = (key, headline) => new Promise((resolve) => {
        setTimeout(() => {
          if (key === PUNK_ID) { resolve('retry'); return }
          applied.set(key, headline)
          resolve('done')
        }, Math.floor(Math.random() * 3))
      })
      const jobs: Array<Promise<unknown>> = []
      const save = (key: string, h: string) => jobs.push(setHeadline({ stateDir, send, warn: quiet }, key, h).catch(() => { problems.saveThrew++ }))
      const flush = () => jobs.push(flushPendingHeadlines(stateDir, send, undefined, quiet).catch(() => { problems.flushThrew++ }))
      save(PUNK_ID, `A ${run}.`)
      save(Y2K_ID, `B ${run}.`)
      flush()
      save(Y2K_ID, `B ${run} again.`)
      flush()
      save(PUNK_ID, `A ${run} again.`)
      await Promise.all(jobs)
      let pending: Record<string, unknown> | null = null
      try { pending = JSON.parse(readFileSync(join(stateDir, PENDING_FILE), 'utf-8')) } catch { problems.torn++ }
      if (pending && pending[PUNK_ID] !== `A ${run} again.`) problems.wiped++
      if (pending && Y2K_ID in pending) problems.wiped++
      if (applied.get(Y2K_ID) !== `B ${run} again.`) problems.wrongFinal++
    }
    assert.deepEqual(problems, { torn: 0, saveThrew: 0, flushThrew: 0, wiped: 0, wrongFinal: 0 })
  })
})

describe('Headline… reaches homemini (PATCH a list, PUT the Top 1000)', () => {
  it('a list: PATCH /api/ipod-lists/:id { headline }, null to clear', async () => {
    const h = fakeHomemini(200, list(PUNK_ID, 'punkPod', [1], { headline: 'Louder than it looks.' }))
    const client = createIpodListClient({ baseUrl: 'http://homemini:3000', fetchImpl: h.fetchImpl, warn: quiet })
    assert.equal(await client.setHeadline(PUNK_ID, 'Louder than it looks.'), 'done')
    assert.equal(await client.setHeadline(PUNK_ID, null), 'done')
    assert.deepEqual(h.seen.map((s) => [s.method, s.url, s.body]), [
      ['PATCH', `http://homemini:3000/api/ipod-lists/${PUNK_ID}`, { headline: 'Louder than it looks.' }],
      ['PATCH', `http://homemini:3000/api/ipod-lists/${PUNK_ID}`, { headline: null }],
    ])
  })
  it('a homemini older than the field (400), one that is down, or a 5xx: the headline waits; no such list (404): dropped', async () => {
    const answer = async (status: number | 'down') =>
      createIpodListClient({ baseUrl: 'http://homemini:3000', fetchImpl: fakeHomemini(status).fetchImpl, warn: quiet }).setHeadline(PUNK_ID, 'Louder than it looks.')
    assert.equal(await answer(400), 'retry')
    assert.equal(await answer('down'), 'retry')
    assert.equal(await answer(500), 'retry')
    assert.equal(await answer(401), 'retry')
    assert.equal(await answer(404), 'drop')
  })
  it('the Top 1000: PUT /api/top1000/name with the headline alone, so its name is never touched', async () => {
    const h = fakeHomemini(200, { name: 'Top 1000', custom: null, headline: 'Every one a keeper.' })
    const remote = createTop1000HeadlineRemote({ baseUrl: 'http://homemini:3000/', fetchImpl: h.fetchImpl, warn: quiet })
    assert.equal(await remote.put('Every one a keeper.'), 'done')
    assert.deepEqual(h.seen[0], { url: 'http://homemini:3000/api/top1000/name', method: 'PUT', body: { headline: 'Every one a keeper.' } })
    assert.deepEqual(await remote.get(), { headline: 'Every one a keeper.', counts: null, story: null }, 'no counts sent: none')
    // older than the field: 400 on the PUT ("only name can be set"), no headline on the GET
    const old = createTop1000HeadlineRemote({ baseUrl: 'http://homemini:3000', fetchImpl: fakeHomemini(400).fetchImpl, warn: quiet })
    assert.equal(await old.put('Every one a keeper.'), 'retry')
    const oldGet = createTop1000HeadlineRemote({ baseUrl: 'http://homemini:3000', fetchImpl: fakeHomemini(200, { name: 'Top 1000', custom: null }).fetchImpl, warn: quiet })
    assert.deepEqual(await oldGet.get(), { headline: null, counts: null, story: null })
    const down = createTop1000HeadlineRemote({ baseUrl: 'http://homemini:3000', fetchImpl: fakeHomemini('down').fetchImpl, warn: quiet })
    assert.equal(await down.put(null), 'retry')
    assert.equal(await down.get(), undefined)
  })
  it('the Top 1000\'s headline: a waiting one wins, then homemini\'s, then its last answer kept here', async () => {
    const stateDir = tmp()
    assert.deepEqual(await localTop1000Headline(stateDir), { headline: null, pending: false, counts: null, story: null })
    const counts = { songCount: 1000, artistCount: 458 }
    assert.deepEqual(await readTop1000Headline({ stateDir, get: async () => ({ headline: 'From homemini.', counts, story: null }) }), { headline: 'From homemini.', pending: false, counts, story: null })
    // homemini away: the copy kept from its last answer, counts included
    assert.deepEqual(await readTop1000Headline({ stateDir, get: async () => undefined }), { headline: 'From homemini.', pending: false, counts, story: null })
    assert.deepEqual(await localTop1000Headline(stateDir), { headline: 'From homemini.', pending: false, counts, story: null })
    // Jake changes it with homemini away: his words show, here, at once
    const r = await setHeadline({ stateDir, send: async () => 'retry', warn: quiet }, TOP1000_HEADLINE_KEY, 'Mine now.')
    assert.equal(r.ok && r.homemini, 'later')
    // homemini answers with its old line and new counts: the line owed wins, the counts are taken,
    // and the old line is not what the next launch paints
    const later = { songCount: 1000, artistCount: 457 }
    assert.deepEqual(await readTop1000Headline({ stateDir, get: async () => ({ headline: 'From homemini.', counts: later, story: null }) }), { headline: 'Mine now.', pending: true, counts: later, story: null })
    assert.deepEqual(await localTop1000Headline(stateDir), { headline: 'Mine now.', pending: true, counts: later, story: null })
    // homemini back: sent, and the kept copy is the new line with homemini's counts kept (a PUT answer has none)
    const again = await setHeadline({ stateDir, send: async () => 'done' }, TOP1000_HEADLINE_KEY, 'Mine now.')
    assert.equal(again.ok && again.homemini, 'saved')
    assert.deepEqual(await localTop1000Headline(stateDir), { headline: 'Mine now.', pending: false, counts: later, story: null })
    // a homemini that can't build the Top 1000 leaves the counts out: this Mac counts again
    assert.deepEqual(await readTop1000Headline({ stateDir, get: async () => ({ headline: 'Mine now.', counts: null, story: null }) }), { headline: 'Mine now.', pending: false, counts: null, story: null })
  })

  it('homemini\'s Top 1000 answer: both counts or none', async () => {
    const both = createTop1000HeadlineRemote({ baseUrl: 'http://homemini:3000', fetchImpl: fakeHomemini(200, { name: 'Top 1000', custom: null, headline: null, songCount: 1000, artistCount: 458 }).fetchImpl, warn: quiet })
    assert.deepEqual(await both.get(), { headline: null, counts: { songCount: 1000, artistCount: 458 }, story: null })
    const one = createTop1000HeadlineRemote({ baseUrl: 'http://homemini:3000', fetchImpl: fakeHomemini(200, { name: 'Top 1000', custom: null, songCount: 1000 }).fetchImpl, warn: quiet })
    assert.deepEqual(await one.get(), { headline: null, counts: null, story: null })
  })
})

describe('the lists the page reads (main/ipod-lists-gather.ts)', () => {
  const punk = buildDeviceMarker({ id: PUNK_ID, name: 'punkPod', color: 'red', primary: false, now })
  const refresh = async () => ({ poolIds: [1], listIds: [1], names: {}, source: 'homemini' as const, note: null, updatedAt: now })
  it('carry the headline, the cap and the last sync; a headline waiting for homemini wins, a cleared one too', async () => {
    const stateDir = tmp()
    const base = {
      registry: async () => [punk],
      refresh,
      all: async () => [list(PUNK_ID, 'punkPod', [1], { headline: 'Old line.', cap: 5000, songCount: 834, artistCount: 199 }), list(Y2K_ID, 'Y2K', [2], { headline: 'Period correct.' })],
      cacheFile: ipodListsCachePath(stateDir),
      lastSynced: async () => ({ [PUNK_ID]: '2026-11-08T18:15:00.000Z' }),
    }
    const hub = await gatherIpodLists({ ...base, isReplica: async () => false })
    assert.deepEqual(hub.lists.map((l) => [l.songCount, l.artistCount]), [[834, 199], [null, null]], 'homemini\'s counts pass through, or null')
    assert.deepEqual(hub.lists.map((l) => [l.name, l.headline, l.cap, l.lastSyncedAt]), [
      ['punkPod', 'Old line.', 5000, '2026-11-08T18:15:00.000Z'],
      ['Y2K', 'Period correct.', 1000, null],
    ])
    const waiting = await gatherIpodLists({ ...base, isReplica: async () => false, pendingHeadlines: async () => ({ [PUNK_ID]: 'Louder than it looks.', [Y2K_ID]: null }) })
    assert.deepEqual(waiting.lists.map((l) => l.headline), ['Louder than it looks.', null])
    // a replica never reads this Mac's sync records
    const replica = await gatherIpodLists({ ...base, isReplica: async () => true, pendingHeadlines: async () => ({ [Y2K_ID]: 'New.' }) })
    assert.deepEqual(replica.lists.map((l) => [l.headline, l.cap, l.lastSyncedAt]), [['Old line.', 5000, null], ['New.', 1000, null]])
  })
  it('a homemini that sends no headline: null, and nothing else changes', async () => {
    const stateDir = tmp()
    const out = await gatherIpodLists({
      isReplica: async () => false, registry: async () => [punk], refresh,
      all: async () => [list(PUNK_ID, 'punkPod', [1]), list(Y2K_ID, 'Y2K', [2])],
      cacheFile: ipodListsCachePath(stateDir),
    })
    assert.deepEqual(out.lists.map((l) => [l.name, l.headline, l.lastSyncedAt]), [['punkPod', null, null], ['Y2K', null, null]])
    // homemini away afterwards: the kept copy answers, a registered iPod's cap is simply not known
    const away = await gatherIpodLists({
      isReplica: async () => false, registry: async () => [punk], refresh,
      all: async () => null, cacheFile: ipodListsCachePath(stateDir),
    })
    assert.deepEqual(away.lists.map((l) => [l.name, l.headline, l.cap]), [['punkPod', null, 1000], ['Y2K', null, 1000]])
  })
})

describe('the page is wired', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf-8')
  it('the writes are main-window only, and reach the renderer', () => {
    const ipc = read('../ipc/ipod-lists-ipc.ts')
    assert.match(ipc, /ipc\.handle\('ipod-headline:set'[\s\S]*?\{ refuse: \{ ok: false, error: 'refused-sender' \} \}\)/)
    assert.match(ipc, /await flushHeadlines\(\)/, 'a waiting headline goes before each list read')
    assert.match(ipc, /void flushHeadlines\(\)/, 'and on the 5-minute retry')
    const preload = read('../../preload/index.ts')
    for (const ch of ['ipod-headline:set', 'ipod-headline:top1000']) assert.match(preload, new RegExp(`'${ch}'`))
  })
  it('the ad is the top of the list\'s own scroller, in list view, and Headline… sits beside Rename…', () => {
    const view = read('../../renderer/views/SmartPlaylistView.tsx')
    assert.match(view, /const showAd = adPage && viewMode === 'list'/)
    assert.match(view, /\{showAd && adEl\}\s*\{showAd \? <div className="songs-pin">\{headerEl\}\{panelsEl\}\{columnsEl\}<\/div> : columnsEl\}/)
    assert.match(view, /Headline…\s*<\/button>\s*\)\}\s*<button className="top25-window-btn" onClick=\{\(\) => setRenaming\(true\)\}/)
    assert.match(view, /setTop1000Headline\(value\) : await setIpodListHeadline\(ipodList!\.id, value\)/)
    // never a native dialog (V3 CLAUDE.md): the box is the app's own
    assert.doesNotMatch(view, /window\.(prompt|alert|confirm)\(/)
  })
  it('the ad is Hoefler Text with a Georgia fallback, 340px tall, and nothing in it tilts, glows or moves', () => {
    const css = read('../../renderer/styles/ipod-ad.css')
    assert.match(css, /--ipod-ad-serif: "Hoefler Text", Georgia, serif;/)
    assert.match(css, /\.ipod-ad \{[\s\S]*?height: 340px;/)
    const ad = css.split('/* ── The page under the ad')[0]
    assert.doesNotMatch(ad, /rotate|skew|animation|transition|box-shadow|text-shadow|filter:/)
    const drawing = read('../../renderer/components/IpodDrawing.tsx')
    assert.doesNotMatch(drawing, /rotate\(|skew|<animate|filter=/)
  })
  it('the renderer stores put the old line back on a refusal and never fire and forget', () => {
    const lists = read('../../renderer/ipodLists.ts')
    assert.match(lists, /export async function setIpodListHeadline[\s\S]*?if \(!r\.ok\) \{\s*snap = before/)
    const top = read('../../renderer/top1000Headline.ts')
    assert.match(top, /export async function setTop1000Headline[\s\S]*?if \(!r\.ok\) \{\s*edits\+\+\s*put\(before\)/)
  })
})

describe('the story under the ad (2026-11-24)', () => {
  const STORY = 'Three chords, two minutes, no permission.\n\nPunk split almost immediately.\n\nLouder than it looks.'
  it('cleanStory keeps homemini\'s text as it is; anything homemini wouldn\'t keep is none', () => {
    assert.equal(cleanStory(STORY), STORY)
    assert.equal(cleanStory(`  ${STORY.replace(/\n/g, '\r\n')}\n`), STORY)
    assert.equal(cleanStory('x'.repeat(STORY_MAX)), 'x'.repeat(STORY_MAX))
    for (const bad of [null, undefined, 7, '', ' \n ', 'x'.repeat(STORY_MAX + 1), 'a\tb', 'bell\u0007']) assert.equal(cleanStory(bad), null, JSON.stringify(bad))
  })
  it('storyParagraphs splits at each blank line and keeps the words; none is []', () => {
    assert.deepEqual(storyParagraphs(STORY), ['Three chords, two minutes, no permission.', 'Punk split almost immediately.', 'Louder than it looks.'])
    assert.deepEqual(storyParagraphs('One.\n  \n\n\nTwo.'), ['One.', 'Two.'])
    assert.deepEqual(storyParagraphs('Line a\nline b\n\nNext.'), ['Line a\nline b', 'Next.'])
    assert.deepEqual(storyParagraphs(null), [])
    assert.deepEqual(storyParagraphs('   '), [])
  })
  it('homemini\'s list carries it; a bad one is absent and the list still parses', () => {
    assert.equal(parseIpodList({ ...list(PUNK_ID, 'punkPod', [1]), story: STORY })?.story, STORY)
    for (const bad of [null, 7, '', 'x'.repeat(STORY_MAX + 1)]) {
      const l = parseIpodList({ ...list(PUNK_ID, 'punkPod', [1]), story: bad })
      assert.ok(l)
      assert.equal('story' in l, false)
    }
  })
  it('the lists the page reads carry it, hub and replica, and null when homemini sends none', async () => {
    const stateDir = tmp()
    const punk = buildDeviceMarker({ id: PUNK_ID, name: 'punkPod', color: 'red', primary: false, now })
    const base = {
      registry: async () => [punk],
      refresh: async () => ({ poolIds: [1], listIds: [1], names: {}, source: 'homemini' as const, note: null, updatedAt: now }),
      all: async () => [list(PUNK_ID, 'punkPod', [1], { story: STORY }), list(Y2K_ID, 'Y2K', [2])],
      cacheFile: ipodListsCachePath(stateDir),
    }
    assert.deepEqual((await gatherIpodLists({ ...base, isReplica: async () => false })).lists.map((l) => l.story), [STORY, null])
    assert.deepEqual((await gatherIpodLists({ ...base, isReplica: async () => true })).lists.map((l) => l.story), [STORY, null])
    // homemini away: the kept copy still has it
    assert.deepEqual((await gatherIpodLists({ ...base, all: async () => null, isReplica: async () => true })).lists.map((l) => l.story), [STORY, null])
  })
  it('the Top 1000\'s: read from GET /api/top1000/name, kept for the first paint, and a headline save keeps it', async () => {
    const remote = createTop1000HeadlineRemote({ baseUrl: 'http://homemini:3000', fetchImpl: fakeHomemini(200, { name: 'Top 1000', custom: null, headline: null, story: STORY }).fetchImpl, warn: quiet })
    assert.deepEqual(await remote.get(), { headline: null, counts: null, story: STORY })
    const stateDir = tmp()
    assert.equal((await readTop1000Headline({ stateDir, get: remote.get })).story, STORY)
    assert.equal((await localTop1000Headline(stateDir)).story, STORY, 'on disk: the next launch paints it at once')
    assert.equal((await readTop1000Headline({ stateDir, get: async () => undefined })).story, STORY, 'homemini away: the kept copy')
    await setHeadline({ stateDir, send: async () => 'done' }, TOP1000_HEADLINE_KEY, 'New line.')
    assert.equal((await localTop1000Headline(stateDir)).story, STORY, 'a headline save never drops it')
    // homemini cleared it: gone here too
    assert.equal((await readTop1000Headline({ stateDir, get: async () => ({ headline: 'New line.', counts: null, story: null }) })).story, null)
  })
  it('the page shows it under the ad, from the same reads as the headline', () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf-8')
    const view = read('../../renderer/views/SmartPlaylistView.tsx')
    assert.match(view, /story=\{adKnown \? \(playlistId === 'top-1000' \? top1000Story : ipodList\?\.story\) : null\}/)
    const ad = read('../../renderer/components/IpodAd.tsx')
    assert.match(ad, /<\/section>\s*<IpodAdStory story=\{story\} dark=\{dark\} \/>/)
    assert.match(ad, /if \(!paragraphs\.length\) return null/)
    const css = read('../../renderer/styles/ipod-ad.css')
    assert.match(css, /\.ipod-ad-story-text \{ max-width: 620px; \}/)
  })
})
