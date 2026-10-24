/**
 * The Top 1000 Quiz's standings on the desktop (2026-10-24): adopt homemini's
 * GET /api/top1000/scores with an ETag, keep the last good copy, serve the
 * strip's taste term and Music Man's listener profile.
 * ⚠️ TWIN of JakeTunesMobile backend/src/routes/top1000.ts GET /scores (the
 * route this calls) and backend/src/util/__tests__/top1000.test.ts
 * ("for the rest of JakeTunes").
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseTop1000Scores, isTop1000Usable, top1000KnowledgeBlock, pullTop1000ScoresOnce, currentTop1000Scores,
  TOP1000_SCORES_FILE, TOP1000_SCORES_FRESH_MS,
} from '../top1000-scores.ts'

const file = (over: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, builtAt: '2026-10-24T04:00:00Z', answered: 5365, sure: 0.929, total: 3,
  scores: { '7': [1, 1, 0], '8': [0.5, 0.42, 3], '9': [0.01, 0.001, 2], bad: [2, 9, 1] },
  knowledge: {
    artists: [['The Beatles', 56], ['Daft Punk', 16], ['nope']],
    confirmed: [{ title: 'Scar Tissue', artist: 'Red Hot Chili Peppers' }, { title: 7 }],
    outs: [{ title: 'Panama', artist: 'Van Halen' }],
  },
  ...over,
})

describe('top1000-scores', () => {
  it('parses, validates, and is usable while fresh', () => {
    const s = parseTop1000Scores(file())!
    assert.deepEqual(s.tracks.get('8'), [0.5, 0.42, 3])
    assert.equal(s.tracks.has('bad'), false)
    assert.equal(s.answered, 5365)
    assert.equal(s.sure, 0.929)
    assert.deepEqual(s.knowledge.artists, [['The Beatles', 56], ['Daft Punk', 16]])
    assert.deepEqual(s.knowledge.confirmed, [{ title: 'Scar Tissue', artist: 'Red Hot Chili Peppers' }])
    assert.equal(isTop1000Usable(s, s.builtAtMs + 1000), true)
    assert.equal(isTop1000Usable(s, s.builtAtMs + TOP1000_SCORES_FRESH_MS + 1), false, 'a week-old copy is not used')
    assert.equal(parseTop1000Scores('{"v":2}'), null)
    assert.equal(parseTop1000Scores(file({ scores: {} }))!.tracks.size, 0)
    assert.equal(isTop1000Usable(parseTop1000Scores(file({ scores: {} })), Date.parse('2026-10-24T05:00:00Z')), false, 'no songs = nothing to use')
  })

  it('the Music Man block names the artists by seats, his confirmations and his outs — and is empty when unusable', () => {
    const s = parseTop1000Scores(file())!
    const block = top1000KnowledgeBlock(s, s.builtAtMs + 1000)
    assert.match(block, /5,365 questions/)
    assert.match(block, /93% sure/)
    assert.match(block, /Most seats in his Top 1000: The Beatles \(56\), Daft Punk \(16\)/)
    assert.match(block, /confirmed most emphatically: "Scar Tissue" by Red Hot Chili Peppers/)
    assert.match(block, /put OUT of his 1000 .*"Panama" by Van Halen/)
    assert.match(block, /favourite even with few plays/)
    assert.equal(top1000KnowledgeBlock(s, s.builtAtMs + TOP1000_SCORES_FRESH_MS + 1), '')
    assert.equal(top1000KnowledgeBlock(null, Date.now()), '')
  })

  it("adopts homemini's copy, revalidates with its ETag, refuses malformed or older copies, survives an outage", async () => {
    const local = mkdtempSync(join(tmpdir(), 't1k-local-'))
    const calls: Array<{ url: string; inm: string | null; companion: boolean }> = []
    let reply: () => Response = () => new Response('', { status: 404 })
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      calls.push({ url, inm: h.get('If-None-Match'), companion: h.has('X-JakeTunes-Companion') || !process.env.MOBILE_API_TOKEN })
      return reply()
    }) as unknown as typeof fetch
    const logs: string[] = []
    const host = { localDir: local, hubBase: () => 'http://homemini:3000', fetchImpl, log: (m: string) => { logs.push(m) } }
    const served = (body: string, etag: string) => () => new Response(body, { status: 200, headers: { etag, 'content-type': 'application/json' } })

    assert.equal(await pullTop1000ScoresOnce(host), false, '404 before homemini runs the route')
    assert.equal(await pullTop1000ScoresOnce(host), false)
    assert.equal(logs.filter((m) => m.includes('HTTP 404')).length, 1, 'a repeating problem is logged once')

    const newest = file({ builtAt: '2026-10-25T08:40:00Z', answered: 6000 })
    reply = served(newest, '"t1k-1"')
    assert.equal(await pullTop1000ScoresOnce(host), true)
    assert.equal(calls.at(-1)?.url, 'http://homemini:3000/api/top1000/scores')
    assert.ok(calls.at(-1)?.companion, 'the companion header rides along when a token is configured')
    assert.equal(readFileSync(join(local, TOP1000_SCORES_FILE), 'utf8'), newest, 'written verbatim into the local state dir')
    assert.equal(currentTop1000Scores()?.answered, 6000)

    reply = () => new Response(null, { status: 304 })
    assert.equal(await pullTop1000ScoresOnce(host), false)
    assert.equal(calls.at(-1)?.inm, '"t1k-1"', 'the repeat poll sends the ETag, so an unchanged copy is not downloaded')

    reply = served('{broken', '"t1k-2"')
    assert.equal(await pullTop1000ScoresOnce(host), false)
    reply = served(file({ builtAt: '2026-10-01T00:00:00Z', answered: 1 }), '"t1k-3"')
    assert.equal(await pullTop1000ScoresOnce(host), false, 'an older copy never replaces a newer one')
    reply = () => { throw new TypeError('fetch failed') }
    assert.equal(await pullTop1000ScoresOnce(host), false, 'homemini unreachable — next tick')
    assert.equal(currentTop1000Scores()?.answered, 6000, 'the last good copy stays in use')
    assert.ok(existsSync(join(local, TOP1000_SCORES_FILE)))

    const before = calls.length
    assert.equal(await pullTop1000ScoresOnce({ ...host, hubBase: undefined }), false)
    assert.equal(calls.length, before, 'no hub configured = local copy only')
  })
})
