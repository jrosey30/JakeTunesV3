import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

/** Adds ----:com.apple.iTunes:iTunSMPB to an ffmpeg-made m4a (moov last, so no
 *  offsets move), the way iTunes writes it. */
export function addSmpb(path: string, priming: number, padding: number, frames: number): void {
  const hex = (v: number, w: number): string => v.toString(16).toUpperCase().padStart(w, '0')
  const value = ` 00000000 ${hex(priming, 8)} ${hex(padding, 8)} ${hex(frames, 16)} 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000`
  const box = (name: string, ...parts: Buffer[]): Buffer => {
    const body = Buffer.concat(parts)
    const h = Buffer.alloc(8)
    h.writeUInt32BE(8 + body.length, 0)
    h.write(name, 4, 'latin1')
    return Buffer.concat([h, body])
  }
  const zero4 = Buffer.alloc(4)
  const dataHead = Buffer.alloc(8)
  dataHead.writeUInt32BE(1, 0)
  const tag = box('----',
    box('mean', zero4, Buffer.from('com.apple.iTunes')),
    box('name', zero4, Buffer.from('iTunSMPB')),
    box('data', dataHead, Buffer.from(value)))
  const file = readFileSync(path)
  // moov -> udta -> meta -> ilst, growing each on the way out.
  const find = (start: number, end: number, name: string): { pos: number; end: number } => {
    let pos = start
    while (pos + 8 <= end) {
      const size = file.readUInt32BE(pos)
      if (file.toString('latin1', pos + 4, pos + 8) === name) return { pos, end: pos + size }
      pos += size
    }
    throw new Error(`no ${name} in ${path}`)
  }
  const moov = find(0, file.length, 'moov')
  assert.equal(moov.end, file.length, 'fixture: moov is last')
  const udta = find(moov.pos + 8, moov.end, 'udta')
  const meta = find(udta.pos + 8, udta.end, 'meta')
  const ilst = find(meta.pos + 12, meta.end, 'ilst')
  for (const a of [moov, udta, meta, ilst]) file.writeUInt32BE(file.readUInt32BE(a.pos) + tag.length, a.pos)
  writeFileSync(path, Buffer.concat([file.subarray(0, ilst.end), tag, file.subarray(ilst.end)]))
}
