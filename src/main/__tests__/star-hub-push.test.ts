/**
 * A replica's stars reach homemini's shared record by MERGE (2026-10-20):
 * POST /api/stars/merge with the whole v2 state; only replicas push; a
 * failure is owed and retried on the next tick.
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/routes/__tests__/userEditsAndStarsMerge.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createStarHubPush, STARS_MERGE_PATH } from '../star-hub-push.ts'

const state = { v: 2 as const, trackIds: ['11952'], removed: { '7757': 1_790_000_000_000 }, added: { '11952': 1_792_000_000_000 } }

describe('star push', () => {
  test('a replica POSTs its whole state to /api/stars/merge', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = []
    const push = createStarHubPush({
      baseUrl: 'http://homemini:3000/', isReplica: async () => true, state: async () => state,
      fetchImpl: async (url, init) => { calls.push({ url, init: init ?? {} }); return { ok: true, status: 200 } },
    })
    assert.equal(await push.pushNow(), true)
    assert.equal(calls[0].url, `http://homemini:3000${STARS_MERGE_PATH}`)
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), state)
    await push.tick()
    assert.equal(calls.length, 1, 'nothing owed after a push landed')
  })

  test('the hub (or homemini\'s own app) never pushes', async () => {
    let called = false
    const push = createStarHubPush({
      baseUrl: 'http://homemini:3000', isReplica: async () => false, state: async () => state,
      fetchImpl: async () => { called = true; return { ok: true, status: 200 } },
    })
    assert.equal(await push.pushNow(), false)
    await push.tick()
    assert.equal(called, false)
  })

  test('homemini down or refusing → owed, and the next tick retries', async () => {
    let n = 0
    const push = createStarHubPush({
      baseUrl: 'http://homemini:3000', isReplica: async () => true, state: async () => state, warn: () => {},
      fetchImpl: async () => { n++; if (n === 1) throw new Error('ECONNREFUSED'); if (n === 2) return { ok: false, status: 503 }; return { ok: true, status: 200 } },
    })
    assert.equal(await push.pushNow(), false)
    await push.tick()
    await push.tick()
    assert.equal(n, 3)
    await push.tick()
    assert.equal(n, 3, 'landed — nothing owed')
  })
})
