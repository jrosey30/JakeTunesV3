/**
 * The playlists on one iPod, on the desktop (2026-11-14): the order, the
 * defaults as the sync writes them (and homemini's twin of them), and the
 * outbox that carries Jake's own playlists to homemini.
 *
 * Jake: "default playlists on top, on the go, then the per ipod playlists in a
 * to z order"; "i also have the ability to create my own per ipod playlist".
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ipodDefaultPlaylists } from '../../renderer/utils/ipodDeviceDefaults.ts'
import { compareNames } from '../../renderer/utils/artistSort.ts'
import type { Track } from '../../renderer/types.ts'
import {
  checkPlaylistName, foldIpodPlaylists, notOnIpodQuestion, orderIpodPlaylists, emptyPending,
  type StoredIpodPlaylist,
} from '../../common/ipod-playlists-view.ts'
import {
  createIpodPlaylistsDesk, createIpodPlaylistsRemote, PENDING_FILE,
  type AddAnswer, type IpodPlaylistsRemote, type SaveAnswer,
} from '../ipod-playlists-outbox.ts'
import { verifiedBpmFor } from '../ipc/ipod-playlists-ipc.ts'
import { compareIpodArtistNames } from '../ipod-artist-sort.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const FIXTURE = 'src/main/__tests__/fixtures/ipod-default-playlists.fixture.json'
const sha = (path: string): string => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')
const tmp = (): string => mkdtempSync(join(tmpdir(), 'jt-ipod-pl-'))

// ── the defaults, and homemini's twin of them ─────────────────────────────

describe('the defaults, as the sync writes them', () => {
  const fx = JSON.parse(readFileSync(join(ROOT, FIXTURE), 'utf-8')) as {
    setName: string; ipodIds: number[]; verifiedBpm: Record<string, number>; library: Track[]
    expected: Array<{ id: string; name: string; kind: string; trackIds: number[] }>
    expectedAsOriginal: Array<{ id: string; name: string; kind: string; trackIds: number[] }>
  }

  test('the fixture is the file JakeTunesMobile keeps, and the rule is the file homemini runs', () => {
    // Change either here, copy it to JakeTunesMobile (backend/src/util/__tests__/fixtures/ and
    // backend/src/util/ipodDevicePlaylists.ts) and move the pins in BOTH repos' tests.
    assert.equal(sha(FIXTURE), '3a1ddfaf4343d3c8ba09edcd754e3bed12829b61dd31f26743dd14e5ef2e10cf')
    assert.equal(sha('src/common/ipod-device-playlists.ts'), '6b1d7af5fc9f114cc0616d2dbfb48d22e6aeda738cc85f41d74a9426ddbe29ae')
    assert.match(readFileSync(join(ROOT, 'src/common/ipod-device-playlists.ts'), 'utf-8'), /⚠️ TWIN: one file, byte for byte, in two repos/)
  })

  test('the desktop’s code writes exactly the fixture’s playlists (homemini’s test expects the same)', () => {
    const bpm = new Map(Object.entries(fx.verifiedBpm).map(([k, v]) => [Number(k), v]))
    const got = ipodDefaultPlaylists({ library: fx.library, ipodIds: fx.ipodIds, setName: fx.setName, original: false, verifiedBpm: bpm })
    assert.deepEqual(got, fx.expected)
    // Jake: a punkPod playlist on punkPod "doesn't make any sense". Only the Original's Top 1000 is an own list.
    assert.ok(!got.some((p) => p.kind === 'set' || p.name === 'punkPod'))
    assert.deepEqual(got.map((p) => p.name).slice(0, 4), ['Top 25 Most Played', 'Starred', 'Recently Added', 'Recently Played'])
    const original = ipodDefaultPlaylists({ library: fx.library, ipodIds: fx.ipodIds, setName: 'Top 1000', original: true, verifiedBpm: bpm })
    assert.deepEqual(original, fx.expectedAsOriginal)
    assert.equal(original[0].name, 'Top 1000')
    assert.deepEqual(original[0].trackIds, fx.ipodIds.filter((id) => fx.library.some((t) => t.id === id)), 'the Top 1000 in rank order')
    // The 2010s have 8 songs on it: under the 10 a decade needs. A song not on the iPod is in nothing.
    assert.ok(!got.some((p) => p.name === "2010's Music"))
    assert.ok(got.every((p) => !p.trackIds.includes(999_999) && !p.trackIds.includes(888_888)))
  })

  test('an iPod with no songs in this library has no defaults', () => {
    assert.deepEqual(ipodDefaultPlaylists({ library: fx.library, ipodIds: [1, 2, 3], setName: 'X', original: false, verifiedBpm: new Map() }), [])
  })

  test('the sidebar and the page use the sync’s own code, not a copy', () => {
    const src = readFileSync(join(ROOT, 'src/renderer/utils/ipodDeviceDefaults.ts'), 'utf-8')
    assert.match(src, /assembleSyncPlaylists\(tracks, \[\], input\.setName\)/)
    assert.match(src, /original: input\.original/)
    assert.match(src, /⚠️ TWIN: JakeTunesMobile backend\/src\/util\/ipodDefaultPlaylists\.ts/)
  })
})

// ── the order ─────────────────────────────────────────────────────────────

const row = (id: string, name: string, source: StoredIpodPlaylist['source'] = 'jake', createdAt = '2026-11-01T00:00:00.000Z'): StoredIpodPlaylist =>
  ({ id, device: 'punk', name, source, trackIds: [], createdAt })

describe('the order: On-The-Go, then the rest A to Z by the one name sort', () => {
  test('On-The-Go by when it was made; the rest ignore The / A / An and punctuation, "2" before "10"', () => {
    const got = orderIpodPlaylists([
      row('a', 'The Zoo'), row('b', 'Gym 10'), row('c', 'On-The-Go 2 — punkPod', 'on-the-go', '2026-11-05T00:00:00.000Z'),
      row('d', '"Rides"'), row('e', 'Gym 2'), row('f', 'On-The-Go 1 — punkPod', 'on-the-go', '2026-11-02T00:00:00.000Z'),
      row('g', 'A Brain List', 'brain'), row('h', 'an apple'),
    ], compareNames)
    assert.deepEqual(got.map((p) => p.name), ['On-The-Go 1 — punkPod', 'On-The-Go 2 — punkPod', 'an apple', 'A Brain List', 'Gym 2', 'Gym 10', '"Rides"', 'The Zoo'])
  })

  test('main’s name sort and the renderer’s agree, so the two never order a list differently', () => {
    const names = ['The Zoo', 'Gym 10', '"Rides"', 'Gym 2', 'an apple', 'Éclair', 'eclair 2', '10 Songs', '2 Songs']
    assert.deepEqual([...names].sort(compareNames), [...names].sort((a, b) => compareIpodArtistNames(a, b)))
  })

  test('a waiting rename moves to its new place at once; a waiting delete is gone; a waiting new one is in its place', () => {
    const pending = emptyPending()
    pending.saves['punk/b'] = { device: 'punk', id: 'b', rev: 1, op: 'save', name: 'Aardvark', trackIds: [5], createdAt: '', isNew: false }
    pending.saves['punk/a'] = { device: 'punk', id: 'a', rev: 1, op: 'delete', name: 'The Zoo', trackIds: [], createdAt: '', isNew: false }
    pending.saves['punk/new'] = { device: 'punk', id: 'new', rev: 1, op: 'save', name: 'Middle', trackIds: [], createdAt: '2026-11-14T00:00:00.000Z', isNew: true }
    pending.saves['other/x'] = { device: 'other', id: 'x', rev: 1, op: 'save', name: 'Elsewhere', trackIds: [], createdAt: '', isNew: true }
    const got = foldIpodPlaylists('punk', [row('a', 'The Zoo'), row('b', 'Gym'), row('e', 'Rides')], pending, compareNames)
    assert.deepEqual(got.map((p) => `${p.name}${p.waiting ? '*' : ''}`), ['Aardvark*', 'Middle*', 'Rides'])
    assert.deepEqual(foldIpodPlaylists('punk', [row('a', 'The Zoo'), row('b', 'Gym'), row('e', 'Rides')], pending, compareNames), got)
  })
})

describe('names and questions', () => {
  test('a name can’t be a default’s or another playlist’s on the same iPod, whatever the case', () => {
    assert.deepEqual(checkPlaylistName('  Gym   Mix ', 'punkPod', { defaults: ['Starred'], others: [] }), { ok: true, name: 'Gym Mix' })
    assert.equal(checkPlaylistName('starred', 'punkPod', { defaults: ['Starred'], others: [] }).ok, false)
    assert.deepEqual(checkPlaylistName('GYM', 'punkPod', { defaults: [], others: ['Gym'] }), { ok: false, error: 'punkPod already has a playlist called “GYM”.' })
    assert.equal(checkPlaylistName('', 'punkPod', { defaults: [], others: [] }).ok, false)
    assert.equal(checkPlaylistName('x'.repeat(61), 'punkPod', { defaults: [], others: [] }).ok, false)
  })

  test('the question, and the Original never taking a song by hand', () => {
    assert.deepEqual(notOnIpodQuestion('punk', 'punkPod', ['Holiday']), { canAdd: true, message: '“Holiday” isn’t on punkPod. Add it to punkPod too?' })
    assert.equal(notOnIpodQuestion('top1000', 'The Original', ['Holiday']).canAdd, false)
    assert.match(notOnIpodQuestion('top1000', 'The Original', ['Holiday']).message, /The Original carries the Top 1000 only/)
  })
})

// ── the outbox, against a homemini that keeps the real rules ──────────────

interface FakeHomemini extends IpodPlaylistsRemote {
  store: Map<string, StoredIpodPlaylist>
  lists: Map<string, { ids: Set<number>; cap: number }>
  away: boolean
  /** Apply the next write but lose the reply (homemini has it; the Mac doesn't know). */
  loseNextReply: boolean
  calls: string[]
  latency: () => Promise<void>
}

function fakeHomemini(lists: Record<string, { ids: number[]; cap?: number }>): FakeHomemini {
  const h: FakeHomemini = {
    store: new Map(),
    lists: new Map(Object.entries(lists).map(([k, v]) => [k, { ids: new Set(v.ids), cap: v.cap ?? 5000 }])),
    away: false,
    loseNextReply: false,
    calls: [],
    latency: async () => {},
    async list(device) {
      await h.latency()
      if (h.away) return null
      return orderIpodPlaylists([...h.store.values()].filter((p) => p.device === device).map((p) => ({ ...p, trackIds: [...p.trackIds] })), compareNames)
    },
    async put(device, id, body) {
      h.calls.push(`PUT ${device}/${id}`)
      await h.latency()
      if (h.away) return { kind: 'retry' }
      const key = `${device}/${id}`
      const others = [...h.store.values()].filter((p) => p.device === device && p.id !== id)
      if (others.some((p) => p.name.toLowerCase() === body.name.toLowerCase())) return { kind: 'name-taken', name: body.name }
      const on = h.lists.get(device)?.ids ?? new Set()
      const notOn = body.trackIds.filter((t) => !on.has(t))
      if (notOn.length) return { kind: 'not-on-ipod', trackIds: notOn }
      const p: StoredIpodPlaylist = { id, device, name: body.name, source: 'jake', trackIds: [...body.trackIds], createdAt: h.store.get(key)?.createdAt ?? body.createdAt }
      h.store.set(key, p)
      return h.lose() ?? { kind: 'done', playlist: { ...p } }
    },
    async patch(device, id, body) {
      h.calls.push(`PATCH ${device}/${id}`)
      await h.latency()
      if (h.away) return { kind: 'retry' }
      const key = `${device}/${id}`
      const had = h.store.get(key)
      if (!had) return { kind: 'missing' }
      if ([...h.store.values()].some((p) => p.device === device && p.id !== id && p.name.toLowerCase() === body.name.toLowerCase())) return { kind: 'name-taken', name: body.name }
      const on = h.lists.get(device)?.ids ?? new Set()
      const notOn = body.trackIds.filter((t) => !had.trackIds.includes(t) && !on.has(t))
      if (notOn.length) return { kind: 'not-on-ipod', trackIds: notOn }
      const p = { ...had, name: body.name, trackIds: [...body.trackIds] }
      h.store.set(key, p)
      return h.lose() ?? { kind: 'done', playlist: { ...p } }
    },
    async remove(device, id) {
      h.calls.push(`DELETE ${device}/${id}`)
      await h.latency()
      if (h.away) return { kind: 'retry' }
      h.store.delete(`${device}/${id}`)
      return h.lose() ?? { kind: 'done', playlist: null }
    },
    async addToIpod(device, trackIds): Promise<AddAnswer> {
      h.calls.push(`ADD ${device} ${trackIds.join(',')}`)
      await h.latency()
      if (h.away) return { kind: 'retry' }
      const list = h.lists.get(device)
      if (!list) return { kind: 'refused', error: 'no list for this iPod' }
      const skipped: Array<{ id: number; reason: string }> = []
      for (const t of trackIds) {
        if (list.ids.has(t)) continue
        if (list.ids.size >= list.cap) { skipped.push({ id: t, reason: 'full' }); continue }
        list.ids.add(t)
      }
      return { kind: 'done', skipped, cap: list.cap }
    },
  } as FakeHomemini & { lose: () => SaveAnswer | null }
  ;(h as unknown as { lose: () => SaveAnswer | null }).lose = () => {
    if (!h.loseNextReply) return null
    h.loseNextReply = false
    return { kind: 'retry' }
  }
  return h
}

const deskFor = (stateDir: string, remote: IpodPlaylistsRemote, ids: string[] = []) => {
  let n = 0
  return createIpodPlaylistsDesk({
    stateDir, remote, compareNames: (a, b) => compareIpodArtistNames(a, b),
    titleOf: (id) => `Song ${id}`,
    newId: () => ids[n++] ?? `gen-${n}`,
    warn: () => {},
  })
}

const fresh = async (desk: ReturnType<typeof deskFor>, device: string) => {
  const v = await desk.view(device, { fresh: true, ipodName: 'punkPod' })
  assert.ok(v.ok)
  return v
}

describe('Jake’s own playlists reach homemini, whatever the signal', () => {
  test('made with homemini away: on disk and shown at once, sent when it answers', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1, 2, 3] } })
    h.away = true
    const desk = deskFor(dir, h, ['p1'])
    const w = await desk.save({ device: 'punk', name: 'Gym', trackIds: [2, 1], defaults: ['Starred'], ipodName: 'punkPod' })
    assert.ok(w.ok)
    assert.equal(w.id, 'mac-p1')
    assert.deepEqual(w.view.playlists.map((p) => [p.name, p.waiting, p.trackIds]), [['Gym', true, [2, 1]]])
    assert.ok(JSON.parse(readFileSync(join(dir, PENDING_FILE), 'utf-8')).saves['punk/mac-p1'])
    const still = await fresh(desk, 'punk')
    assert.equal(still.playlists[0].waiting, true)
    h.away = false
    const v = await fresh(desk, 'punk')
    assert.equal(v.from, 'homemini')
    assert.deepEqual(v.playlists.map((p) => [p.name, p.waiting, p.trackIds]), [['Gym', false, [2, 1]]])
    assert.deepEqual(JSON.parse(readFileSync(join(dir, PENDING_FILE), 'utf-8')).saves, {})
    // A second Mac (or the phone) sees it under the same id.
    assert.deepEqual([...h.store.keys()], ['punk/mac-p1'])
  })

  test('a create sent twice (the reply lost) is one playlist: the id is this Mac’s', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1, 2] } })
    h.loseNextReply = true
    const desk = deskFor(dir, h, ['twice'])
    assert.ok((await desk.save({ device: 'punk', name: 'Gym', trackIds: [1], defaults: [], ipodName: 'punkPod' })).ok)
    await desk.flushDevice('punk')   // homemini made it; the reply never came
    assert.equal(h.store.size, 1)
    await fresh(desk, 'punk')         // sent again
    assert.deepEqual(h.calls.filter((c) => c.startsWith('PUT')), ['PUT punk/mac-twice', 'PUT punk/mac-twice'])
    assert.equal(h.store.size, 1)
  })

  test('rename, reorder, remove a song, delete: each lands as the whole playlist, newest wins', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1, 2, 3, 4] } })
    const desk = deskFor(dir, h, ['a'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1, 2, 3], defaults: [], ipodName: 'punkPod' })
    await fresh(desk, 'punk')
    h.away = true
    await desk.save({ device: 'punk', id: 'mac-a', name: 'Rides', defaults: [], ipodName: 'punkPod' })
    await desk.save({ device: 'punk', id: 'mac-a', trackIds: [3, 1], defaults: [], ipodName: 'punkPod' })
    h.away = false
    await fresh(desk, 'punk')
    assert.deepEqual(h.store.get('punk/mac-a')?.name, 'Rides')
    assert.deepEqual(h.store.get('punk/mac-a')?.trackIds, [3, 1])
    assert.ok(h.calls.includes('PATCH punk/mac-a'))
    assert.ok((await desk.remove({ device: 'punk', id: 'mac-a' })).ok)
    const v = await fresh(desk, 'punk')
    assert.equal(h.store.size, 0)
    assert.deepEqual(v.playlists, [])
  })

  test('a playlist deleted while homemini is away is deleted there too when it answers', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1] } })
    h.away = true
    const desk = deskFor(dir, h, ['gone'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1], defaults: [], ipodName: 'punkPod' })
    await desk.remove({ device: 'punk', id: 'mac-gone' })
    h.away = false
    const v = await fresh(desk, 'punk')
    assert.equal(h.store.size, 0)
    assert.deepEqual(v.playlists, [])
    assert.deepEqual(h.calls, ['DELETE punk/mac-gone'], 'a delete of something homemini never had is answered existed:false, and is fine')
  })

  test('create, the reply lost, then delete: homemini ends with no playlist (review of PR 423)', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1] } })
    const desk = deskFor(dir, h, ['p'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1], defaults: [], ipodName: 'punkPod' })
    h.loseNextReply = true
    await desk.flushDevice('punk')            // homemini made it; this Mac never heard
    assert.equal(h.store.size, 1)
    await desk.remove({ device: 'punk', id: 'mac-p' })
    const v = await fresh(desk, 'punk')
    assert.equal(h.store.size, 0, 'the create that landed is deleted')
    assert.deepEqual(v.playlists, [])
    assert.deepEqual(JSON.parse(readFileSync(join(dir, PENDING_FILE), 'utf-8')).saves, {})
  })

  test('deleted while its create is on its way: it never comes back, here or on homemini (review of PR 423)', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1] } })
    const desk = deskFor(dir, h, ['p'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1], defaults: [], ipodName: 'punkPod' })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    h.latency = () => gate
    const sending = desk.flushDevice('punk')
    await new Promise((r) => setTimeout(r, 10))
    const r = await desk.remove({ device: 'punk', id: 'mac-p' })
    assert.ok(r.ok)
    assert.deepEqual(r.view.playlists, [], 'gone from the screen at once')
    release()
    h.latency = async () => {}
    await sending
    const local = await desk.view('punk')
    assert.ok(local.ok)
    assert.deepEqual(local.playlists, [], 'the create’s answer did not put it back')
    const v = await fresh(desk, 'punk')
    assert.deepEqual(v.playlists, [])
    assert.equal(h.store.size, 0)
    assert.deepEqual(h.calls, ['PUT punk/mac-p', 'DELETE punk/mac-p'])
  })

  test('a name the defaults or another playlist has is refused before anything is written', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1] } })
    const desk = deskFor(dir, h, ['a', 'b'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [], defaults: [], ipodName: 'punkPod' })
    assert.deepEqual(await desk.save({ device: 'punk', name: 'gym', trackIds: [], defaults: [], ipodName: 'punkPod' }), { ok: false, error: 'punkPod already has a playlist called “gym”.' })
    assert.equal((await desk.save({ device: 'punk', name: 'Recently Added', trackIds: [], defaults: ['Recently Added'], ipodName: 'punkPod' })).ok, false)
  })

  test('defaults and On-The-Go can’t be changed or deleted here', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1] } })
    h.store.set('punk/otg-1', { id: 'otg-1', device: 'punk', name: 'On-The-Go 1', source: 'on-the-go', trackIds: [1], createdAt: '2026-11-01T00:00:00.000Z' })
    const desk = deskFor(dir, h)
    await fresh(desk, 'punk')
    assert.equal((await desk.save({ device: 'punk', id: 'otg-1', name: 'Mine now', defaults: [], ipodName: 'punkPod' })).ok, false)
    assert.equal((await desk.remove({ device: 'punk', id: 'otg-1' })).ok, false)
  })
})

describe('a song the iPod doesn’t hold: asked, never added silently', () => {
  test('homemini’s 409 holds the playlist as Jake made it, and asks; "Add to punkPod" puts it on the list first', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1, 2] } })
    const desk = deskFor(dir, h, ['p', 'op1'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1, 9], defaults: [], ipodName: 'punkPod' })
    let v = await fresh(desk, 'punk')
    assert.deepEqual(v.playlists[0].hold, { kind: 'not-on-ipod', trackIds: [9] })
    assert.deepEqual(v.playlists[0].trackIds, [1, 9])
    assert.equal(h.store.size, 0)
    // Held: the retry doesn't hammer homemini with it.
    const before = h.calls.length
    await desk.flushAll()
    assert.equal(h.calls.length, before)
    assert.ok((await desk.answer({ device: 'punk', id: 'mac-p', choice: 'add' })).ok)
    v = await fresh(desk, 'punk')
    assert.ok(h.lists.get('punk')?.ids.has(9))
    assert.deepEqual(h.store.get('punk/mac-p')?.trackIds, [1, 9])
    assert.equal(v.playlists[0].hold, null)
    const addAt = h.calls.findIndex((c) => c === 'ADD punk 9')
    assert.ok(addAt >= 0 && addAt < h.calls.lastIndexOf('PUT punk/mac-p'), 'the iPod gets the song before the playlist is sent again')
  })

  test('"Take it out" sends the playlist without it', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1] } })
    const desk = deskFor(dir, h, ['p'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1, 9], defaults: [], ipodName: 'punkPod' })
    await fresh(desk, 'punk')
    await desk.answer({ device: 'punk', id: 'mac-p', choice: 'drop' })
    await fresh(desk, 'punk')
    assert.deepEqual(h.store.get('punk/mac-p')?.trackIds, [1])
    assert.equal(h.lists.get('punk')?.ids.has(9), false)
  })

  test('a yes asked up front goes before the playlist; a full iPod takes the song back out and says so', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1, 2], cap: 3 } })
    const desk = deskFor(dir, h, ['p', 'op'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1, 7, 8], defaults: [], ipodName: 'punkPod', alsoOnIpod: [7, 8] })
    const v = await fresh(desk, 'punk')
    assert.equal(h.calls[0], 'ADD punk 7,8')
    assert.deepEqual(h.store.get('punk/mac-p')?.trackIds, [1, 7])
    // Landed: the line went with the waiting entry (homemini has what it could take).
    assert.deepEqual(v.playlists[0].trackIds, [1, 7])
  })

  test('the line about a full iPod is shown while the playlist waits', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1, 2], cap: 2 } })
    const desk = deskFor(dir, h, ['p', 'op'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1, 8], defaults: [], ipodName: 'punkPod', alsoOnIpod: [8] })
    // The add lands; the playlist's own send is cut off (homemini goes away between the two).
    const add = h.addToIpod.bind(h)
    h.addToIpod = async (d, t, w) => { const a = await add(d, t, w); h.away = true; return a }
    await desk.flushDevice('punk')
    const v = await desk.view('punk')
    assert.ok(v.ok)
    assert.deepEqual(v.playlists[0].trackIds, [1])
    assert.deepEqual(v.playlists[0].notices, ['punkPod is full (2 songs), so “Song 8” couldn’t go on it.'])
  })

  test('the Original never takes a song by hand', async () => {
    const desk = deskFor(tmp(), fakeHomemini({}), ['p'])
    assert.deepEqual(await desk.save({ device: 'top1000', name: 'Gym', trackIds: [1], defaults: [], ipodName: 'The Original', alsoOnIpod: [1] }), { ok: false, error: 'The Original carries the Top 1000 only.' })
  })

  test('a name homemini says is taken holds the playlist until it is renamed', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1] } })
    h.store.set('punk/phone-1', { id: 'phone-1', device: 'punk', name: 'Gym', source: 'jake', trackIds: [], createdAt: '2026-11-01T00:00:00.000Z' })
    const desk = deskFor(dir, h, ['p'])
    // This Mac hasn't heard of the phone's "Gym" yet.
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1], defaults: [], ipodName: 'punkPod' })
    await desk.flushDevice('punk')
    let v = await desk.view('punk')
    assert.ok(v.ok)
    assert.deepEqual(v.playlists.find((p) => p.id === 'mac-p')?.hold, { kind: 'name-taken', name: 'Gym' })
    await desk.answer({ device: 'punk', id: 'mac-p', choice: 'rename', name: 'Gym 2', ipodName: 'punkPod', defaults: [] })
    v = await fresh(desk, 'punk')
    assert.equal(h.store.get('punk/mac-p')?.name, 'Gym 2')
  })
})

describe('under overlap (the #415 / #419 review’s shape)', () => {
  test('a late reply never clears a newer edit', async () => {
    const dir = tmp()
    const h = fakeHomemini({ punk: { ids: [1, 2, 3] } })
    const desk = deskFor(dir, h, ['p'])
    await desk.save({ device: 'punk', name: 'Gym', trackIds: [1], defaults: [], ipodName: 'punkPod' })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    h.latency = () => gate
    const sending = desk.flushDevice('punk')
    await new Promise((r) => setTimeout(r, 10))
    // Jake adds a song while the first send is on its way.
    await desk.save({ device: 'punk', id: 'mac-p', trackIds: [1, 2], defaults: [], ipodName: 'punkPod' })
    release()
    h.latency = async () => {}
    await sending
    await fresh(desk, 'punk')
    assert.deepEqual(h.store.get('punk/mac-p')?.trackIds, [1, 2])
  })

  test('200 runs: two iPods, two playlists each, saved at once beside flushes and reads', async () => {
    let torn = 0
    let threw = 0
    let wrong = 0
    for (let run = 0; run < 200; run++) {
      const dir = tmp()
      const h = fakeHomemini({ a: { ids: [1, 2, 3, 4, 5, 6] }, b: { ids: [1, 2, 3, 4, 5, 6] } })
      let seed = run + 1
      const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
      h.latency = () => new Promise((r) => setTimeout(r, Math.floor(rnd() * 3)))
      h.away = rnd() < 0.3
      const desk = deskFor(dir, h, ['a1', 'a2', 'b1', 'b2'])
      const made: Array<[string, string]> = [['a', 'mac-a1'], ['a', 'mac-a2'], ['b', 'mac-b1'], ['b', 'mac-b2']]
      try {
        for (const [d, id] of made) {
          const w = await desk.save({ device: d, name: `List ${id}`, trackIds: [1], defaults: [], ipodName: d })
          assert.ok(w.ok && w.id === id)
        }
        // Each playlist's edits one after another (one window, one hand), the four playlists
        // and the flushes and reads all at once. The last edit of each is what must land.
        const want = new Map<string, number[]>()
        const chains = made.map(async ([d, id]) => {
          for (let i = 0; i < 6; i++) {
            const ids = [1, 2, 3, 4, 5, 6].filter(() => rnd() < 0.5)
            want.set(`${d}/${id}`, ids)
            const w = await desk.save({ device: d, id, trackIds: ids, defaults: [], ipodName: d })
            if (!w.ok) throw new Error(w.error)
            if (i === 3) h.away = false
          }
        })
        const others: Array<Promise<unknown>> = []
        for (let i = 0; i < 6; i++) others.push(desk.flushDevice(rnd() < 0.5 ? 'a' : 'b'), desk.flushAll(), desk.view(rnd() < 0.5 ? 'a' : 'b', { fresh: true }))
        await Promise.all([...chains, ...others])
        try { JSON.parse(readFileSync(join(dir, PENDING_FILE), 'utf-8')) } catch { torn++ }
        // What Jake sees now is his last edit of each.
        for (const d of ['a', 'b']) {
          const v = await desk.view(d)
          assert.ok(v.ok)
          for (const p of v.playlists) if (JSON.stringify(p.trackIds) !== JSON.stringify(want.get(`${d}/${p.id}`))) wrong++
        }
        h.away = false
        await desk.flushAll()
        await desk.flushAll()
        for (const [k, ids] of want) if (JSON.stringify(h.store.get(k)?.trackIds) !== JSON.stringify(ids)) wrong++
        const left = JSON.parse(readFileSync(join(dir, PENDING_FILE), 'utf-8'))
        if (Object.keys(left.saves).length) wrong++
      } catch (err) {
        threw++
        if (threw === 1) console.error(err)
      }
    }
    assert.deepEqual({ torn, threw, wrong }, { torn: 0, threw: 0, wrong: 0 })
  })
})

describe('homemini’s answers, read', () => {
  const answer = (status: number, body: unknown) => async () => ({ status, json: async () => body })
  test('the statuses mean what the route says', async () => {
    const r = (status: number, body: unknown) => createIpodPlaylistsRemote({ baseUrl: 'http://x', fetchImpl: answer(status, body) as never, warn: () => {} })
    assert.equal((await r(200, { ok: true, playlist: { id: 'p', device: 'punk', name: 'Gym', source: 'jake', trackIds: [1], createdAt: 'x' } }).put('punk', 'p', { name: 'Gym', trackIds: [1], createdAt: 'x' })).kind, 'done')
    assert.deepEqual(await r(409, { ok: false, error: 'not-on-ipod', notOnIpod: [9] }).patch('punk', 'p', { name: 'Gym', trackIds: [9] }), { kind: 'not-on-ipod', trackIds: [9] })
    assert.deepEqual(await r(409, { ok: false, error: 'name-taken', name: 'Gym' }).patch('punk', 'p', { name: 'Gym', trackIds: [] }), { kind: 'name-taken', name: 'Gym' })
    assert.equal((await r(404, { ok: false, error: 'no such playlist' }).patch('punk', 'p', { name: 'Gym', trackIds: [] })).kind, 'missing')
    // A proxy's page, a 5xx, a refused token: not homemini's answer, so it waits.
    assert.equal((await r(404, null).patch('punk', 'p', { name: 'Gym', trackIds: [] })).kind, 'retry')
    assert.equal((await r(503, { ok: false }).put('punk', 'p', { name: 'Gym', trackIds: [], createdAt: 'x' })).kind, 'retry')
    assert.equal((await r(401, { error: 'no' }).remove('punk', 'p')).kind, 'retry')
    assert.deepEqual(await r(200, { list: { cap: 5000 }, added: [], skipped: [{ id: 3, reason: 'full' }] }).addToIpod('punk', [3], 'why'), { kind: 'done', skipped: [{ id: 3, reason: 'full' }], cap: 5000 })
  })

  test('a "yes" is added to the iPod’s list by the existing route, with why', async () => {
    const seen: Array<{ url: string; body: unknown }> = []
    const r = createIpodPlaylistsRemote({ baseUrl: 'http://x/', fetchImpl: (async (url: string, init: { body?: string }) => { seen.push({ url, body: JSON.parse(init.body ?? 'null') }); return { status: 200, json: async () => ({ list: {}, skipped: [] }) } }) as never, warn: () => {} })
    await r.addToIpod('punk', [3], 'Jake said yes')
    assert.deepEqual(seen, [{ url: 'http://x/api/ipod-lists/punk/add', body: { ids: [3], by: 'claude', why: 'Jake said yes' } }])
  })

  test('verified BPMs: homemini’s answer is kept; when it is away the kept copy answers', async () => {
    const dir = tmp()
    const up = (async () => ({ status: 200, json: async () => ({ tracks: { 1: { bpm: 120, bpmStatus: 'verified' }, 2: { bpm: 90, bpmStatus: 'unverified' } } }) })) as never
    assert.deepEqual(await verifiedBpmFor({ stateDir: dir, baseUrl: 'http://x', fetchImpl: up }, [1, 2]), { ok: true, bpm: { 1: 120 }, known: true })
    const down = (async () => { throw new Error('away') }) as never
    assert.deepEqual(await verifiedBpmFor({ stateDir: dir, baseUrl: 'http://x', fetchImpl: down, warn: () => {} }, [1, 2]), { ok: true, bpm: { 1: 120 }, known: true })
    writeFileSync(join(dir, 'unrelated'), '')
  })
})
