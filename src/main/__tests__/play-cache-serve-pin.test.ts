import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServePin } from '../play-cache-serve-pin.ts'

const raw = { kind: 'local' as const, path: '/lib/set.m4a' }
const flac = { kind: 'local' as const, path: '/cache/set.flac' }

test('a load that began on the raw file keeps getting the raw file after the cache lands', () => {
  const pin = createServePin()
  const yes = () => true
  assert.deepEqual(pin.resolve('u', raw, 0, yes), raw)                 // first request: raw (no cache yet)
  assert.deepEqual(pin.resolve('u', raw, 1_000_000, yes), raw)
  assert.deepEqual(pin.resolve('u', flac, 50_000_000, yes), raw)       // cache landed mid-play → still raw
  assert.deepEqual(pin.resolve('u', flac, 0, yes), flac)               // a NEW load picks the cache
  assert.deepEqual(pin.resolve('u', flac, 9_000, yes), flac)
})

test('a pinned file that vanished re-picks; remote pins hold too', () => {
  const pin = createServePin()
  assert.deepEqual(pin.resolve('u', raw, 0, () => true), raw)
  assert.deepEqual(pin.resolve('u', flac, 500, (p) => p !== '/lib/set.m4a'), flac)
  const pin2 = createServePin()
  assert.deepEqual(pin2.resolve('v', { kind: 'remote' }, 0, () => true), { kind: 'remote' })
  assert.deepEqual(pin2.resolve('v', flac, 4096, () => true), { kind: 'remote' })
  assert.equal(pin2.pinned('v')?.kind, 'remote')
})

test('rangeStart parses the header', () => {
  const pin = createServePin()
  assert.equal(pin.rangeStart(null), 0)
  assert.equal(pin.rangeStart('bytes=0-'), 0)
  assert.equal(pin.rangeStart('bytes=12345-99999'), 12345)
})
