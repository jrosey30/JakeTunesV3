/**
 * Rename the iPod (2026-11-07, Jake: "i actually want to name the actual ipod
 * punkPod not just a nickname. it shows up as JT Red").
 *
 * No real iPod and no diskutil here: the marker is written to a fake card in a
 * temp folder, the drive rename and homemini are fakes.
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkIpodName, macShowsLine, FAT_LABEL_MAX } from '../../common/ipod-name.ts'
import { buildDeviceMarker, IPOD_MARKER_REL, type IpodDeviceMarker } from '../../common/ipod-identity.ts'
import { identifyIpod, loadIpodRegistry, renameIpodMarker } from '../ipod-identity.ts'
import { flushHomeminiName, queueHomeminiName, renameIpod, type RenameIpodDeps } from '../ipod-rename.ts'
import { createIpodListClient } from '../ipod-list-client.ts'
import type { FetchLike } from '../top1000-client.ts'

const PUNK_ID = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
const now = '2026-11-07T00:00:00.000Z'
const punk = buildDeviceMarker({ id: PUNK_ID, name: 'JT Red', color: 'red', purpose: 'Punk', primary: false, now })!
const original = buildDeviceMarker({ id: 'original-58ebb78e', name: 'Original', primary: true, now })!

const roots: string[] = []
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  roots.push(d)
  return d
}
function fakeCard(marker: IpodDeviceMarker | null, name = 'JT RED'): string {
  const mount = join(tmp('jt-rename-vol-'), name)
  mkdirSync(join(mount, 'iPod_Control', 'iTunes'), { recursive: true })
  if (marker) writeFileSync(join(mount, ...IPOD_MARKER_REL), JSON.stringify(marker))
  return mount
}

describe('a name the iPod’s FAT32 drive can hold', () => {
  it('takes punkPod, and says the Finder will show PUNKPOD after a replug', () => {
    const c = checkIpodName('  punkPod ')
    assert.ok(c.ok)
    assert.equal(c.name, 'punkPod')
    assert.equal(c.macShows, 'PUNKPOD')
    assert.match(macShowsLine(c) || '', /The Mac’s Finder will show the drive as PUNKPOD/)
    const caps = checkIpodName('EVIL')
    assert.ok(caps.ok)
    assert.equal(macShowsLine(caps), null, 'all capitals: nothing to warn about')
  })
  it('refuses what the drive refused on a real FAT32 image, in plain words', () => {
    assert.equal(checkIpodName('').ok, false)
    const long = checkIpodName('TwelveChars1')
    assert.ok(!long.ok && long.error.includes(`at most ${FAT_LABEL_MAX}`))
    for (const bad of ['a.b', 'a+b', 'a=b', 'a,b', 'a;b', 'a[b', 'a"b', 'a*b', 'a?b', 'a|b', 'a<b', 'ÅBC', 'a/b', 'a:b']) {
      assert.equal(checkIpodName(bad).ok, false, bad)
    }
    for (const good of ["a-b_c&'()", 'x!#$%@^', 'a{b}~', 'JT Red', 'Nine Inch1']) {
      assert.equal(checkIpodName(good).ok, true, good)
    }
  })
})

describe('the marker is renamed, and the id stays the identity', () => {
  it('rewrites the card’s marker and the registry, keeping id, colour, purpose and createdAt', async () => {
    const state = tmp('jt-rename-state-')
    const mount = fakeCard(punk)
    const r = await renameIpodMarker(mount, state, 'punkPod')
    assert.ok(r.ok)
    assert.equal(r.before, 'JT Red')
    const onCard = JSON.parse(readFileSync(join(mount, ...IPOD_MARKER_REL), 'utf-8'))
    assert.deepEqual({ ...onCard, name: 'JT Red' }, punk)
    assert.equal(onCard.name, 'punkPod')
    assert.equal((await loadIpodRegistry(state)).devices.find((d) => d.id === PUNK_ID)?.name, 'punkPod')
  })
  it('after the drive moves to a new mount path, it is still the same iPod', async () => {
    const state = tmp('jt-rename-state-')
    const mount = fakeCard(punk)
    assert.ok((await renameIpodMarker(mount, state, 'punkPod')).ok)
    const moved = join(mount, '..', 'punkPod')
    renameSync(mount, moved)
    const id = await identifyIpod(moved, state)
    assert.equal(id.status, 'known')
    assert.equal(id.status === 'known' && id.device.id, PUNK_ID)
    assert.equal(id.status === 'known' && id.device.name, 'punkPod')
  })
  it('an iPod JakeTunes doesn’t know is refused, and nothing is written', async () => {
    const mount = fakeCard(null)
    const r = await renameIpodMarker(mount, tmp('jt-rename-state-'), 'punkPod')
    assert.equal(r.ok, false)
    assert.equal(existsSync(join(mount, ...IPOD_MARKER_REL)), false)
  })
})

function deps(marker: IpodDeviceMarker | null, over: Partial<RenameIpodDeps> = {}) {
  const log: string[] = []
  const d: RenameIpodDeps = {
    syncing: () => false,
    mount: () => '/Volumes/JT RED',
    renameMarker: async (_m, name) => {
      log.push(`marker:${name}`)
      return marker ? { ok: true, device: { ...marker, name }, before: marker.name } : { ok: false, error: 'JakeTunes doesn’t know this iPod yet. Set it up first.' }
    },
    renameVolume: async (_m, label) => { log.push(`volume:${label}`); return `/Volumes/${label}` },
    renameOnHomemini: async (id, name) => { log.push(`homemini:${id}:${name}`); return true },
    queueHomeminiName: async (id, name) => { log.push(`queued:${id}:${name}`) },
    followMount: (m) => { log.push(`follow:${m}`) },
    ...over,
  }
  return { d, log }
}

describe('one rename, everywhere', () => {
  it('a list-only iPod: marker, then drive, the mount followed, then homemini', async () => {
    const { d, log } = deps(punk)
    const r = await renameIpod(d, 'punkPod')
    assert.ok(r.ok)
    assert.equal(r.mount, '/Volumes/punkPod')
    assert.equal(r.homemini, 'saved')
    assert.deepEqual(log, ['marker:punkPod', 'volume:punkPod', 'follow:/Volumes/punkPod', `homemini:${PUNK_ID}:punkPod`])
  })
  it('homemini away: the rename still lands, and the name waits for the next sync', async () => {
    const { d, log } = deps(punk, { renameOnHomemini: async () => false })
    const r = await renameIpod(d, 'punkPod')
    assert.ok(r.ok)
    assert.equal(r.homemini, 'later')
    assert.ok(log.includes(`queued:${PUNK_ID}:punkPod`))
  })
  it('the Original has no list on homemini: homemini is never asked', async () => {
    const { d, log } = deps(original)
    const r = await renameIpod(d, 'Original')
    assert.ok(r.ok)
    assert.equal(r.homemini, 'n/a')
    assert.ok(!log.some((l) => l.startsWith('homemini') || l.startsWith('queued')))
  })
  it('refused while a sync runs, for a bad name, with no iPod, and for an unknown iPod', async () => {
    const busy = deps(punk, { syncing: () => true })
    const a = await renameIpod(busy.d, 'punkPod')
    assert.ok(!a.ok && /Wait for the sync to finish/.test(a.error))
    assert.deepEqual(busy.log, [], 'nothing is touched during a sync')
    const bad = deps(punk)
    assert.equal((await renameIpod(bad.d, 'punk.pod')).ok, false)
    assert.deepEqual(bad.log, [])
    assert.equal((await renameIpod(deps(punk, { mount: () => null }).d, 'punkPod')).ok, false)
    const unknown = deps(null)
    assert.equal((await renameIpod(unknown.d, 'punkPod')).ok, false)
    assert.ok(!unknown.log.some((l) => l.startsWith('volume')), 'an unknown drive is never renamed')
  })
  it('the drive refusing its new label is said plainly; the marker rename stands', async () => {
    const { d } = deps(punk, { renameVolume: async () => { throw new Error('disk busy') } })
    const r = await renameIpod(d, 'punkPod')
    assert.ok(r.ok)
    assert.match(r.driveNote || '', /the Mac kept the drive’s old name \(disk busy\)/)
    assert.equal(r.mount, '/Volumes/JT RED')
  })
})

describe('homemini hears the name: PATCH now, or before the next list read', () => {
  it('PATCHes /api/ipod-lists/:id with {name}', async () => {
    const seen: Array<{ url: string; init?: Record<string, unknown> }> = []
    const fetchImpl: FetchLike = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) } }
    const c = createIpodListClient({ baseUrl: 'http://homemini:3000', fetchImpl, warn: () => {} })
    assert.equal(await c.rename(PUNK_ID, 'punkPod'), true)
    assert.equal(seen[0].url, `http://homemini:3000/api/ipod-lists/${PUNK_ID}`)
    assert.equal(seen[0].init?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { name: 'punkPod' })
    const down: FetchLike = async () => { throw new Error('ECONNREFUSED') }
    assert.equal(await createIpodListClient({ baseUrl: 'http://x', fetchImpl: down, warn: () => {} }).rename(PUNK_ID, 'p'), false)
  })
  it('a waiting name is sent once homemini answers, then forgotten', async () => {
    const state = tmp('jt-rename-pending-')
    await queueHomeminiName(state, PUNK_ID, 'punkPod')
    let up = false
    const sent: string[] = []
    const send = async (id: string, name: string) => { sent.push(`${id}:${name}`); return up }
    assert.equal(await flushHomeminiName(state, PUNK_ID, send), 'still-waiting')
    up = true
    assert.equal(await flushHomeminiName(state, PUNK_ID, send), 'sent')
    assert.equal(await flushHomeminiName(state, PUNK_ID, send), 'none')
    assert.deepEqual(sent, [`${PUNK_ID}:punkPod`, `${PUNK_ID}:punkPod`])
  })
})

describe('wiring (source locks)', () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf-8')
  it('every list read flushes a waiting name first (every sync reads the list)', () => {
    const src = read('main/ipc/ipod-lists-ipc.ts')
    assert.ok(src.indexOf('flushHomeminiName(') < src.indexOf('return refreshIpodPool({'))
  })
  it('the drive is renamed by device id, and the mount is followed without a new plug-in', () => {
    const rn = read('main/ipod-rename.ts')
    assert.match(rn, /execP\('diskutil', \['rename', dev, label\]/)
    const ipc = read('main/ipc/ipod-ipc.ts')
    assert.match(ipc, /followMount: \(mount\) => host\.setMount\(\{ mount, volume: volumeNameFromMount\(mount\), missStreak: 0 \}\)/)
  })
  it('the next sync writes the name into the iPod’s own catalog', () => {
    const engine = read('main/ipod-activity-engine.ts')
    assert.match(engine, /JSON\.stringify\(\{ tracks, playlists, masterName: input\.ipodName \}\)/)
    const sync = read('main/sync-engine/index.ts')
    assert.match(sync, /ipodName = ipod\.device\?\.name/)
    assert.match(sync, /JSON\.stringify\(\{ tracks, playlists, masterName: ipodName \}\)/)
    const py = readFileSync(join(import.meta.dirname, '..', '..', '..', 'core', 'db_reader.py'), 'utf-8')
    assert.match(py, /build_mhyp_record\(master_name, all_dbids, is_master=True/)
    assert.match(py, /master_name=input_data\.get\('masterName'\)/)
  })
  it('the Device page renames by clicking the name', () => {
    const dv = read('renderer/views/DeviceView.tsx')
    assert.match(dv, /renameIpodDevice\?\.\(check\.name\)/)
    assert.match(dv, /className="device-sync-name"/)
    assert.match(dv, /macShowsLine\(check\)/)
  })
})
