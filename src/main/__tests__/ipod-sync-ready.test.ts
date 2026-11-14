/**
 * "Ready for an updated sync" (2026-11-07, Jake: "i should get a notification when my top 1000
 * changes....meaning its ready for an updated sync").
 *
 *   • the diff: in / out sets, the 1,000 cap, no manifest, fillers kept
 *   • the debounce: one notice per distinct difference, at most one per iPod per 6 hours,
 *     the Original (Top 1000) once a week with the net difference then (2026-11-08),
 *     "not synced yet" once, a replica never
 *   • the phone push: the ntfy call's shape with a fake sender, never the topic in a log
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SYNC_READY_ORIGINAL_QUIET_MS, SYNC_READY_QUIET_MS, createIpodSyncReady, quietMsFor, decideNotice, diffIpodTarget, diffKey, noticeText, readManifestIds,
  type IpodSyncReadyDeps,
} from '../ipod-sync-ready.ts'
import { pushNtfy, ntfyTitle, type NtfyFetch } from '../ntfy-push.ts'
import { buildDeviceMarker, type IpodDeviceMarker } from '../../common/ipod-identity.ts'

const stamp = '2026-11-07T00:00:00.000Z'
const original = buildDeviceMarker({ id: 'original-58ebb78e', name: 'Original', primary: true, now: stamp })!
const punk = buildDeviceMarker({ id: '0d8fc490-74d1-4232-9a35-1801a66f4fde', name: 'punkPod', color: 'red', purpose: 'punk', primary: false, now: stamp })!

const tmps: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sync-ready-')); tmps.push(d); return d }
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }) })

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)

describe('diffIpodTarget', () => {
  it('names the songs coming in and going out', () => {
    const d = diffIpodTarget({ target: [1, 2, 3, 7], onIpod: [1, 2, 3, 4, 5] })
    assert.deepEqual(d, { kind: 'differs', in: [7], out: [4, 5] })
  })
  it('the same set in another order is no difference', () => {
    assert.deepEqual(diffIpodTarget({ target: [3, 2, 1], onIpod: [1, 2, 3] }), { kind: 'same' })
  })
  it('caps the target at 1,000 in its own order; what is past the cap is out', () => {
    const ranked = range(1, 1200)
    const on = range(1, 1000)
    assert.deepEqual(diffIpodTarget({ target: ranked, onIpod: on }), { kind: 'same' })
    const d = diffIpodTarget({ target: ranked, onIpod: [...range(2, 999), 1100] })
    assert.equal(d.kind, 'differs')
    if (d.kind !== 'differs') return
    assert.deepEqual(d.in, [1])
    assert.deepEqual(d.out, [1100])
  })
  it('a repeat in the target counts once and does not use a seat', () => {
    const d = diffIpodTarget({ target: [1, 1, 2], onIpod: [1, 2], cap: 2 })
    assert.deepEqual(d, { kind: 'same' })
  })
  it('no manifest = never synced from this Mac', () => {
    assert.deepEqual(diffIpodTarget({ target: [1, 2, 3], onIpod: null }), { kind: 'never-synced', targetCount: 3 })
  })
  it('a filler the sync would keep is not out', () => {
    assert.deepEqual(diffIpodTarget({ target: [1, 2], onIpod: [1, 2, 9], keep: new Set([9]) }), { kind: 'same' })
  })
  it('the key is the in/out sets, not their order', () => {
    assert.equal(diffKey({ in: [3, 1], out: [9, 8] }), diffKey({ in: [1, 3], out: [8, 9] }))
    assert.notEqual(diffKey({ in: [1], out: [2] }), diffKey({ in: [2], out: [1] }))
  })
})

describe('decideNotice', () => {
  const d1 = { kind: 'differs' as const, in: [7], out: [4] }
  const d2 = { kind: 'differs' as const, in: [7, 8], out: [4, 5] }
  it('the same difference is told once', () => {
    const a = decideNotice(undefined, d1, 0)
    assert.equal(a.notify, true)
    assert.equal(decideNotice(a.next, d1, 10 * SYNC_READY_QUIET_MS).notify, false)
  })
  it('a new difference inside 6 hours waits; after 6 hours it is told', () => {
    const a = decideNotice(undefined, d1, 0)
    const b = decideNotice(a.next, d2, SYNC_READY_QUIET_MS - 1)
    assert.equal(b.notify, false)
    assert.equal(b.next.pending, true)
    const c = decideNotice(b.next, d2, SYNC_READY_QUIET_MS)
    assert.equal(c.notify, true)
    assert.equal(c.next.pending, false)
  })
  it('no difference says nothing', () => {
    assert.equal(decideNotice(undefined, { kind: 'same' }, 0).notify, false)
  })
  it('the Original waits a week; other iPods keep 6 hours', () => {
    assert.equal(quietMsFor(original), 7 * 24 * 3600 * 1000)
    assert.equal(SYNC_READY_ORIGINAL_QUIET_MS, 7 * 24 * 3600 * 1000)
    assert.equal(quietMsFor(punk), 6 * 3600 * 1000)
    const a = decideNotice(undefined, d1, 0, quietMsFor(original))
    assert.equal(a.notify, true)
    const b = decideNotice(a.next, d2, SYNC_READY_QUIET_MS, quietMsFor(original))
    assert.equal(b.notify, false, 'six hours is not a week')
    assert.equal(b.next.pending, true)
    assert.equal(decideNotice(b.next, d2, SYNC_READY_ORIGINAL_QUIET_MS - 1, quietMsFor(original)).notify, false)
    assert.equal(decideNotice(b.next, d2, SYNC_READY_ORIGINAL_QUIET_MS, quietMsFor(original)).notify, true)
  })
  it('back to no difference inside the week: nothing waits', () => {
    const a = decideNotice(undefined, d1, 0, quietMsFor(original))
    const b = decideNotice(a.next, d2, 3600 * 1000, quietMsFor(original))
    const c = decideNotice(b.next, { kind: 'same' }, 2 * 3600 * 1000, quietMsFor(original))
    assert.equal(c.notify, false)
    assert.equal(c.next.pending, false)
  })
  it('a list homemini grows every 7+ days is told once per that many days; under 7 keeps 6 hours', () => {
    assert.equal(quietMsFor(punk, 14), 14 * 24 * 3600 * 1000)
    assert.equal(quietMsFor(punk, 7), 7 * 24 * 3600 * 1000)
    assert.equal(quietMsFor(punk, 6), SYNC_READY_QUIET_MS)
    assert.equal(quietMsFor(punk, 1), SYNC_READY_QUIET_MS)
    assert.equal(quietMsFor(punk, undefined), SYNC_READY_QUIET_MS)
    assert.equal(quietMsFor(original, 14), SYNC_READY_ORIGINAL_QUIET_MS, 'the Original stays weekly')
  })
  it('"not synced yet" once, and never for an empty list', () => {
    const a = decideNotice(undefined, { kind: 'never-synced', targetCount: 3 }, 0)
    assert.equal(a.notify, true)
    assert.equal(decideNotice(a.next, { kind: 'never-synced', targetCount: 3 }, 1).notify, false)
    assert.equal(decideNotice(undefined, { kind: 'never-synced', targetCount: 0 }, 0).notify, false)
  })
})

describe('noticeText', () => {
  it('the Original', () => {
    assert.equal(noticeText(original, { kind: 'differs', in: range(1, 6), out: range(10, 6) })?.body,
      'Top 1000 this week: 6 in, 6 out. The Original is ready for an updated sync.')
    assert.equal(noticeText(original, { kind: 'never-synced', targetCount: 1000 })?.body,
      'The Original hasn’t been synced from this Mac yet. Its Top 1000 is ready to go on.')
  })
  it('another iPod', () => {
    assert.equal(noticeText(punk, { kind: 'differs', in: [1, 2, 3], out: [] })?.body, 'punkPod: 3 new songs ready to sync.')
    assert.equal(noticeText(punk, { kind: 'differs', in: [1], out: [] })?.body, 'punkPod: 1 new song ready to sync.')
    assert.equal(noticeText(punk, { kind: 'differs', in: [], out: [4, 5] })?.body, 'punkPod: 2 songs to come off. Ready for an updated sync.')
    assert.equal(noticeText(punk, { kind: 'differs', in: [1, 2], out: [4] })?.body, 'punkPod: 2 new songs in, 1 out. Ready for an updated sync.')
    assert.equal(noticeText(punk, { kind: 'never-synced', targetCount: 312 })?.body,
      'punkPod hasn’t been synced from this Mac yet. 312 songs on its list are ready to go on.')
    assert.equal(noticeText(punk, { kind: 'same' }), null)
  })
})

/** A world for the runner: a state dir, manifests, homemini's answers, recorded notices. */
function world(over: Partial<IpodSyncReadyDeps> & { manifests?: Record<string, number[] | null>; top?: number[] | null; lists?: Record<string, number[] | null> } = {}) {
  const stateDir = tmp()
  let nowMs = 1_000_000
  const notices: Array<{ title: string; body: string; deviceId: string }> = []
  const pushes: Array<{ title: string; body: string }> = []
  const asked = { top1000: 0, list: 0 }
  const w = {
    stateDir,
    manifests: over.manifests ?? { [original.id]: range(1, 1000), [punk.id]: [1, 2, 3] },
    top: over.top === undefined ? range(1, 1000) : over.top,
    lists: over.lists ?? { [punk.id]: [3, 2, 1] },
    notices,
    pushes,
    asked,
    advance(ms: number) { nowMs += ms },
  }
  const runner = createIpodSyncReady({
    stateDir,
    isHub: async () => true,
    devices: async () => [original, punk],
    onIpod: async (d: IpodDeviceMarker) => w.manifests[d.id] ?? null,
    top1000: async () => { asked.top1000++; return w.top },
    list: async (d: IpodDeviceMarker) => { asked.list++; return w.lists[d.id] ?? null },
    notify: (n) => { notices.push(n) },
    push: async (n) => { pushes.push(n) },
    now: () => nowMs,
    log: () => {},
    ...over,
  })
  return { w, runner }
}

describe('the runner', () => {
  it('nothing when every iPod holds its target', async () => {
    const { w, runner } = world()
    await runner.check({ original: true, lists: true })
    assert.equal(w.notices.length, 0)
    assert.equal(w.pushes.length, 0)
  })

  it('the Top 1000 moved: one notice + one push; the same difference again: nothing', async () => {
    const { w, runner } = world()
    w.top = [...range(7, 994), ...range(2001, 6)]   // 6 in (2001..2006), 6 out (1..6)
    await runner.check({ original: true })
    assert.equal(w.notices.length, 1)
    assert.equal(w.notices[0].body, 'Top 1000 this week: 6 in, 6 out. The Original is ready for an updated sync.')
    assert.equal(w.notices[0].deviceId, original.id)
    assert.deepEqual(w.pushes, [{ title: 'JakeTunes', body: w.notices[0].body }])
    w.advance(24 * 3600 * 1000)
    await runner.check({ original: true })
    assert.equal(w.notices.length, 1, 'the same difference is never told twice')
  })

  it('the Top 1000 keeps shifting: quiet for the week, then the net totals once', async () => {
    const { w, runner } = world()
    w.top = [...range(2, 999), 2001]
    await runner.check({ original: true })
    assert.equal(w.notices.length, 1)
    w.advance(3600 * 1000)
    w.top = [...range(3, 998), 2001, 2002]
    await runner.check({ original: true })
    assert.equal(w.notices.length, 1, 'inside the week')
    w.advance(SYNC_READY_QUIET_MS)
    w.top = [...range(4, 997), 2001, 2002, 2003]
    await runner.check({ original: true })
    assert.equal(w.notices.length, 1, 'six hours on: still inside the week')
    w.top = [...range(3, 998), 2001, 2002]
    // The standings don't move again, but the waiting notice is due: the plain tick checks the Original.
    w.advance(SYNC_READY_ORIGINAL_QUIET_MS - SYNC_READY_QUIET_MS - 3600 * 1000 - 1)
    runner.pulled(false)
    await runner.check({})
    assert.equal(w.notices.length, 1, 'a millisecond short of the week')
    w.advance(1)
    const before = w.asked.top1000
    runner.pulled(false)
    await runner.check({})   // waits for the queued pass
    assert.equal(w.asked.top1000, before + 1)
    assert.equal(w.notices.length, 2)
    assert.equal(w.notices[1].body, 'Top 1000 this week: 2 in, 2 out. The Original is ready for an updated sync.')
  })

  it('the Top 1000 changes and changes back inside the week: nothing is sent', async () => {
    const { w, runner } = world()
    w.top = [...range(2, 999), 2001]
    await runner.check({ original: true })
    assert.equal(w.notices.length, 1)
    w.advance(24 * 3600 * 1000)
    w.top = [...range(3, 998), 2001, 2002]
    await runner.check({ original: true })
    w.advance(24 * 3600 * 1000)
    w.top = range(1, 1000)   // the iPod holds its target again
    await runner.check({ original: true })
    w.advance(SYNC_READY_ORIGINAL_QUIET_MS)
    runner.pulled(false)
    await runner.check({})
    assert.equal(w.notices.length, 1)
    assert.equal(w.pushes.length, 1)
  })

  it('another iPod keeps 6 hours', async () => {
    const { w, runner } = world()
    w.lists[punk.id] = [4, 3, 2, 1]
    await runner.check({ lists: true })
    w.advance(3600 * 1000)
    w.lists[punk.id] = [5, 4, 3, 2, 1]
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 1, 'inside 6 hours')
    w.advance(SYNC_READY_QUIET_MS)
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 2)
    assert.equal(w.notices[1].body, 'punkPod: 2 new songs ready to sync.')
  })

  it('punkPod on a 14-day cadence: one notice, then quiet for 14 days, then the net totals', async () => {
    const DAY = 24 * 3600 * 1000
    const answers: Record<string, { ids: number[]; everyDays?: number }> = { [punk.id]: { ids: [4, 3, 2, 1], everyDays: 14 } }
    const { w, runner } = world({ list: async (d: IpodDeviceMarker) => answers[d.id] ?? null })
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 1)
    w.advance(SYNC_READY_QUIET_MS)
    answers[punk.id] = { ids: [5, 4, 3, 2, 1], everyDays: 14 }
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 1, '6 hours is not enough on a 14-day cadence')
    w.advance(14 * DAY - SYNC_READY_QUIET_MS - 1)
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 1, 'still inside the 14 days')
    w.advance(1)
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 2)
    assert.equal(w.notices[1].body, 'punkPod: 2 new songs ready to sync.')
    const saved = JSON.parse(readFileSync(join(w.stateDir, 'ipod-sync-ready.json'), 'utf-8'))
    assert.equal(saved[punk.id].everyDays, 14)
  })

  it('a list read through the pool refresh carries its cadence; a bare id list keeps the last one seen', async () => {
    const DAY = 24 * 3600 * 1000
    const { w, runner } = world()
    runner.listRead(punk, [4, 3, 2, 1], 14)
    await runner.check({})
    assert.equal(w.notices.length, 1)
    w.advance(DAY)
    w.lists[punk.id] = [5, 4, 3, 2, 1]   // the world's list() answers a bare id list
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 1, 'the 14 days homemini last named still hold')
    // homemini drops the cadence: back to 6 hours
    runner.listRead(punk, [6, 5, 4, 3, 2, 1], undefined)
    await runner.check({})
    assert.equal(w.notices.length, 2)
  })

  it('a restart does not reset the Original\'s week', async () => {
    const first = world()
    first.w.top = [...range(2, 999), 2001]
    await first.runner.check({ original: true })
    assert.equal(first.w.notices.length, 1)
    let nowMs = 1_000_000 + 2 * 24 * 3600 * 1000
    const notices: unknown[] = []
    const again = createIpodSyncReady({
      stateDir: first.w.stateDir, isHub: async () => true, devices: async () => [original],
      onIpod: async () => range(1, 1000), top1000: async () => [...range(3, 998), 2001, 2002], list: async () => null,
      notify: (n) => { notices.push(n) }, push: async () => {}, log: () => {}, now: () => nowMs,
    })
    await again.check({ original: true })
    assert.equal(notices.length, 0, 'two days after the last notice')
    nowMs = 1_000_000 + SYNC_READY_ORIGINAL_QUIET_MS
    again.pulled(false)
    await again.check({})
    assert.equal(notices.length, 1)
  })

  it('a plain tick with nothing waiting does not ask for the Top 1000', async () => {
    const { w, runner } = world()
    runner.pulled(false)
    await runner.check({})
    assert.equal(w.asked.top1000, 0)
    assert.equal(w.asked.list, 1, 'the lists are checked on every tick')
  })

  it('a replica never checks and never tells', async () => {
    const { w, runner } = world({ isHub: async () => false })
    w.top = range(500, 1000)
    w.lists[punk.id] = [9, 8, 7]
    await runner.check({ original: true, lists: true })
    runner.pulled(true)
    runner.listRead(punk, [9, 8, 7])
    await runner.check({})
    assert.equal(w.notices.length, 0)
    assert.equal(w.pushes.length, 0)
    assert.equal(w.asked.top1000 + w.asked.list, 0)
  })

  it('unsure what this Mac is = not the hub', async () => {
    const { w, runner } = world({ isHub: async () => { throw new Error('settings unreadable') } })
    w.top = range(500, 1000)
    await runner.check({ original: true })
    assert.equal(w.notices.length, 0)
  })

  it('never synced here: one "not synced yet", once', async () => {
    const { w, runner } = world({ manifests: { [original.id]: range(1, 1000), [punk.id]: null } })
    await runner.check({ lists: true })
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 1)
    assert.equal(w.notices[0].body, 'punkPod hasn’t been synced from this Mac yet. 3 songs on its list are ready to go on.')
  })

  it('homemini away: nothing, and the state is not touched', async () => {
    const { w, runner } = world({ top: null, lists: {} })
    await runner.check({ original: true, lists: true })
    assert.equal(w.notices.length, 0)
    assert.throws(() => readFileSync(join(w.stateDir, 'ipod-sync-ready.json')))
  })

  it('a list read from homemini is checked with those ids, without asking again', async () => {
    const { w, runner } = world()
    runner.listRead(punk, [12, 11, 3, 2, 1])
    await runner.check({})
    assert.equal(w.asked.list, 0)
    assert.equal(w.notices.length, 1)
    assert.equal(w.notices[0].body, 'punkPod: 2 new songs ready to sync.')
  })

  it('the state survives a restart: the same difference is not told again', async () => {
    const first = world()
    first.w.lists[punk.id] = [4, 3, 2, 1]
    await first.runner.check({ lists: true })
    assert.equal(first.w.notices.length, 1)
    const again = createIpodSyncReady({
      stateDir: first.w.stateDir, isHub: async () => true, devices: async () => [punk],
      onIpod: async () => [1, 2, 3], top1000: async () => null, list: async () => [4, 3, 2, 1],
      notify: (n) => { first.w.notices.push(n) }, push: async () => {}, log: () => {},
    })
    await again.check({ lists: true })
    assert.equal(first.w.notices.length, 1)
  })

  it('the Original: songs that can’t go on are skipped and the fillers on it stay', async () => {
    // Song 5 can't go on: the sync takes 1..4, 6..1001 and fills nothing (1,000 boardable in range).
    const { w, runner } = world({
      boarding: async () => ({ canBoard: (id) => id !== 5, fill: () => [] }),
    })
    w.top = range(1, 1100)
    w.manifests[original.id] = [...range(1, 4), ...range(6, 996)]
    await runner.check({ original: true })
    assert.equal(w.notices.length, 0)
    // Only 999 can go on: the 1,000th seat is a filler (9000) the sync keeps.
    const two = world({ boarding: async () => ({ canBoard: (id) => id !== 5, fill: () => [9000] }) })
    two.w.top = range(1, 1000)
    two.w.manifests[original.id] = [...range(1, 4), ...range(6, 995), 9000]
    await two.runner.check({ original: true })
    assert.equal(two.w.notices.length, 0)
  })

  it('a list past 1,000 is compared whole: every song the iPod lacks is "in" (2026-11-13)', async () => {
    const { w, runner } = world()
    w.lists[punk.id] = range(1, 1200).reverse()   // newest first: 1200..1
    w.manifests[punk.id] = range(1, 1200)
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 0)             // the iPod has all 1,200: nothing to say
    w.manifests[punk.id] = range(1, 1000)         // the iPod as it was before the cap was raised
    await runner.check({ lists: true })
    assert.equal(w.notices.length, 1)
    assert.equal(diffIpodTarget({ target: w.lists[punk.id], onIpod: range(1, 1000), cap: 5000 }).kind, 'differs')
  })

  it('a list is never compared past 5,000 songs', () => {
    const d = diffIpodTarget({ target: range(1, 5200), onIpod: range(1, 5000), cap: 5000 })
    assert.equal(d.kind, 'same')
  })
})

describe('readManifestIds', () => {
  it('ids from tracks[].id; no file = null; a torn file throws', async () => {
    const d = tmp()
    mkdirSync(d, { recursive: true })
    assert.equal(await readManifestIds(join(d, 'none.json')), null)
    writeFileSync(join(d, 'm.json'), JSON.stringify({ tracks: [{ id: 3 }, { id: '4' }, { id: null }] }))
    assert.deepEqual(await readManifestIds(join(d, 'm.json')), [3, 4])
    writeFileSync(join(d, 'torn.json'), '{"tracks": [')
    await assert.rejects(readManifestIds(join(d, 'torn.json')))
  })
})

describe('pushNtfy', () => {
  const SECRET = 'jt-topic-abc123'
  it('POSTs the body to the topic with a Title, at default priority', async () => {
    const d = tmp()
    writeFileSync(join(d, 'ntfy-topic'), `${SECRET}\n`)
    const calls: Array<{ url: string; init: Parameters<NtfyFetch>[1] }> = []
    const fake: NtfyFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 } }
    const r = await pushNtfy({ title: 'JakeTunes', body: 'punkPod: 3 new songs ready to sync.' }, { topicFile: join(d, 'ntfy-topic'), fetchImpl: fake, log: () => {} })
    assert.equal(r, 'sent')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `https://ntfy.sh/${SECRET}`)
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(calls[0].init.headers, { Title: 'JakeTunes' })
    assert.equal(calls[0].init.body, 'punkPod: 3 new songs ready to sync.')
    assert.ok(!('Priority' in calls[0].init.headers))
  })
  it('a full URL in the file is used as it is', async () => {
    const d = tmp()
    writeFileSync(join(d, 'ntfy-topic'), 'https://ntfy.example/abc')
    let url = ''
    await pushNtfy({ title: 't', body: 'b' }, { topicFile: join(d, 'ntfy-topic'), fetchImpl: async (u) => { url = u; return { ok: true, status: 200 } }, log: () => {} })
    assert.equal(url, 'https://ntfy.example/abc')
  })
  it('no topic file: no push', async () => {
    let called = false
    const r = await pushNtfy({ title: 't', body: 'b' }, { topicFile: join(tmp(), 'missing'), fetchImpl: async () => { called = true; return { ok: true, status: 200 } } })
    assert.equal(r, 'no-topic')
    assert.equal(called, false)
  })
  it('a failure is logged without the topic', async () => {
    const d = tmp()
    writeFileSync(join(d, 'ntfy-topic'), SECRET)
    const logs: string[] = []
    const r1 = await pushNtfy({ title: 't', body: 'b' }, { topicFile: join(d, 'ntfy-topic'), fetchImpl: async () => { throw new Error(`fetch failed for https://ntfy.sh/${SECRET}`) }, log: (m) => logs.push(m) })
    const r2 = await pushNtfy({ title: 't', body: 'b' }, { topicFile: join(d, 'ntfy-topic'), fetchImpl: async () => ({ ok: false, status: 500 }), log: (m) => logs.push(m) })
    assert.equal(r1, 'failed')
    assert.equal(r2, 'failed')
    assert.equal(logs.length, 2)
    for (const l of logs) assert.ok(!l.includes(SECRET), l)
  })
  it('the Title header is ASCII only', () => {
    assert.equal(ntfyTitle('JakeTunes — iPod'), 'JakeTunes  iPod')
    assert.equal(ntfyTitle('’’'), 'JakeTunes')
  })
})

describe('wiring (source locks)', () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf-8')
  it('the standings tick and every list read reach the check; a click opens the Device page', () => {
    const idx = read('main/index.ts')
    assert.match(idx, /onTop1000Pulled: \(adopted\) => ipodSyncReady\.pulled\(adopted\)/)
    assert.match(idx, /onListRead: \(d, ids, everyDays\) => ipodSyncReady\.listRead\(d, ids, everyDays\)/)
    assert.match(idx, /isReplica: isHomeminiPlaybackClientCached/)
    assert.match(read('main/taste-state.ts'), /startTop1000ScoresPull\(\{ \.\.\.host, onPulled: host\.onTop1000Pulled \}\)/)
    assert.match(read('main/top1000-scores.ts'), /host\.onPulled\?\.\(adopted\)/)
    assert.match(read('main/ipc/ipod-lists-ipc.ts'), /host\.onListRead\?\.\(device, r\.listIds, r\.everyDays\)/)
    const start = read('main/ipod-sync-ready-start.ts')
    assert.match(start, /host\.send\('menu-action', action\)/)
    assert.match(start, /notify: \(\{ title, body \}\) => showNotice\(host, title, body, 'view-device'\)/)
    // the brain's picks (2026-11-09): the same ticks, and the click opens that iPod's list
    assert.match(start, /notify: \(\{ title, body, deviceId \}\) => showNotice\(host, title, body, openIpodListAction\(deviceId\)\)/)
    assert.match(start, /pulled\(adopted\) \{ runner\.pulled\(adopted\); void picks\.check\(\) \}/)
    assert.match(start, /if \(!device\.primary\) void picks\.check\(device\.id\)/)
    assert.match(read('renderer/App.tsx'), /const pickedIpod = parseOpenIpodListAction\(action\)/)
    assert.match(read('renderer/views/SmartPlaylistView.tsx'), /<IpodProposalsPanel deviceId=\{ipodListDevice\}/)
    assert.match(read('renderer/App.tsx'), /case 'view-device': dispatch\(\{ type: 'SET_VIEW', view: 'device' \}\)/)
  })
})
