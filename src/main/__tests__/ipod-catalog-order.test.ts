/** Mini 1.4.1 lists artists in mhit PHYSICAL order — this ordering IS the
 *  Artists menu. Pins: articles, accents, numeric track order, stability. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orderForIpodCatalog, ipodArtistSortKey, conformCatalogIdOrder } from '../ipod-catalog-order.ts'

const t = (artist: string, album = '', trackNumber = 0, title = '') => ({ artist, album, trackNumber, title })

describe('ipodArtistSortKey', () => {
  test('leading articles fold away — The Beatles files under B', () => {
    assert.equal(ipodArtistSortKey('The Beatles'), 'beatles')
    assert.equal(ipodArtistSortKey('A Tribe Called Quest'), 'tribe called quest')
  })

  test('accents fold BEFORE the strip — Motorhead with umlaut under m', () => {
    assert.equal(ipodArtistSortKey('Motörhead'), 'motorhead')
    assert.equal(ipodArtistSortKey('Beyoncé'), 'beyonce')
  })

  test('"There" and "Anberlin" keep their letters — only whole articles fold', () => {
    assert.equal(ipodArtistSortKey('Therapy?'), 'therapy')
    assert.equal(ipodArtistSortKey('Anberlin'), 'anberlin')
  })
})

describe('orderForIpodCatalog', () => {
  test('artists come out alphabetical regardless of input order', () => {
    const out = orderForIpodCatalog([t('Weezer'), t('The Beatles'), t('blink-182'), t('Motörhead')])
    assert.deepEqual(out.map((x) => x.artist), ['The Beatles', 'blink-182', 'Motörhead', 'Weezer'])
  })

  test('within an artist: album, then NUMERIC track number', () => {
    const out = orderForIpodCatalog([
      t('Weezer', 'Blue Album', 10, 'Only in Dreams'),
      t('Weezer', 'Blue Album', 2, 'No One Else'),
      t('Weezer', 'Pinkerton', 1, 'Tired of Sex'),
      t('Weezer', 'Blue Album', 1, 'My Name Is Jonas'),
    ])
    assert.deepEqual(out.map((x) => `${x.album} ${x.trackNumber}`),
      ['Blue Album 1', 'Blue Album 2', 'Blue Album 10', 'Pinkerton 1'])
  })

  test('stable for full ties — equal keys keep input order', () => {
    const a = { artist: 'X', album: '', trackNumber: 0, title: '', tag: 1 }
    const b = { artist: 'X', album: '', trackNumber: 0, title: '', tag: 2 }
    assert.deepEqual(orderForIpodCatalog([a, b]).map((x) => x.tag), [1, 2])
  })

  test('missing artist falls to albumArtist, then Unknown Artist', () => {
    const out = orderForIpodCatalog([
      { artist: '', albumArtist: 'Zeta', album: '', trackNumber: 0, title: '' },
      { artist: 'Alpha', album: '', trackNumber: 0, title: '' },
    ])
    assert.deepEqual(out.map((x) => x.albumArtist || x.artist), ['Alpha', 'Zeta'])
  })
})

/** Firmware binary-searches mhits by the 32-bit id — the 819-of-1000 root
 *  cause. A synthetic iTunesDB with out-of-order ids must come back with
 *  ids ascending in record order and every mhip ref remapped. */
describe('conformCatalogIdOrder', () => {
  const tag = (b: Buffer, off: number, name: string) => b.write(name, off, 'latin1')
  const u32 = (b: Buffer, off: number, v: number) => b.writeUInt32LE(v, off)

  const buildDb = (mhitIds: number[], mhipRefs: number[]): Buffer => {
    const MHIT_LEN = 156
    const MHIP_LEN = 76
    const sec1Start = 104
    const mhltStart = sec1Start + 96
    const mhitsStart = mhltStart + 92
    const sec2Start = mhitsStart + mhitIds.length * MHIT_LEN
    const mhlpStart = sec2Start + 96
    const mhypStart = mhlpStart + 92
    const mhipsStart = mhypStart + 108
    const total = mhipsStart + mhipRefs.length * MHIP_LEN
    const b = Buffer.alloc(total)
    tag(b, 0, 'mhbd'); u32(b, 4, 104); u32(b, 8, total)
    tag(b, sec1Start, 'mhsd'); u32(b, sec1Start + 4, 96); u32(b, sec1Start + 8, sec2Start - sec1Start); u32(b, sec1Start + 12, 1)
    tag(b, mhltStart, 'mhlt'); u32(b, mhltStart + 4, 92); u32(b, mhltStart + 8, mhitIds.length)
    mhitIds.forEach((id, i) => {
      const p = mhitsStart + i * MHIT_LEN
      tag(b, p, 'mhit'); u32(b, p + 4, MHIT_LEN); u32(b, p + 8, MHIT_LEN); u32(b, p + 12, 0); u32(b, p + 0x10, id)
    })
    tag(b, sec2Start, 'mhsd'); u32(b, sec2Start + 4, 96); u32(b, sec2Start + 8, total - sec2Start); u32(b, sec2Start + 12, 2)
    tag(b, mhlpStart, 'mhlp'); u32(b, mhlpStart + 4, 92); u32(b, mhlpStart + 8, 1)
    tag(b, mhypStart, 'mhyp'); u32(b, mhypStart + 4, 108); u32(b, mhypStart + 8, total - mhypStart); u32(b, mhypStart + 12, 0); u32(b, mhypStart + 16, mhipRefs.length)
    mhipRefs.forEach((ref, i) => {
      const p = mhipsStart + i * MHIP_LEN
      tag(b, p, 'mhip'); u32(b, p + 4, MHIP_LEN); u32(b, p + 0x18, ref)
    })
    return b
  }

  test('ids re-minted ascending in record order, mhip refs follow', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-idorder-'))
    const dbPath = join(dir, 'iTunesDB')
    await writeFile(dbPath, buildDb([500, 200, 300], [300, 500, 200]))
    const res = await conformCatalogIdOrder(dbPath)
    assert.equal(res.ok, true, res.ok ? '' : res.error)
    const out = await readFile(dbPath)
    const mhits = 104 + 96 + 92
    const ids = [0, 1, 2].map((i) => out.readUInt32LE(mhits + i * 156 + 0x10))
    assert.deepEqual(ids, [10000, 10001, 10002], 'mhit ids must ascend in file order')
    const sec2 = mhits + 3 * 156
    const mhips = sec2 + 96 + 92 + 108
    const refs = [0, 1, 2].map((i) => out.readUInt32LE(mhips + i * 76 + 0x18))
    assert.deepEqual(refs, [10002, 10000, 10001], 'mhip refs must map to the re-minted ids')
  })

  test('refuses a catalog whose playlist references an unknown track id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-idorder-'))
    const dbPath = join(dir, 'iTunesDB')
    const before = buildDb([500, 200], [999])
    await writeFile(dbPath, before)
    const res = await conformCatalogIdOrder(dbPath)
    assert.equal(res.ok, false)
    assert.match(res.ok ? '' : res.error, /unknown track id 999/)
  })

  test('refuses a non-iTunesDB file without writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jt-idorder-'))
    const dbPath = join(dir, 'iTunesDB')
    await writeFile(dbPath, Buffer.from('not a database at all'))
    const res = await conformCatalogIdOrder(dbPath)
    assert.equal(res.ok, false)
  })
})
