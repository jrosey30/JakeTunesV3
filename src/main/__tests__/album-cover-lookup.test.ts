/**
 * Finding an album's own cover on the web, for the poster migration. Exact matches
 * only: a wrong cover is worse than none. Offline: fetch is injected.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { comparableTitle, coverArtArchiveCandidate, deezerCandidate, findCoverOnline, itunesCandidate, searchTitle, type FetchLike } from '../album-cover-lookup.ts'

function fakeFetch(answers: (url: string) => { status?: number; json?: unknown; bytes?: Uint8Array } | Error): FetchLike & { asked: string[] } {
  const asked: string[] = []
  const f = (async (url: string) => {
    asked.push(url)
    const a = answers(url)
    if (a instanceof Error) throw a
    const status = a.status ?? 200
    return {
      ok: status < 400,
      status,
      json: async () => a.json ?? {},
      arrayBuffer: async () => (a.bytes ?? new Uint8Array()).buffer as ArrayBuffer,
    }
  }) as FetchLike & { asked: string[] }
  f.asked = asked
  return f
}

describe('comparing titles', () => {
  test('brackets, case, a leading The and curly quotes do not count', () => {
    assert.equal(comparableTitle("All The World's A Stage [Live]"), comparableTitle('All the World’s a Stage (Live) [Remastered]'))
    assert.equal(comparableTitle('The Postal Service'), comparableTitle('Postal Service'))
    assert.equal(comparableTitle('Good Evening New York City (Live At Citi Field, NYC, 2009)'), comparableTitle('Good Evening New York City'))
  })
  test('the search drops the tags', () => {
    assert.equal(searchTitle('Everything Will Change (Live)'), 'Everything Will Change')
    assert.equal(searchTitle("All The World's A Stage [Live]"), "All The World's A Stage")
    assert.equal(searchTitle('(Live)'), '(Live)', 'a title that is only a tag stays itself')
  })
})

describe('each source', () => {
  test('iTunes: the exact album, at 1200 px', async () => {
    const f = fakeFetch(() => ({ json: { results: [
      { artistName: 'Rush', collectionName: 'Moving Pictures', artworkUrl100: 'https://x/mp/100x100bb.jpg' },
      { artistName: 'Rush', collectionName: "All the World's a Stage (Live) [Remastered]", artworkUrl100: 'https://x/atwas/100x100bb.jpg' },
    ] } }))
    const hit = await itunesCandidate('Rush', "All The World's A Stage [Live]", f)
    assert.equal(hit?.url, 'https://x/atwas/1200x1200bb.jpg')
    assert.equal(hit?.provider, 'itunes')
  })
  test('a prefix is not a match: "Alive" must not find "Alive 2007"', async () => {
    const f = fakeFetch(() => ({ json: { data: [{ title: 'Alive 2007', artist: { name: 'Daft Punk' }, cover_xl: 'https://x/a.jpg' }] } }))
    assert.equal(await deezerCandidate('Daft Punk', 'Alive', f), null)
  })
  test('the wrong artist is never a match', async () => {
    const f = fakeFetch(() => ({ json: { data: [{ title: 'Stop Making Sense', artist: { name: 'A Tribute Band' }, cover_xl: 'https://x/a.jpg' }] } }))
    assert.equal(await deezerCandidate('Talking Heads', 'Stop Making Sense', f), null)
  })
  test('Cover Art Archive goes through MusicBrainz, exact release and credit', async () => {
    const f = fakeFetch(() => ({ json: { releases: [
      { id: 'wrong', title: 'Unplugged', 'artist-credit': [{ name: 'Nirvana' }] },
      { id: 'right', title: 'MTV Unplugged in New York', 'artist-credit': [{ name: 'Nirvana' }] },
    ] } }))
    const hit = await coverArtArchiveCandidate('Nirvana', 'MTV Unplugged In New York', f)
    assert.equal(hit?.url, 'https://coverartarchive.org/release/right/front')
  })
})

describe('the chain', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])
  test('the biggest source first, and the bytes come with it', async () => {
    const f = fakeFetch((url) => {
      if (url.includes('itunes.apple.com')) return { json: { results: [{ artistName: 'Paul McCartney', collectionName: 'Good Evening New York City', artworkUrl100: 'https://img/100x100bb.jpg' }] } }
      if (url.startsWith('https://img/')) return { bytes }
      return new Error(`should not ask ${url}`)
    })
    const hit = await findCoverOnline('Paul McCartney', 'Good Evening New York City (Live At Citi Field, NYC, 2009)', f)
    assert.equal(hit?.candidate.provider, 'itunes')
    assert.equal(hit?.bytes.length, bytes.length)
  })
  test('a source that fails is skipped, not fatal', async () => {
    const logged: string[] = []
    const f = fakeFetch((url) => {
      if (url.includes('itunes.apple.com')) return new Error('offline')
      if (url.includes('deezer')) return { json: { data: [{ title: 'Alive 2007', artist: { name: 'Daft Punk' }, cover_xl: 'https://img/a.jpg' }] } }
      if (url.startsWith('https://img/')) return { bytes }
      return new Error(`should not ask ${url}`)
    })
    const hit = await findCoverOnline('Daft Punk', 'Alive 2007', f, (m) => logged.push(m))
    assert.equal(hit?.candidate.provider, 'deezer')
    assert.ok(logged.some((m) => m.includes('offline')))
  })
  test('found nowhere is null: the album is left alone', async () => {
    const f = fakeFetch(() => ({ json: {} }))
    assert.equal(await findCoverOnline('Nirvana', "Amsterdam '91 - Come As You Are [Live]", f), null)
  })
  test('a match whose image will not download moves to the next source', async () => {
    const f = fakeFetch((url) => {
      if (url.includes('itunes.apple.com')) return { json: { results: [{ artistName: 'B', collectionName: 'A', artworkUrl100: 'https://bad/100x100bb.jpg' }] } }
      if (url.startsWith('https://bad/')) return { status: 404 }
      if (url.includes('deezer')) return { json: { data: [{ title: 'A', artist: { name: 'B' }, cover_xl: 'https://img/a.jpg' }] } }
      if (url.startsWith('https://img/')) return { bytes }
      return { json: {} }
    })
    assert.equal((await findCoverOnline('B', 'A', f))?.candidate.provider, 'deezer')
  })
})
