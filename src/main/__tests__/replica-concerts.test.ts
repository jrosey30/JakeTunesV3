/**
 * Replica concert mirror (2026-10-19) — "the workmini should mimic the live
 * concert thing exactly. how they are on the macbook". Measured on workmini
 * the same day: all 12 sets in live-sets.json, 0 shown (rows missing — fixed in
 * hub-catalog), no concert-crowd/ dir at all, and Postal Service's poster an
 * older image than the laptop's. These tests drive the pull against a fake hub.
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/concertMirror.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  concertArtworkKeys, liveSetsAdoptDecision, parseLiveSetsBody, startReplicaConcertSync,
  type ReplicaLiveSet, type ReplicaTrackRow,
} from '../replica-concerts.ts'

const POSTAL_OLD = '54ea9c03f48a5af3d1296ad21c6875e5_1788000000000'
const POSTAL_NEW = 'accd557ecfd5443d7e49d4870e98f375_1788390537907'

const sets: Record<string, ReplicaLiveSet> = {
  'the postal service|||everything will change (live)': {
    mergedTrackId: 9346,
    cues: [{ trackId: 9330, title: 'The District Sleeps Alone Tonight (Live)', artist: 'The Postal Service', startMs: 0, durationMs: 1000 }],
    concert: { venue: 'Greek Theatre', facts: ['a'] },
  },
  'geese|||alive & in person': {
    mergedTrackId: 12260,
    cues: [{ trackId: 12256, title: '2122', artist: 'Geese', startMs: 0, durationMs: 1000 }],
    promotedTrackIds: [],
  },
}
const rows: ReplicaTrackRow[] = [
  { id: 9346, artist: 'The Postal Service', album: 'Everything Will Change (Live) (Live Set)' },
  { id: 9330, artist: 'The Postal Service', album: 'Everything Will Change (Live)' },
  { id: 12260, artist: 'Geese', album: 'Alive & In Person (Live Set)' },
  { id: 12256, artist: 'Geese', album: 'Alive & In Person' },
]

describe('live-sets body + adopt rules', () => {
  it('parses a real-shaped body and rejects anything half-understood', () => {
    assert.ok(parseLiveSetsBody(JSON.stringify(sets)))
    assert.equal(parseLiveSetsBody('{"a":'), null)
    assert.equal(parseLiveSetsBody('[]'), null)
    assert.equal(parseLiveSetsBody(JSON.stringify({ k: { mergedTrackId: '9346', cues: [] } })), null)
    assert.equal(parseLiveSetsBody(JSON.stringify({ k: { mergedTrackId: 1 } })), null)
    assert.deepEqual(parseLiveSetsBody('{}'), {})
  })
  it('adopts a different copy, ignores an identical one, never adopts an empty one over ours', () => {
    assert.equal(liveSetsAdoptDecision(sets, JSON.parse(JSON.stringify(sets))), 'same')
    const edited = JSON.parse(JSON.stringify(sets))
    edited['geese|||alive & in person'].concert = { notes: 'I was there.' }
    assert.equal(liveSetsAdoptDecision(sets, edited), 'adopt')
    assert.equal(liveSetsAdoptDecision(sets, {}), 'refuse-empty')
    assert.equal(liveSetsAdoptDecision({}, sets), 'adopt')
  })
  it('asks for the keys the renderer draws each concert with', () => {
    const keys = concertArtworkKeys(sets, rows).sort()
    assert.deepEqual(keys, [
      'geese|||alive & in person',
      'geese|||alive & in person (live set)',
      'the postal service|||everything will change (live)',
      'the postal service|||everything will change (live) (live set)',
    ])
    // A set whose merged row is missing is not drawn, so it asks for nothing.
    assert.deepEqual(concertArtworkKeys(sets, rows.filter((r) => r.id !== 12260)).filter((k) => k.startsWith('geese')), [])
  })
})

interface Hub {
  liveBody: string
  liveEtag: string
  index: Record<string, string>
  images: Record<string, Buffer>
  crowd: Record<number, Buffer>
  calls: string[]
}

function fakeFetch(hub: Hub): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const inm = new Headers(init?.headers).get('if-none-match')
    hub.calls.push(`${u.pathname}${u.search}`)
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
    if (u.pathname === '/api/live-sets/sidecar') {
      if (inm === hub.liveEtag) return new Response(null, { status: 304 })
      return json({ name: 'live-sets.json', mtimeMs: 1, body: hub.liveBody }, 200, { etag: hub.liveEtag })
    }
    if (u.pathname === '/api/live-sets/artwork') {
      const items: Record<string, string | null> = {}
      for (const k of u.searchParams.getAll('key')) items[k] = hub.index[k] ?? null
      return json({ items })
    }
    const art = /^\/artwork\/([0-9a-f]{32})$/.exec(u.pathname)
    if (art) {
      const img = hub.images[art[1]]
      return img ? new Response(img, { status: 200, headers: { 'content-type': 'image/jpeg' } }) : json({ error: 'nf' }, 404)
    }
    const crowd = /^\/api\/live-sets\/(\d+)\/crowd$/.exec(u.pathname)
    if (crowd) {
      const clip = hub.crowd[Number(crowd[1])]
      return clip ? new Response(clip, { status: 200, headers: { 'content-type': 'audio/mp4' } }) : json({ error: 'no crowd clip' }, 404)
    }
    return json({ error: 'unexpected' }, 500)
  }) as typeof fetch
}

async function replica(hub: Hub, opts: { local?: Record<string, ReplicaLiveSet>; index?: Record<string, string>; hubBase?: string | null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'replica-concerts-'))
  const artDir = join(dir, 'artwork')
  const crowdDir = join(dir, 'concert-crowd')
  await mkdir(artDir, { recursive: true })
  let live: Record<string, ReplicaLiveSet> = opts.local ?? {}
  let index: Record<string, string> = { ...(opts.index ?? {}) }
  const notes: Array<{ liveSets: boolean; artwork: Array<{ key: string; hash: string }> }> = []
  let sets = 0
  const handle = startReplicaConcertSync({
    hubBase: async () => (opts.hubBase === undefined ? 'http://hub' : opts.hubBase),
    liveSets: { get: async () => live, set: (next) => { live = next; sets++ } },
    tracks: async () => rows,
    artwork: { dir: artDir, loadIndex: async () => index, saveIndex: async (next) => { index = next } },
    crowdDir,
    notify: (u) => { notes.push(u) },
    fetchImpl: fakeFetch(hub),
    log: () => {},
    intervalMs: 3_600_000,
  })
  return { handle, dir, artDir, crowdDir, notes, live: () => live, index: () => index, setCount: () => sets }
}

const freshHub = (): Hub => ({
  liveBody: JSON.stringify(sets),
  liveEtag: '"ls-1"',
  index: {
    'the postal service|||everything will change (live)': POSTAL_NEW,
    'the postal service|||everything will change (live) (live set)': POSTAL_NEW,
  },
  images: { accd557ecfd5443d7e49d4870e98f375: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
  crowd: { 9346: Buffer.from('crowd-9346') },
  calls: [],
})

describe('replica pull against the hub', () => {
  it('adopts the hub live sets, then rides the ETag (no re-adopt, no notify)', async () => {
    const hub = freshHub()
    const r = await replica(hub)
    try {
      await r.handle.tick()
      assert.equal(r.setCount(), 1)
      assert.deepEqual(r.live(), sets)
      assert.equal(r.notes[0]?.liveSets, true)
      await r.handle.tick()
      assert.equal(r.setCount(), 1, '304 → nothing adopted again')
      assert.equal(r.notes.length, 1)
    } finally { r.handle.stop() }
  })

  it('never blanks our live sets with an empty hub copy', async () => {
    const hub = { ...freshHub(), liveBody: '{}' }
    const r = await replica(hub, { local: sets })
    try {
      await r.handle.tick()
      assert.equal(r.setCount(), 0)
      assert.deepEqual(r.live(), sets)
    } finally { r.handle.stop() }
  })

  it('a stale poster key is brought to the laptop hash, fetching the missing image', async () => {
    const hub = freshHub()
    const r = await replica(hub, {
      local: sets,
      index: { 'the postal service|||everything will change (live)': POSTAL_OLD, 'geese|||alive & in person': 'ef41024533f36f12f569d27cbdf49a51_1' },
    })
    try {
      await r.handle.tick()
      assert.equal(r.index()['the postal service|||everything will change (live)'], POSTAL_NEW)
      assert.equal(r.index()['the postal service|||everything will change (live) (live set)'], POSTAL_NEW)
      assert.equal(r.index()['geese|||alive & in person'], 'ef41024533f36f12f569d27cbdf49a51_1', 'a key the hub lacks is never removed or changed')
      const jpg = await readFile(join(r.artDir, 'accd557ecfd5443d7e49d4870e98f375.jpg'))
      assert.equal(jpg[0], 0xff)
      const art = r.notes.at(-1)?.artwork ?? []
      assert.deepEqual(art.map((a) => a.key).sort(), [
        'the postal service|||everything will change (live)',
        'the postal service|||everything will change (live) (live set)',
      ])
      // Second pass: already matching → no image fetch, no notify.
      const before = hub.calls.filter((c) => c.startsWith('/artwork/')).length
      const notesBefore = r.notes.length
      await r.handle.tick()
      assert.equal(hub.calls.filter((c) => c.startsWith('/artwork/')).length, before)
      assert.equal(r.notes.length, notesBefore)
    } finally { r.handle.stop() }
  })

  it('a poster the hub cannot serve leaves the key alone', async () => {
    const hub = { ...freshHub(), images: {} }
    const r = await replica(hub, { local: sets, index: { 'the postal service|||everything will change (live)': POSTAL_OLD } })
    try {
      await r.handle.tick()
      assert.equal(r.index()['the postal service|||everything will change (live)'], POSTAL_OLD)
    } finally { r.handle.stop() }
  })

  it('the canonical laptop (no hub base) does nothing at all', async () => {
    const hub = freshHub()
    const r = await replica(hub, { hubBase: null })
    try {
      await r.handle.tick()
      assert.equal(await r.handle.crowdClip(9346), null)
      assert.deepEqual(hub.calls, [])
    } finally { r.handle.stop() }
  })
})

describe('crowd clips reach the replica through the hub', () => {
  it('a local clip is served as-is; a missing one is fetched once and cached', async () => {
    const hub = freshHub()
    const r = await replica(hub)
    try {
      const first = await r.handle.crowdClip(9346)
      assert.equal(first?.toString(), 'crowd-9346')
      assert.equal((await readFile(join(r.crowdDir, '9346.m4a'))).toString(), 'crowd-9346')
      const fetches = hub.calls.length
      assert.equal((await r.handle.crowdClip(9346))?.toString(), 'crowd-9346')
      assert.equal(hub.calls.length, fetches, 'second open reads the local copy')
      await writeFile(join(r.crowdDir, '12260.m4a'), 'local-12260')
      assert.equal((await r.handle.crowdClip(12260))?.toString(), 'local-12260')
    } finally { r.handle.stop() }
  })
  it('a show with no clip on the hub answers null and is not re-asked right away', async () => {
    const hub = freshHub()
    const r = await replica(hub)
    try {
      assert.equal(await r.handle.crowdClip(11059), null)
      const n = hub.calls.length
      assert.equal(await r.handle.crowdClip(11059), null)
      assert.equal(hub.calls.length, n)
      assert.equal(await r.handle.crowdClip(-1), null)
    } finally { r.handle.stop() }
  })
})
