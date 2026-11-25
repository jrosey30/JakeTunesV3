/**
 * Brief 265: the Device page's iPod format and convert-cache controls.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CACHE_CAPS, EMPTY_COST, FORMAT_CHOICES, LIMIT_COST, changeFor, choiceOf } from '../../renderer/ipodFormatChoice.ts'
import { planPrune, pruneToCap } from '../sync-convert-cache.ts'
import { mirrorNamesFor, protectedMirrorNames } from '../sync-convert-cache-protect.ts'
import { aacMirrorCacheName, ipodAlacMirrorCacheName } from '../aac-mirror-recipe.ts'
import { mkdir, writeFile, readdir, utimes } from 'node:fs/promises'
import { profileSource } from '../ipc/ipod-profile-ipc.ts'
import { profileForSync, profileStorePath, updateProfileStore } from '../ipod-audio-profiles.ts'
import { INDIE_SLEAZE_IPOD_ID, Y2K_IPOD_ID, parseProfileStore } from '../../common/ipod-audio-format.ts'

describe('the format choice', () => {
  it('shows a profile as its choice; none or switched off shows the convert setting', () => {
    assert.equal(choiceOf({ codec: 'aac', kbps: 256, enabled: true }), 'aac-256')
    assert.equal(choiceOf({ codec: 'mp3', kbps: 320, enabled: true }), 'mp3-320')
    assert.equal(choiceOf({ codec: 'alac', enabled: true }), 'alac')
    assert.equal(choiceOf({ codec: 'aac', kbps: 256, enabled: false }), 'off')
    assert.equal(choiceOf(null), 'off')
  })
  it('every choice saves a profile the store accepts, and round-trips', () => {
    for (const c of FORMAT_CHOICES) {
      const change = changeFor(c.value, { codec: 'aac', kbps: 192, enabled: true })
      const store = parseProfileStore({ x: change })
      assert.ok(store.x, `${c.value} saves`)
      assert.equal(choiceOf(store.x), c.value)
    }
  })
  it('the cache size limit is off by default: nothing is emptied until Jake picks a size', () => {
    assert.equal(CACHE_CAPS[0].value, null)
    assert.match(CACHE_CAPS[0].label, /No limit/)
  })
  it('emptying and a limit say plainly what they cost', () => {
    assert.match(EMPTY_COST, /converted again/)
    assert.match(EMPTY_COST, /full copy converts every song/)
    assert.match(EMPTY_COST, /hours/)
    assert.match(EMPTY_COST, /stutters/)
    assert.match(LIMIT_COST, /never takes the copies the songs on your iPods were made from/)
  })
})

describe('where the page says the format comes from', () => {
  it('stored (by serial or ID file), Jake\'s default, or the convert setting', () => {
    const store = parseProfileStore({ 'serial:00577CC6': { codec: 'aac', kbps: 256, enabled: true } })
    assert.equal(profileSource(store, { serial: '00577CC6', deviceId: Y2K_IPOD_ID }), 'stored')
    assert.equal(profileSource({}, { deviceId: Y2K_IPOD_ID }), 'seed')
    assert.equal(profileSource({}, { deviceId: 'original-x', primary: true }), 'seed')
    assert.equal(profileSource({}, { deviceId: 'someone-new' }), 'device-page')
  })
  it('a format saved the way the page saves it is what the next sync of that iPod reads', async () => {
    const f = profileStorePath(await mkdtemp(join(tmpdir(), 'b265-fmt-')))
    await updateProfileStore(f, (s) => ({ ...s, [INDIE_SLEAZE_IPOD_ID]: changeFor('aac-320', null) }))
    assert.deepEqual(await profileForSync(f, { deviceId: INDIE_SLEAZE_IPOD_ID }), { ok: true, profile: { codec: 'aac', kbps: 320, enabled: true } })
  })
})

describe('the page', () => {
  it('sits in the Device page\'s Options, above the convert setting, and empties the cache only after a confirm', async () => {
    const view = await readFile(new URL('../../renderer/views/DeviceView.tsx', import.meta.url), 'utf-8')
    const at = view.indexOf('<IpodFormatOptions />')
    assert.ok(at > 0 && at < view.indexOf('optConvertBitrate}'), 'above the convert checkbox it points to')
    const comp = await readFile(new URL('../../renderer/components/IpodFormatOptions.tsx', import.meta.url), 'utf-8')
    assert.match(comp, /<ConfirmDialog[\s\S]*message="Empty the converted copies\?"[\s\S]*onConfirm=\{\(\) => \{ void empty\(\) \}\}/)
    assert.doesNotMatch(comp, /window\.(confirm|alert|prompt)/)
  })
  it('the format can\'t change during a sync', async () => {
    const ipc = await readFile(new URL('../ipc/ipod-profile-ipc.ts', import.meta.url), 'utf-8')
    assert.match(ipc, /if \(host\.syncInFlight\(\)\) return \{ ok: false, error: 'An iPod sync is running\./)
  })
})

describe('a size limit never takes a copy a song on an iPod was made from', () => {
  it('planPrune skips protected names even if that leaves the cache over the limit', () => {
    const files = [
      { name: 'old-protected.m4a', path: '', size: 500, usedMs: 1, mtimeMs: 1 },
      { name: 'old.m4a', path: '', size: 500, usedMs: 2, mtimeMs: 2 },
      { name: 'new.m4a', path: '', size: 500, usedMs: 3, mtimeMs: 3 },
    ]
    assert.deepEqual(planPrune(files, 500, new Set(['old-protected.m4a'])).map((f) => f.name), ['old.m4a', 'new.m4a'])
    assert.deepEqual(planPrune(files, 0, new Set(files.map((f) => f.name))), [], 'all protected: nothing goes')
  })
  it('the protected names: every recipe\'s copy of every song on every iPod, from their last sync records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b265-protect-'))
    const state = join(root, 'state')
    await mkdir(join(state, 'ipod-pools', 'nano'), { recursive: true })
    await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify({ tracks: [{ id: 1 }] }))                 // the Original
    await writeFile(join(state, 'ipod-pools', 'nano', 'last-sync-manifest.json'), JSON.stringify({ tracks: [{ id: 2 }] }))
    const tracks = [{ id: 1, path: ':iPod_Control:Music:F01:A.flac' }, { id: 2, path: ':iPod_Control:Music:F02:B.m4a' }, { id: 3, path: ':iPod_Control:Music:F03:C.m4a' }]
    const names = await protectedMirrorNames({ stateDir: state, libraryRoot: '/Lib', tracks })
    assert.ok(names.has(ipodAlacMirrorCacheName('/Lib/iPod_Control/Music/F01/A.flac')), 'the Original\'s FLAC rescue')
    assert.ok(names.has(aacMirrorCacheName('/Lib/iPod_Control/Music/F02/B.m4a', 256)), 'the nano\'s AAC')
    assert.ok(!names.has(aacMirrorCacheName('/Lib/iPod_Control/Music/F03/C.m4a', 256)), 'a song on no iPod is not protected')
    assert.equal(mirrorNamesFor('/x').length, 9)
  })
  it('pruneToCap with the protect set: an iPod\'s copy survives a limit of 1 GB; an unprotected older one goes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b265-protect-cap-'))
    const keep = aacMirrorCacheName('/Lib/x.m4a', 256)
    await writeFile(join(dir, keep), Buffer.alloc(10)); await truncate(join(dir, keep), 900_000_000)
    await writeFile(join(dir, 'spare.m4a'), Buffer.alloc(10)); await truncate(join(dir, 'spare.m4a'), 900_000_000)
    const t = new Date(Date.now() - 3_600_000)
    await utimes(join(dir, keep), t, t)   // the protected one is the least recently used
    const r = await pruneToCap(dir, 1, { syncInFlight: () => false, protect: async () => new Set([keep]) })
    assert.equal(r.pruned, true)
    assert.deepEqual(await readdir(dir), [keep])
    const failing = await pruneToCap(dir, 0.1, { syncInFlight: () => false, protect: async () => { throw new Error('no library') } })
    assert.equal(failing.pruned, false, 'when the protected copies can\'t be worked out, nothing is taken')
    assert.deepEqual(await readdir(dir), [keep])
  })
})
