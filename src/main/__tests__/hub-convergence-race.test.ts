/**
 * Audit A02 (2026-10-22) — an OLDER hub reply must never overwrite NEWER local
 * state. A converge snapshots local playlists / tombstones / pins (or tapes and
 * tape tombstones), POSTs, waits for the hub, and used to replace local state
 * with the reply. Anything Jake did during the wait was undone: a deleted
 * playlist or tape came back (and then spread to every device), a fresh rename
 * or new item was replaced by the old copy, a newer pin lost.
 *
 * What runs here is the REAL code: convergePlaylistHub / convergeMixtapeHub, the
 * save path (commitLocalPlaylistSave -> stampModifiedPlaylists +
 * recordPlaylistSave), saveLocalPins, upsertMixtape / removeMixtape, real
 * tombstone / pins / tape files in a scratch dir. The hub is a fake whose
 * answers come from the hub's own merge rules; each request is merged the moment
 * it "arrives" (as homemini does) and the test's hook then runs INSIDE the
 * request window, before the reply is returned.
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/desktopPlaylistHubRules.ts
 * (mergeCollection / mergeHub) is copied below so this suite can stand a hub
 * up offline. To prove the copy still IS the hub's rule book, point the suite
 * at the real file:
 *   JT_HUB_RULES=/path/to/JakeTunesMobile/backend/src/util/desktopPlaylistHubRules.ts npm test
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  convergePlaylistHub, commitLocalPlaylistSave, initPlaylistHubSync, schedulePlaylistHubConverge,
} from '../playlist-hub-sync.ts'
import { convergeMixtapeHub, initMixtapeHubSync, scheduleMixtapeHubConverge } from '../mixtape-hub-sync.ts'
import { loadTombstones, recordPlaylistSave } from '../playlist-tombstones.ts'
import { loadPins, savePins, saveLocalPins } from '../playlist-pins.ts'
import { createPhonePlaylistSync } from '../phone-playlist-sync.ts'
import { upsertMixtape, removeMixtape, mutateMixtapeStore } from '../mixtape-store-writes.ts'
import {
  bumpLocalGen, snapshotLocalGens, movedGens, withLocalLock, lockKeys,
  PLAYLIST_HUB_COLLECTIONS, MIXTAPE_HUB_COLLECTIONS,
} from '../hub-local-state.ts'

// ── The hub's rule book (copy of Mobile desktopPlaylistHubRules.ts) ─────
type Stone = { id: string; name: string; deletedAt: string }
type Pins = { pinnedPlaylists: string[]; updatedAt: string }
type HubState = { playlists: any[]; tombstones: Stone[]; pins: Pins | null }
const at = (s: unknown): string => (typeof s === 'string' ? s : '')

function mergeCollectionCopy(hubItems: any[], hubTombstones: Stone[], inItems?: any[], inTombstones?: Stone[]) {
  const incomingItems = Array.isArray(inItems) ? inItems.filter((p) => p && p.id != null) : []
  const incomingTombs = Array.isArray(inTombstones) ? inTombstones.filter((t) => t && t.id != null) : []
  const tomb = new Map<string, Stone>()
  for (const t of [...hubTombstones, ...incomingTombs]) {
    const id = String(t.id)
    const cur = tomb.get(id)
    if (!cur || at(t.deletedAt) < at(cur.deletedAt)) tomb.set(id, { ...t, id })
  }
  const byId = new Map<string, any>()
  for (const p of hubItems) byId.set(String(p.id), p)
  for (const p of incomingItems) {
    const id = String(p.id)
    const cur = byId.get(id)
    if (!cur || at(p.modifiedAt) > at(cur.modifiedAt)) byId.set(id, { ...p, id })
  }
  const items: any[] = []
  for (const p of byId.values()) {
    const t = tomb.get(p.id)
    if (t && !(at(p.modifiedAt) > at(t.deletedAt))) continue
    if (t) tomb.delete(p.id)
    items.push(p)
  }
  return { items, tombstones: [...tomb.values()] }
}

function mergeHubCopy(hub: HubState, incoming: { playlists?: any[]; tombstones?: Stone[]; pins?: Pins | null }): HubState {
  const { items: playlists, tombstones } = mergeCollectionCopy(hub.playlists, hub.tombstones, incoming.playlists, incoming.tombstones)
  let pins = hub.pins
  if (incoming.pins && (!pins || at(incoming.pins.updatedAt) > at(pins.updatedAt))) {
    pins = {
      pinnedPlaylists: (incoming.pins.pinnedPlaylists || []).filter((x): x is string => typeof x === 'string').slice(0, 3),
      updatedAt: at(incoming.pins.updatedAt),
    }
  }
  return { playlists, tombstones, pins }
}

const real = process.env.JT_HUB_RULES ? await import(process.env.JT_HUB_RULES) : null
const mergeHub: typeof mergeHubCopy = real ? real.mergeHub : mergeHubCopy
const mergeCollection: typeof mergeCollectionCopy = real ? real.mergeCollection : mergeCollectionCopy

// ── Helpers ─────────────────────────────────────────────────────────────
type P = { id: string; name: string; trackIds: number[]; modifiedAt?: string; [k: string]: unknown }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Poll until `cond` holds (never a fixed guess at how fast the machine is). */
async function waitFor(cond: () => boolean, what = 'condition', ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(2)
  }
}
function defer() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

// A strictly increasing fake clock shared by the desktop and the "remote
// devices", so every stamp is ordered the way the operations were.
let tick = Date.parse('2026-10-22T12:00:00Z')
const now = () => new Date((tick += 1000)).toISOString()

type Hook = (n: number) => void | Promise<void>

/** A hub: merges each request on arrival, then runs the test's hook while
 *  the reply is "in flight", then answers with the state AS MERGED. */
function makePlaylistHub(initial: { playlists?: P[]; tombstones?: Stone[]; pins?: Pins | null } = {}) {
  let state: HubState = { playlists: clone(initial.playlists ?? []), tombstones: clone(initial.tombstones ?? []), pins: clone(initial.pins ?? null) }
  const bodies: any[] = []
  const hub = {
    afterMerge: undefined as Hook | undefined,
    failFrom: Infinity,
    bodies,
    state: () => state,
    /** A phone PATCH / the other Mac's converge writing straight into the hub. */
    remote(incoming: { playlists?: any[]; tombstones?: Stone[]; pins?: Pins | null }) { state = mergeHub(state, clone(incoming)) },
    fetchFn: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      const n = bodies.length
      if (n >= hub.failFrom) throw new Error('ECONNREFUSED')
      state = mergeHub(state, body)
      const reply = clone({ ok: true, playlists: state.playlists, tombstones: state.tombstones, pins: state.pins })
      await hub.afterMerge?.(n)
      return { ok: true, status: 200, json: async () => reply }
    }) as unknown as typeof fetch,
  }
  return hub
}

async function makeDesktop(initial: P[]) {
  const dir = await mkdtemp(join(tmpdir(), 'hubrace-'))
  const tombstonesFile = join(dir, 'playlist-tombstones.json')
  const pinsFile = join(dir, 'playlist-pins.json')
  let cache: P[] = clone(initial)
  const told: P[][] = []
  const adopted: P[][] = []
  const d = {
    dir, tombstonesFile, pinsFile, told, adopted,
    peek: () => cache,
    ids: () => cache.map((p) => p.id),
    byId: (id: string) => cache.find((p) => p.id === id),
    deps(hub: ReturnType<typeof makePlaylistHub>) {
      return {
        hubUrl: 'http://hub', device: 'macbook',
        getPlaylists: async () => clone(cache),
        setPlaylists: (p: any[]) => { cache = clone(p); adopted.push(clone(p)) },
        tombstonesFile, pinsFile, fetchFn: hub.fetchFn,
        onApplied: (p: any[]) => { told.push(clone(p)) },
        log: () => {},
      }
    },
    /** The save-playlists path (library-ipc.ts calls this very function). */
    async save(next: P[]) {
      const { ledger } = await commitLocalPlaylistSave({
        playlists: clone(next),
        getPlaylists: async () => clone(cache),
        setPlaylists: (p) => { cache = clone(p as P[]) },
        tombstonesFile, now,
      })
      await ledger
    },
    /** Edit one playlist the way the renderer does: the whole array comes back. */
    async edit(id: string, patch: Partial<P>) {
      await d.save(cache.map((p) => (p.id === id ? { ...p, ...patch } : p)))
    },
    async remove(id: string) { await d.save(cache.filter((p) => p.id !== id)) },
    async add(p: P) { await d.save([...cache, p]) },
    async pin(ids: string[]) { await saveLocalPins({ pinnedPlaylists: ids, updatedAt: now() }, pinsFile) },
    stoneIds: async () => (await loadTombstones(tombstonesFile)).map((t) => t.id).sort(),
    pinIds: async () => (await loadPins(pinsFile))?.pinnedPlaylists,
  }
  return d
}

const A = (): P => ({ id: 'A', name: 'Road Trip', trackIds: [1, 2], modifiedAt: now() })
const B = (): P => ({ id: 'B', name: 'Delete Me', trackIds: [3], modifiedAt: now() })
const names = (ps: Array<{ id: string; name: string }>) => Object.fromEntries(ps.map((p) => [p.id, p.name]))

// ═══════════════════════════════════════════════════════════════════════
describe('the harness itself (controls)', () => {
  test('an edit made AFTER the reply lands survives and reaches the hub', async () => {
    const a = A()
    const d = await makeDesktop([a])
    const hub = makePlaylistHub({ playlists: [a] })
    hub.remote({ playlists: [{ id: 'X', name: 'From phone', trackIds: [9], modifiedAt: now() }] })
    const r1 = await convergePlaylistHub(d.deps(hub))
    assert.equal(r1.changed, true, 'the remote playlist was adopted')
    await d.edit('A', { name: 'Road Trip 2026' })
    await convergePlaylistHub(d.deps(hub))
    assert.equal(d.byId('A')!.name, 'Road Trip 2026')
    assert.equal(hub.state().playlists.find((p) => p.id === 'A').name, 'Road Trip 2026')
    assert.deepEqual(names(d.peek()), names(hub.state().playlists))
  })

  test('the request body keeps the shape the hub reads', async () => {
    const d = await makeDesktop([A()])
    const hub = makePlaylistHub({})
    await convergePlaylistHub(d.deps(hub))
    assert.deepEqual(Object.keys(hub.bodies[0]).sort(), ['device', 'pins', 'playlists', 'tombstones'])
  })

  test('with nothing racing, exactly one request is made and the reply is adopted as before', async () => {
    const d = await makeDesktop([A()])
    const hub = makePlaylistHub({ playlists: [A()] })
    hub.remote({ playlists: [{ id: 'X', name: 'Remote', trackIds: [], modifiedAt: now() }] })
    const r = await convergePlaylistHub(d.deps(hub))
    assert.deepEqual({ ok: r.ok, changed: r.changed, deferred: r.deferred }, { ok: true, changed: true, deferred: undefined })
    assert.equal(hub.bodies.length, 1)
    assert.equal(d.told.length, 1)
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('playlists — a local change during the request survives', () => {
  test('1. DELETE during the request, no remote change: it stays deleted (the P1 driver)', async () => {
    const a = A(); const b = B()
    const d = await makeDesktop([a, b])
    const hub = makePlaylistHub({ playlists: [a, b] })
    hub.afterMerge = async (n) => { if (n === 1) await d.remove('B') }   // Jake deletes B while the hub is answering

    const r = await convergePlaylistHub(d.deps(hub))

    assert.equal(r.ok, true)
    assert.deepEqual(d.ids(), ['A'], 'B must not come back')
    assert.deepEqual(await d.stoneIds(), ['B'], 'the tombstone that recorded the delete must survive the older reply')
    assert.deepEqual(hub.state().tombstones.map((t) => t.id), ['B'], 'and the hub must learn the delete')
    assert.ok(!hub.state().playlists.some((p) => p.id === 'B'))
    assert.equal(d.told.length, 0, 'the renderer is never handed the old list with B in it')
    assert.equal(hub.bodies.length, 2, 'the older reply was dropped and the converge ran again')
    // ...and it stays deleted on every later converge.
    await convergePlaylistHub(d.deps(hub))
    await convergePlaylistHub(d.deps(hub))
    assert.deepEqual(d.ids(), ['A'])
    assert.deepEqual(await d.stoneIds(), ['B'])
  })

  test('1b. DELETE during the request WITH an unrelated remote change: remote change adopted, B stays deleted', async () => {
    const a = A(); const b = B()
    const d = await makeDesktop([a, b])
    const hub = makePlaylistHub({ playlists: [a, b] })
    hub.remote({ playlists: [{ ...a, name: 'Road Trip (phone rename)', modifiedAt: now() }] })
    hub.afterMerge = async (n) => { if (n === 1) await d.remove('B') }

    await convergePlaylistHub(d.deps(hub))

    assert.deepEqual(d.ids(), ['A'])
    assert.equal(d.byId('A')!.name, 'Road Trip (phone rename)', 'the remote change still arrives')
    assert.deepEqual(await d.stoneIds(), ['B'])
    assert.ok(d.told.length === 1 && !d.told[0].some((p) => p.id === 'B'), 'one push to the renderer, without B')
  })

  test('1c. a delete whose tombstone is STILL BEING WRITTEN when the converge starts is not undone either', async () => {
    const a = A(); const b = B()
    const d = await makeDesktop([a, b])
    const hub = makePlaylistHub({ playlists: [a, b] })
    const fileBusy = defer()
    const holder = withLocalLock(lockKeys.tombstones(d.tombstonesFile), () => fileBusy.promise)   // the tombstone file is busy
    const { ledger } = await commitLocalPlaylistSave({                  // Jake deletes B: cache updated now, stone written LATER
      playlists: [a], getPlaylists: async () => clone(d.peek()), setPlaylists: (p) => { d.peek().splice(0, d.peek().length, ...(p as P[])) },
      tombstonesFile: d.tombstonesFile, now,
    })
    assert.deepEqual(d.ids(), ['A'])
    assert.deepEqual(await d.stoneIds(), [], 'precondition: the stone is not on disk yet')
    const run = convergePlaylistHub(d.deps(hub))                        // snapshots [A] with NO stone; the hub keeps B (absence is not deletion)
    await waitFor(() => hub.bodies.length === 1, 'the request to reach the hub')
    fileBusy.resolve(); await holder; await ledger                      // the stone lands while the reply is in flight
    await run
    assert.deepEqual(d.ids(), ['A'], 'B must not come back')
    assert.deepEqual(await d.stoneIds(), ['B'])
    assert.deepEqual(hub.state().tombstones.map((t) => t.id), ['B'])
  })

  test('2. rename + added song during the request, with an unrelated remote change: edit survives AND remote change arrives', async () => {
    const a = A()
    const d = await makeDesktop([a])
    const hub = makePlaylistHub({ playlists: [a] })
    hub.remote({ playlists: [{ id: 'X', name: 'Phone made this', trackIds: [9], modifiedAt: now() }] })
    hub.afterMerge = async (n) => { if (n === 1) await d.edit('A', { name: 'Road Trip 2026', trackIds: [1, 2, 3] }) }

    const r = await convergePlaylistHub(d.deps(hub))

    assert.equal(r.ok, true)
    assert.equal(d.byId('A')!.name, 'Road Trip 2026', 'fresh rename survives')
    assert.deepEqual(d.byId('A')!.trackIds, [1, 2, 3], 'fresh added song survives')
    assert.ok(d.byId('X'), 'the remote change (phone playlist) is adopted by the follow-up converge')
    assert.equal(hub.state().playlists.find((p) => p.id === 'A').name, 'Road Trip 2026', 'and the hub has the edit')
    assert.deepEqual(d.adopted.map((p) => names(p).A), ['Road Trip 2026'], 'the only adoption already contains the edit')
    assert.equal(names(d.told.at(-1)!).A, 'Road Trip 2026', 'the renderer is told the edited copy, never the old one')
  })

  test('2b. a brand-new playlist created during the request survives', async () => {
    const a = A()
    const d = await makeDesktop([a])
    const hub = makePlaylistHub({ playlists: [a] })
    hub.remote({ playlists: [{ id: 'X', name: 'Phone made this', trackIds: [9], modifiedAt: now() }] })
    hub.afterMerge = async (n) => { if (n === 1) await d.add({ id: 'C', name: 'Brand New', trackIds: [5, 6, 7] }) }

    await convergePlaylistHub(d.deps(hub))

    assert.ok(d.byId('C'), 'new playlist survives locally')
    assert.ok(hub.state().playlists.some((p) => p.id === 'C'), 'and reaches the hub')
    assert.ok(d.byId('X'), 'the remote playlist arrives too')
  })

  test('2c. a restored (re-created) playlist during the request is not re-deleted by the old tombstone', async () => {
    const a = A(); const b = B()
    const d = await makeDesktop([a])
    // B was deleted earlier on this Mac and the hub knows it.
    const stone = { id: 'B', name: 'Delete Me', deletedAt: now() }
    const hub = makePlaylistHub({ playlists: [a], tombstones: [stone] })
    await writeFile(d.tombstonesFile, JSON.stringify([stone]))
    hub.afterMerge = async (n) => { if (n === 1) await d.add({ ...b, modifiedAt: undefined }) }   // Jake brings B back

    await convergePlaylistHub(d.deps(hub))

    assert.ok(d.byId('B'), 'the deliberate re-creation lives')
    assert.deepEqual(await d.stoneIds(), [], 'its own tombstone is cleared (a live copy in a save is the owner\'s word)')
    assert.ok(hub.state().playlists.some((p) => p.id === 'B'))
    assert.deepEqual(hub.state().tombstones, [])
  })

  test('3. pins changed during the request beat an OLDER remote pin change', async () => {
    const a = A()
    const d = await makeDesktop([a])
    await d.pin(['A'])                                                   // T0, local
    const hub = makePlaylistHub({ playlists: [a] })
    hub.remote({ pins: { pinnedPlaylists: ['X'], updatedAt: now() } })   // T1, other Mac
    hub.afterMerge = async (n) => { if (n === 1) await d.pin(['A', 'Y']) }   // T2 > T1, local, in flight

    await convergePlaylistHub(d.deps(hub))

    assert.deepEqual(await d.pinIds(), ['A', 'Y'], 'the newest pins win')
    assert.deepEqual(hub.state().pins!.pinnedPlaylists, ['A', 'Y'], 'and the hub hears them')
  })

  test('3b. control: a NEWER remote pin change still wins when nothing local moved', async () => {
    const d = await makeDesktop([A()])
    await d.pin(['A'])
    const hub = makePlaylistHub({})
    hub.remote({ pins: { pinnedPlaylists: ['X'], updatedAt: now() } })
    await convergePlaylistHub(d.deps(hub))
    assert.deepEqual(await d.pinIds(), ['X'])
  })

  test('4. the hub going away between attempts leaves local state exactly as the user left it', async () => {
    const a = A(); const b = B()
    const d = await makeDesktop([a, b])
    const hub = makePlaylistHub({ playlists: [a, b] })
    hub.failFrom = 2                                                      // the re-converge cannot reach homemini
    hub.afterMerge = async (n) => { if (n === 1) await d.remove('B') }

    const r = await convergePlaylistHub(d.deps(hub))

    assert.equal(r.ok, false, 'a quiet failure, never a throw')
    assert.deepEqual(d.ids(), ['A'], 'the delete is intact')
    assert.deepEqual(await d.stoneIds(), ['B'], 'and so is its tombstone')
    assert.equal(d.adopted.length, 0)
    // Later, the hub comes back: the delete reaches it.
    hub.failFrom = Infinity
    await convergePlaylistHub(d.deps(hub))
    assert.ok(!hub.state().playlists.some((p) => p.id === 'B'))
    assert.deepEqual(d.ids(), ['A'])
  })

  test('5. a steady stream of edits cannot spin the client: bounded attempts, nothing replaced, then it catches up', async () => {
    const a = A()
    const d = await makeDesktop([a])
    const hub = makePlaylistHub({ playlists: [a] })
    hub.remote({ playlists: [{ id: 'X', name: 'Remote', trackIds: [], modifiedAt: now() }] })
    let edits = 0
    hub.afterMerge = async () => { edits++; await d.edit('A', { name: `edit ${edits}` }) }   // an edit lands in EVERY window

    const r = await convergePlaylistHub(d.deps(hub))

    assert.deepEqual({ ok: r.ok, changed: r.changed, deferred: r.deferred }, { ok: true, changed: false, deferred: true })
    assert.equal(hub.bodies.length, 4, 'bounded: the first attempt plus three immediate re-converges')
    assert.equal(d.adopted.length, 0, 'no reply was ever adopted over the edits')
    assert.equal(d.byId('A')!.name, `edit ${edits}`)

    hub.afterMerge = undefined                                            // the user stops typing
    const r2 = await convergePlaylistHub(d.deps(hub))
    assert.equal(r2.changed, true)
    assert.ok(d.byId('X'), 'the remote playlist finally arrives')
    assert.equal(d.byId('A')!.name, `edit ${edits}`, 'and the last edit is still there')
    assert.equal(hub.state().playlists.find((p) => p.id === 'A').name, `edit ${edits}`)
  })

  test('6. DUPLICATE replies are harmless: the same answer twice changes nothing the second time', async () => {
    const a = A()
    const d = await makeDesktop([a])
    const hub = makePlaylistHub({ playlists: [a] })
    hub.remote({ playlists: [{ id: 'X', name: 'Remote', trackIds: [], modifiedAt: now() }] })
    const r1 = await convergePlaylistHub(d.deps(hub))
    const r2 = await convergePlaylistHub(d.deps(hub))
    assert.equal(r1.changed, true)
    assert.equal(r2.changed, false)
    assert.equal(d.told.length, 1, 'the renderer is told once')
    assert.deepEqual(names(d.peek()), names(hub.state().playlists))
  })

  test('7. REORDERED replies: an older answer that lands after a newer one is dropped, not adopted', async () => {
    const a = A(); const b = B()
    const d = await makeDesktop([a, b])
    const hub = makePlaylistHub({ playlists: [a, b] })
    // Request 1 is slow; request 2 (merged AFTER a remote delete of B) answers first.
    const slow = defer()
    hub.afterMerge = async (n) => { if (n === 1) await slow.promise }
    const first = convergePlaylistHub(d.deps(hub))
    await waitFor(() => hub.bodies.length === 1, 'request 1 to reach the hub')   // its reply is held
    hub.remote({ tombstones: [{ id: 'B', name: 'Delete Me', deletedAt: now() }] })   // the other Mac deletes B
    hub.afterMerge = undefined
    const second = await convergePlaylistHub(d.deps(hub))               // newer answer: B is gone
    assert.deepEqual(d.ids(), ['A'])
    assert.deepEqual(await d.stoneIds(), ['B'])
    slow.resolve()                                                        // the OLD reply (still containing B, no tombstone) lands last
    const firstR = await first
    assert.equal(second.ok && firstR.ok, true)
    assert.deepEqual(d.ids(), ['A'], 'the older answer must not bring B back')
    assert.deepEqual(await d.stoneIds(), ['B'], 'nor wipe the tombstone')
    assert.deepEqual(names(d.peek()), names(hub.state().playlists))
  })

  test('9. the generations are recorded BEFORE local state is read: an edit that lands during the reads is not missed', async () => {
    const a = A()
    const d = await makeDesktop([a])
    const hub = makePlaylistHub({ playlists: [a] })
    hub.remote({ playlists: [{ id: 'X', name: 'Remote', trackIds: [], modifiedAt: now() }] })
    const deps = d.deps(hub)
    const baseGet = deps.getPlaylists
    let first = true
    deps.getPlaylists = async () => {
      const v = await baseGet()                                          // the snapshot the converge will send
      if (first) {                                                       // ...and the edit lands right after it was taken
        first = false
        d.peek().splice(0, 1, { ...d.peek()[0], name: 'edited during the reads', modifiedAt: now() })
        bumpLocalGen('playlists')
      }
      return v
    }
    await convergePlaylistHub(deps)
    assert.equal(d.byId('A')!.name, 'edited during the reads')
    assert.equal(hub.state().playlists.find((p) => p.id === 'A').name, 'edited during the reads')
  })

  test('10. defence in depth: even a writer that forgot to bump cannot have its newer pins replaced by older hub pins', async () => {
    const a = A()
    const d = await makeDesktop([a])
    await d.pin(['A'])                                                   // T0
    const hub = makePlaylistHub({ playlists: [a] })
    hub.remote({ pins: { pinnedPlaylists: ['X'], updatedAt: now() } })   // T1
    hub.afterMerge = async (n) => {
      // a raw write, NOT through saveLocalPins: no generation moves
      if (n === 1) await savePins({ pinnedPlaylists: ['A', 'Y'], updatedAt: now() }, d.pinsFile)   // T2
    }
    await convergePlaylistHub(d.deps(hub))
    assert.deepEqual(await d.pinIds(), ['A', 'Y'], 'the pins file is compared as it is NOW, not as it was before the request')
  })

  test('11. the phone-playlist apply is a local writer too: a phone delete applied during the request is not undone', async () => {
    const jv = { id: 'JV', name: 'JUSTIFICATION V', trackIds: [1, 2], modifiedAt: now() }
    const bad: P = { id: 'mobile:51dfd77d-a53e-4fc3-893a-095715d0d94a', name: 'Bad Ass Music', trackIds: [1], modifiedAt: now() }
    const d = await makeDesktop([jv, bad])
    const hub = makePlaylistHub({ playlists: [jv, bad] })
    hub.remote({ playlists: [{ id: 'X', name: 'Remote', trackIds: [], modifiedAt: now() }] })
    await writeFile(join(d.dir, 'mobile-playlist-deletions.json'), JSON.stringify({ deletedIds: [bad.id] }))
    const sync = createPhonePlaylistSync({
      mirrorDir: d.dir, tombstonesFile: d.tombstonesFile, isSaveLocked: () => null,
      getPlaylists: async () => clone(d.peek()), setPlaylists: (p) => { d.peek().splice(0, d.peek().length, ...(p as P[])) },
      now, log: () => {},
    })
    hub.afterMerge = async (n) => { if (n === 1) await sync.apply('phone-mirror') }
    await convergePlaylistHub(d.deps(hub))
    assert.ok(!d.ids().includes(bad.id), 'the phone delete stays applied')
    assert.deepEqual(await d.stoneIds(), [bad.id])
    assert.ok(d.byId('X'), 'the remote playlist still arrives')
    assert.ok(!hub.state().playlists.some((p) => p.id === bad.id))
  })

  test('12. a local delete that starts AFTER the guard has passed queues behind the adoption writes (no lost tombstone)', async () => {
    const a = A(); const b = B()
    const d = await makeDesktop([a, b])
    const hub = makePlaylistHub({ playlists: [a, b] })
    // The hub also carries a tombstone for an old playlist Z, so the adoption rewrites the tombstone file.
    hub.remote({ tombstones: [{ id: 'Z', name: 'Old', deletedAt: now() }] })
    hub.remote({ playlists: [{ id: 'X', name: 'Remote', trackIds: [], modifiedAt: now() }] })   // makes the reply "differ" so it is adopted
    let ledger: Promise<unknown> = Promise.resolve()
    let committed = false
    let probed = false
    let seenByQueuedWriter: string[] = []
    const deps = d.deps(hub)
    const baseSet = deps.setPlaylists
    // setPlaylists runs INSIDE the adoption (after the guard passed, before its file writes):
    // Jake deletes B right there, on a path that does not wait for the adoption.
    deps.setPlaylists = (p) => {
      baseSet(p)
      void commitLocalPlaylistSave({
        playlists: p.filter((x) => x.id !== 'B'), getPlaylists: async () => clone(p), setPlaylists: () => {},
        tombstonesFile: d.tombstonesFile, now,
      }).then((r) => { ledger = r.ledger; committed = true })
      // A probe taking the same lock: it must only run once the adoption's writes are down.
      void withLocalLock(lockKeys.tombstones(d.tombstonesFile), async () => {
        seenByQueuedWriter = (await loadTombstones(d.tombstonesFile)).map((t) => t.id).sort()
        probed = true
      })
    }
    await convergePlaylistHub(deps)
    await waitFor(() => committed && probed, 'the mid-adoption delete and probe to run'); await ledger
    assert.deepEqual(seenByQueuedWriter, ['Z'], 'a local writer that arrives mid-adoption waits for the adoption\'s file writes')
    assert.deepEqual(await d.stoneIds(), ['B', 'Z'], 'both the hub\'s stone and Jake\'s fresh one are in the file')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('mixtapes — the same guard on the tape shelf', () => {
  type Tape = { id: string; title: string; tracks: number[]; modifiedAt?: string; [k: string]: unknown }
  async function makeShelf(initial: Tape[]) {
    const dir = await mkdtemp(join(tmpdir(), 'hubrace-tapes-'))
    const file = join(dir, 'mixtapes.json')
    const tombstonesFile = join(dir, 'mixtape-tombstones.json')
    await writeFile(file, JSON.stringify(initial))
    const io = {
      load: async () => JSON.parse(await readFile(file, 'utf-8')) as Tape[],
      save: async (all: Tape[]) => { await writeFile(file + '.tmp', JSON.stringify(all)); const { rename } = await import('node:fs/promises'); await rename(file + '.tmp', file) },
      tombstonesFile,
    }
    const hubSets: Tape[][] = []
    const shelf = {
      dir, file, tombstonesFile, io, hubSets,
      list: () => io.load(),
      stones: async () => (await loadTombstones(tombstonesFile)).map((t) => t.id).sort(),
      saveTape: (t: Tape) => upsertMixtape(io, t, now),
      deleteTape: (id: string) => removeMixtape(io, id, now),
      deps: (hub: ReturnType<typeof makeTapeHub>) => ({
        hubUrl: 'http://hub', device: 'macbook',
        getMixtapes: io.load as () => Promise<any[]>,
        setMixtapes: async (t: any[]) => { hubSets.push(clone(t)); await io.save(t) },
        tombstonesFile, introsDir: join(dir, 'intros'), fetchFn: hub.fetchFn, log: () => {},
      }),
    }
    return shelf
  }
  function makeTapeHub(initial: Tape[] = []) {
    let state = { mixtapes: clone(initial) as any[], tombstones: [] as Stone[] }
    const bodies: any[] = []
    const hub = {
      afterMerge: undefined as Hook | undefined,
      bodies,
      state: () => state,
      remote(tapes: any[], tombstones: Stone[] = []) {
        const m = mergeCollection(state.mixtapes, state.tombstones, clone(tapes), tombstones)
        state = { mixtapes: m.items, tombstones: m.tombstones }
      },
      fetchFn: (async (url: string, init?: RequestInit) => {
        if (!url.endsWith('/converge')) return { ok: true, json: async () => ({ names: [] }) }
        const body = JSON.parse(String(init!.body))
        bodies.push(body)
        const m = mergeCollection(state.mixtapes, state.tombstones, body.mixtapes, body.tombstones)
        state = { mixtapes: m.items, tombstones: m.tombstones }
        const reply = clone({ ok: true, mixtapes: state.mixtapes, tombstones: state.tombstones })
        await hub.afterMerge?.(bodies.length)
        return { ok: true, status: 200, json: async () => reply }
      }) as unknown as typeof fetch,
    }
    return hub
  }
  const T1 = (): Tape => ({ id: 't1', title: 'Summer', tracks: [1, 2], modifiedAt: now() })
  const T2 = (): Tape => ({ id: 't2', title: 'Delete me', tracks: [3], modifiedAt: now() })

  test('M1. a tape edit saved during the request survives an unrelated remote change, and the hub gets it', async () => {
    const t1 = T1()
    const shelf = await makeShelf([t1])
    const hub = makeTapeHub([t1])
    hub.remote([{ id: 'tw', title: 'Workmini tape', tracks: [7], modifiedAt: now() }])
    hub.afterMerge = async (n) => { if (n === 1) await shelf.saveTape({ id: 't1', title: 'Summer (final cut)', tracks: [1, 2, 3] }) }

    const r = await convergeMixtapeHub(shelf.deps(hub))

    assert.equal(r.ok, true)
    const list = await shelf.list()
    assert.equal(list.find((t) => t.id === 't1')!.title, 'Summer (final cut)')
    assert.ok(list.some((t) => t.id === 'tw'), 'the workmini tape arrives')
    assert.equal(hub.state().mixtapes.find((t) => t.id === 't1').title, 'Summer (final cut)')
    assert.deepEqual(shelf.hubSets.map((s) => s.find((t) => t.id === 't1')!.title), ['Summer (final cut)'], 'the only adoption already carries the edit')
  })

  test('M2. a NEW tape recorded during the request survives and reaches the hub', async () => {
    const t1 = T1()
    const shelf = await makeShelf([t1])
    const hub = makeTapeHub([t1])
    hub.remote([{ id: 'tw', title: 'Workmini tape', tracks: [7], modifiedAt: now() }])
    hub.afterMerge = async (n) => { if (n === 1) await shelf.saveTape({ id: 't3', title: 'Brand new tape', tracks: [4, 5], introPath: '/x/intro.m4a' }) }

    await convergeMixtapeHub(shelf.deps(hub))

    assert.ok((await shelf.list()).some((t) => t.id === 't3'), 'the new tape survives locally')
    assert.ok(hub.state().mixtapes.some((t) => t.id === 't3'), 'and the hub has it')
  })

  test('M3. a tape DELETED during the request stays deleted, with no remote change at all', async () => {
    const t1 = T1(); const t2 = T2()
    const shelf = await makeShelf([t1, t2])
    const hub = makeTapeHub([t1, t2])
    hub.afterMerge = async (n) => { if (n === 1) await shelf.deleteTape('t2') }

    const r = await convergeMixtapeHub(shelf.deps(hub))

    assert.equal(r.ok, true)
    assert.deepEqual((await shelf.list()).map((t) => t.id), ['t1'])
    assert.deepEqual(await shelf.stones(), ['t2'], 'the tombstone survives the older reply')
    assert.deepEqual(hub.state().tombstones.map((t) => t.id), ['t2'])
    // Every later converge keeps it dead.
    await convergeMixtapeHub(shelf.deps(hub))
    await convergeMixtapeHub(shelf.deps(hub))
    assert.deepEqual((await shelf.list()).map((t) => t.id), ['t1'])
    assert.deepEqual(await shelf.stones(), ['t2'])
  })

  test('M4. a save that starts after the guard queues behind the shelf adoption (no lost tape, no torn shelf)', async () => {
    const t1 = T1()
    const shelf = await makeShelf([t1])
    const hub = makeTapeHub([t1])
    hub.remote([{ id: 'tw', title: 'Workmini tape', tracks: [7], modifiedAt: now() }])
    const deps = shelf.deps(hub)
    const baseSet = deps.setMixtapes
    let saved: Promise<unknown> = Promise.resolve()
    let seenByQueuedWriter: string[] = []
    let probe: Promise<unknown> = Promise.resolve()
    deps.setMixtapes = async (t) => {                                      // inside the adoption, after the guard passed
      // A probe taking the same lock, queued first: it must only run once the adopted shelf is on disk.
      probe = withLocalLock(lockKeys.mixtapeStore(shelf.tombstonesFile), async () => { seenByQueuedWriter = (await shelf.list()).map((x) => x.id).sort() })
      saved = shelf.saveTape({ id: 't3', title: 'Recorded just now', tracks: [1] })
      await baseSet(t)
    }
    await convergeMixtapeHub(deps)
    await Promise.all([saved, probe])
    assert.deepEqual(seenByQueuedWriter, ['t1', 'tw'], 'a writer that arrives mid-adoption waits until the adopted shelf is on disk')
    const ids = (await shelf.list()).map((t) => t.id).sort()
    assert.deepEqual(ids, ['t1', 't3', 'tw'], 'adoption and the fresh recording both on the shelf')
    await convergeMixtapeHub(shelf.deps(hub))
    assert.ok(hub.state().mixtapes.some((t) => t.id === 't3'), 'the recording reaches the hub on the next converge')
  })

  test('M7. a tape delete whose shelf/tombstone writes are STILL PENDING when the converge starts is not undone', async () => {
    const t1 = T1(); const t2 = T2()
    const shelf = await makeShelf([t1, t2])
    const hub = makeTapeHub([t1, t2])
    const busy = defer()
    const holder = withLocalLock(lockKeys.mixtapeStore(shelf.tombstonesFile), () => busy.promise)   // the shelf is busy
    const deleting = shelf.deleteTape('t2')                              // queued behind the holder; its start already bumped
    const run = convergeMixtapeHub(shelf.deps(hub))                      // snapshots the OLD shelf (t2 alive), no stone
    await waitFor(() => hub.bodies.length === 1, 'the request to reach the hub')
    busy.resolve(); await holder; await deleting                         // the delete lands while the reply is in flight
    await run
    assert.deepEqual((await shelf.list()).map((t) => t.id), ['t1'])
    assert.deepEqual(await shelf.stones(), ['t2'])
    assert.deepEqual(hub.state().tombstones.map((t) => t.id), ['t2'])
  })

  test('M8. REORDERED replies on the shelf: an older answer that lands after a newer one is dropped', async () => {
    const t1 = T1(); const t2 = T2()
    const shelf = await makeShelf([t1, t2])
    const hub = makeTapeHub([t1, t2])
    const slow = defer()
    hub.afterMerge = async (n) => { if (n === 1) await slow.promise }
    const first = convergeMixtapeHub(shelf.deps(hub))
    await waitFor(() => hub.bodies.length === 1, 'request 1 to reach the hub')
    hub.remote([], [{ id: 't2', name: 'Delete me', deletedAt: now() }])  // the other Mac deletes t2
    hub.afterMerge = undefined
    await convergeMixtapeHub(shelf.deps(hub))                            // newer answer: t2 is gone
    assert.deepEqual((await shelf.list()).map((t) => t.id), ['t1'])
    slow.resolve()                                                        // the OLD reply (still has t2, no stone) lands last
    await first
    assert.deepEqual((await shelf.list()).map((t) => t.id), ['t1'], 'the older answer must not bring t2 back')
    assert.deepEqual(await shelf.stones(), ['t2'], 'nor wipe the stone')
  })

  test('M5. a steady stream of tape saves cannot spin the client either', async () => {
    const t1 = T1()
    const shelf = await makeShelf([t1])
    const hub = makeTapeHub([t1])
    let n = 0
    hub.afterMerge = async () => { n++; await shelf.saveTape({ id: 't1', title: `take ${n}`, tracks: [1] }) }
    const r = await convergeMixtapeHub(shelf.deps(hub))
    assert.equal(r.deferred, true)
    assert.equal(hub.bodies.length, 4)
    assert.equal(shelf.hubSets.length, 0)
    assert.equal((await shelf.list())[0].title, `take ${n}`)
  })

  test('M6. the season-tape writer (mutateMixtapeStore) moves the same generations', async () => {
    const shelf = await makeShelf([T1()])
    const since = snapshotLocalGens()
    await mutateMixtapeStore(shelf.tombstonesFile, async () => {
      const cur = await shelf.io.load(); cur.unshift({ id: 'season', title: 'October', tracks: [1] }); await shelf.io.save(cur)
    })
    assert.deepEqual(movedGens(since, MIXTAPE_HUB_COLLECTIONS).sort(), ['mixtapeTombstones', 'mixtapes'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('the scheduler never drops a request made while a converge is in flight', () => {
  test('playlists: an edit scheduled mid-converge gets its own converge; a deferred converge is re-run', async () => {
    const a = A()
    const d = await makeDesktop([a])
    const hub = makePlaylistHub({ playlists: [a] })
    const slow = defer()
    hub.afterMerge = async (n) => { if (n === 1) await slow.promise }
    initPlaylistHubSync(d.deps(hub), { rerunDelayMs: 5 })
    schedulePlaylistHubConverge(0)
    await waitFor(() => hub.bodies.length === 1, 'converge #1 to reach the hub')   // in flight, reply held
    await d.edit('A', { name: 'edited while syncing' })
    schedulePlaylistHubConverge(5)                                       // the save's own schedule, fires mid-converge
    await sleep(30)
    slow.resolve()
    await waitFor(() => hub.state().playlists.find((p) => p.id === 'A').name === 'edited while syncing', 'the edit to reach the hub')
    await sleep(150)
    assert.ok(hub.bodies.length <= 4, `and the chain settles (no converge storm): ${hub.bodies.length} requests`)
    // A converge overtaken on EVERY attempt is run again by the scheduler.
    let edits = 0
    hub.afterMerge = async () => { if (edits < 4) { edits++; await d.edit('A', { name: `busy ${edits}` }) } }
    const before = hub.bodies.length
    schedulePlaylistHubConverge(0)
    await waitFor(() => hub.state().playlists.find((p) => p.id === 'A').name === 'busy 4', 'the deferred converge to be re-run')
    assert.ok(hub.bodies.length - before >= 5, 'four overtaken attempts, then the re-run')
    assert.equal(d.byId('A')!.name, 'busy 4')
  })

  test('playlists: an edit scheduled during a converge that then FAILS still gets its converge', async () => {
    const a = A()
    const d = await makeDesktop([a])
    const hub = makePlaylistHub({ playlists: [a] })
    const slow = defer()
    hub.afterMerge = async (n) => { if (n === 1) { await slow.promise; throw new Error('socket hang up') } }
    initPlaylistHubSync(d.deps(hub), { rerunDelayMs: 5 })
    const before = hub.bodies.length
    schedulePlaylistHubConverge(0)
    await waitFor(() => hub.bodies.length - before === 1, 'converge #1 to reach the hub')
    await d.edit('A', { name: 'edited while the first request hangs' })
    schedulePlaylistHubConverge(5)                                       // fires mid-converge: used to be dropped
    await sleep(30)
    slow.resolve()
    await waitFor(() => hub.state().playlists.find((p) => p.id === 'A').name === 'edited while the first request hangs',
      'the failed converge to be followed by the one the edit asked for')
    assert.equal(hub.bodies.length - before, 2)
  })

  test('mixtapes: the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hubrace-sched-'))
    let requests = 0
    const slow = defer()
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/converge')) return { ok: true, json: async () => ({ names: [] }) }
      requests++
      const body = JSON.parse(String(init!.body))
      if (requests === 1) { await slow.promise; throw new Error('socket hang up') }
      return { ok: true, json: async () => ({ ok: true, mixtapes: body.mixtapes, tombstones: body.tombstones }) }
    }) as unknown as typeof fetch
    initMixtapeHubSync({
      hubUrl: 'http://hub', device: 't', getMixtapes: async () => [], setMixtapes: async () => {},
      tombstonesFile: join(dir, 'ts.json'), introsDir: join(dir, 'intros'), fetchFn, log: () => {},
    }, { rerunDelayMs: 5 })
    scheduleMixtapeHubConverge(0)
    await waitFor(() => requests === 1, 'converge #1 to reach the hub')
    scheduleMixtapeHubConverge(5)
    await sleep(30)
    slow.resolve()
    await waitFor(() => requests === 2, 'the mid-flight request to be re-run')
    await sleep(60)
    assert.equal(requests, 2, 're-run once, not dropped and not repeated')
  })
})

// ═══════════════════════════════════════════════════════════════════════
describe('every local writer moves ITS generation (and adoption moves what it writes)', () => {
  const only = (since: ReturnType<typeof snapshotLocalGens>, c: Parameters<typeof movedGens>[1][number]) =>
    movedGens(since, ['playlists', 'playlistTombstones', 'pins', 'mixtapes', 'mixtapeTombstones']).filter((x) => x !== c)

  test('save-playlists (commitLocalPlaylistSave) moves playlists, and the ledger moves the tombstones', async () => {
    const d = await makeDesktop([A(), B()])
    const since = snapshotLocalGens()
    const { ledger } = await commitLocalPlaylistSave({
      playlists: [A()], getPlaylists: async () => clone(d.peek()), setPlaylists: () => {}, tombstonesFile: d.tombstonesFile, now,
    })
    assert.ok(movedGens(since, ['playlists']).length === 1, 'playlists generation moved')
    await ledger
    assert.ok(movedGens(since, ['playlistTombstones']).length === 1, 'tombstone generation moved')
    assert.deepEqual(movedGens(since, ['pins', 'mixtapes', 'mixtapeTombstones']), [], 'and nothing else did')
  })

  test('save-playlist-pins (saveLocalPins) moves pins only', async () => {
    const d = await makeDesktop([])
    const since = snapshotLocalGens()
    await d.pin(['A'])
    assert.deepEqual(movedGens(since, ['pins']), ['pins'])
    assert.deepEqual(only(since, 'pins'), [])
  })

  test('mixtape-save / mixtape-delete move the shelf and its tombstones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hubrace-w-'))
    const file = join(dir, 'mixtapes.json'); await writeFile(file, '[]')
    const io = { load: async () => JSON.parse(await readFile(file, 'utf-8')), save: async (all: unknown[]) => { await writeFile(file, JSON.stringify(all)) }, tombstonesFile: join(dir, 'ts.json') }
    let since = snapshotLocalGens()
    await upsertMixtape(io, { id: 't', title: 'T', tracks: [1] }, now)
    assert.deepEqual(movedGens(since, MIXTAPE_HUB_COLLECTIONS).sort(), ['mixtapeTombstones', 'mixtapes'])
    since = snapshotLocalGens()
    await removeMixtape(io, 't', now)
    assert.deepEqual(movedGens(since, MIXTAPE_HUB_COLLECTIONS).sort(), ['mixtapeTombstones', 'mixtapes'])
    assert.deepEqual(only(since, 'mixtapes').filter((x) => x !== 'mixtapeTombstones'), [])
  })

  test('the phone-playlist apply moves playlists and tombstones', async () => {
    const bad: P = { id: 'mobile:abc', name: 'Phone made', trackIds: [1] }
    const d = await makeDesktop([bad])
    await writeFile(join(d.dir, 'mobile-playlist-deletions.json'), JSON.stringify({ deletedIds: [bad.id] }))
    const sync = createPhonePlaylistSync({
      mirrorDir: d.dir, tombstonesFile: d.tombstonesFile, isSaveLocked: () => null,
      getPlaylists: async () => clone(d.peek()), setPlaylists: () => {}, now, log: () => {},
    })
    const since = snapshotLocalGens()
    await sync.apply('phone-mirror')
    assert.deepEqual(movedGens(since, ['playlists', 'playlistTombstones']).sort(), ['playlistTombstones', 'playlists'])
    assert.deepEqual(movedGens(since, ['pins', 'mixtapes', 'mixtapeTombstones']), [])
  })

  test('a tape-shelf adoption moves what it wrote', async () => {
    const t1: any = { id: 't1', title: 'T', tracks: [1], modifiedAt: now() }
    const dir = await mkdtemp(join(tmpdir(), 'hubrace-wa-'))
    const file = join(dir, 'mixtapes.json'); await writeFile(file, JSON.stringify([t1]))
    const tombstonesFile = join(dir, 'ts.json')
    const reply = { ok: true, mixtapes: [t1, { id: 'tw', title: 'W', tracks: [2], modifiedAt: now() }], tombstones: [{ id: 'old', name: 'Old', deletedAt: now() }] }
    const fetchFn = (async (url: string) => (url.endsWith('/converge') ? { ok: true, json: async () => reply } : { ok: true, json: async () => ({ names: [] }) })) as unknown as typeof fetch
    const deps = {
      hubUrl: 'http://hub', device: 'mb', getMixtapes: async () => JSON.parse(await readFile(file, 'utf-8')),
      setMixtapes: async (t: any[]) => { await writeFile(file, JSON.stringify(t)) }, tombstonesFile, introsDir: join(dir, 'i'), fetchFn, log: () => {},
    }
    const since = snapshotLocalGens()
    await convergeMixtapeHub(deps)
    assert.deepEqual(movedGens(since, MIXTAPE_HUB_COLLECTIONS).sort(), ['mixtapeTombstones', 'mixtapes'])
    const quiet = snapshotLocalGens()
    await convergeMixtapeHub({ ...deps, fetchFn: (async (url: string) => (url.endsWith('/converge') ? { ok: true, json: async () => ({ ...reply, mixtapes: JSON.parse(await readFile(file, 'utf-8')) }) } : { ok: true, json: async () => ({ names: [] }) })) as unknown as typeof fetch })
    assert.deepEqual(movedGens(quiet, MIXTAPE_HUB_COLLECTIONS), [], 'an identical answer writes nothing and moves nothing')
  })

  test('a hub adoption moves exactly what it wrote (so an overlapping converge is dropped)', async () => {
    const a = A()
    const d = await makeDesktop([a])
    const hub = makePlaylistHub({ playlists: [a], pins: { pinnedPlaylists: ['A'], updatedAt: now() } })
    hub.remote({ playlists: [{ id: 'X', name: 'Remote', trackIds: [], modifiedAt: now() }], tombstones: [{ id: 'Z', name: 'Old', deletedAt: now() }] })
    const since = snapshotLocalGens()
    await convergePlaylistHub(d.deps(hub))
    assert.deepEqual(movedGens(since, PLAYLIST_HUB_COLLECTIONS).sort(), ['pins', 'playlistTombstones', 'playlists'])
    const quiet = snapshotLocalGens()
    await convergePlaylistHub(d.deps(hub))                                // identical answer: nothing to write, nothing moves
    assert.deepEqual(movedGens(quiet, PLAYLIST_HUB_COLLECTIONS), [])
  })
})

describe('hub-local-state — generations and locks', () => {
  test('a bump is seen only by the collections that were watched', () => {
    const since = snapshotLocalGens()
    bumpLocalGen('pins')
    assert.deepEqual(movedGens(since, PLAYLIST_HUB_COLLECTIONS), ['pins'])
    assert.deepEqual(movedGens(since, MIXTAPE_HUB_COLLECTIONS), [])
  })

  test('the lock is FIFO per key, independent across keys, and survives a failing holder', async () => {
    const order: string[] = []
    const a1 = withLocalLock('k', async () => { await sleep(15); order.push('a1') })
    const a2 = withLocalLock('k', async () => { order.push('a2'); throw new Error('boom') })
    const a3 = withLocalLock('k', async () => { order.push('a3') })
    const other = withLocalLock('other', async () => { order.push('other') })
    await other
    await a1
    await assert.rejects(a2, /boom/)
    await a3
    assert.deepEqual(order, ['other', 'a1', 'a2', 'a3'])
  })

  test('recordPlaylistSave takes the tombstone lock: three quick deletes lose no stone (their read-modify-writes used to race)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hubrace-rps-'))
    const file = join(dir, 'ts.json')
    await Promise.all([
      recordPlaylistSave([{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }], [{ id: 'b' }, { id: 'c' }], file, now),
      recordPlaylistSave([{ id: 'b', name: 'b' }, { id: 'c', name: 'c' }], [{ id: 'c' }], file, now),
      recordPlaylistSave([{ id: 'c', name: 'c' }], [], file, now),
    ])
    assert.deepEqual((await loadTombstones(file)).map((t) => t.id).sort(), ['a', 'b', 'c'])
  })

  test('lock keys: tombstone and pins locks are per file, a shelf is named by its tombstone file', () => {
    assert.notEqual(lockKeys.tombstones('/x/a.json'), lockKeys.tombstones('/x/b.json'))
    assert.notEqual(lockKeys.tombstones('/x/a.json'), lockKeys.pins('/x/a.json'))
    assert.equal(lockKeys.mixtapeStore('/x/t.json'), lockKeys.mixtapeStore('/x/t.json'))
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Seeded random interleavings. The oracle is the hub's own doctrine: per id the
// LAST write anywhere (this Mac or a remote device) wins, a delete is a write,
// and once everything is quiet this Mac and the hub must agree exactly.
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('randomised interleavings converge to the newest write per id (never the older reply)', () => {
  const SEEDS = Array.from({ length: 30 }, (_, i) => 1000 + i * 7919)

  for (const seed of SEEDS) {
    test(`playlists + pins, seed ${seed}`, async () => {
      const rand = rng(seed)
      const hubRand = rng(seed ^ 0x9e3779b9)
      const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
      const base: P[] = ['p0', 'p1', 'p2'].map((id) => ({ id, name: `${id} v0`, trackIds: [1], modifiedAt: now() }))
      const d = await makeDesktop(base)
      const hub = makePlaylistHub({ playlists: base })
      hub.afterMerge = async () => { await sleep(Math.floor(hubRand() * 3)) }   // random reply delay
      const truth = new Map<string, string | null>(base.map((p) => [p.id, p.name]))
      let truthPins: string[] | null = null
      let nextId = 3
      let inflight: Promise<unknown> | null = null
      const runConverge = () => {
        if (inflight) return
        inflight = convergePlaylistHub(d.deps(hub)).finally(() => { inflight = null })
      }

      for (let step = 0; step < 36; step++) {
        const roll = rand()
        const liveLocal = d.ids()
        const liveHub = hub.state().playlists.map((p) => p.id as string)
        if (roll < 0.18 && liveLocal.length) {
          const id = pick(liveLocal); const name = `${id} L${step}`
          await d.edit(id, { name }); truth.set(id, name)
        } else if (roll < 0.28) {
          const id = `p${nextId++}`; const name = `${id} L${step}`
          await d.add({ id, name, trackIds: [step] }); truth.set(id, name)
        } else if (roll < 0.42 && liveLocal.length > 1) {
          const id = pick(liveLocal)
          await d.remove(id); truth.set(id, null)
        } else if (roll < 0.54 && liveHub.length) {
          const id = pick(liveHub); const name = `${id} R${step}`
          hub.remote({ playlists: [{ ...hub.state().playlists.find((p) => p.id === id), name, modifiedAt: now() }] }); truth.set(id, name)
        } else if (roll < 0.62 && liveHub.length > 1) {
          const id = pick(liveHub)
          hub.remote({ tombstones: [{ id, name: id, deletedAt: now() }] }); truth.set(id, null)
        } else if (roll < 0.68) {
          const id = `p${nextId++}`; const name = `${id} R${step}`
          hub.remote({ playlists: [{ id, name, trackIds: [step], modifiedAt: now() }] }); truth.set(id, name)
        } else if (roll < 0.74) {
          const ids = [pick(['p0', 'p1', 'p2'])]; await d.pin(ids); truthPins = ids
        } else if (roll < 0.78) {
          const ids = [pick(['p0', 'p1', 'p2'])]; hub.remote({ pins: { pinnedPlaylists: ids, updatedAt: now() } }); truthPins = ids
        } else if (roll < 0.9) {
          runConverge()
        }
        await sleep(Math.floor(rand() * 3))
      }
      await inflight
      // Quiet: converge until nothing changes (bounded).
      for (let i = 0; i < 6; i++) {
        const r = await convergePlaylistHub(d.deps(hub))
        if (r.ok && !r.changed && !r.deferred) break
      }

      const local = names(d.peek())
      const hubNames = names(hub.state().playlists)
      assert.deepEqual(local, hubNames, `this Mac and the hub agree (seed ${seed})`)
      assert.deepEqual(await d.stoneIds(), hub.state().tombstones.map((t) => t.id).sort(), `same tombstones (seed ${seed})`)
      for (const [id, name] of truth) {
        if (name === null) assert.ok(!(id in local) && !(id in hubNames), `${id} was deleted last and must stay deleted (seed ${seed})`)
        else assert.equal(local[id], name, `${id}: the newest write wins (seed ${seed})`)
      }
      if (truthPins) {
        assert.deepEqual(await d.pinIds(), truthPins, `newest pins win locally (seed ${seed})`)
        assert.deepEqual(hub.state().pins?.pinnedPlaylists, truthPins, `and at the hub (seed ${seed})`)
      }
    })
  }

  for (const seed of SEEDS.slice(0, 15)) {
    test(`mixtapes, seed ${seed}`, async () => {
      const rand = rng(seed ^ 0x5bd1e995)
      const hubRand = rng(seed ^ 0x7f4a7c15)
      const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
      type Tape = { id: string; title: string; tracks: number[]; modifiedAt?: string }
      const dir = await mkdtemp(join(tmpdir(), 'hubrace-rt-'))
      const file = join(dir, 'mixtapes.json')
      const tombstonesFile = join(dir, 'mixtape-tombstones.json')
      const base: Tape[] = ['t0', 't1', 't2'].map((id) => ({ id, title: `${id} v0`, tracks: [1], modifiedAt: now() }))
      await writeFile(file, JSON.stringify(base))
      const io = {
        load: async () => JSON.parse(await readFile(file, 'utf-8')) as Tape[],
        save: async (all: Tape[]) => { await writeFile(file + '.tmp', JSON.stringify(all)); const { rename } = await import('node:fs/promises'); await rename(file + '.tmp', file) },
        tombstonesFile,
      }
      let hubState = { mixtapes: clone(base) as any[], tombstones: [] as Stone[] }
      const merge = (m: any[], t: Stone[]) => { const r = mergeCollection(hubState.mixtapes, hubState.tombstones, clone(m), t); hubState = { mixtapes: r.items, tombstones: r.tombstones } }
      const fetchFn = (async (url: string, init?: RequestInit) => {
        if (!url.endsWith('/converge')) return { ok: true, json: async () => ({ names: [] }) }
        const body = JSON.parse(String(init!.body))
        merge(body.mixtapes, body.tombstones)
        const reply = clone({ ok: true, mixtapes: hubState.mixtapes, tombstones: hubState.tombstones })
        await sleep(Math.floor(hubRand() * 3))
        return { ok: true, status: 200, json: async () => reply }
      }) as unknown as typeof fetch
      const deps = { hubUrl: 'http://hub', device: 'mb', getMixtapes: io.load as any, setMixtapes: io.save as any, tombstonesFile, introsDir: join(dir, 'i'), fetchFn, log: () => {} }
      const truth = new Map<string, string | null>(base.map((t) => [t.id, t.title]))
      let nextId = 3
      let inflight: Promise<unknown> | null = null
      const run = () => { if (!inflight) inflight = convergeMixtapeHub(deps).finally(() => { inflight = null }) }

      for (let step = 0; step < 30; step++) {
        const roll = rand()
        const liveLocal = (await io.load()).map((t) => t.id)
        const liveHub = hubState.mixtapes.map((t) => t.id as string)
        if (roll < 0.18 && liveLocal.length) {
          const id = pick(liveLocal); const title = `${id} L${step}`
          await upsertMixtape(io, { id, title, tracks: [step] } as Tape, now); truth.set(id, title)
        } else if (roll < 0.3) {
          const id = `t${nextId++}`; const title = `${id} L${step}`
          await upsertMixtape(io, { id, title, tracks: [step] } as Tape, now); truth.set(id, title)
        } else if (roll < 0.44 && liveLocal.length > 1) {
          const id = pick(liveLocal)
          await removeMixtape(io, id, now); truth.set(id, null)
        } else if (roll < 0.56 && liveHub.length) {
          const id = pick(liveHub); const title = `${id} R${step}`
          merge([{ ...hubState.mixtapes.find((t) => t.id === id), title, modifiedAt: now() }], []); truth.set(id, title)
        } else if (roll < 0.64 && liveHub.length > 1) {
          const id = pick(liveHub)
          merge([], [{ id, name: id, deletedAt: now() }]); truth.set(id, null)
        } else if (roll < 0.7) {
          const id = `t${nextId++}`; const title = `${id} R${step}`
          merge([{ id, title, tracks: [step], modifiedAt: now() }], []); truth.set(id, title)
        } else if (roll < 0.88) {
          run()
        }
        await sleep(Math.floor(rand() * 3))
      }
      await inflight
      for (let i = 0; i < 6; i++) {
        const r = await convergeMixtapeHub(deps)
        if (r.ok && !r.changed && !r.deferred) break
      }
      const local = Object.fromEntries((await io.load()).map((t) => [t.id, t.title]))
      const hubTitles = Object.fromEntries(hubState.mixtapes.map((t) => [t.id, t.title]))
      assert.deepEqual(local, hubTitles, `this Mac and the hub agree (seed ${seed})`)
      for (const [id, title] of truth) {
        if (title === null) assert.ok(!(id in local) && !(id in hubTitles), `${id} was deleted last and must stay deleted (seed ${seed})`)
        else assert.equal(local[id], title, `${id}: the newest write wins (seed ${seed})`)
      }
      assert.deepEqual((await loadTombstones(tombstonesFile)).map((t) => t.id).sort(), hubState.tombstones.map((t) => t.id).sort(), `same tombstones (seed ${seed})`)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// WRITER CENSUS — "bumped by EVERY local writer". These are source-shape locks:
// a NEW writer of the hub-synced state must either go through the guarded
// helpers or bump a generation, and the test below fails until it does.
describe('writer census — every local writer of hub-synced state is guarded', () => {
  const SRC = join(import.meta.dirname, '../..')
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf-8')
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== '_archive') out.push(...walk(p)) }
      else if (e.name.endsWith('.ts')) out.push(p)
    }
    return out
  }
  const mainFiles = walk(join(SRC, 'main'))
  const callers = (re: RegExp): string[] =>
    mainFiles.filter((f) => re.test(readFileSync(f, 'utf-8'))).map((f) => f.slice(SRC.length + 1)).sort()

  test('save-playlists goes through commitLocalPlaylistSave (stamp + store + bump + ledger)', () => {
    const lib = read('main/ipc/library-ipc.ts')
    assert.match(lib, /await commitLocalPlaylistSave\(/)
    assert.equal((lib.match(/host\.setPlaylists\(/g) || []).length, 1, 'the only setPlaylists call is the one handed to commitLocalPlaylistSave')
    assert.doesNotMatch(lib, /recordPlaylistSave\(/, 'the ledger is written by commitLocalPlaylistSave, not inline')
  })

  test('the phone-playlist apply bumps the playlists generation next to its own setPlaylists', () => {
    const src = read('main/phone-playlist-sync.ts')
    assert.equal((src.match(/deps\.setPlaylists\(/g) || []).length, 1)
    assert.match(src, /deps\.setPlaylists\(stamped\)[\s\S]{0,400}bumpLocalGen\('playlists'\)/)
  })

  test('playlists.json has exactly the three cache writers we know (save, phone apply, hub adoption)', () => {
    const idx = read('main/index.ts')
    assert.equal((idx.match(/playlistsCache\.set\(/g) || []).length, 3,
      'a new playlistsCache.set( is a new local writer: bump the playlists generation (hub-local-state.ts) in it, then update this count')
    assert.equal((idx.match(/playlistsCache\.update\(/g) || []).length, 0)
  })

  test('save-playlist-pins writes through saveLocalPins; only the pins module and the hub client call savePins', () => {
    assert.match(read('main/ipc/ui-state-ipc.ts'), /await saveLocalPins\(/)
    assert.deepEqual(callers(/\bsavePins\(/), ['main/playlist-hub-sync.ts', 'main/playlist-pins.ts'])
  })

  test('tombstone files are written only by the ledger, the tape writers and the two hub clients', () => {
    assert.deepEqual(callers(/\bsaveTombstones\(/), [
      'main/mixtape-hub-sync.ts', 'main/mixtape-store-writes.ts', 'main/playlist-hub-sync.ts', 'main/playlist-tombstones.ts',
    ])
  })

  test('mixtapes.json is written only by the hub adoption, the monthly tape and the guarded writers', () => {
    const src = read('main/mixtapes.ts')
    // definition + writeMixtapesFromHub + the season tape inside mutateMixtapeStore
    assert.equal((src.match(/\bsaveMixtapes\(/g) || []).length, 3,
      'a new saveMixtapes( call is a new tape writer: run it through mutateMixtapeStore / upsertMixtape / removeMixtape (mixtape-store-writes.ts)')
    assert.match(src, /mutateMixtapeStore\(MIXTAPE_TOMBSTONES_FILE\(\)[\s\S]{0,400}saveMixtapes\(cur\)/)
    assert.match(src, /await upsertMixtape\(/)
    assert.match(src, /await removeMixtape\(/)
    assert.doesNotMatch(src, /loadTombstones|saveTombstones/, 'tape tombstones are written only inside mixtape-store-writes.ts')
  })

  test('both hub clients check the generations under the writers\' locks', () => {
    const pl = read('main/playlist-hub-sync.ts')
    assert.match(pl, /movedGens\(since, PLAYLIST_HUB_COLLECTIONS\)/)
    assert.match(pl, /withLocalLock\(lockKeys\.tombstones\(deps\.tombstonesFile\)/)
    assert.match(pl, /withLocalLock\(lockKeys\.pins\(deps\.pinsFile\)/)
    const tp = read('main/mixtape-hub-sync.ts')
    assert.match(tp, /movedGens\(since, MIXTAPE_HUB_COLLECTIONS\)/)
    assert.match(tp, /withLocalLock\(lockKeys\.mixtapeStore\(deps\.tombstonesFile\)/)
  })

  test('the stores a converge reads are exactly the ones whose generations it checks', () => {
    assert.deepEqual([...PLAYLIST_HUB_COLLECTIONS].sort(), ['pins', 'playlistTombstones', 'playlists'])
    assert.deepEqual([...MIXTAPE_HUB_COLLECTIONS].sort(), ['mixtapeTombstones', 'mixtapes'])
  })
})
