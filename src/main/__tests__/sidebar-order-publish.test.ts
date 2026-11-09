/**
 * The sidebar's section order reaches homemini (2026-11-09), so the phone's
 * Playlists tab draws its sections the way Jake dragged them here.
 * ⚠️ CONTRACT: JakeTunesMobile backend/src/routes/sidebarOrder.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSidebarOrderPublisher, RETRY_FIRST_MS, RETRY_MAX_MS } from '../sidebar-order-publish.ts'

type Call = { url: string; init: RequestInit }

function harness(opts: { replica?: boolean; answers?: Array<number | 'throw'> } = {}) {
  const calls: Call[] = []
  const answers = [...(opts.answers ?? [])]
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  const warns: string[] = []
  const pub = createSidebarOrderPublisher({
    baseUrl: 'http://homemini:3000/',
    isReplica: async () => opts.replica ?? false,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      const a = answers.length ? answers.shift()! : 200
      if (a === 'throw') throw new TypeError('fetch failed')
      return { ok: a >= 200 && a < 300, status: a }
    },
    withAuth: (init) => ({ ...init, headers: { ...(init.headers as Record<string, string>), 'X-JakeTunes-Companion': 't' } }),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t },
    clearTimer: (t) => { (t as { live: boolean }).live = false },
    warn: (m) => warns.push(m),
  })
  const fire = async () => {
    const t = timers.filter((x) => x.live).pop()
    assert.ok(t, 'a retry is waiting')
    t.live = false
    t.fn()
    await new Promise((r) => setImmediate(r))
  }
  return { pub, calls, timers, warns, fire }
}

const body = (c: Call) => JSON.parse(String(c.init.body)) as { order: string[] }

describe('sidebar order publish', () => {
  it('PUTs the cleaned order to homemini with the companion header', async () => {
    const h = harness()
    assert.equal(await h.pub.publish(['playlists', 'synced-sets', 'ipods', 'ipods', 7, 'year:2026']), 'sent')
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url, 'http://homemini:3000/api/sidebar-order')
    assert.equal(h.calls[0].init.method, 'PUT')
    assert.equal((h.calls[0].init.headers as Record<string, string>)['X-JakeTunes-Companion'], 't')
    // parseSavedOrder: the retired key, the repeat and the non-string are gone.
    assert.deepEqual(body(h.calls[0]), { order: ['playlists', 'ipods', 'year:2026'] })
  })

  it('a reset sends [] (the default order)', async () => {
    const h = harness()
    await h.pub.publish([])
    assert.deepEqual(body(h.calls[0]), { order: [] })
    await h.pub.publish(undefined)
    assert.deepEqual(body(h.calls[1]), { order: [] })
  })

  it('a replica (homemini or workmini) never sends', async () => {
    const h = harness({ replica: true })
    assert.equal(await h.pub.publish(['playlists']), 'replica')
    assert.equal(h.calls.length, 0)
  })

  it('a failed send retries the newest order, backing off, and warns once', async () => {
    const h = harness({ answers: ['throw', 503, 200] })
    assert.equal(await h.pub.publish(['ipods']), 'failed')
    assert.equal(h.timers.at(-1)!.ms, RETRY_FIRST_MS)
    await h.fire()
    assert.equal(h.calls.length, 2)
    assert.equal(h.timers.at(-1)!.ms, RETRY_FIRST_MS * 2)
    await h.fire()
    assert.equal(h.calls.length, 3)
    assert.deepEqual(body(h.calls[2]), { order: ['ipods'] })
    assert.equal(h.timers.filter((t) => t.live).length, 0)
    assert.equal(h.warns.length, 1)
  })

  it('a new order replaces a waiting retry', async () => {
    const h = harness({ answers: [500, 200] })
    await h.pub.publish(['ipods'])
    assert.equal(h.timers.filter((t) => t.live).length, 1)
    assert.equal(await h.pub.publish(['playlists', 'ipods']), 'sent')
    assert.equal(h.timers.filter((t) => t.live).length, 0)
    assert.deepEqual(body(h.calls[1]), { order: ['playlists', 'ipods'] })
  })

  it('the wait never grows past the cap', async () => {
    const h = harness({ answers: Array(12).fill(500) })
    await h.pub.publish(['ipods'])
    for (let i = 0; i < 10; i++) await h.fire()
    assert.equal(h.timers.at(-1)!.ms, RETRY_MAX_MS)
  })

  it('is wired: a ui-state save carrying the order publishes it, and launch sends the saved one', () => {
    const ipcSrc = readFileSync(join(import.meta.dirname, '../ipc/ui-state-ipc.ts'), 'utf8')
    assert.match(ipcSrc, /SIDEBAR_ORDER_KEY in uiState/)
    assert.match(ipcSrc, /hooks\.onSidebarOrder\?\.\(uiState\[SIDEBAR_ORDER_KEY\]\)/)
    const index = readFileSync(join(import.meta.dirname, '../index.ts'), 'utf8')
    assert.match(index, /registerUiStateIpc\(ipc, \{ onSidebarOrder:/)
    assert.match(index, /readSavedSidebarOrder\(\)\.then/)
    assert.match(index, /isReplica: \(\) => isHomeminiPlaybackClientCached\(\)/)
  })
})
