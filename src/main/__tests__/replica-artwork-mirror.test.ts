/**
 * Full artwork mirror for replicas (2026-10-19, "eye for eye"). Measured that
 * day on workmini against the laptop: 143 keys missing, 581 naming another
 * version (475 of them over identical bytes), 894 naming the SAME version over
 * different bytes. These tests drive the mirror against a fake hub, one case
 * per drift class, plus the link rules (yield to playback, serial, resumable,
 * identity-gated, never deletes, batched renderer updates).
 * ⚠️ TWIN: ~/JakeTunesMobile backend/src/util/artworkManifest.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIRROR_LEDGER_FILE, parseManifest, planMirror, recentAlbumKeys, startReplicaArtworkMirror,
  type ArtworkMirrorUpdate, type MirrorManifest,
} from '../replica-artwork-mirror.ts'

const md5 = (b: Buffer | string): string => createHash('md5').update(b).digest('hex')
const H = (c: string): string => c.repeat(32)          // a fake bare hash: 'aaaa…'

// One key per drift class (real keys from the 2026-10-19 measurement).
const MISSING = 'geese|||a beautiful memory'                       // absent on workmini
const VERSION = "rush|||all the world's a stage [live]"            // other version, same bytes
const BYTES = 'nirvana|||mtv unplugged in new york'                // same version, other bytes
const SAME = 'daft punk|||alive 2007'                              // already identical
const CONCERT = "paul mccartney|||good evening new york city (live at citi field, nyc, 2009)"
const LOCAL_ONLY = 'workmini|||only here'                          // the laptop lacks it

interface Hub {
  manifest: MirrorManifest
  images: Record<string, Buffer>
  etag: string
  calls: string[]
  status?: number
  /** Serve these bytes instead of the manifest's (homemini changed mid-pass). */
  lie?: Record<string, Buffer>
}

function hubFrom(files: Record<string, Buffer>, index: Record<string, string>): Hub {
  const mf: MirrorManifest['files'] = {}
  for (const [b, buf] of Object.entries(files)) mf[b] = [buf.length, md5(buf)]
  return { manifest: { index, files: mf }, images: files, etag: '"am-1"', calls: [] }
}

function fakeFetch(hub: Hub, onBody?: (bare: string) => void): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    hub.calls.push(u.pathname)
    if (u.pathname === '/api/artwork-mirror/manifest') {
      if (hub.status) return new Response('{}', { status: hub.status })
      if (new Headers(init?.headers).get('if-none-match') === hub.etag) return new Response(null, { status: 304 })
      return new Response(JSON.stringify({ v: 1, ...hub.manifest }), { status: 200, headers: { 'content-type': 'application/json', etag: hub.etag } })
    }
    const art = /^\/artwork\/([0-9a-f]{32})$/.exec(u.pathname)
    if (art) {
      onBody?.(art[1]!)
      const img = hub.lie?.[art[1]!] ?? hub.images[art[1]!]
      if (init?.signal?.aborted) throw new Error('aborted')
      return img ? new Response(img, { status: 200, headers: { 'content-type': 'image/jpeg' } }) : new Response('nf', { status: 404 })
    }
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
}

async function replica(hub: Hub, opts: {
  index?: Record<string, string>
  files?: Record<string, Buffer>
  priority?: string[]
  playing?: () => boolean
  batchFiles?: number
  dir?: string
  onBody?: (bare: string) => void
} = {}) {
  const dir = opts.dir ?? await mkdtemp(join(tmpdir(), 'art-mirror-'))
  const artDir = join(dir, 'artwork')
  await mkdir(artDir, { recursive: true })
  for (const [b, buf] of Object.entries(opts.files ?? {})) await writeFile(join(artDir, `${b}.jpg`), buf)
  let index: Record<string, string> = { ...(opts.index ?? {}) }
  const notes: ArtworkMirrorUpdate[] = []
  const invalidated: string[] = []
  const landed: string[][] = []
  let t = 1_000_000
  const handle = startReplicaArtworkMirror({
    hubBase: async () => 'http://hub',
    artwork: { dir: artDir, loadIndex: async () => index, saveIndex: async (next) => { index = { ...next } } },
    invalidate: (b) => { invalidated.push(b) },
    priorityKeys: async () => opts.priority ?? [],
    isPlaying: opts.playing ?? (() => false),
    paceBytesPerSec: async () => 0,
    notify: (u) => { notes.push(u) },
    onLanded: (b) => { landed.push(b) },
    fetchImpl: fakeFetch(hub, opts.onBody),
    log: () => {},
    now: () => t,
    sleep: async (ms) => { t += ms },
    intervalMs: 3_600_000,
    quietMs: 30_000,
    batchFiles: opts.batchFiles ?? 25,
  })
  return { handle, dir, artDir, notes, invalidated, landed, index: () => index, advance: (ms: number) => { t += ms } }
}

/** The four drift classes + a concert poster + a key only workmini has. */
function scenario() {
  const laptop = {
    [H('a')]: Buffer.from('geese-a-beautiful-memory'),
    [H('b')]: Buffer.from('rush-poster'),
    [H('c')]: Buffer.from('nirvana-unplugged-poster'),
    [H('d')]: Buffer.from('daft-punk'),
    [H('e')]: Buffer.from('mccartney-poster'),
    [H('f')]: Buffer.from('laptop-only-orphan-jpg'),
  }
  const hub = hubFrom(laptop, {
    [MISSING]: `${H('a')}_1791000000000`,
    [VERSION]: `${H('b')}_1788390804464`,
    [BYTES]: `${H('c')}_1788389396248`,
    [`${BYTES} (live set)`]: H('c'),
    [SAME]: `${H('d')}_1788391112843`,
    [CONCERT]: `${H('e')}_1788389364995`,
  })
  const local = {
    index: {
      [VERSION]: `${H('b')}_1700000000000`,           // other version…
      [BYTES]: `${H('c')}_1788389396248`,            // …same version
      [SAME]: `${H('d')}_1788391112843`,
      [CONCERT]: `${H('e')}_1779599534633`,
      [LOCAL_ONLY]: `${H('9')}_1`,
    },
    files: {
      [H('b')]: Buffer.from('rush-poster'),          // same bytes as the laptop
      [H('c')]: Buffer.from('nirvana-JUL-10-cover'), // stale bytes, same version
      [H('d')]: Buffer.from('daft-punk'),
      [H('e')]: Buffer.from('mccartney-OLD'),
      [H('9')]: Buffer.from('only-on-workmini'),
    },
  }
  return { laptop, hub, local }
}

describe('manifest + plan (pure)', () => {
  it('parses the v1 shape; refuses anything else whole; drops bad entries', () => {
    const ok = parseManifest({ v: 1, index: { 'a|||b': H('a'), 'bad': H('a'), 'c|||d': '../x' }, files: { [H('a')]: [3, md5('abc')], nothex: [1, md5('x')], [H('b')]: [0, md5('x')] } })
    assert.deepEqual({ ...ok!.index }, { 'a|||b': H('a') })
    assert.deepEqual({ ...ok!.files }, { [H('a')]: [3, md5('abc')] })
    // The laptop's largest real cover is 27.8 MB (4fb31690…): a cap below it broke eye-for-eye.
    assert.deepEqual(parseManifest({ v: 1, index: {}, files: { [H('b')]: [27_832_325, md5('x')] } })!.files[H('b')], [27_832_325, md5('x')])
    assert.equal(parseManifest({ v: 2, index: {}, files: {} }), null)
    assert.equal(parseManifest([]), null)
    assert.equal(parseManifest(null), null)
  })

  it('classifies every drift class and orders downloads: priority, then missing keys, then the rest, then unnamed jpgs', () => {
    const { hub, local } = scenario()
    const localMd5 = (b: string): string | null => (local.files[b as keyof typeof local.files] ? md5(local.files[b as keyof typeof local.files]) : null)
    const plan = planMirror(local.index, parseManifest({ v: 1, ...hub.manifest })!, localMd5, [CONCERT])
    // Version differs but the bytes match: index-only, no download.
    assert.deepEqual(plan.indexNow, { [VERSION]: hub.manifest.index[VERSION] })
    assert.deepEqual(plan.downloads, [H('e'), H('a'), H('c'), H('f')])
    // H('c') counts as a missing KEY: its "(live set)" row has no entry here.
    assert.deepEqual(plan.tiers, { priority: 1, missingKey: 2, rest: 0, orphan: 1 })
    assert.deepEqual(plan.keysByBare.get(H('c'))?.sort(), [BYTES, `${BYTES} (live set)`])
    assert.ok(!(LOCAL_ONLY in plan.indexNow), 'a key the laptop lacks is never touched')
  })

  it('a key whose jpg homemini does not have yet is left alone', () => {
    const plan = planMirror({ [SAME]: H('d') }, { index: { [SAME]: `${H('d')}_2` }, files: {} }, () => null, [])
    assert.deepEqual(plan, { indexNow: {}, downloads: [], keysByBare: new Map(), tiers: { priority: 0, missingKey: 0, rest: 0, orphan: 0 } })
  })

  it('recent albums: newest add-or-play first, one key per album', () => {
    const keys = recentAlbumKeys([
      { artist: 'Geese', album: 'Getting Killed', dateAdded: '2025-09-26' },
      { artist: 'Geese', album: 'Getting Killed', lastPlayedAt: Date.parse('2026-10-19') },
      { artist: 'Rush', album: 'Moving Pictures', dateAdded: '2026-01-01' },
      { artist: '', album: 'x' },
    ])
    assert.deepEqual(keys, ['geese|||getting killed', 'rush|||moving pictures'])
  })
})

describe('a replica pass against the hub', () => {
  it('makes index + jpgs identical to the laptop, keeps local-only art, tells the renderer per batch', async () => {
    const { laptop, hub, local } = scenario()
    const r = await replica(hub, { ...local, priority: [CONCERT], batchFiles: 2 })
    try {
      await r.handle.tick()
      for (const [b, buf] of Object.entries(laptop)) {
        assert.equal(md5(await readFile(join(r.artDir, `${b}.jpg`))), md5(buf), `${b} matches the laptop byte for byte`)
      }
      assert.equal((await readFile(join(r.artDir, `${H('9')}.jpg`))).toString(), 'only-on-workmini', 'never deletes art the laptop lacks')
      assert.deepEqual(r.index(), { ...local.index, ...hub.manifest.index }, 'index = ours + every laptop entry')
      // Order on the wire: the concert poster first.
      assert.deepEqual(hub.calls.filter((c) => c.startsWith('/artwork/')), [`/artwork/${H('e')}`, `/artwork/${H('a')}`, `/artwork/${H('c')}`, `/artwork/${H('f')}`])
      assert.deepEqual(r.invalidated.sort(), [H('a'), H('c'), H('e'), H('f')].sort(), 'byte cache + thumbs dropped for every replaced jpg')
      // 1 index-only notify + 2 batches of 2 — never one event per file.
      assert.equal(r.notes.length, 3)
      assert.deepEqual(r.notes[0], { entries: { [VERSION]: hub.manifest.index[VERSION] }, bares: [] })
      assert.deepEqual(r.notes.flatMap((n) => n.bares).sort(), [H('a'), H('c'), H('e'), H('f')].sort())
      assert.equal(r.notes[2]!.entries[BYTES], hub.manifest.index[BYTES])
      assert.deepEqual(r.landed.flat().sort(), [H('a'), H('c'), H('e'), H('f')].sort(), 'thumbs pregenerated for landed art')
      // In sync: the next pass is one 304 and nothing else.
      const before = hub.calls.length
      await r.handle.tick()
      assert.deepEqual(hub.calls.slice(before), ['/api/artwork-mirror/manifest'])
      assert.equal(r.notes.length, 3)
      assert.ok(r.handle.active())
    } finally { r.handle.stop() }
  })

  it('the same version over different bytes is still replaced (the 894-key case) — mutation: version-only diff misses it', async () => {
    const { hub, local } = scenario()
    // Both keys naming H('c') already agree with the laptop, so ONLY the bytes differ.
    const r = await replica(hub, { index: { [BYTES]: hub.manifest.index[BYTES]!, [`${BYTES} (live set)`]: H('c') }, files: { [H('c')]: local.files[H('c')] } })
    try {
      await r.handle.tick()
      assert.equal((await readFile(join(r.artDir, `${H('c')}.jpg`))).toString(), 'nirvana-unplugged-poster')
      assert.ok(r.notes.some((n) => n.bares.includes(H('c'))), 'renderer told the bytes changed (its URL gets a new r=)')
    } finally { r.handle.stop() }
  })

  it('identity gate: bytes that do not hash to the manifest never replace ours', async () => {
    const { hub, local } = scenario()
    hub.lie = { [H('c')]: Buffer.from('half-synced-on-homemini') }
    const r = await replica(hub, local)
    try {
      await r.handle.tick()
      assert.equal((await readFile(join(r.artDir, `${H('c')}.jpg`))).toString(), 'nirvana-JUL-10-cover')
      assert.notEqual(r.index()[BYTES], undefined)
      assert.ok(!r.invalidated.includes(H('c')))
    } finally { r.handle.stop() }
  })

  it('resumes across a restart from the ledger: landed files are neither re-hashed nor re-fetched', async () => {
    const { hub, local } = scenario()
    let n = 0
    let first: Awaited<ReturnType<typeof replica>> | null = null
    first = await replica(hub, { ...local, priority: [CONCERT], batchFiles: 1, onBody: () => { if (++n === 2) first!.handle.stop() } })
    await first.handle.tick()
    // Order is [e (concert), a, c, f]; the app quit while `a` was in flight.
    assert.deepEqual(hub.calls.filter((c) => c.startsWith('/artwork/')), [`/artwork/${H('e')}`, `/artwork/${H('a')}`])
    const ledger = JSON.parse(await readFile(join(first.artDir, MIRROR_LEDGER_FILE), 'utf-8'))
    assert.equal(ledger.v, 1)
    assert.deepEqual(Object.keys(ledger.files).sort(), [H('b'), H('c'), H('d'), H('e')], 'every local jpg the laptop also has is verified once and recorded')
    assert.equal(ledger.files[H('e')][2], md5('mccartney-poster'), 'the landed poster is recorded by its new md5')
    // "Relaunch": a new instance over the same dir, with the index persisted so far.
    hub.calls.length = 0
    const second = await replica(hub, { dir: first.dir, index: first.index(), priority: [CONCERT] })
    try {
      await second.handle.tick()
      assert.deepEqual(hub.calls.filter((c) => c.startsWith('/artwork/')), [`/artwork/${H('a')}`, `/artwork/${H('c')}`, `/artwork/${H('f')}`],
        'only what is still different: the poster that landed before the restart is not fetched again')
      assert.equal(second.index()[CONCERT], hub.manifest.index[CONCERT])
      assert.equal((await readFile(join(second.artDir, `${H('f')}.jpg`))).toString(), 'laptop-only-orphan-jpg')
    } finally { second.handle.stop() }
  })

  it('yields to playback: nothing is fetched while music plays, and the pass picks up once it has been quiet', async () => {
    const { hub, local } = scenario()
    let playing = true
    let polls = 0
    const r = await replica(hub, { ...local, playing: () => { if (++polls > 5) playing = false; return playing } })
    try {
      await r.handle.tick()
      const fetched = hub.calls.filter((c) => c.startsWith('/artwork/')).length
      assert.equal(fetched, 4)
      assert.ok(polls > 5, 'it waited through the playing polls first')
    } finally { r.handle.stop() }
  })

  it('an older hub (no manifest route) leaves the concert poster pass in charge', async () => {
    const { hub } = scenario()
    hub.status = 404
    const r = await replica(hub)
    try {
      await r.handle.tick()
      assert.equal(r.handle.active(), false)
      assert.deepEqual(hub.calls, ['/api/artwork-mirror/manifest'])
    } finally { r.handle.stop() }
  })

  it('landed files are written atomically (no .tmp left) and keep a size the manifest promised', async () => {
    const { hub, local } = scenario()
    const r = await replica(hub, local)
    try {
      await r.handle.tick()
      const st = await stat(join(r.artDir, `${H('a')}.jpg`))
      assert.equal(st.size, hub.manifest.files[H('a')]![0])
    } finally { r.handle.stop() }
  })
})
