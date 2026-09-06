/**
 * The scheduler mutates jobs in place, so every emit must hand subscribers a
 * NEW array: useSyncExternalStore readers (sidebar door count, Downloads
 * panel) compare snapshots by reference and would otherwise miss
 * queued → downloading → done / canceled. Found by the Downloads panel
 * (2026-09-06); this locks it.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { enqueue, getQueue, subscribeQueue, cancel, clearFinished, trackQueryId, type QResult } from '../../renderer/views/DownloadStore/downloadQueue.ts'

type Answer = { ok: boolean; imported?: number; dupes?: number; error?: string; outcome?: string }
let answer: () => Promise<Answer> = async () => ({ ok: true, imported: 1, dupes: 0 })
const inFlight = new Set<(a: Answer) => void>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = async () => { for (let i = 0; i < 60; i++) { await sleep(5); if (!getQueue().some((q) => q.status === 'queued' || q.status === 'downloading')) return } }

;(globalThis as unknown as { window: unknown }).window = {
  electronAPI: {
    streamripDownloadByQuery: async () => new Promise<Answer>((res) => { inFlight.add(res); void answer().then((v) => { inFlight.delete(res); res(v) }) }),
    streamripCancelActive: async () => { for (const res of inFlight) res({ ok: false, error: 'canceled', outcome: 'canceled' }); inFlight.clear() },
  },
  dispatchEvent: () => true,
}

const song = (title: string): QResult => ({ kind: 'query', source: 'qobuz', mediaType: 'track', id: trackQueryId('Nobody', title), desc: `${title} — Nobody`, artist: 'Nobody', title })

describe('download queue snapshots', () => {
  beforeEach(async () => { await settle(); clearFinished(); inFlight.clear() })

  it('every status transition reaches a subscriber as a new snapshot', async () => {
    const seen: Array<{ ref: unknown; status: string | undefined }> = []
    const off = subscribeQueue(() => { const q = getQueue(); seen.push({ ref: q, status: q.find((x) => x.result.title === 'Alpha')?.status }) })
    answer = async () => { await sleep(20); return { ok: true, imported: 1, dupes: 0 } }
    enqueue(song('Alpha'))
    await settle()
    off()
    const statuses = seen.map((s) => s.status)
    assert.deepEqual(statuses, ['queued', 'downloading', 'done'])
    const refs = new Set(seen.map((s) => s.ref))
    assert.equal(refs.size, seen.length, 'each emit must hand out a fresh array reference')
  })

  it('cancel mid-flight is a visible transition too, and the final snapshot is what getQueue returns', async () => {
    const snaps: unknown[] = []
    const off = subscribeQueue(() => snaps.push(getQueue()))
    answer = () => new Promise(() => { /* never resolves on its own — cancel ends it */ })
    enqueue(song('Beta'))
    await sleep(10)
    assert.equal(getQueue().find((x) => x.result.title === 'Beta')?.status, 'downloading')
    const beforeCancel = getQueue()
    await cancel(getQueue().find((x) => x.result.title === 'Beta')!.key)
    await settle()
    off()
    assert.notEqual(getQueue(), beforeCancel, 'cancel must publish a new snapshot')
    assert.equal(getQueue().find((x) => x.result.title === 'Beta')?.status, 'canceled')
    assert.equal(snaps[snaps.length - 1], getQueue(), 'the last notification carries the current snapshot')
  })
})
