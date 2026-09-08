import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { streamVariant, normalizeStreamKbps, STREAM_KBPS_DEFAULT } from '../stream-format.ts'

describe('normalizeStreamKbps', () => {
  it('defaults on junk and clamps to the listenable band', () => {
    assert.equal(normalizeStreamKbps(undefined), STREAM_KBPS_DEFAULT)
    assert.equal(normalizeStreamKbps('nonsense'), STREAM_KBPS_DEFAULT)
    assert.equal(normalizeStreamKbps(0), STREAM_KBPS_DEFAULT)
    assert.equal(normalizeStreamKbps('192'), 192)
    assert.equal(normalizeStreamKbps(32), 96)     // too thin to listen to
    assert.equal(normalizeStreamKbps(5000), 320)  // defeats the purpose
  })
})

describe('streamVariant', () => {
  it('leaves a fat-link client exactly as it was', () => {
    assert.deepEqual(streamVariant({ compressed: false, wantFlac: false }), {
      query: '', spoolSuffix: '', transcoding: false, label: 'homemini',
    })
    assert.deepEqual(streamVariant({ compressed: false, wantFlac: true }), {
      query: '?fmt=flac', spoolSuffix: '-flac', transcoding: true, label: 'homemini-flac',
    })
  })

  it('asks for AAC on a thin link, ALAC or not — AAC decodes in Chromium too', () => {
    const alac = streamVariant({ compressed: true, kbps: 256, wantFlac: true })
    const aac = streamVariant({ compressed: true, kbps: 256, wantFlac: false })
    assert.equal(alac.query, '?fmt=aac&kbps=256')
    assert.equal(aac.query, '?fmt=aac&kbps=256')
    assert.equal(alac.transcoding, true)
  })

  it('keeps compressed and lossless spools apart under one track id', () => {
    // Same id, different bytes — a shared spool key would serve the wrong file.
    const keys = new Set([
      streamVariant({ compressed: false, wantFlac: false }).spoolSuffix,
      streamVariant({ compressed: false, wantFlac: true }).spoolSuffix,
      streamVariant({ compressed: true, kbps: 256, wantFlac: true }).spoolSuffix,
      streamVariant({ compressed: true, kbps: 128, wantFlac: true }).spoolSuffix,
    ])
    assert.equal(keys.size, 4)
  })
})
