/**
 * Replacing songs on an iPod without ever deleting the original first (Brief 265 Parts 2-3,
 * the final safeguard, Jake 2026-11-24).
 *
 * A song whose card file must change (a format change, a re-ripped master, a new recipe) is
 * replaced IN PLACE, keeping its card path, in waves sized to the card's free space:
 *
 *   1. stage:   each replacement is written beside its original as `.<name>.jtnew`, then
 *               confirmed on the card (size, flush);
 *   2. swap:    the original is renamed to `.<name>.jtorig`, the replacement to `<name>`;
 *   3. commit:  the catalog naming the wave's replacements is written and proven;
 *   4. release: only then are the wave's `.jtorig` originals deleted, freeing room for the next.
 *
 * A wave takes as many replacements as fit beside their originals. A card that can't hold even
 * one replacement beside its original stops the sync and says so; nothing is deleted to make
 * room. If anything fails before the commit, every original of the wave is put back under its
 * own name and the staged files are removed, so the catalog on the card still describes the
 * files on the card. A sync that was cut off mid-wave is repaired by the next one, from the
 * catalog on the card: recoverInterruptedWaves.
 *
 * Hidden names (a leading dot) are never listed by the firmware and never count against the
 * swap proof. Pure planning + small file helpers; node --test loads it.
 */
import { readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const NEW_TAG = 'jtnew'
export const ORIG_TAG = 'jtorig'
/** Room kept free on the card beyond a wave (the catalog, the firmware's own files). */
export const WAVE_RESERVE_BYTES = 64 * 1024 * 1024

/** `.<name>.<tag>` beside the card file. */
export function sideName(cardAbs: string, tag: typeof NEW_TAG | typeof ORIG_TAG): string {
  return join(dirname(cardAbs), `.${basename(cardAbs)}.${tag}`)
}

/** The card file a side file belongs to, or null when the name isn't one of ours. */
export function ownerOfSide(sideAbs: string): { owner: string; tag: typeof NEW_TAG | typeof ORIG_TAG } | null {
  const m = /^\.(.+)\.(jtnew|jtorig)$/.exec(basename(sideAbs))
  return m ? { owner: join(dirname(sideAbs), m[1]), tag: m[2] as typeof NEW_TAG | typeof ORIG_TAG } : null
}

export interface WaveItem { id: number; newSize: number }

/** A file's size on the card: whole clusters (FAT) / blocks. */
export function onCardBytes(size: number, clusterBytes: number): number {
  const c = clusterBytes > 0 ? clusterBytes : 4096
  return Math.ceil(Math.max(0, size) / c) * c
}

/**
 * What a wave must leave free beside its replacements: the fixed reserve, two copies of the
 * catalog (the temp copy and the new one) and the artwork database the catalog write rewrites.
 */
export function waveReserveBytes(catalogBytes: number, artworkBytes: number): number {
  return WAVE_RESERVE_BYTES + 2 * Math.max(0, catalogBytes) + Math.max(0, artworkBytes)
}

/**
 * The next wave: first fit, in order, of the replacements that fit (rounded up to whole
 * clusters) in the free space less the reserve. A song too big for the space now doesn't block
 * smaller ones after it; it waits for a later wave, when originals have been released. Empty =
 * nothing fits beside its original (the caller stops; nothing is deleted).
 */
export function nextWave(items: readonly WaveItem[], freeBytes: number, reserveBytes = WAVE_RESERVE_BYTES, clusterBytes = 4096): WaveItem[] {
  const room = freeBytes - reserveBytes
  const out: WaveItem[] = []
  let used = 0
  for (const it of items) {
    const need = onCardBytes(it.newSize, clusterBytes)
    if (used + need > room) continue
    out.push(it)
    used += need
  }
  return out
}

/** The plain refusal when no replacement fits beside its original. */
export function noRoomForReplacement(title: string, needBytes: number, freeBytes: number, reserveBytes: number): string {
  const mb = (n: number) => `${Math.max(0, Math.round(n / 1e6))} MB`
  return `There isn't room on the iPod to put the new copy of "${title}" beside the old one: it needs ${mb(needBytes + reserveBytes)} free (the song and room for the song list) and ${mb(freeBytes)} is free. Nothing was deleted. Free some space on the iPod or take songs off its list, then sync again.`
}

/** iTunesDB: colon path → mhit fileSize (0x24), for repairing an interrupted wave. */
export function catalogSizesByPath(buf: Buffer): Map<string, number> | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'mhbd') return null
  let pos = buf.readUInt32LE(4)
  let sec1: number | null = null
  while (pos < buf.length - 16 && buf.toString('latin1', pos, pos + 4) === 'mhsd') {
    const stl = buf.readUInt32LE(pos + 8)
    if (buf.readUInt32LE(pos + 12) === 1) sec1 = pos
    if (stl <= 0) return null
    pos += stl
  }
  if (sec1 === null) return null
  const mhlt = sec1 + buf.readUInt32LE(sec1 + 4)
  if (buf.toString('latin1', mhlt, mhlt + 4) !== 'mhlt') return null
  const n = buf.readUInt32LE(mhlt + 8)
  const out = new Map<string, number>()
  let p = mhlt + buf.readUInt32LE(mhlt + 4)
  for (let i = 0; i < n; i++) {
    if (p + 0x28 > buf.length || buf.toString('latin1', p, p + 4) !== 'mhit') return null
    const tl = buf.readUInt32LE(p + 8)
    const hl = buf.readUInt32LE(p + 4)
    const nm = buf.readUInt32LE(p + 12)
    const size = buf.readUInt32LE(p + 0x24)
    let mp = p + hl
    for (let m = 0; m < nm; m++) {
      if (mp + 16 > buf.length) return null
      const mtl = buf.readUInt32LE(mp + 8)
      if (buf.readUInt32LE(mp + 12) === 2) {
        const slen = buf.readUInt32LE(mp + 0x1c)
        out.set(buf.toString('utf16le', mp + 0x28, mp + 0x28 + slen), size)
      }
      mp += mtl
    }
    p += tl
  }
  return out
}

export interface RecoveryReport { restored: string[]; released: string[]; staleNew: string[]; kept: string[] }

/**
 * Put right what a cut-off wave left on the card, by the catalog on the card:
 *   • `.X.jtorig` whose size the catalog has for X: the wave never committed: the original
 *     goes back as X (the uncommitted replacement goes);
 *   • `.X.jtorig` when the catalog has X's current size: the wave committed: the original goes;
 *   • `.X.jtnew`: never swapped in: it goes;
 *   • anything else (no catalog, sizes that match neither): left alone and reported.
 * `toColon(abs)` gives the catalog's colon path for a card file.
 */
export async function recoverInterruptedWaves(
  musicRoot: string,
  catalog: Map<string, number> | null,
  toColon: (abs: string) => string,
): Promise<RecoveryReport> {
  const rep: RecoveryReport = { restored: [], released: [], staleNew: [], kept: [] }
  const dirs = await readdir(musicRoot).catch(() => [] as string[])
  for (const d of dirs) {
    const names = await readdir(join(musicRoot, d)).catch(() => [] as string[])
    for (const n of names) {
      const abs = join(musicRoot, d, n)
      const side = ownerOfSide(abs)
      if (!side) continue
      try {
        if (side.tag === NEW_TAG) {
          await unlink(abs)
          rep.staleNew.push(abs)
          continue
        }
        const orig = await stat(abs).catch(() => null)
        const now = await stat(side.owner).catch(() => null)
        const want = catalog?.get(toColon(side.owner))
        if (!orig || want === undefined) { rep.kept.push(abs); continue }
        if (want === orig.size && (!now || now.size !== orig.size)) {
          // Never committed: the original goes straight back over the new copy (one rename).
          await rename(abs, side.owner)
          rep.restored.push(side.owner)
        } else if (now && want === now.size) {
          await unlink(abs)
          rep.released.push(abs)
        } else {
          rep.kept.push(abs)
        }
      } catch (err) {
        console.warn(`[ipod-waves] couldn't put right ${abs} (left as found):`, err instanceof Error ? err.message : err)
        rep.kept.push(abs)
      }
    }
  }
  return rep
}
