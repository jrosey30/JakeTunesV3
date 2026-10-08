/** Round Trip parsers (6.0 story) — synthetic firmware files exercise the
 *  byte-level readers: Play Counts (mhdp), OTG (mhpo), catalog paths. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlayCounts, parseOtgIndexes, parseCatalogPaths } from '../sync-engine/roundtrip.ts'

const MAC_EPOCH = 2082844800

function playCountsBuf(entries: Array<{ plays: number; macTime: number }>, entryLen = 16): Buffer {
  const headerLen = 96
  const b = Buffer.alloc(headerLen + entries.length * entryLen)
  b.write('mhdp', 0, 'latin1')
  b.writeUInt32LE(headerLen, 4)
  b.writeUInt32LE(entryLen, 8)
  b.writeUInt32LE(entries.length, 12)
  entries.forEach((e, i) => {
    b.writeUInt32LE(e.plays, headerLen + i * entryLen)
    b.writeUInt32LE(e.macTime, headerLen + i * entryLen + 4)
  })
  return b
}

describe('parsePlayCounts', () => {
  test('reads plays + converts mac time to unix ms', () => {
    const unix = 1_756_000_000 // seconds
    const out = parsePlayCounts(playCountsBuf([
      { plays: 3, macTime: unix + MAC_EPOCH },
      { plays: 0, macTime: 0 },
    ]))
    assert.ok(out)
    assert.equal(out.length, 2)
    assert.equal(out[0].plays, 3)
    assert.equal(out[0].lastPlayedMs, unix * 1000)
    assert.equal(out[1].plays, 0)
    assert.equal(out[1].lastPlayedMs, 0)
  })
  test('tolerates 12-byte entries (older firmware)', () => {
    const out = parsePlayCounts(playCountsBuf([{ plays: 7, macTime: 0 }], 12))
    assert.ok(out)
    assert.equal(out[0].plays, 7)
  })
  test('wrong magic → null, never a guess', () => {
    assert.equal(parsePlayCounts(Buffer.from('not a playcounts file')), null)
  })
})

describe('parseOtgIndexes', () => {
  test('reads positional indexes', () => {
    const b = Buffer.alloc(20 + 12)
    b.write('mhpo', 0, 'latin1')
    b.writeUInt32LE(20, 4)
    b.writeUInt32LE(3, 16)
    ;[5, 0, 999].forEach((v, i) => b.writeUInt32LE(v, 20 + i * 4))
    assert.deepEqual(parseOtgIndexes(b), [5, 0, 999])
  })
  test('wrong magic → empty', () => {
    assert.deepEqual(parseOtgIndexes(Buffer.from('mhipnope............')), [])
  })
})

describe('parseCatalogPaths', () => {
  function db(paths: string[]): Buffer {
    const mhods = paths.map((p) => {
      const str = Buffer.from(p, 'utf16le')
      const b = Buffer.alloc(0x28 + str.length)
      b.write('mhod', 0, 'latin1')
      b.writeUInt32LE(0x18, 4)
      b.writeUInt32LE(b.length, 8)
      b.writeUInt32LE(2, 12)          // type 2 = location
      b.writeUInt32LE(str.length, 0x1c)
      str.copy(b, 0x28)
      return b
    })
    const HL = 156
    const mhits = mhods.map((m) => {
      const b = Buffer.alloc(HL + m.length)
      b.write('mhit', 0, 'latin1')
      b.writeUInt32LE(HL, 4)
      b.writeUInt32LE(b.length, 8)
      b.writeUInt32LE(1, 12)
      m.copy(b, HL)
      return b
    })
    const tracksLen = mhits.reduce((n, b) => n + b.length, 0)
    const mhlt = Buffer.alloc(92)
    mhlt.write('mhlt', 0, 'latin1')
    mhlt.writeUInt32LE(92, 4)
    mhlt.writeUInt32LE(mhits.length, 8)
    const sec1 = Buffer.alloc(96)
    sec1.write('mhsd', 0, 'latin1')
    sec1.writeUInt32LE(96, 4)
    sec1.writeUInt32LE(96 + 92 + tracksLen, 8)
    sec1.writeUInt32LE(1, 12)
    const head = Buffer.alloc(104)
    head.write('mhbd', 0, 'latin1')
    head.writeUInt32LE(104, 4)
    return Buffer.concat([head, sec1, mhlt, ...mhits])
  }
  test('paths come back in record order', () => {
    const paths = [':iPod_Control:Music:F00:1234.m4a', ':iPod_Control:Music:F01:CDJB.m4a']
    assert.deepEqual(parseCatalogPaths(db(paths)), paths)
  })
  test('non-db bytes → null', () => {
    assert.equal(parseCatalogPaths(Buffer.from('garbage bytes here......')), null)
  })
})
