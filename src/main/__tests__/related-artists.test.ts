// Related artists on the artist page (2026-10-22, Jake: both devices show the
// identical list, from the same homemini route; never the artist itself).
// The client reads homemini's list first (with the companion header like its
// other homemini reads) and asks Claude here only when homemini can't answer.
// A fake homemini and a fake Claude: no network, no Electron.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRelatedArtistsClient, dropSelf, relatedUserPrompt, selfKey,
  RELATED_MAX, RELATED_SYSTEM, RELATED_TTL_MS,
} from '../related-artists.ts'
import { COMPANION_HEADER, COMPANION_TOKEN_ENV } from '../hub-companion.ts'
import type { ProfileFetchLike } from '../artist-profile-client.ts'

const savedToken = process.env[COMPANION_TOKEN_ENV]
afterEach(() => {
  if (savedToken === undefined) delete process.env[COMPANION_TOKEN_ENV]
  else process.env[COMPANION_TOKEN_ENV] = savedToken
})

// Haiku's actual answer for the Chili Peppers' own page (2026-10-22): the band row first.
const RHCP = [
  { name: 'Red Hot Chili Peppers', relation: 'band' },
  { name: 'Anthony Kiedis', relation: 'member' },
  { name: 'Flea', relation: 'member' },
  { name: 'John Frusciante', relation: 'member' },
  { name: 'Chad Smith', relation: 'member' },
  { name: 'Eleven', relation: 'sideProject' },
  { name: 'Atoms for Peace', relation: 'sideProject' },
  { name: 'Fishbone', relation: 'similar' },
  { name: "Jane's Addiction", relation: 'similar' },
  { name: 'Rage Against the Machine', relation: 'similar' },
]

const reply = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

interface Seen { url: string; headers: Headers }

/** A fake homemini: answers each call from `answer`, and remembers what it was asked. */
function fakeHub(answer: () => ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>): { fetchImpl: ProfileFetchLike; seen: Seen[] } {
  const seen: Seen[] = []
  const fetchImpl: ProfileFetchLike = async (url, init) => {
    seen.push({ url, headers: new Headers((init?.headers as HeadersInit | undefined) ?? {}) })
    return answer()
  }
  return { fetchImpl, seen }
}

function localAsk(text: string): { askLocal: (s: string, u: string) => Promise<string>; asked: Array<{ system: string; user: string }> } {
  const asked: Array<{ system: string; user: string }> = []
  return { asked, askLocal: async (system, user) => { asked.push({ system, user }); return text } }
}

const quiet = { warn: () => {} }

describe('related artists — reads homemini first', () => {
  it('asks the shared route for the artist and hands back its list', async () => {
    const hub = fakeHub(() => reply({ ok: true, related: [{ name: 'Wings', relation: 'sideProject' }, { name: 'Turnstile', relation: 'similar' }] }))
    const local = localAsk('[]')
    const c = createRelatedArtistsClient({ baseUrl: 'http://homemini:3000/', ...hub, ...local, ...quiet })
    const out = await c.get('  Simon & Garfunkel ')
    assert.deepEqual(out, { ok: true, related: [{ name: 'Wings', relation: 'sideProject' }, { name: 'Turnstile', relation: 'similar' }], source: 'homemini' })
    assert.equal(hub.seen.length, 1)
    assert.equal(hub.seen[0]!.url, 'http://homemini:3000/api/artist/Simon%20%26%20Garfunkel/related')
    assert.equal(local.asked.length, 0, 'homemini answered, so Claude is not asked here')
  })

  it('sends the companion header when the token is set, and none when it is not', async () => {
    const hub = fakeHub(() => reply({ ok: true, related: [] }))
    const c = createRelatedArtistsClient({ baseUrl: 'http://homemini:3000', ...hub, ...localAsk('[]'), ...quiet })
    delete process.env[COMPANION_TOKEN_ENV]
    await c.get('Geese')
    assert.equal(hub.seen[0]!.headers.get(COMPANION_HEADER), null)
    process.env[COMPANION_TOKEN_ENV] = 'test-token'
    await c.get('Nirvana')
    assert.equal(hub.seen[1]!.headers.get(COMPANION_HEADER), 'test-token')
  })

  it('runs homemini\'s rows through the same whitelist as a local answer', async () => {
    const hub = fakeHub(() => reply({ ok: true, related: [
      { name: 'George Martin', relation: 'collaborator' },
      { name: 'Pete Best', relation: 'bandmate' },
      { name: 'Wings', relation: 'sideProject' },
      { name: 'wings', relation: 'sideProject' },
      { relation: 'band' },
    ] }))
    const out = await createRelatedArtistsClient({ baseUrl: 'http://h', ...hub, ...localAsk('[]'), ...quiet }).get('Paul McCartney')
    assert.deepEqual(out.ok && out.related.map((r) => r.name), ['Wings'])
  })

  it('keeps the first 16', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ name: `Artist ${i + 1}`, relation: 'similar' }))
    const out = await createRelatedArtistsClient({ baseUrl: 'http://h', ...fakeHub(() => reply({ ok: true, related: rows })), ...localAsk('[]'), ...quiet }).get('X')
    assert.equal(out.ok && out.related.length, RELATED_MAX)
    assert.equal(out.ok && out.related[15]!.name, 'Artist 16')
  })

  it('an empty list from homemini is an answer, not a reason to ask locally', async () => {
    const local = localAsk('[{"name":"Hole","relation":"similar"}]')
    const out = await createRelatedArtistsClient({ baseUrl: 'http://h', ...fakeHub(() => reply({ ok: true, related: [] })), ...local, ...quiet }).get('Nirvana')
    assert.deepEqual(out, { ok: true, related: [], source: 'homemini' })
    assert.equal(local.asked.length, 0)
  })

  it('no name answers an empty list without asking anyone', async () => {
    const hub = fakeHub(() => reply({ ok: true, related: [] }))
    const local = localAsk('[]')
    const out = await createRelatedArtistsClient({ baseUrl: 'http://h', ...hub, ...local, ...quiet }).get('   ')
    assert.equal(out.ok && out.related.length, 0)
    assert.equal(hub.seen.length + local.asked.length, 0)
  })
})

describe('related artists — homemini away, the section never goes blank', () => {
  const LOCAL = '[{"name":"Hole","relation":"similar"},{"name":"Foo Fighters","relation":"member"}]'
  const cases: Array<[string, () => ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>]> = [
    ['unreachable', () => { throw new Error('connect ECONNREFUSED') }],
    ['no model key (503)', () => reply({ ok: false, error: 'ANTHROPIC_API_KEY not set on this backend' }, 503)],
    ['its own call failed (502)', () => reply({ ok: false, error: 'overloaded' }, 502)],
    ['a homemini without the route yet (404)', () => reply({ error: 'not found: GET /api/artist/Nirvana/related' }, 404)],
    ['ok:false in a 200', () => reply({ ok: false, error: 'no' })],
    ['junk (not a list)', () => reply({ ok: true, related: 'nope' })],
    ['junk (not JSON)', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })],
  ]
  for (const [label, answer] of cases) {
    it(`falls back to the Mac's own ask: ${label}`, async () => {
      const local = localAsk(LOCAL)
      const out = await createRelatedArtistsClient({ baseUrl: 'http://h', fetchImpl: async () => answer(), askLocal: local.askLocal, ...quiet }).get('Nirvana')
      assert.deepEqual(out, { ok: true, related: [{ name: 'Hole', relation: 'similar' }, { name: 'Foo Fighters', relation: 'member' }], source: 'local' })
      assert.equal(local.asked.length, 1)
      assert.equal(local.asked[0]!.system, RELATED_SYSTEM)
      assert.equal(local.asked[0]!.user, relatedUserPrompt('Nirvana'))
    })
  }

  it('says so when both homemini and the local ask fail', async () => {
    const out = await createRelatedArtistsClient({
      baseUrl: 'http://h',
      fetchImpl: async () => { throw new Error('down') },
      askLocal: async () => { throw new Error('rate limited') },
      errorText: (e) => `x:${e instanceof Error ? e.message : String(e)}`,
      ...quiet,
    }).get('Nirvana')
    assert.deepEqual(out, { ok: false, error: 'x:rate limited' })
  })

  it('logs why it fell back, without the token', async () => {
    process.env[COMPANION_TOKEN_ENV] = 'test-token'
    const lines: string[] = []
    await createRelatedArtistsClient({
      baseUrl: 'http://h',
      fetchImpl: async () => reply({ ok: false }, 503),
      askLocal: async () => '[]',
      warn: (_k, m) => lines.push(m),
    }).get('Nirvana')
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /503/)
    assert.equal(lines[0]!.includes('test-token'), false)
  })
})

describe('related artists — the cache is the one it had: a day, and homemini\'s answers only', () => {
  it('serves homemini\'s answer from memory for a day, then asks again', async () => {
    let clock = 1_000_000
    const hub = fakeHub(() => reply({ ok: true, related: [{ name: 'Hole', relation: 'similar' }] }))
    const c = createRelatedArtistsClient({ baseUrl: 'http://h', ...hub, ...localAsk('[]'), now: () => clock, ...quiet })
    await c.get('Nirvana')
    clock += RELATED_TTL_MS - 1
    const again = await c.get('NIRVANA')
    assert.equal(hub.seen.length, 1)
    assert.equal(again.ok && again.source, 'homemini')
    clock += 2
    await c.get('Nirvana')
    assert.equal(hub.seen.length, 2)
  })

  it('does not keep a local fallback: the next look asks homemini again, and the two converge', async () => {
    let up = false
    const hub = fakeHub(() => { if (!up) throw new Error('away'); return reply({ ok: true, related: [{ name: 'Hole', relation: 'similar' }] }) })
    const local = localAsk('[{"name":"Sebadoh","relation":"similar"}]')
    const c = createRelatedArtistsClient({ baseUrl: 'http://h', ...hub, ...local, ...quiet })
    const first = await c.get('Nirvana')
    assert.deepEqual(first.ok && [first.source, first.related.map((r) => r.name)], ['local', ['Sebadoh']])
    up = true
    const second = await c.get('Nirvana')
    assert.deepEqual(second.ok && [second.source, second.related.map((r) => r.name)], ['homemini', ['Hole']])
  })
})

describe('related artists — never the artist itself', () => {
  it('the real Chili Peppers case: "Red Hot Chili Peppers · band" is not on their own page (homemini list)', async () => {
    const out = await createRelatedArtistsClient({ baseUrl: 'http://h', ...fakeHub(() => reply({ ok: true, related: RHCP })), ...localAsk('[]'), ...quiet }).get('Red Hot Chili Peppers')
    const names = out.ok ? out.related.map((r) => r.name) : []
    assert.equal(names.includes('Red Hot Chili Peppers'), false)
    assert.equal(names.length, 9)
    assert.equal(names[0], 'Anthony Kiedis', 'order kept')
    assert.ok(names.includes('Flea'), 'a member is not self')
  })

  it('and not in the local fallback either', async () => {
    const out = await createRelatedArtistsClient({
      baseUrl: 'http://h',
      fetchImpl: async () => { throw new Error('away') },
      askLocal: async () => JSON.stringify(RHCP),
      ...quiet,
    }).get('Red Hot Chili Peppers')
    assert.deepEqual(out.ok && [out.source, out.related.length, out.related.some((r) => r.name === 'Red Hot Chili Peppers')], ['local', 9, false])
  })

  it('is dropped before the first 16 are kept, so a full page is still full', async () => {
    const rows = [{ name: 'Nirvana', relation: 'band' }, ...Array.from({ length: 20 }, (_, i) => ({ name: `Artist ${i + 1}`, relation: 'similar' }))]
    const out = await createRelatedArtistsClient({ baseUrl: 'http://h', ...fakeHub(() => reply({ ok: true, related: rows })), ...localAsk('[]'), ...quiet }).get('Nirvana')
    assert.equal(out.ok && out.related.length, RELATED_MAX)
    assert.equal(out.ok && out.related[0]!.name, 'Artist 1')
  })

  it('accents, case, punctuation and a leading "The" are the same artist (the shared name fold)', () => {
    assert.equal(selfKey('The Beatles'), selfKey('Beatles'))
    assert.deepEqual(dropSelf([{ name: 'Beyonce', relation: 'band' }, { name: 'BEYONCÉ', relation: 'similar' }, { name: "Destiny's Child", relation: 'band' }], 'Beyoncé').map((r) => r.name), ["Destiny's Child"])
    assert.deepEqual(dropSelf([{ name: 'The Beatles', relation: 'band' }, { name: 'Wings', relation: 'sideProject' }], 'Beatles').map((r) => r.name), ['Wings'])
    assert.deepEqual(dropSelf([{ name: 'Beatles', relation: 'band' }], 'The Beatles'), [])
  })

  it('only the same artist: a longer or different name stays, "The" only counts as a leading word', () => {
    const list = [{ name: 'Foo Fighters', relation: 'band' }, { name: 'Them Crooked Vultures', relation: 'sideProject' }, { name: 'Thee Oh Sees', relation: 'similar' }]
    assert.equal(dropSelf(list, 'Foo').length, 3)
    assert.deepEqual(dropSelf(list, 'Foo Fighters').map((r) => r.name), ['Them Crooked Vultures', 'Thee Oh Sees'])
    assert.equal(dropSelf(list, 'Thee Oh Sees').length, 2)
  })

  it('a name the fold cannot read is never treated as self', () => {
    const list = [{ name: '!!!', relation: 'similar' }, { name: '???', relation: 'similar' }]
    assert.equal(dropSelf(list, '???').length, 2)
  })
})

describe('related artists — wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const main = join(here, '..')
  const read = (f: string) => readFileSync(join(main, f), 'utf-8')

  it('the IPC handler goes through the client (homemini first), not a bare Claude call', () => {
    const index = read('index.ts')
    assert.match(index, /createRelatedArtistsClient\(\{/)
    assert.match(index, /ipc\.handle\('get-related-artists', \(_e, artist: string\) => relatedArtists\.get\(artist\)/)
    assert.equal(/claudeCall\('related-artists'/.test(index), true, 'the local fallback is still the existing ask')
    assert.equal(/parseRelatedArtists\(/.test(index), false, 'the parse lives in the client now')
  })

  it('the prompt is the phone/homemini one, word for word (checked against the shared phrases)', () => {
    assert.match(RELATED_SYSTEM, /exclude George Martin, Pete Best, Stuart Sutcliffe/)
    assert.match(relatedUserPrompt('Nirvana'), /"band","member","sideProject","similar"/)
    assert.match(relatedUserPrompt('Nirvana'), /^List the recording artists most directly related to "Nirvana"/)
  })
})
