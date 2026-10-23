/** Which iPod is plugged in — the fs half, against fake cards in a temp dir. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { identifyIpod, registerIpod, refuseUnlessOriginalIpod } from '../ipod-identity.ts'

// Same synthetic iTunesDB as ipod-roundtrip.test.ts (catalog paths only).
function db(paths: string[]): Buffer {
  const mhits = paths.map((p) => {
    const str = Buffer.from(p, 'utf16le')
    const m = Buffer.alloc(0x28 + str.length)
    m.write('mhod', 0, 'latin1'); m.writeUInt32LE(0x18, 4); m.writeUInt32LE(m.length, 8)
    m.writeUInt32LE(2, 12); m.writeUInt32LE(str.length, 0x1c); str.copy(m, 0x28)
    const b = Buffer.alloc(156 + m.length)
    b.write('mhit', 0, 'latin1'); b.writeUInt32LE(156, 4); b.writeUInt32LE(b.length, 8); b.writeUInt32LE(1, 12)
    m.copy(b, 156)
    return b
  })
  const tracksLen = mhits.reduce((n, b) => n + b.length, 0)
  const mhlt = Buffer.alloc(92); mhlt.write('mhlt', 0, 'latin1'); mhlt.writeUInt32LE(92, 4); mhlt.writeUInt32LE(mhits.length, 8)
  const sec1 = Buffer.alloc(96); sec1.write('mhsd', 0, 'latin1'); sec1.writeUInt32LE(96, 4)
  sec1.writeUInt32LE(96 + 92 + tracksLen, 8); sec1.writeUInt32LE(1, 12)
  const head = Buffer.alloc(104); head.write('mhbd', 0, 'latin1'); head.writeUInt32LE(104, 4)
  return Buffer.concat([head, sec1, mhlt, ...mhits])
}

const synced = Array.from({ length: 40 }, (_, i) => `:iPod_Control:Music:F0${i % 5}:s${i}.m4a`)
const wholeLibrary = [...synced, ...Array.from({ length: 400 }, (_, i) => `:iPod_Control:Music:F0${i % 5}:x${i}.m4a`)]

async function card(root: string, name: string, paths: string[]): Promise<string> {
  const mount = join(root, name)
  await mkdir(join(mount, 'iPod_Control', 'iTunes'), { recursive: true })
  await writeFile(join(mount, 'iPod_Control', 'iTunes', 'iTunesDB'), db(paths))
  return mount
}

describe('identifying iPods', () => {
  test('original is recognised from the last sync; red Mini is not; red gets its own ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ipod-id-'))
    const state = join(root, 'state'); await mkdir(state)
    await writeFile(join(state, 'last-sync-manifest.json'), JSON.stringify({ tracks: synced.map((destPath, id) => ({ id, destPath })) }))
    const original = await card(root, 'JAKETUNES', synced)
    const red = await card(root, 'RED', wholeLibrary)

    // The red Mini first: no original registered yet, but it does not look like the last sync.
    const redFirst = await identifyIpod(red, state)
    assert.deepEqual(redFirst, { status: 'unknown', canBeOriginal: true })
    assert.ok(await refuseUnlessOriginalIpod(red, state))

    // The original: adopted automatically, ID written to the card.
    const o = await identifyIpod(original, state)
    assert.equal(o.status, 'known')
    assert.equal(o.status === 'known' && o.device.primary, true)
    assert.equal(o.status === 'known' && o.device.purpose, 'My top 1000 songs')
    const onCard = JSON.parse(await readFile(join(original, 'iPod_Control', 'jaketunes-device.json'), 'utf-8'))
    assert.equal(onCard.primary, true)
    assert.equal(await refuseUnlessOriginalIpod(original, state), null)

    // Red, now that an original exists: cannot claim to be it.
    assert.deepEqual(await identifyIpod(red, state), { status: 'unknown', canBeOriginal: false })
    const claim = await registerIpod(red, state, { asOriginal: true })
    assert.equal(claim.ok, false)

    // Set up as a new iPod: known, not primary, still refused for writes.
    const r = await registerIpod(red, state, { asOriginal: false, name: 'Red', color: 'red', purpose: '' })
    assert.equal(r.ok, true)
    const ri = await identifyIpod(red, state)
    assert.equal(ri.status === 'known' && ri.device.name, 'Red')
    assert.equal(ri.status === 'known' && ri.device.primary, false)
    assert.match(await refuseUnlessOriginalIpod(red, state) || '', /Red doesn’t have its own Pool/)

    // Both are in this Mac's list.
    const reg = JSON.parse(await readFile(join(state, 'ipod-devices.json'), 'utf-8'))
    assert.equal(reg.devices.length, 2)
    // Registering twice is refused.
    assert.equal((await registerIpod(red, state, { asOriginal: false, name: 'Red again' })).ok, false)
  })

  test('a Mac with no sync history asks instead of guessing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ipod-id-'))
    const state = join(root, 'state'); await mkdir(state)
    const original = await card(root, 'JAKETUNES', synced)
    assert.deepEqual(await identifyIpod(original, state), { status: 'unknown', canBeOriginal: true })
    const r = await registerIpod(original, state, { asOriginal: true })
    assert.equal(r.ok && r.device.name, 'Original')
    assert.equal(await refuseUnlessOriginalIpod(original, state), null)
  })

  test('an unreadable card fails closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ipod-id-'))
    const state = join(root, 'state'); await mkdir(state)
    assert.ok(await refuseUnlessOriginalIpod(join(root, 'nope'), state))
  })
})
