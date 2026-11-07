/**
 * One button per iPod (Jake, 2026-11-07: "activity sync is kind of obsolete.
 * can we just make the sync process for specific ipods easy and pretty
 * straight forward").
 *
 * The plan that one Sync puts on the plugged-in iPod:
 *   • the Original → its Top 1000 (exactly 1,000, most-loved fill when the list is short)
 *   • any other registered iPod → its list from homemini, at most 1,000, never filler
 *   • an unknown iPod, or none → refused
 * No size picker, no brief, no Music Man — for either.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planOneSync, ONE_SYNC_SIZE, type OneSyncDeps, type OneSyncIpod, type OneSyncTrack } from '../ipod-one-sync.ts'
import { readyLine, leftOffLine, syncButtonLabel, lastSyncedLine, syncingStep } from '../../common/ipod-one-sync-plan.ts'
import { syncFailureCopy } from '../../common/sync-failure-copy.ts'

const ORIGINAL: OneSyncIpod = { status: 'known', id: 'orig-0001', name: 'Original', color: 'silver', primary: true }
const PUNK: OneSyncIpod = { status: 'known', id: '0d8fc490-74d1-4232-9a35-1801a66f4fde', name: 'punkPod', color: 'pink', primary: false }

function song(id: number, extra: Partial<OneSyncTrack> = {}): OneSyncTrack {
  return { id, title: `Song ${id}`, artist: `Band ${id % 97}`, path: `:iPod_Control:Music:F00:${id}.m4a`, codec: 'alac', duration: 200_000, genre: 'Rock', ...extra }
}
const library = (n: number, from = 1): OneSyncTrack[] => Array.from({ length: n }, (_, i) => song(from + i))

interface Calls { top1000: number; list: number }
function deps(ipod: OneSyncIpod, over: Partial<OneSyncDeps> = {}): { d: OneSyncDeps; calls: Calls } {
  const calls: Calls = { top1000: 0, list: 0 }
  const d: OneSyncDeps = {
    ipod: async () => ipod,
    top1000: async () => { calls.top1000++; return null },
    list: async () => { calls.list++; return null },
    ineligible: async () => new Set<number>(),
    ...over,
  }
  if (over.top1000) { const f = over.top1000; d.top1000 = async () => { calls.top1000++; return f() } }
  if (over.list) { const f = over.list; d.list = async () => { calls.list++; return f() } }
  return { d, calls }
}

describe('the Original: its Top 1000', () => {
  it('syncs the ranked list, best first, exactly 1,000, and never asks for a list', async () => {
    const lib = library(3000)
    const ranked = Array.from({ length: 1000 }, (_, i) => 2000 - i)   // rank 1 = id 2000
    const { d, calls } = deps(ORIGINAL, { top1000: async () => ranked })
    const plan = await planOneSync(d, lib)
    assert.ok(plan.ok)
    assert.equal(plan.kind, 'original')
    assert.equal(plan.setName, 'Top 1000')
    assert.equal(plan.trackIds.length, ONE_SYNC_SIZE)
    assert.deepEqual(plan.trackIds.slice(0, 3), [2000, 1999, 1998])
    assert.deepEqual(plan.leftOff, [])
    assert.equal(plan.note, null)
    assert.equal(calls.top1000, 1)
    assert.equal(calls.list, 0, 'the Original never reads a list')
  })

  it('a song that can’t go on is skipped, and the most-loved songs in the library fill to 1,000', async () => {
    const lib = library(1500)
    lib[4] = song(5, { audioMissing: true })                 // ranked, can't board
    lib[9] = song(10, { title: 'Intro (Skit)' })              // ranked, a skit
    lib[1399] = song(1400, { rating: 100, playCount: 50 })    // not ranked, most loved
    const ranked = Array.from({ length: 1000 }, (_, i) => i + 1)
    const concert = new Set([20])
    const { d } = deps(ORIGINAL, { top1000: async () => ranked, ineligible: async () => concert })
    const plan = await planOneSync(d, lib)
    assert.ok(plan.ok)
    assert.equal(plan.trackIds.length, 1000)
    assert.ok(!plan.trackIds.includes(5) && !plan.trackIds.includes(10) && !plan.trackIds.includes(20))
    assert.equal(plan.trackIds[997], 1400, 'the first fill seat goes to the most-loved song')
    assert.equal(new Set(plan.trackIds).size, 1000)
    assert.match(plan.note || '', /997 from your Top 1000 can go on; your most-loved songs fill the other 3\./)
  })

  it('homemini away: refused in plain words — no Music Man, no guess', async () => {
    const { d } = deps(ORIGINAL)
    const plan = await planOneSync(d, library(2000))
    assert.equal(plan.ok, false)
    assert.equal(plan.kind, 'original')
    assert.match(plan.ok ? '' : plan.error, /homemini didn’t answer, so Original’s Top 1000 can’t be read right now\. Nothing on the iPod was changed\./)
    assert.equal(syncFailureCopy(plan.ok ? '' : plan.error).stage, 'build')
  })
})

describe('any other iPod: its list, never filler', () => {
  it('syncs exactly its list from homemini, in list order, and never asks for the Top 1000', async () => {
    const lib = library(5000)
    const ids = [4200, 17, 999, 3]
    const { d, calls } = deps(PUNK, { list: async () => ({ ids, note: null }) })
    const plan = await planOneSync(d, lib)
    assert.ok(plan.ok)
    assert.equal(plan.kind, 'list')
    assert.equal(plan.ipodName, 'punkPod')
    assert.equal(plan.setName, 'punkPod')
    assert.deepEqual(plan.trackIds, ids)
    assert.equal(calls.list, 1)
    assert.equal(calls.top1000, 0, 'a list-only iPod never reads the Top 1000')
  })

  it('what can’t go on is left off and named; nothing from the library takes its seat', async () => {
    const lib = library(50)
    lib[1] = song(2, { audioMissing: true, title: 'Gone', artist: 'Ghost Band' })
    const ids = [1, 2, 3, 77777, 4, 5]
    const { d } = deps(PUNK, { list: async () => ({ ids, note: null }), ineligible: async () => new Set([4]) })
    const plan = await planOneSync(d, lib)
    assert.ok(plan.ok)
    assert.deepEqual(plan.trackIds, [1, 3, 5])
    assert.deepEqual(plan.leftOff.map((l) => [l.id, l.why]), [
      [77777, 'it isn’t in this library'],
      [4, 'it belongs to a full concert, which stays off iPods'],
      [2, 'its audio file is missing everywhere'],
    ])
    assert.equal(plan.leftOff[2].title, 'Gone')
    assert.equal(leftOffLine(plan), '3 songs can’t go on')
  })

  it('capped at 1,000', async () => {
    const lib = library(1500)
    const { d } = deps(PUNK, { list: async () => ({ ids: lib.map((t) => t.id), note: null }) })
    const plan = await planOneSync(d, lib)
    assert.ok(plan.ok)
    assert.equal(plan.trackIds.length, 1000)
    assert.deepEqual(plan.trackIds.slice(0, 2), [1, 2])
  })

  it('homemini’s note rides along (the last good list in use)', async () => {
    const note = 'homemini didn’t answer — using the list from Nov 7, 1:15 PM.'
    const { d } = deps(PUNK, { list: async () => ({ ids: [1, 2], note }) })
    const plan = await planOneSync(d, library(5))
    assert.ok(plan.ok)
    assert.equal(plan.note, note)
  })

  it('an empty list, or none of it able to go on, is refused before anything is written', async () => {
    const empty = await planOneSync(deps(PUNK, { list: async () => ({ ids: [], note: null }) }).d, library(5))
    assert.equal(empty.ok, false)
    assert.match(empty.ok ? '' : empty.error, /punkPod’s list is empty/)
    assert.equal(syncFailureCopy(empty.ok ? '' : empty.error).stage, 'build')
    const none = await planOneSync(deps(PUNK, { list: async () => ({ ids: [900, 901], note: null }) }).d, library(5))
    assert.equal(none.ok, false)
    assert.match(none.ok ? '' : none.error, /None of the 2 songs on punkPod’s list can go on it/)
    assert.equal(syncFailureCopy(none.ok ? '' : none.error).stage, 'build')
  })
})

describe('no iPod, or one JakeTunes doesn’t know: refused', () => {
  it('unknown → refused, and neither the Top 1000 nor a list is read', async () => {
    const { d, calls } = deps({ status: 'unknown' }, { top1000: async () => [1, 2], list: async () => ({ ids: [1], note: null }) })
    const plan = await planOneSync(d, library(10))
    assert.equal(plan.ok, false)
    assert.equal(plan.kind, 'unknown')
    assert.deepEqual(calls, { top1000: 0, list: 0 })
  })
  it('none → refused', async () => {
    const plan = await planOneSync(deps({ status: 'none' }).d, library(10))
    assert.equal(plan.ok, false)
    assert.equal(plan.kind, 'none')
  })
  it('an identity read that throws counts as no iPod, never as the Original', async () => {
    const plan = await planOneSync(deps(ORIGINAL, { ipod: async () => { throw new Error('card gone') } }).d, library(10))
    assert.equal(plan.ok, false)
    assert.equal(plan.kind, 'none')
  })
})

describe('the words on the Device page', () => {
  it('names are never shortened', async () => {
    const plan = await planOneSync(deps(PUNK, { list: async () => ({ ids: Array.from({ length: 847 }, (_, i) => i + 1), note: null }) }).d, library(900))
    assert.ok(plan.ok)
    assert.equal(readyLine(plan), 'punkPod · 847 songs ready')
    assert.equal(syncButtonLabel('punkPod'), 'Sync punkPod')
    assert.equal(syncButtonLabel('A Very Long iPod Name That Keeps Going'), 'Sync A Very Long iPod Name That Keeps Going')
    assert.equal(leftOffLine(plan), null)
  })
  it('last synced reads like a date, and the progress step carries the count the strip reads', () => {
    assert.match(lastSyncedLine('2026-11-07T18:15:00Z'), /^Last synced Nov 7, \d{1,2}:15 [AP]M$/)
    assert.equal(lastSyncedLine(null), 'Not synced yet')
    assert.equal(lastSyncedLine('junk'), 'Not synced yet')
    assert.match(syncingStep('Top 1000', 1000), /1,000 tracks/)
  })
})

describe('wiring (source locks)', () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf-8')
  const device = read('renderer/views/DeviceView.tsx')
  const util = read('renderer/utils/workoutIpodSync.ts')
  const ipc = read('main/workout-sync-ipc.ts')
  const one = read('main/ipod-one-sync.ts')

  it('the Device page has one Sync button, through the plan and the activity engine — no size, no sheet, no review', () => {
    assert.match(device, /planIpodSync\(/)
    assert.match(device, /onClick=\{\(\) => \{ void runOneSync\(\) \}\}/)
    assert.match(device, /origin: 'activity-click'/)
    assert.doesNotMatch(device, /ActivitySheet|SyncReviewSheet|buildWorkoutIpodSyncPayload|device-sync-size|quickTarget|requestPoolMode|Sync the Pool|profileName/)
    assert.doesNotMatch(device, />\{syncing \? 'Syncing…' : 'Activity Sync'\}</)
    // The progress strip and its Details / Dismiss lines stay.
    assert.match(device, /SYNC_STEPS\.map/)
    assert.match(device, /'Hide details' : 'Details'/)
  })

  it('the plan asks main for nothing but the library rows — never a size, a brief or a pool', () => {
    assert.match(util, /api\(allTracks\.map\(toPlanTrack\)\)/)
    assert.doesNotMatch(util, /buildWorkoutSyncSet|\btarget:|getPoolIds/)
  })

  it('main plans without Music Man: no Claude call, no vibe, no picker', () => {
    const handler = ipc.slice(ipc.indexOf("ipc.handle('plan-ipod-sync'"), ipc.indexOf("ipc.handle('build-workout-sync-set'"))
    assert.ok(handler.length > 0)
    assert.doesNotMatch(handler, /claudeCall|askActivityVibe|selectWorkoutSyncSet|brief/)
    assert.doesNotMatch(one, /claudeCall|askActivityVibe|selectWorkoutSyncSet|musicMan/i)
  })

  it('the two sheets are gone', () => {
    assert.throws(() => read('renderer/components/ActivitySheet.tsx'))
    assert.throws(() => read('renderer/components/SyncReviewSheet.tsx'))
  })
})
