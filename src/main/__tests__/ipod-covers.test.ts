/**
 * The iPod covers (2026-11-09). Jake: "the playlist photos should be their respective ipods. so
 * silver ipod mini is the top 1000. red ipod mini is the punkpod. if i dont have one use a default
 * ipod photo to which i can customize color".
 *
 *   • colours: a named iPod colour or '#rrggbb', anything else ignored (twin of homemini's rules)
 *   • the look: Jake's choice on this Mac, then a registered iPod's registry colour, then homemini's
 *     list colour, then the model's default; Top 1000 = the Original's mini, silver unless its
 *     registry colour says otherwise
 *   • the picture: a named colour is bundled; a custom one shows its nearest named colour until
 *     homemini's exact picture arrives, which is kept for good (a 'nearest' answer never is)
 *   • "iPod color…": kept on disk before homemini is asked, waits when homemini is away, goes later
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IPOD_COLORS, IPOD_MODELS, ipodCoverChoice, ipodCoverKey, ipodCoverPath, ipodLook, isIpodModel,
  nearestIpodColor, normalizeIpodColor, parseIpodCoverKey, top1000Look,
} from '../../common/ipod-covers.ts'
import { parseIpodList } from '../../common/ipod-list-doc.ts'
import { chooseIpodColor, flushPendingColors, readChosenColors, readPendingColors, CHOSEN_FILE } from '../ipod-colors.ts'
import { ipodCoverDataUrl } from '../ipod-cover-cache.ts'
import { gatherIpodLists, ipodListsCachePath } from '../ipod-lists-gather.ts'
import { buildDeviceMarker } from '../../common/ipod-identity.ts'
import type { IpodList } from '../../common/ipod-list-doc.ts'

const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'ipod-covers-')); dirs.push(d); return d }

const PUNK_ID = '0d8fc490-74d1-4232-9a35-1801a66f4fde'
const now = '2026-11-09T00:00:00.000Z'

describe('colours', () => {
  it('a named colour or #rrggbb, trimmed and lowercased; anything else is ignored', () => {
    assert.equal(normalizeIpodColor(' Red '), 'red')
    assert.equal(normalizeIpodColor('#C51F2E'), '#c51f2e')
    for (const bad of ['', 'crimson', '#fff', '#12345g', 'rgb(1,2,3)', null, 3, '#c51f2e00']) {
      assert.equal(normalizeIpodColor(bad), null, String(bad))
    }
  })
  it('the table is the eleven colours homemini draws, and the four models', () => {
    assert.deepEqual(IPOD_COLORS.map((c) => c.name), ['silver', 'gold', 'pink', 'blue', 'green', 'red', 'purple', 'orange', 'yellow', 'black', 'white'])
    assert.deepEqual([...IPOD_MODELS], ['mini', 'classic', '3g', 'default'])
    assert.ok(isIpodModel('3g') && !isIpodModel('nano'))
  })
  it('the nearest named colour: smallest RGB distance; a name is itself', () => {
    assert.equal(nearestIpodColor('#c0202f'), 'red')
    assert.equal(nearestIpodColor('#000000'), 'black')
    assert.equal(nearestIpodColor('#ffffff'), 'white')
    assert.equal(nearestIpodColor('gold'), 'gold')
  })
  it('the file a cover is kept under, and only such keys parse back', () => {
    assert.equal(ipodCoverKey('mini', 'red'), 'mini-red')
    assert.equal(ipodCoverKey('classic', '#c51f2e'), 'classic-c51f2e')
    assert.deepEqual(parseIpodCoverKey('classic-c51f2e'), { model: 'classic', color: '#c51f2e' })
    assert.deepEqual(parseIpodCoverKey('3g-white'), { model: '3g', color: 'white' })
    for (const bad of ['../x', 'mini-crimson', 'nano-red', 'mini-c51f2', 'mini-red/..']) assert.equal(parseIpodCoverKey(bad), null, bad)
    assert.equal(ipodCoverPath({ model: 'mini', color: '#c51f2e' }), '/api/playlist-cover/ipod/mini/c51f2e')
  })
})

describe('which iPod a list wears', () => {
  it('a registered iPod: Jake\'s choice here, then the registry colour, then homemini\'s, then the default', () => {
    assert.deepEqual(ipodLook({ model: 'mini', listColor: 'blue', registryColor: 'red', registered: true }), { model: 'mini', color: 'red' })
    assert.deepEqual(ipodLook({ model: 'mini', listColor: 'blue', registryColor: 'red', registered: true, chosen: 'green' }), { model: 'mini', color: 'green' })
    assert.deepEqual(ipodLook({ model: 'mini', listColor: 'blue', registryColor: 'sticker-ish', registered: true }), { model: 'mini', color: 'blue' })
    assert.deepEqual(ipodLook({ model: 'mini', registered: true }), { model: 'mini', color: 'silver' })
  })
  it('a list no iPod here carries: the registry never counts', () => {
    assert.deepEqual(ipodLook({ model: 'classic', listColor: 'black', registryColor: 'red', registered: false }), { model: 'classic', color: 'black' })
  })
  it('defaults: no model is the default iPod; each model has its own colour', () => {
    assert.deepEqual(ipodLook({}), { model: 'default', color: 'white' })
    assert.deepEqual(ipodLook({ model: '3g' }), { model: '3g', color: 'white' })
    assert.deepEqual(ipodLook({ model: 'classic' }), { model: 'classic', color: 'silver' })
    assert.deepEqual(ipodLook({ model: 'nano', listColor: 'pink' }), { model: 'default', color: 'pink' })
  })
  it('Top 1000 is the Original: a mini, silver unless its registry colour says otherwise', () => {
    assert.deepEqual(top1000Look(null), { model: 'mini', color: 'silver' })
    assert.deepEqual(top1000Look('#c0c0c0'), { model: 'mini', color: '#c0c0c0' })
    assert.deepEqual(top1000Look('Gold'), { model: 'mini', color: 'gold' })
    assert.deepEqual(top1000Look('sparkly'), { model: 'mini', color: 'silver' })
  })
})

describe('which picture', () => {
  it('a named colour is bundled and exact', () => {
    assert.deepEqual(ipodCoverChoice({ model: 'mini', color: 'red' }), { bundledKey: 'mini-red', fetchKey: null })
  })
  it('a custom colour shows its nearest named colour and asks for its own', () => {
    assert.deepEqual(ipodCoverChoice({ model: 'mini', color: '#c0202f' }), { bundledKey: 'mini-red', fetchKey: 'mini-c0202f' })
  })
  it('a colour change picks a new picture', () => {
    const a = ipodCoverChoice(ipodLook({ model: 'mini', listColor: 'red' }))
    const b = ipodCoverChoice(ipodLook({ model: 'mini', listColor: 'blue' }))
    assert.notEqual(a.bundledKey, b.bundledKey)
  })
  it('every model in every named colour ships with the app', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'assets', 'ipod-covers')
    const files = new Set(readdirSync(dir))
    for (const m of IPOD_MODELS) for (const c of IPOD_COLORS) assert.ok(files.has(`${ipodCoverKey(m, c.name)}.jpg`), `${m}-${c.name}`)
    const top = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'assets', 'playlist-covers')
    assert.ok(existsSync(join(top, 'top-1000.jpg')))
    assert.ok(!existsSync(join(top, `ipod-list-${PUNK_ID}.jpg`)), 'the old iPod EVIL cover is gone')
  })
})

describe('homemini\'s list carries the look', () => {
  const base = { id: PUNK_ID, name: 'punkPod', purpose: null, cap: 1000, ids: [1], adds: [], removed: [], updatedAt: now, brain: { enabled: true, perDay: 1 } }
  it('model and colour are kept, normalized', () => {
    const l = parseIpodList({ ...base, model: 'mini', color: '#C51F2E' })!
    assert.equal(l.model, 'mini')
    assert.equal(l.color, '#c51f2e')
  })
  it('a bad one is dropped, never the list', () => {
    const l = parseIpodList({ ...base, model: 'zune', color: 'crimson' })!
    assert.ok(l)
    assert.equal(l.model, undefined)
    assert.equal(l.color, undefined)
  })
})

describe('the hub\'s gather', () => {
  const list = (id: string, extra: Partial<IpodList>): IpodList => ({ id, name: id, purpose: null, cap: 1000, ids: [], adds: [], removed: [], updatedAt: now, brain: { enabled: true, perDay: 1 }, ...extra })
  const original = buildDeviceMarker({ id: 'original-58ebb78e', name: 'Original', primary: true, now })!
  const punk = buildDeviceMarker({ id: PUNK_ID, name: 'punkPod', color: 'red', primary: false, now })!
  const run = (chosen: Record<string, string>) => {
    const stateDir = tmp()
    return gatherIpodLists({
      isReplica: async () => false,
      registry: async () => [original, punk],
      refresh: async () => ({ poolIds: [], listIds: [], names: {}, source: 'homemini', note: null, updatedAt: now }),
      all: async () => [list(PUNK_ID, { model: 'mini', color: 'blue' }), list('y2k-revival-01', { model: 'mini' }), list('best-of-bandcamp', { model: 'classic', color: '#123456' })],
      cacheFile: ipodListsCachePath(stateDir),
      chosen: async () => chosen,
    })
  }
  it('a registered iPod\'s registry colour wins over homemini\'s; the model comes from homemini', async () => {
    const r = await run({})
    const p = r.lists.find((l) => l.id === PUNK_ID)!
    assert.equal(p.model, 'mini')
    assert.equal(p.color, 'red')
    const y = r.lists.find((l) => l.id === 'y2k-revival-01')!
    assert.deepEqual([y.model, y.color], ['mini', 'silver'])
    const b = r.lists.find((l) => l.id === 'best-of-bandcamp')!
    assert.deepEqual([b.model, b.color], ['classic', '#123456'])
  })
  it('Jake\'s choice on this Mac wins over the registry', async () => {
    const r = await run({ [PUNK_ID]: 'pink' })
    assert.equal(r.lists.find((l) => l.id === PUNK_ID)!.color, 'pink')
  })
})

describe('"iPod color…"', () => {
  const registry = (dir: string) => writeFileSync(join(dir, 'ipod-devices.json'), JSON.stringify({ devices: [
    buildDeviceMarker({ id: 'original-58ebb78e', name: 'Original', primary: true, now }),
    buildDeviceMarker({ id: PUNK_ID, name: 'punkPod', color: 'red', primary: false, now }),
  ] }))

  it('homemini away: kept here and in the registry, waits, and goes when homemini answers', async () => {
    const dir = tmp()
    registry(dir)
    const sent: string[] = []
    let up = false
    const send = async (id: string, c: string) => { if (!up) return false; sent.push(`${id}:${c}`); return true }
    const r = await chooseIpodColor({ stateDir: dir, send, hub: true }, PUNK_ID, 'Green')
    assert.deepEqual(r, { ok: true, color: 'green', homemini: 'later', registry: true })
    assert.deepEqual(await readChosenColors(dir), { [PUNK_ID]: 'green' })
    assert.deepEqual(await readPendingColors(dir), { [PUNK_ID]: 'green' })
    const reg = JSON.parse(readFileSync(join(dir, 'ipod-devices.json'), 'utf-8')) as { devices: Array<{ id: string; color: string; name: string }> }
    assert.equal(reg.devices.find((d) => d.id === PUNK_ID)!.color, 'green')
    assert.equal(reg.devices.find((d) => d.id === PUNK_ID)!.name, 'punkPod', 'nothing else in the entry moves')
    assert.equal(await flushPendingColors(dir, send), 'still-waiting')
    up = true
    assert.equal(await flushPendingColors(dir, send), 'sent')
    assert.deepEqual(sent, [`${PUNK_ID}:green`])
    assert.deepEqual(await readPendingColors(dir), {})
    assert.equal(await flushPendingColors(dir, send), 'none')
  })

  it('homemini there: saved at once, nothing left waiting', async () => {
    const dir = tmp()
    const r = await chooseIpodColor({ stateDir: dir, send: async () => true, hub: true }, PUNK_ID, '#C0202F')
    assert.deepEqual(r, { ok: true, color: '#c0202f', homemini: 'saved', registry: false })
    assert.deepEqual(await readPendingColors(dir), {})
  })

  it('a replica only tells homemini: no choice file', async () => {
    const dir = tmp()
    await chooseIpodColor({ stateDir: dir, send: async () => true, hub: false }, PUNK_ID, 'blue')
    assert.ok(!existsSync(join(dir, CHOSEN_FILE)))
  })

  it('refuses a colour it doesn\'t know and an id that isn\'t one', async () => {
    const dir = tmp()
    assert.equal((await chooseIpodColor({ stateDir: dir, send: async () => true, hub: true }, PUNK_ID, 'crimson')).ok, false)
    assert.equal((await chooseIpodColor({ stateDir: dir, send: async () => true, hub: true }, '../x', 'red')).ok, false)
  })
})

describe('a custom-colour cover from homemini', () => {
  const jpeg = Buffer.alloc(4000, 7)
  it('an exact picture is kept for good: the second ask never reaches homemini', async () => {
    const dir = tmp()
    let asks = 0
    const fetchCover = async (path: string) => { asks++; assert.match(path, /^\/api\/playlist-cover\/ipod\/mini\/c0202f\?s=\d+$/); return { bytes: jpeg, exact: true } }
    const a = await ipodCoverDataUrl({ stateDir: dir, fetchCover }, 'mini-c0202f')
    assert.ok(a?.startsWith('data:image/jpeg;base64,'))
    const b = await ipodCoverDataUrl({ stateDir: dir, fetchCover: async () => { throw new Error('offline') } }, 'mini-c0202f')
    assert.equal(b, a)
    assert.equal(asks, 1)
  })
  it('a nearest-colour stand-in is never kept; offline is null', async () => {
    const dir = tmp()
    assert.equal(await ipodCoverDataUrl({ stateDir: dir, fetchCover: async () => ({ bytes: jpeg, exact: false }) }, 'mini-c0202f'), null)
    assert.ok(!existsSync(join(dir, 'ipod-covers', 'mini-c0202f.jpg')))
    assert.equal(await ipodCoverDataUrl({ stateDir: dir, fetchCover: async () => null }, 'mini-c0202f'), null)
  })
  it('a named colour or a bad key never asks homemini', async () => {
    const dir = tmp()
    const fetchCover = async () => { throw new Error('must not ask') }
    assert.equal(await ipodCoverDataUrl({ stateDir: dir, fetchCover }, 'mini-red'), null)
    assert.equal(await ipodCoverDataUrl({ stateDir: dir, fetchCover }, '../../etc'), null)
  })
})
