// Brief 264: a plugged-in iPod is seen at once — the negative cache gives way
// to a /Volumes change, a hung network mount can't hold the answer, and a
// watcher that fails leaves the poll running alone.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createIpodDetector, IPOD_NEGATIVE_CACHE_MS, IPOD_DISKUTIL_EVERY_MS, type IpodDetectDeps,
} from '../platform.ts'
import { startVolumesWatch, type WatchFn } from '../volumes-watch.ts'

function rig(over: Partial<IpodDetectDeps> = {}) {
  let t = 1_000_000
  const state = { mounts: ['/Volumes/Macintosh HD'], ipods: new Set<string>(), lists: 0, remounts: 0, logs: [] as string[] }
  const deps: IpodDetectDeps = {
    listMounts: async () => { state.lists++; return [...state.mounts] },
    isIpod: async (m) => state.ipods.has(m),
    remount: async () => { state.remounts++; return null },
    now: () => t,
    log: (...a) => { state.logs.push(a.map(String).join(' ')) },
    checkBudgetMs: 50,
    ...over,
  }
  return { det: createIpodDetector(deps), state, advance: (ms: number) => { t += ms } }
}

const never = () => new Promise<boolean>(() => {})

describe('iPod detection — negative cache', () => {
  it('a miss caches for at most 2 s', async () => {
    const { det, state, advance } = rig()
    assert.equal(await det.find(), null)
    assert.ok(IPOD_NEGATIVE_CACHE_MS <= 2000)
    const lists = state.lists
    state.mounts.push('/Volumes/JACOBROSENB'); state.ipods.add('/Volumes/JACOBROSENB')
    assert.equal(await det.find(), null, 'inside the cache: no look')
    assert.equal(state.lists, lists)
    advance(IPOD_NEGATIVE_CACHE_MS)
    assert.equal(await det.find(), '/Volumes/JACOBROSENB')
  })

  it('a /Volumes change clears the cache, and a miss right after one is not cached', async () => {
    const { det, state, advance } = rig()
    assert.equal(await det.find(), null)
    assert.ok(det.negativeCacheUntil() > 0)
    det.noteVolumesChanged()
    assert.equal(det.negativeCacheUntil(), 0)
    // The iPod's folder is there but not readable yet: a miss, not cached.
    assert.equal(await det.find(), null)
    assert.equal(det.negativeCacheUntil(), 0)
    advance(300)
    state.mounts.push('/Volumes/JACOBROSENB'); state.ipods.add('/Volumes/JACOBROSENB')
    assert.equal(await det.find(), '/Volumes/JACOBROSENB')
    assert.ok(state.logs.some((l) => /FOUND iPod at \/Volumes\/JACOBROSENB — 300 ms after \/Volumes changed/.test(l)), state.logs.join('\n'))
  })
})

describe('iPod detection — a hung network mount', () => {
  it('a never-resolving stat on a share does not delay finding the iPod', async () => {
    const { det, state } = rig({
      isIpod: async (m) => (m === '/Volumes/JakeShared' ? never() : m === '/Volumes/JACOBROSENB'),
      checkBudgetMs: 1_000,   // even with a long budget, the iPod answers first
    })
    state.mounts = ['/Volumes/JakeShared', '/Volumes/JACOBROSENB']
    const t0 = Date.now()
    assert.equal(await det.find(), '/Volumes/JACOBROSENB')
    assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`)
  })

  it('a hung share alone ends the pass within the budget, and its check is reused, not stacked', async () => {
    let calls = 0
    const { det, state, advance } = rig({
      isIpod: (m) => { if (m === '/Volumes/Movies') { calls++; return never() } return Promise.resolve(false) },
      checkBudgetMs: 30,
    })
    state.mounts = ['/Volumes/Movies', '/Volumes/Macintosh HD']
    const t0 = Date.now()
    assert.equal(await det.find(), null)
    assert.ok(Date.now() - t0 < 500)
    advance(IPOD_NEGATIVE_CACHE_MS)
    assert.equal(await det.find(), null)
    assert.equal(calls, 1, 'the stalled stat is reused, never a second one on the same share')
    assert.ok(state.logs.some((l) => l.includes('slow')))
  })
})

describe('iPod detection — diskutil fallback', () => {
  it('the poll never waits on it, and it runs at most every 10 s', async () => {
    let release!: (v: string | null) => void
    let runs = 0
    const { det, advance } = rig({
      remount: () => { runs++; return new Promise((r) => { release = r }) },
    })
    assert.equal(await det.find({ remount: 'background' }), null, 'answers without the fallback')
    assert.equal(runs, 1)
    release(null); await new Promise((r) => setImmediate(r))
    advance(IPOD_NEGATIVE_CACHE_MS)
    assert.equal(await det.find({ remount: 'background' }), null)
    assert.equal(runs, 1, 'not again inside 10 s')
    advance(IPOD_DISKUTIL_EVERY_MS)
    await det.find({ remount: 'background' })
    assert.equal(runs, 2)
  })

  it('other callers still wait for it', async () => {
    const { det } = rig({ remount: async () => '/Volumes/JACOBROSENB' })
    assert.equal(await det.find(), '/Volumes/JACOBROSENB')
  })
})

describe('volumes watcher', () => {
  class FakeWatcher extends EventEmitter { closed = false; close() { this.closed = true } }

  it('clears at once, tells the renderer once per burst after the debounce', async () => {
    let listener!: () => void
    const w = new FakeWatcher()
    const watch: WatchFn = (_d, l) => { listener = l; return w }
    let raw = 0, settled = 0
    const vw = startVolumesWatch({ watch, debounceMs: 20, onRawChange: () => raw++, onSettled: () => settled++, log: () => {} })
    listener(); listener(); listener()
    assert.equal(raw, 3)
    assert.equal(settled, 0)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(settled, 1)
    vw.close()
    assert.ok(w.closed)
    listener()
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(settled, 1, 'nothing after close')
  })

  it('a watcher error closes it and falls back to polling', () => {
    const w = new FakeWatcher()
    const logs: string[] = []
    const vw = startVolumesWatch({ watch: () => w, onSettled: () => {}, log: (m) => logs.push(m) })
    assert.ok(vw.active())
    w.emit('error', new Error('EMFILE'))
    assert.equal(vw.active(), false)
    assert.ok(w.closed)
    assert.ok(logs.some((l) => l.includes('polling only')))
  })

  it('a watcher that cannot start leaves polling only', () => {
    const logs: string[] = []
    const vw = startVolumesWatch({ watch: () => { throw new Error('ENOENT') }, onSettled: () => {}, log: (m) => logs.push(m) })
    assert.equal(vw.active(), false)
    assert.ok(logs.some((l) => l.includes('polling only')))
  })
})
