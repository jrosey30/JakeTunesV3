/**
 * mp4-moov-padding — take the zeros out of an m4a's moov.
 *
 * mutagen (core/tag_writer.py, its default padding) leaves 1 KiB + 0.1% of the
 * file as a `free` atom inside moov/udta/meta, so a later re-tag needn't move
 * the audio. On a concert that is 62-71% of the moov: 380 KB of zeros on Carnegie
 * and 1 MB on Nassau, which the phone downloads before the first note (about
 * 1.1 s for Carnegie at the 2.73 Mbps measured on 2026-11-05).
 *
 * This removes `free` and `skip` from moov, udta and meta, and moves every chunk
 * offset down by what came out. Nothing else in the file changes: the audio
 * bytes, the tags and the sample tables stay as the encoder and mutagen wrote
 * them, and moov stays ahead of mdat. The top-level `free` afconvert writes
 * after moov stays too (under 4 KB, and nothing has to read it).
 *
 * Only for a file the caller owns outright (the merge's scratch output): it
 * rewrites the file, through a temp name and one rename.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

const PADDING_ATOMS = new Set(['free', 'skip'])

interface Atom { name: string; start: number; end: number; header: number }

function atomsIn(b: Buffer, start: number, end: number): Atom[] {
  const out: Atom[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = b.readUInt32BE(pos)
    let header = 8
    if (size === 1) {
      if (pos + 16 > end) throw new Error('truncated atom header')
      size = Number(b.readBigUInt64BE(pos + 8))
      header = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < header || pos + size > end) throw new Error('atom overruns its parent')
    out.push({ name: b.toString('latin1', pos + 4, pos + 8), start: pos, end: pos + size, header })
    pos += size
  }
  return out
}

/** Bytes of a `meta` payload before its children: 4 in the ISO form (version +
 *  flags), 0 in the QuickTime form, whose first child's name sits at offset 4. */
function metaPrefix(b: Buffer, atom: Atom): number {
  const body = atom.start + atom.header
  return b.toString('latin1', body + 4, body + 8) === 'hdlr' ? 0 : 4
}

/** The container with padding children gone and sizes corrected. */
function rebuild(b: Buffer, atom: Atom): Buffer {
  const body = atom.start + atom.header
  const prefix = atom.name === 'meta' ? metaPrefix(b, atom) : 0
  const parts: Buffer[] = [b.subarray(atom.start, body + prefix)]
  for (const c of atomsIn(b, body + prefix, atom.end)) {
    if (PADDING_ATOMS.has(c.name)) continue
    parts.push(c.name === 'udta' || c.name === 'meta' ? rebuild(b, c) : b.subarray(c.start, c.end))
  }
  const out = Buffer.concat(parts)
  if (atom.header === 16) out.writeBigUInt64BE(BigInt(out.length), 8)
  else out.writeUInt32BE(out.length, 0)
  return out
}

function chunkOffsetTables(moov: Buffer): Atom[] {
  const tables: Atom[] = []
  const walk = (start: number, end: number): void => {
    for (const a of atomsIn(moov, start, end)) {
      if (a.name === 'stco' || a.name === 'co64') tables.push(a)
      else if (a.name === 'trak' || a.name === 'mdia' || a.name === 'minf' || a.name === 'stbl') walk(a.start + a.header, a.end)
    }
  }
  const top = atomsIn(moov, 0, moov.length)[0]
  walk(top.start + top.header, top.end)
  return tables
}

/**
 * Pure: the moov atom (whole, header included) without padding, its chunk
 * offsets moved down for a moov that sits ahead of the audio. Audio before the
 * moov keeps its offset. `firstChunk` is the first entry before and after, so a
 * caller can check the map still lands on the same bytes.
 */
export function compactMoov(moov: Buffer, moovStart: number): { moov: Buffer; removed: number; firstChunk: { was: number; now: number } | null } {
  const atom = atomsIn(moov, 0, moov.length)[0]
  if (!atom || atom.name !== 'moov') throw new Error('not a moov atom')
  const out = rebuild(moov, atom)
  const removed = moov.length - out.length
  const moovEnd = moovStart + moov.length
  let firstChunk: { was: number; now: number } | null = null
  for (const t of chunkOffsetTables(out)) {
    const wide = t.name === 'co64'
    const body = t.start + t.header
    const n = out.readUInt32BE(body + 4)
    const stride = wide ? 8 : 4
    for (let i = 0; i < n; i++) {
      const at = body + 8 + i * stride
      if (at + stride > t.end) throw new Error('chunk table overruns its atom')
      const was = wide ? Number(out.readBigUInt64BE(at)) : out.readUInt32BE(at)
      const now = was >= moovEnd ? was - removed : was
      if (wide) out.writeBigUInt64BE(BigInt(now), at)
      else out.writeUInt32BE(now, at)
      if (!firstChunk) firstChunk = { was, now }
    }
  }
  return { moov: out, removed, firstChunk }
}

/** Removes the padding in place. Returns the bytes removed (0: nothing to do). */
export async function dropMoovPadding(path: string): Promise<number> {
  const fh = await open(path, 'r')
  let moovStart = -1
  let moov: Buffer
  try {
    const fileSize = (await fh.stat()).size
    const head = Buffer.alloc(16)
    let pos = 0
    let size = 0
    while (pos + 8 <= fileSize) {
      const { bytesRead } = await fh.read(head, 0, 16, pos)
      if (bytesRead < 8) break
      size = head.readUInt32BE(0)
      let header = 8
      if (size === 1) { size = Number(head.readBigUInt64BE(8)); header = 16 } else if (size === 0) { size = fileSize - pos }
      if (size < header) break
      if (head.toString('latin1', 4, 8) === 'moov') { moovStart = pos; break }
      pos += size
    }
    if (moovStart < 0) return 0
    moov = Buffer.alloc(size)
    const r = await fh.read(moov, 0, size, moovStart)
    if (r.bytesRead !== size) throw new Error('short read of moov')
  } finally {
    await fh.close()
  }

  const compact = compactMoov(moov, moovStart)
  if (compact.removed === 0) return 0

  const tmp = `${path}.compact.tmp`
  try {
    const out = await open(tmp, 'w')
    const src = await open(path, 'r')
    try {
      if (moovStart > 0) {
        const before = Buffer.alloc(moovStart)
        await src.read(before, 0, moovStart, 0)
        await out.write(before)
      }
      await out.write(compact.moov)
    } finally {
      await out.close()
      await src.close()
    }
    await pipeline(createReadStream(path, { start: moovStart + moov.length }), createWriteStream(tmp, { flags: 'a' }))

    // The map must still land on the same audio.
    if (compact.firstChunk) {
      const a = Buffer.alloc(4096), b = Buffer.alloc(4096)
      const oldFh = await open(path, 'r'), newFh = await open(tmp, 'r')
      try {
        const ra = await oldFh.read(a, 0, 4096, compact.firstChunk.was)
        const rb = await newFh.read(b, 0, 4096, compact.firstChunk.now)
        if (ra.bytesRead !== rb.bytesRead || !a.equals(b)) throw new Error('first chunk moved under the map')
      } finally {
        await oldFh.close()
        await newFh.close()
      }
    }
    await rename(tmp, path)
    return compact.removed
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
