// lyrics.ovh fallback + likely-instrumental misses (2026-10-27). LRCLIB stays
// the first source; lyrics.ovh (plain text, NO duration check) is asked only
// after both LRCLIB paths miss and only for titles that can't be a different
// cut. A double miss on a likely-instrumental track is still a MISS (Get Info
// must not say "Instrumental" on a guess), retried after 180 days, not 30.
// No network: every test injects a fake fetch.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLyricsFetcher, isLikelyInstrumental, missTtlMs, ovhTitleBlocked, cleanOvhText,
  MISS_TTL_MS, LIKELY_INSTRUMENTAL_MISS_TTL_MS, LIKELY_INSTRUMENTAL_GENRES,
} from '../../../scripts/lyrics-sources.mjs'

type Reply = { status: number; body?: unknown } | Error
type Track = { id: number; title: string; artist: string; album?: string; genre?: string; duration?: number }

const LONG = 'I walked along the river and the river walked with me\nWe sang until the morning and the morning set us free\n'

/** Fake fetch: LRCLIB get/search reply per the given shape; ovh per `ovh`. */
function harness(opts: { lrclibGet?: Reply; lrclibSearch?: Reply; ovh?: Reply }) {
  const calls: string[] = []
  let clock = 1_000_000
  const reply = (r: Reply | undefined, fallback: Reply) => {
    const x = r ?? fallback
    if (x instanceof Error) throw x
    return { status: x.status, json: async () => x.body }
  }
  const fetch = async (url: string) => {
    calls.push(url)
    if (url.includes('lrclib.net/api/get')) return reply(opts.lrclibGet, { status: 404 })
    if (url.includes('lrclib.net/api/search')) return reply(opts.lrclibSearch, { status: 200, body: [] })
    if (url.includes('api.lyrics.ovh')) return reply(opts.ovh, { status: 404 })
    throw new Error(`unexpected ${url}`)
  }
  const fetcher = createLyricsFetcher({ fetch, sleep: async (ms: number) => { clock += ms }, now: () => clock })
  return { fetcher, calls, ovhCalls: () => calls.filter((u) => u.includes('api.lyrics.ovh')) }
}
const track = (over: Partial<Track> = {}): Track => ({ id: 7, title: 'River Song', artist: 'The Walkers', album: 'Banks', genre: 'Indie Rock', duration: 200000, ...over })

describe('lyrics.ovh fallback', () => {
  test('LRCLIB hit never asks lyrics.ovh and keeps lrclibId', async () => {
    const h = harness({ lrclibGet: { status: 200, body: { id: 42, plainLyrics: LONG, syncedLyrics: '[00:01.00] hi' } } })
    const { rec, via } = await h.fetcher.lookup(track())
    assert.equal(via, 'lrclib')
    assert.equal(rec.source, 'lrclib')
    assert.equal(rec.lrclibId, 42)
    assert.equal(h.ovhCalls().length, 0)
  })

  test('double LRCLIB miss + ovh hit → { plain, source: lyrics.ovh } with no synced / lrclibId', async () => {
    const h = harness({ ovh: { status: 200, body: { lyrics: 'Paroles de la chanson River Song par The Walkers\r\n' + LONG } } })
    const { rec, via } = await h.fetcher.lookup(track())
    assert.equal(via, 'lyrics.ovh')
    assert.equal(rec.source, 'lyrics.ovh')
    assert.equal(rec.plain, LONG.trim(), 'the "Paroles de la chanson" header is stripped')
    assert.ok(!('synced' in rec) && !('lrclibId' in rec) && !rec.miss)
    assert.equal(typeof rec.fetchedAt, 'number')
    const url = h.ovhCalls()[0]
    assert.equal(url, 'https://api.lyrics.ovh/v1/The%20Walkers/River%20Song')
    assert.ok(h.calls.some((u) => u.includes('/api/get')) && h.calls.some((u) => u.includes('/api/search')), 'both LRCLIB paths ran first')
  })

  test('remix / dub / edit / live titles (or albums) never take an ovh hit', async () => {
    for (const over of [{ title: 'River Song (Dub)' }, { title: 'River Song - Extended Mix' }, { title: 'River Song (Radio Edit)' },
      { title: 'River Song (Remixed)' }, { title: 'River Song (Live)' }, { title: 'River Song - Radio Edit' },
      { title: 'River Song [Live at Wembley]' }, { title: 'River Song - Interlude' }, { title: 'River Song (Instrumental)' },
      { title: 'River Song', album: 'Live at the Banks' }, { title: 'River Song', album: 'Banks (Live)' }]) {
      const h = harness({ ovh: { status: 200, body: { lyrics: LONG } } })
      const { rec } = await h.fetcher.lookup(track(over))
      assert.equal(rec.miss, true, JSON.stringify(over))
      assert.equal(h.ovhCalls().length, 0, `ovh not asked for ${JSON.stringify(over)}`)
    }
    assert.equal(ovhTitleBlocked('Remixing Society', ''), false, 'word boundary: a word merely containing "mix" passes')
    assert.equal(ovhTitleBlocked('Song (Live)', ''), true)
    assert.equal(ovhTitleBlocked('Song - Radio Edit', ''), true)
    assert.equal(ovhTitleBlocked('Credit', ''), false, '"edit" inside a word passes')
  })

  test('a song merely TITLED with a block word is not a version: "Live Forever", "Mix Tape" ask ovh', async () => {
    for (const title of ['Live Forever', 'Mix Tape', 'Live and Let Die', 'Intro']) {
      assert.equal(ovhTitleBlocked(title, 'Definitely Maybe'), false, title)
      const h = harness({ ovh: { status: 200, body: { lyrics: LONG } } })
      const { rec, via } = await h.fetcher.lookup(track({ title, genre: 'Rock' }))
      assert.equal(via, 'lyrics.ovh', title)
      assert.equal(rec.source, 'lyrics.ovh')
      assert.equal(h.ovhCalls().length, 1)
    }
    assert.equal(ovhTitleBlocked('Song', 'Live Through This'), false, 'an album merely starting with "Live" is not a live album')
  })

  test('short or placeholder ovh text is rejected', async () => {
    for (const lyrics of ['', 'Instrumental', 'Paroles de la chanson River Song par The Walkers\r\n', 'la la la la'.repeat(5)]) {
      const h = harness({ ovh: { status: 200, body: { lyrics } } })
      const { rec, via } = await h.fetcher.lookup(track())
      assert.equal(via, 'miss', JSON.stringify(lyrics))
      assert.equal(rec.miss, true)
    }
    assert.equal(cleanOvhText(undefined), null)
  })

  test('miss on both → { miss, source: lrclib+ovh }, 30-day retry', async () => {
    const h = harness({})
    const { rec } = await h.fetcher.lookup(track())
    assert.deepEqual(Object.keys(rec).sort(), ['fetchedAt', 'miss', 'source'])
    assert.equal(rec.source, 'lrclib+ovh')
    assert.equal(missTtlMs(rec), MISS_TTL_MS)
    assert.equal(h.ovhCalls().length, 1, 'one ovh attempt, no retries on 404')
  })

  test('ovh network error → an ordinary LRCLIB miss, never likelyInstrumental, never throws', async () => {
    const h = harness({ ovh: new Error('ECONNRESET') })
    const { rec, via } = await h.fetcher.lookup(track({ genre: 'Techno' }))
    assert.equal(via, 'miss')
    assert.deepEqual(rec, { miss: true, source: 'lrclib', fetchedAt: rec.fetchedAt })
    assert.equal(missTtlMs(rec), MISS_TTL_MS)
  })

  test('a transient LRCLIB failure still throws (stored nothing → retried next run) without asking ovh', async () => {
    const h = harness({ lrclibGet: new Error('timeout') })
    await assert.rejects(h.fetcher.lookup(track()))
    assert.equal(h.ovhCalls().length, 0)
  })

  test('at most one ovh request per second', async () => {
    const times: number[] = []
    let clock = 0
    const fetch = async (url: string) => {
      if (url.includes('api.lyrics.ovh')) times.push(clock)
      return { status: url.includes('/api/search') ? 200 : 404, json: async () => [] }
    }
    // Only the ovh limiter's own waits (≤ 1 s) move the clock — LRCLIB's 1.2 s
    // cold-cache beat does not, so without the limiter every gap would be 0.
    const f = createLyricsFetcher({ fetch, sleep: async (ms: number) => { if (ms <= 1000) clock += ms }, now: () => clock })
    for (let i = 0; i < 3; i++) await f.lookup(track({ id: i }))
    assert.equal(times.length, 3)
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1000, `gap ${times[i] - times[i - 1]}ms`)
  })
})

describe('likely-instrumental misses', () => {
  test('genre or title → { miss, likelyInstrumental, source: lrclib+ovh }, 180-day retry', async () => {
    for (const over of [{ genre: 'deep house' }, { genre: 'Techno' }, { genre: 'Soundtrack' }, { title: 'River Song (Instrumental)', genre: 'Rock' }]) {
      const h = harness({})
      const { rec } = await h.fetcher.lookup(track(over))
      assert.equal(rec.miss, true)
      assert.equal(rec.likelyInstrumental, true, JSON.stringify(over))
      assert.ok(!rec.instrumental, 'never claimed instrumental')
      assert.equal(rec.source, 'lrclib+ovh')
      assert.equal(missTtlMs(rec), LIKELY_INSTRUMENTAL_MISS_TTL_MS)
      assert.equal(LIKELY_INSTRUMENTAL_MISS_TTL_MS, 180 * 24 * 3600 * 1000)
    }
  })

  test('the rule: listed genres + Instrumental/Dub titles only; vocal-norm genres are out', () => {
    assert.ok(isLikelyInstrumental({ genre: 'House' }))
    assert.ok(isLikelyInstrumental({ genre: ' instrumental hip-hop ' }))
    assert.ok(isLikelyInstrumental({ genre: 'Indie Rock', title: 'Fade (Dub)' }))
    for (const genre of ['Indie Rock', 'Nu Disco', 'Disco', 'Israeli Hip-Hop', 'Dub-Hop', 'Bossa Nova', 'Comedy', "Children's", 'UK Garage', '']) {
      assert.equal(isLikelyInstrumental({ genre, title: 'Song' }), false, genre)
    }
    assert.equal(isLikelyInstrumental({ genre: 'Rock', title: 'Dubai' }), false, 'word boundary')
    assert.ok(LIKELY_INSTRUMENTAL_GENRES.length > 0 && Object.isFrozen(LIKELY_INSTRUMENTAL_GENRES))
  })

  test('an ordinary miss keeps the 30-day TTL; legacy lrclib misses too', () => {
    assert.equal(missTtlMs({ miss: true, source: 'lrclib+ovh' }), MISS_TTL_MS)
    assert.equal(missTtlMs({ miss: true, source: 'lrclib' }), MISS_TTL_MS)
    assert.equal(MISS_TTL_MS, 30 * 24 * 3600 * 1000)
  })
})
