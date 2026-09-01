/**
 * iPod Mini catalog ordering (2026-08-28, Jake: "is there a reason why the
 * artists on the ipod mini, even after successful sync, are not in
 * alphabetical order?").
 *
 * The Mini's 1.4.1 firmware predates the type-52 sort tables the DB writer
 * dutifully builds — it walks the mhit records in PHYSICAL order. We were
 * writing them in library order, so the Artists menu came out 48% shuffled.
 * The fix is not in the writer (core/ is Do-Not-Touch): the engine sorts
 * the track array before handing it over, because mhits are emitted in
 * input order and playlists reference tracks by dbid — reordering the
 * catalog cannot touch playlist order.
 *
 * Sort convention is iTunes': leading articles fold away ("The Beatles"
 * files under B), accents fold BEFORE the strip (Motörhead under M, not
 * after Z — the JAŸ-Z lesson), case ignored. Within an artist: album,
 * then numeric track number, then title.
 */

import { readFile, writeFile } from 'node:fs/promises'

const fold = (s: string): string =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

export function ipodArtistSortKey(name: string): string {
  return fold(name).replace(/^(the|a|an) /, '')
}

export function orderForIpodCatalog<T extends Record<string, unknown>>(tracks: T[]): T[] {
  const key = (t: T): [string, string, number, string] => [
    ipodArtistSortKey(String(t['artist'] || t['albumArtist'] || 'Unknown Artist')),
    fold(String(t['album'] || '')),
    Number(t['trackNumber']) || 0,
    fold(String(t['title'] || '')),
  ]
  // Decorate–sort–undecorate keeps this O(n log n) with stable ties.
  return tracks
    .map((t, i) => ({ t, i, k: key(t) }))
    .sort((a, b) => {
      if (a.k[0] !== b.k[0]) return a.k[0] < b.k[0] ? -1 : 1
      if (a.k[1] !== b.k[1]) return a.k[1] < b.k[1] ? -1 : 1
      if (a.k[2] !== b.k[2]) return a.k[2] - b.k[2]
      if (a.k[3] !== b.k[3]) return a.k[3] < b.k[3] ? -1 : 1
      return a.i - b.i
    })
    .map((x) => x.t)
}

/**
 * Mini 1.4.1 locates every song by BINARY SEARCH over the mhit array keyed
 * on the 32-bit id at mhit+0x10 — records must ascend in id order or
 * lookups silently fail and the song vanishes from About/Shuffle (the
 * 819-of-1000 saga, resolved 2026-09-01: the search model predicted
 * 824/412/1/7 against measured 819/415/1/7 across four catalog orderings,
 * and an id-renumbered card booted 1000/1000). 2004 iTunes kept the
 * invariant by appending records in id-mint order; sorting by artist
 * (orderForIpodCatalog) breaks it. So after the DB writer runs, ids are
 * re-minted ascending in final record order and every playlist mhip ref
 * is remapped to match. The writer itself is core/ (Do-Not-Touch), which
 * is why this is a byte-level post-pass.
 */
const CONFORM_ID_BASE = 10000

export async function conformCatalogIdOrder(dbPath: string): Promise<
  { ok: true, summary: string } | { ok: false, error: string }
> {
  const data = await readFile(dbPath)
  const u32 = (off: number): number => data.readUInt32LE(off)
  if (data.length < 12 || data.toString('latin1', 0, 4) !== 'mhbd') {
    return { ok: false, error: 'catalog id-order: file is not an iTunesDB (no mhbd)' }
  }
  // Section walk: mhsd type 1 = track list, type 2 = playlists.
  let pos = u32(4)
  let sec1: [number, number] | null = null
  let sec2: [number, number] | null = null
  while (pos < data.length - 16 && data.toString('latin1', pos, pos + 4) === 'mhsd') {
    const stl = u32(pos + 8)
    const styp = u32(pos + 12)
    if (styp === 1) sec1 = [pos, stl]
    if (styp === 2) sec2 = [pos, stl]
    if (stl <= 0) return { ok: false, error: 'catalog id-order: zero-length mhsd' }
    pos += stl
  }
  if (!sec1 || !sec2) return { ok: false, error: 'catalog id-order: missing track or playlist section' }

  // Re-mint mhit ids ascending in file order.
  const mhlt = sec1[0] + u32(sec1[0] + 4)
  if (data.toString('latin1', mhlt, mhlt + 4) !== 'mhlt') {
    return { ok: false, error: 'catalog id-order: mhlt not where the header says' }
  }
  const n = u32(mhlt + 8)
  const idMap = new Map<number, number>()
  let p = mhlt + u32(mhlt + 4)
  for (let i = 0; i < n; i++) {
    if (data.toString('latin1', p, p + 4) !== 'mhit') {
      return { ok: false, error: `catalog id-order: mhit ${i + 1}/${n} not found at chain offset` }
    }
    const oldId = u32(p + 0x10)
    if (idMap.has(oldId)) return { ok: false, error: `catalog id-order: duplicate mhit id ${oldId}` }
    idMap.set(oldId, CONFORM_ID_BASE + i)
    data.writeUInt32LE(CONFORM_ID_BASE + i, p + 0x10)
    p += u32(p + 8)
  }

  // Remap every playlist mhip ref (+0x18) to the new ids.
  let remapped = 0
  let q = sec2[0]
  const end2 = sec2[0] + sec2[1]
  while (q < end2 - 8) {
    const tag = data.toString('latin1', q, q + 4)
    if (tag === 'mhip') {
      const ref = u32(q + 0x18)
      const next = idMap.get(ref)
      if (next === undefined) {
        return { ok: false, error: `catalog id-order: mhip references unknown track id ${ref}` }
      }
      data.writeUInt32LE(next, q + 0x18)
      remapped++
      q += u32(q + 4)
    } else if (tag === 'mhod') {
      q += u32(q + 8)
    } else if (tag === 'mhyp' || tag === 'mhlp') {
      q += u32(q + 4)
    } else {
      q += 4
    }
  }
  await writeFile(dbPath, data)
  return { ok: true, summary: `catalog id-order conformed — ${n} mhits re-minted ascending, ${remapped} playlist refs remapped` }
}
