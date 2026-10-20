/**
 * Replica hub files (2026-10-20): workmini had no release-kinds.json (164 of
 * 2,598 albums in the wrong artist-page section) and no playlist-covers folder.
 * Both now come from homemini. The hub wins; missing is never empty; inert on
 * the MacBook. fetch is injected — nothing here touches the network.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptHubReleaseKinds, coversToFetch, createCoverMirror, createReleaseKindsPuller, parseHubCoverList, COVER_MIRROR_RECORD,
} from '../replica-hub-files.ts'
import { emptyReleaseKinds } from '../release-kinds.ts'
import type { ReleaseKindsFile } from '../../common/release-kind.ts'

type Reply = { status: number; body?: unknown; bytes?: Uint8Array; etag?: string }

function fakeFetch(route: (url: string, headers: Headers) => Reply) {
  const calls: Array<{ url: string; inm: string | null }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const h = new Headers(init?.headers)
    calls.push({ url: u, inm: h.get('if-none-match') })
    const r = route(u, h)
    const text = r.bytes ? '' : JSON.stringify(r.body ?? null)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.etag ? { etag: r.etag } : {}),
      text: async () => text,
      json: async () => r.body,
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer,
    }
  }) as typeof fetch
  return { calls, fetchImpl }
}

const rk = (albums: ReleaseKindsFile['albums'], updatedAt = '2026-10-20T00:40:45.702Z'): ReleaseKindsFile => ({ version: 1, updatedAt, albums })

describe('release kinds: a replica adopts homemini\'s copy', () => {
  it('pure: hub entries win album by album, an album only this machine has is kept', () => {
    const local = rk({ 'geese|3d country': { kind: 'album', source: 'title' }, 'local|only': { kind: 'ep', source: 'shape' } }, 'old')
    const hub = rk({ 'geese|3d country': { kind: 'album', source: 'musicbrainz', mbid: 'm1' }, 'geese|4d country': { kind: 'ep', source: 'musicbrainz' } })
    const next = adoptHubReleaseKinds(local, hub)!
    assert.equal(next.albums['geese|3d country'].source, 'musicbrainz')
    assert.equal(next.albums['geese|4d country'].kind, 'ep')
    assert.equal(next.albums['local|only'].kind, 'ep', 'missing is not empty')
    assert.equal(next.updatedAt, hub.updatedAt)
  })
  it('pure: an empty hub copy changes nothing; an identical one needs no write', () => {
    const local = rk({ 'a|b': { kind: 'album', source: 'title' } })
    assert.equal(adoptHubReleaseKinds(local, emptyReleaseKinds()), null)
    assert.equal(adoptHubReleaseKinds(local, rk({ 'a|b': { kind: 'album', source: 'title' } })), null)
  })

  it('pulls, writes the file, then sends the ETag back and a 304 leaves the file alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rk-pull-'))
    const file = join(dir, 'release-kinds.json')
    const hubFile = rk({ 'lou reed|transformer': { kind: 'album', source: 'musicbrainz', mbid: 'x' } })
    const hub = fakeFetch((u, h) => {
      assert.ok(u.endsWith('/api/release-kinds'), u)
      return h.get('if-none-match') === '"rk1"' ? { status: 304 } : { status: 200, body: hubFile, etag: '"rk1"' }
    })
    const p = createReleaseKindsPuller({ file, hubBase: async () => 'http://hub:3000', fetchImpl: hub.fetchImpl, log: () => {} })
    assert.equal(await p.pull(), true)
    const onDisk = JSON.parse(await readFile(file, 'utf-8')) as ReleaseKindsFile
    assert.equal(onDisk.albums['lou reed|transformer'].mbid, 'x')
    const before = (await stat(file)).mtimeMs
    assert.equal(await p.pull(), false)
    assert.equal(hub.calls[1].inm, '"rk1"')
    assert.equal((await stat(file)).mtimeMs, before)
  })

  it('inert on the MacBook (no hub base): no request at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rk-inert-'))
    const hub = fakeFetch(() => { throw new Error('must not fetch') })
    const p = createReleaseKindsPuller({ file: join(dir, 'release-kinds.json'), hubBase: async () => null, fetchImpl: hub.fetchImpl, log: () => {} })
    assert.equal(await p.pull(), false)
    assert.equal(hub.calls.length, 0)
  })

  it('a 404, a malformed body or an empty copy never blanks the local file; a problem is logged once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rk-keep-'))
    const file = join(dir, 'release-kinds.json')
    const local = rk({ 'a|b': { kind: 'single', source: 'musicbrainz' } })
    await writeFile(file, JSON.stringify(local))
    let reply: Reply = { status: 404, body: { error: 'missing' } }
    const hub = fakeFetch(() => reply)
    const lines: string[] = []
    const p = createReleaseKindsPuller({ file, hubBase: async () => 'http://hub', fetchImpl: hub.fetchImpl, log: (m) => lines.push(m) })
    await p.pull()
    await p.pull()
    assert.equal(lines.filter((l) => l.includes('HTTP 404')).length, 1, 'logged once, not every tick')
    reply = { status: 200, body: { version: 1, updatedAt: 'x', albums: {} } }
    assert.equal(await p.pull(), false)
    reply = { status: 200, body: 'not json at all' }
    assert.equal(await p.pull(), false)
    const onDisk = JSON.parse(await readFile(file, 'utf-8')) as ReleaseKindsFile
    assert.equal(onDisk.albums['a|b'].kind, 'single')
  })

  it('wired: registerReleaseKindsIpc starts the pull with the replica hub base', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'index.ts'), 'utf-8')
    assert.match(src, /registerReleaseKindsIpc\(ipc, \{[^\n]*hubBase: replicaHubBase/)
    assert.match(src, /registerPlaylistCoverIpc\(ipc, [^\n]*hubBase: replicaHubBase/)
  })
})

describe('playlist covers: a replica mirrors the MacBook\'s covers from homemini', () => {
  const jpeg = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i === 0 ? 0xff : i === 1 ? 0xd8 : i % 251)))

  it('pure: the listing drops unsafe ids and malformed rows', () => {
    const items = parseHubCoverList({ items: [
      { id: 'pl-1786144518145', bytes: 84433, mtimeMs: 1 },
      { id: '../etc/passwd', bytes: 10, mtimeMs: 1 },
      { id: 'mix-mslgizex', bytes: 0, mtimeMs: 1 },
      { id: 'ipod-baseball', bytes: 5, mtimeMs: 'x' },
      null,
    ] })
    assert.deepEqual(items?.map((i) => i.id), ['pl-1786144518145'])
    assert.equal(parseHubCoverList({ nope: true }), null)
  })

  it('pure: fetch what is missing or changed on the hub; a local pick is not overwritten while the hub copy is unchanged', () => {
    const hub = [{ id: 'a', bytes: 10, mtimeMs: 1 }, { id: 'b', bytes: 20, mtimeMs: 2 }, { id: 'c', bytes: 30, mtimeMs: 3 }]
    const record = { b: { bytes: 20, mtimeMs: 2 }, c: { bytes: 30, mtimeMs: 1 } }
    const have = new Set(['b', 'c'])
    assert.deepEqual(coversToFetch(hub, record, have).map((i) => i.id), ['a', 'c'])
  })

  it('downloads every listed cover into the folder, records it, and tells the renderer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cover-mirror-'))
    const dir = join(root, 'playlist-covers')
    const recordFile = join(root, COVER_MIRROR_RECORD)
    const listing = { items: [{ id: 'pl-1786144518145', bytes: 64, mtimeMs: 10 }, { id: 'mix-mslgizex', bytes: 32, mtimeMs: 11 }] }
    const hub = fakeFetch((u, h) => {
      if (u.endsWith('/api/playlist-covers')) return h.get('if-none-match') === '"L1"' ? { status: 304 } : { status: 200, body: listing, etag: '"L1"' }
      if (u.endsWith('/api/playlist-cover/pl-1786144518145')) return { status: 200, bytes: jpeg(64) }
      if (u.endsWith('/api/playlist-cover/mix-mslgizex')) return { status: 200, bytes: jpeg(32) }
      return { status: 404 }
    })
    const notified: string[][] = []
    const m = createCoverMirror({ dir, recordFile, hubBase: async () => 'http://hub', fetchImpl: hub.fetchImpl, notify: (ids) => notified.push(ids), log: () => {} })
    assert.deepEqual((await m.tick()).sort(), ['mix-mslgizex', 'pl-1786144518145'])
    assert.equal((await readFile(join(dir, 'pl-1786144518145.jpg'))).length, 64)
    assert.equal((await readFile(join(dir, 'mix-mslgizex.jpg'))).length, 32)
    assert.equal(notified.length, 1)
    const record = JSON.parse(await readFile(recordFile, 'utf-8')) as Record<string, { bytes: number; mtimeMs: number }>
    assert.deepEqual(record['pl-1786144518145'], { bytes: 64, mtimeMs: 10 })
    assert.deepEqual((await readdir(dir)).sort(), ['mix-mslgizex.jpg', 'pl-1786144518145.jpg'], 'no temp files left behind')
    // Second pass: conditional listing, nothing downloaded.
    const before = hub.calls.length
    assert.deepEqual(await m.tick(), [])
    assert.equal(hub.calls.length, before + 1)
    assert.equal(hub.calls[before].inm, '"L1"')
  })

  it('a new pick on the MacBook (hub size / mtime moved) replaces the cover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cover-replace-'))
    const dir = join(root, 'playlist-covers')
    let listing = { items: [{ id: 'pl-1', bytes: 16, mtimeMs: 1 }] }
    let bytes = jpeg(16)
    const hub = fakeFetch((u) => u.endsWith('/api/playlist-covers') ? { status: 200, body: listing } : { status: 200, bytes })
    const m = createCoverMirror({ dir, recordFile: join(root, COVER_MIRROR_RECORD), hubBase: async () => 'http://hub', fetchImpl: hub.fetchImpl, log: () => {} })
    await m.tick()
    listing = { items: [{ id: 'pl-1', bytes: 48, mtimeMs: 2 }] }
    bytes = jpeg(48)
    assert.deepEqual(await m.tick(), ['pl-1'])
    assert.equal((await readFile(join(dir, 'pl-1.jpg'))).length, 48)
  })

  it('missing is not empty: a cover the hub no longer lists, an empty or failed listing, never removes one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cover-keep-'))
    const dir = join(root, 'playlist-covers')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'pl-mine.jpg'), jpeg(20))
    let reply: Reply = { status: 200, body: { items: [] } }
    const hub = fakeFetch(() => reply)
    const m = createCoverMirror({ dir, recordFile: join(root, COVER_MIRROR_RECORD), hubBase: async () => 'http://hub', fetchImpl: hub.fetchImpl, log: () => {} })
    await m.tick()
    reply = { status: 500 }
    await m.tick()
    reply = { status: 200, body: { garbage: 1 } }
    await m.tick()
    assert.equal((await readFile(join(dir, 'pl-mine.jpg'))).length, 20)
  })

  it('caps the downloads per pass and asks for the whole listing again until the backlog is done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cover-cap-'))
    const dir = join(root, 'playlist-covers')
    const listing = { items: ['a', 'b', 'c'].map((id, i) => ({ id, bytes: 8, mtimeMs: i })) }
    const hub = fakeFetch((u) => u.endsWith('/api/playlist-covers') ? { status: 200, body: listing, etag: '"L"' } : { status: 200, bytes: jpeg(8) })
    const m = createCoverMirror({ dir, recordFile: join(root, COVER_MIRROR_RECORD), hubBase: async () => 'http://hub', fetchImpl: hub.fetchImpl, perTick: 2, log: () => {} })
    assert.equal((await m.tick()).length, 2)
    const second = hub.calls.length
    assert.deepEqual(await m.tick(), ['c'])
    assert.equal(hub.calls[second].inm, null, 'a listing with a backlog is not answered 304')
    assert.deepEqual(await m.tick(), [])
  })

  it('inert on the MacBook (no hub base)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cover-inert-'))
    const hub = fakeFetch(() => { throw new Error('must not fetch') })
    const m = createCoverMirror({ dir: join(root, 'pc'), recordFile: join(root, COVER_MIRROR_RECORD), hubBase: async () => null, fetchImpl: hub.fetchImpl, log: () => {} })
    assert.deepEqual(await m.tick(), [])
    assert.equal(hub.calls.length, 0)
  })
})
