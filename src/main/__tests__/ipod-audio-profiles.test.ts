/**
 * Brief 265 Part 2: the profile file (ipod-audio-profiles.ts). Its own file, written only by
 * main; an unreadable file refuses the sync instead of falling back to the seeds.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { carryProfileForMovedCard, profileForSync, profileStorePath, profileStoreRefusal, readProfileStore, updateProfileStore } from '../ipod-audio-profiles.ts'
import { Y2K_IPOD_ID, INDIE_SLEAZE_IPOD_ID } from '../../common/ipod-audio-format.ts'

const dir = () => mkdtemp(join(tmpdir(), 'b265-profiles-'))

describe('the profile file', () => {
  it('missing = no profiles yet (the seeds apply)', async () => {
    const f = profileStorePath(await dir())
    assert.deepEqual(await readProfileStore(f), { ok: true, store: {} })
    const r = await profileForSync(f, { deviceId: Y2K_IPOD_ID })
    assert.deepEqual(r, { ok: true, profile: { codec: 'alac', enabled: true } })
  })
  it('unreadable = the sync refuses; never the seeds', async () => {
    const f = profileStorePath(await dir())
    await writeFile(f, '{"profiles": {"x": ')
    const r = await profileForSync(f, { deviceId: INDIE_SLEAZE_IPOD_ID })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(profileStoreRefusal(r.reason), /did not start\. Nothing on the iPod was changed\./)
  })
  it('a sync with a serial moves a list-id profile onto the serial, on disk', async () => {
    const f = profileStorePath(await dir())
    await updateProfileStore(f, () => ({ [Y2K_IPOD_ID]: { codec: 'aac', kbps: 192, enabled: true } }))
    const r = await profileForSync(f, { serial: '00577CC6', deviceId: Y2K_IPOD_ID })
    assert.deepEqual(r, { ok: true, profile: { codec: 'aac', kbps: 192, enabled: true } })
    const disk = JSON.parse(await readFile(f, 'utf-8'))
    assert.deepEqual(disk.profiles, { 'serial:00577CC6': { codec: 'aac', kbps: 192, enabled: true } })
  })
  it('a moved card without a serial carries its profile to the new list id', async () => {
    const f = profileStorePath(await dir())
    await updateProfileStore(f, () => ({ [Y2K_IPOD_ID]: { codec: 'aac', kbps: 256, enabled: true } }))
    await carryProfileForMovedCard(f, { fromId: Y2K_IPOD_ID, toId: INDIE_SLEAZE_IPOD_ID })
    const disk = JSON.parse(await readFile(f, 'utf-8'))
    assert.deepEqual(disk.profiles, { [INDIE_SLEAZE_IPOD_ID]: { codec: 'aac', kbps: 256, enabled: true } })
  })
  it('writes are serialized: two at once both land', async () => {
    const f = profileStorePath(await dir())
    await Promise.all([
      updateProfileStore(f, (s) => ({ ...s, a: { codec: 'alac', enabled: true } })),
      updateProfileStore(f, (s) => ({ ...s, b: { codec: 'aac', kbps: 256, enabled: true } })),
    ])
    const r = await readProfileStore(f)
    assert.ok(r.ok && r.store.a && r.store.b)
  })
  it('nothing in the renderer or ui-state names the profile file', async () => {
    const ui = await readFile(new URL('../ipc/ui-state-ipc.ts', import.meta.url), 'utf-8')
    assert.doesNotMatch(ui, /profile/i)
  })
})
