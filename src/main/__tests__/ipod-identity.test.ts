import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDeviceMarker, catalogMatchesManifest, ipodWriteRefusal, parseDeviceMarker, shouldAutoAdoptOriginal,
} from '../../common/ipod-identity.ts'

const now = '2026-10-23T12:00:00.000Z'

describe('device marker', () => {
  it('round-trips a valid marker and trims its text', () => {
    const m = buildDeviceMarker({ id: 'abc12345-red', name: '  Red  ', color: 'red', purpose: ' late   night ', primary: false, now })
    assert.ok(m)
    assert.equal(m.name, 'Red')
    assert.equal(m.purpose, 'late night')
    assert.deepEqual(parseDeviceMarker(JSON.parse(JSON.stringify(m))), m)
  })
  it('rejects junk: no name, bad id, wrong version', () => {
    assert.equal(buildDeviceMarker({ id: 'abc12345', name: '   ', primary: false, now }), null)
    assert.equal(parseDeviceMarker({ version: 1, id: '../../etc', name: 'x' }), null)
    assert.equal(parseDeviceMarker({ version: 2, id: 'abc12345', name: 'x' }), null)
    assert.equal(parseDeviceMarker(null), null)
  })
  it('primary only when exactly true', () => {
    assert.equal(parseDeviceMarker({ version: 1, id: 'abc12345', name: 'x', primary: 'yes' })?.primary, false)
  })
})

describe('recognising the original by its last sync', () => {
  const synced = Array.from({ length: 1000 }, (_, i) => `:iPod_Control:Music:F${i % 50}:s${i}.m4a`)
  it('matches the card the last sync built', () => {
    assert.equal(catalogMatchesManifest(synced, synced), true)
    assert.equal(catalogMatchesManifest(synced.slice(10), synced), true)
  })
  it('does NOT match the red Mini, which carries the whole library (manifest ⊂ card)', () => {
    const wholeLibrary = [...synced, ...Array.from({ length: 11000 }, (_, i) => `:iPod_Control:Music:F${i % 50}:x${i}.m4a`)]
    assert.equal(catalogMatchesManifest(wholeLibrary, synced), false)
  })
  it('does not match an unrelated card or empty inputs', () => {
    assert.equal(catalogMatchesManifest(['a', 'b'], synced), false)
    assert.equal(catalogMatchesManifest([], synced), false)
    assert.equal(catalogMatchesManifest(synced, []), false)
  })
  it('auto-adopts only when no original is registered yet', () => {
    assert.equal(shouldAutoAdoptOriginal({ registryHasPrimary: false, catalogMatch: true }), true)
    assert.equal(shouldAutoAdoptOriginal({ registryHasPrimary: true, catalogMatch: true }), false)
    assert.equal(shouldAutoAdoptOriginal({ registryHasPrimary: false, catalogMatch: false }), false)
  })
})

describe('only the original iPod is written to', () => {
  it('refuses unknown and non-original iPods, allows the original', () => {
    assert.match(ipodWriteRefusal({ status: 'unknown', canBeOriginal: true }) || '', /doesn’t know this iPod/)
    const red = buildDeviceMarker({ id: 'abc12345-red', name: 'Red', primary: false, now })!
    assert.match(ipodWriteRefusal({ status: 'known', device: red }) || '', /Red doesn’t have its own Pool/)
    const orig = buildDeviceMarker({ id: 'original-1234', name: 'Original', primary: true, now })!
    assert.equal(ipodWriteRefusal({ status: 'known', device: orig }), null)
  })
})
