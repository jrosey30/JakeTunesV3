/**
 * A blank iPod song database (2026-11-13, iPod set-up).
 *
 * A freshly formatted card has NO iTunesDB (the red mini, 2026-09-07), and the
 * catalog writer (core/db_reader.py --write) reads its template before it
 * writes anything: on such a card a sync copied every song and only then died.
 * Set-up writes this first: a database with no songs, one master playlist
 * carrying the iPod's name, and nothing else.
 *
 * What the writer keeps from a template is the file header (mhbd), so the
 * header here is the one thing that outlives the first sync. Its fixed fields
 * are the ones in the Original's database as iTunes last wrote it (read from
 * this Mac's own 2026-08-31 backup copy, never from an iPod): the 244-byte
 * header, version 0x73, the 'en' language mark and the constants at 0x20-0x22,
 * 0x50-0x54, 0x6c and 0xa0-0xa6. The mini's 1.4.1 software has indexed 1,000
 * songs under that header since 2026-09-01. The three ids are fresh per iPod.
 *
 * Layout (all little-endian), the same records core/db_reader.py writes:
 *   mhbd (244) → mhsd type 1 (96) → mhlt (92, 0 songs)
 *              → mhsd type 2 (96) → mhlp (92, 1 playlist) → mhyp master (184) → mhod name
 *
 * UNPROVEN ON AN iPOD: no device has started up from this file. The tests
 * prove it parses in both readers (roundtrip.ts and db_reader.py) and that the
 * writer accepts it as a template.
 */
import { randomBytes } from 'crypto'

const MHBD_LEN = 244
const MHSD_LEN = 96
const MHLT_LEN = 92
const MHLP_LEN = 92
const MHYP_LEN = 184

function tag(b: Buffer, name: string, headerLen: number): void {
  b.write(name, 0, 'latin1')
  b.writeUInt32LE(headerLen, 4)
}

function section(type: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(MHSD_LEN)
  tag(h, 'mhsd', MHSD_LEN)
  h.writeUInt32LE(MHSD_LEN + payload.length, 8)
  h.writeUInt32LE(type, 12)
  return Buffer.concat([h, payload])
}

/** The master playlist's title is the name the iPod shows for itself (About). */
function nameMhod(name: string): Buffer {
  const s = Buffer.from(name, 'utf16le')
  const m = Buffer.alloc(40 + s.length)
  tag(m, 'mhod', 24)
  m.writeUInt32LE(m.length, 8)
  m.writeUInt32LE(1, 12)          // type 1: a title
  m.writeUInt32LE(1, 24)          // position
  m.writeUInt32LE(s.length, 28)   // string bytes
  m.writeUInt32LE(1, 32)          // UTF-16-LE
  s.copy(m, 40)
  return m
}

export function buildBlankCatalog(ipodName: string, ids: Buffer = randomBytes(24)): Buffer {
  const name = ipodName.replace(/\s+/g, ' ').trim().slice(0, 63) || 'iPod'
  if (ids.length < 24) throw new Error('buildBlankCatalog needs 24 id bytes')

  const mhlt = Buffer.alloc(MHLT_LEN)
  tag(mhlt, 'mhlt', MHLT_LEN)     // 0 songs at offset 8

  const title = nameMhod(name)
  const mhyp = Buffer.alloc(MHYP_LEN)
  tag(mhyp, 'mhyp', MHYP_LEN)
  mhyp.writeUInt32LE(MHYP_LEN + title.length, 8)
  mhyp.writeUInt32LE(1, 0x0c)     // one mhod: the name
  mhyp.writeUInt32LE(0, 0x10)     // no songs
  mhyp.writeUInt32LE(1, 0x14)     // the master playlist
  ids.copy(mhyp, 0x18, 0, 8)      // playlist id
  mhyp.writeUInt32LE(1, 0x28)
  mhyp.writeUInt32LE(1, 0x2c)

  const mhlp = Buffer.alloc(MHLP_LEN)
  tag(mhlp, 'mhlp', MHLP_LEN)
  mhlp.writeUInt32LE(1, 8)

  const body = Buffer.concat([section(1, mhlt), section(2, Buffer.concat([mhlp, mhyp, title]))])

  const mhbd = Buffer.alloc(MHBD_LEN)
  tag(mhbd, 'mhbd', MHBD_LEN)
  mhbd.writeUInt32LE(MHBD_LEN + body.length, 8)
  mhbd.writeUInt32LE(1, 0x0c)
  mhbd.writeUInt32LE(0x73, 0x10)  // database version
  mhbd.writeUInt32LE(2, 0x14)     // two sections
  ids.copy(mhbd, 0x18, 8, 16)     // database id
  mhbd.writeUInt16LE(1, 0x20)
  mhbd.writeUInt16LE(0x0263, 0x22)
  ids.copy(mhbd, 0x48, 16, 24)    // library id
  mhbd.write('en', 0x46, 'latin1')
  mhbd.writeUInt32LE(1, 0x50)
  mhbd.writeUInt32LE(0x9f, 0x54)
  mhbd.writeInt32LE(-25200, 0x6c)
  mhbd.writeUInt32LE(0xffffffff, 0xa0)
  mhbd.writeUInt16LE(0x19, 0xa4)
  mhbd.writeUInt16LE(0x0a, 0xa6)
  return Buffer.concat([mhbd, body])
}

/** Read a database's own name and song count back, with no help from the builder above. */
export function readCatalogSummary(buf: Buffer): { songs: number; name: string | null } | null {
  if (buf.length < 24 || buf.toString('latin1', 0, 4) !== 'mhbd') return null
  let pos = buf.readUInt32LE(4)
  const children = buf.readUInt32LE(20)
  let songs: number | null = null
  let name: string | null = null
  for (let i = 0; i < children && pos + 16 <= buf.length; i++) {
    if (buf.toString('latin1', pos, pos + 4) !== 'mhsd') return null
    const total = buf.readUInt32LE(pos + 8)
    const type = buf.readUInt32LE(pos + 12)
    const inner = pos + buf.readUInt32LE(pos + 4)
    if (total <= 0) return null
    if (type === 1 && buf.toString('latin1', inner, inner + 4) === 'mhlt') songs = buf.readUInt32LE(inner + 8)
    if (type === 2 && name === null && buf.toString('latin1', inner, inner + 4) === 'mhlp') {
      const lists = buf.readUInt32LE(inner + 8)
      let yp = inner + buf.readUInt32LE(inner + 4)
      for (let l = 0; l < lists && yp + 0x18 <= buf.length; l++) {
        if (buf.toString('latin1', yp, yp + 4) !== 'mhyp') break
        const yTotal = buf.readUInt32LE(yp + 8)
        if (buf.readUInt32LE(yp + 0x14) === 1) {
          let mp = yp + buf.readUInt32LE(yp + 4)
          const mhods = buf.readUInt32LE(yp + 0x0c)
          for (let m = 0; m < mhods && mp + 40 <= buf.length; m++) {
            if (buf.toString('latin1', mp, mp + 4) !== 'mhod') break
            if (buf.readUInt32LE(mp + 12) === 1) {
              name = buf.toString('utf16le', mp + 40, mp + 40 + buf.readUInt32LE(mp + 28))
              break
            }
            mp += buf.readUInt32LE(mp + 8)
          }
          break
        }
        if (yTotal <= 0) break
        yp += yTotal
      }
    }
    pos += total
  }
  return songs === null ? null : { songs, name }
}
