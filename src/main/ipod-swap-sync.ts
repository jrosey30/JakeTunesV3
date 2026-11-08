/**
 * Swap-only iPod sync (Jake, 2026-11-07: "with that sync, it shouldnt wipe the
 * ipod and start the 1000 from scratch, it should just swap out the songs that
 * they are being replaced with").
 *
 * The activity engine already had a keep plan (activity-keep.ts, 2026-09-19),
 * but it never kept a song: the engine wrote its 'in-flight' manifest BEFORE
 * it read the last one, so the keep plan always read an unsealed manifest and
 * every sync copied all 1,000 again (the ledger's last result: copied 1000).
 *
 * This module decides, from what the last sync left behind, whether the card
 * can be trusted enough to swap only the songs that change. Pure (the engine
 * feeds it the card's listing, catalog hash and the two state files), so
 * node --test loads it.
 *
 * Proof, all of it, or a full wipe-and-copy with one plain reason:
 *   • a sealed manifest in THIS format (it carries the catalog's md5/bytes and
 *     every file's size; an older one can't vouch for the card);
 *   • a seal that agrees with that manifest, song for song;
 *   • the card's iTunesDB is byte-for-byte the catalog the last sync wrote,
 *     and its ids ascend (the firmware's binary search, the 819 saga);
 *   • every file the last sync put there is present at its size, and nothing
 *     else is in iPod_Control/Music;
 *   • at most 70% of the set changes (past that a full copy is simpler).
 * Identity is the fingerprint, never text (CLAUDE.md: destructive ops gate on
 * identity); a song with no fingerprint yet stays only on id + exact card path
 * + both sizes (identityHolds). A song whose library file changed (size of the master, size of
 * the file we would copy, or fingerprint) leaves and arrives again.
 */
import { createHash } from 'crypto'
import { parseTsaSeal, tsaNormalizeColonPath } from './ipod-sync-tsa.ts'

export const SWAP_MANIFEST_FORMAT = 2
/** More of the set than this arriving → a full copy is simpler. */
export const SWAP_MAX_CHANGE_FRACTION = 0.7
/**
 * Fragmentation backstop (review of #377). Before swaps, every sync wiped, so
 * the card's free space started in one piece. A swap punches holes (the songs
 * leaving) and writes the catalog into them, and the 2026-08-15 lesson
 * (ipod-db-contiguity.ts) is that a fragmented catalog passes every check
 * while the Mini indexes a random count. So after this many swaps, or once
 * this share of the card has been freed by removals since the last full copy,
 * the next Sync is a full copy again.
 */
export const SWAP_FULL_EVERY = 5
export const SWAP_MAX_REMOVED_SHARE = 0.15
export const LAST_SYNC_MANIFEST_FILE = 'last-sync-manifest.json'
export const TSA_SEAL_FILE = 'ipod-activity-tsa-seal.json'

export interface SwapManifestRow {
  id: number
  destPath: string
  identity: string
  /** Size of the file on the card (what the catalog's mhit says). */
  size: number
  /** Size of the library master it came from (before any ALAC/AAC mirror); 0 = unknown. */
  sourceSize: number
}

export interface SwapManifest {
  format: typeof SWAP_MANIFEST_FORMAT
  syncedAt: string
  status: 'sealed'
  sealed: true
  count: number
  catalog: { md5: string; bytes: number }
  /** Swaps that removed songs since the last full copy (0 right after one). */
  swapsSinceFull: number
  /** Bytes of songs removed by swaps since the last full copy. */
  bytesRemovedSinceFull: number
  tracks: SwapManifestRow[]
}

/** Since the last full copy: how many swaps, and how much they freed. */
export interface SwapHistory { swapsSinceFull: number; bytesRemovedSinceFull: number }

/** What the card holds right now, read without writing anything. */
export interface CardState {
  /** md5 + length of iPod_Control/iTunes/iTunesDB; null = missing or unreadable. */
  catalog: { md5: string; bytes: number } | null
  /** mhit ids ascend in record order (null = the catalog could not be walked). */
  catalogIdsAscend: boolean | null
  /** Every file under iPod_Control/Music/F##, colon path → size. */
  files: Map<string, number>
}

export type SwapProof =
  | { ok: true; rows: Map<number, SwapManifestRow>; history: SwapHistory }
  | { ok: false; why: string }

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

function manifestRows(m: Record<string, unknown>): Map<number, SwapManifestRow> | null {
  if (!Array.isArray(m.tracks)) return null
  const rows = new Map<number, SwapManifestRow>()
  for (const raw of m.tracks as Array<Record<string, unknown>>) {
    const id = Number(raw?.id)
    const destPath = tsaNormalizeColonPath(String(raw?.destPath ?? ''))
    const identity = String(raw?.identity ?? '')
    const size = Number(raw?.size)
    const sourceSize = Number(raw?.sourceSize ?? 0)
    // Library ids start at 0 (Lou Reed's "New York Telephone Conversation" is id 0).
    if (!Number.isInteger(id) || id < 0 || !destPath || !identity) return null
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(sourceSize) || sourceSize < 0) return null
    if (rows.has(id)) return null
    rows.set(id, { id, destPath, identity, size, sourceSize })
  }
  return rows
}

/**
 * Can the card be trusted for a swap? Every "no" is one plain line the result
 * shows ("Full copy: <why>.").
 */
export function proveCardForSwap(manifestRaw: unknown, sealRaw: unknown, card: CardState): SwapProof {
  if (!manifestRaw || typeof manifestRaw !== 'object') {
    return { ok: false, why: 'this Mac has no record of what the last sync put on this iPod' }
  }
  const m = manifestRaw as Record<string, unknown>
  if (m.sealed !== true || m.status !== 'sealed') {
    return { ok: false, why: 'the last sync didn’t finish' }
  }
  if (m.format !== SWAP_MANIFEST_FORMAT) {
    return { ok: false, why: 'the record of the last sync is from an older JakeTunes (one full copy, then swaps)' }
  }
  const rows = manifestRows(m)
  const cat = m.catalog as { md5?: unknown; bytes?: unknown } | undefined
  const swapsSinceFull = Number(m.swapsSinceFull)
  const bytesRemovedSinceFull = Number(m.bytesRemovedSinceFull)
  if (!rows || rows.size === 0 || rows.size !== Number(m.count) || !cat || typeof cat.md5 !== 'string' || !(Number(cat.bytes) > 0)
    || !Number.isInteger(swapsSinceFull) || swapsSinceFull < 0 || !Number.isFinite(bytesRemovedSinceFull) || bytesRemovedSinceFull < 0) {
    return { ok: false, why: 'the record of the last sync can’t be read' }
  }
  const seal = parseTsaSeal(sealRaw)
  if (!seal) return { ok: false, why: 'the iPod has no seal from a finished sync' }
  if (seal.target !== rows.size) return { ok: false, why: 'the seal and the record of the last sync disagree' }
  for (const p of seal.passengers) {
    const r = rows.get(p.id)
    if (!r || r.destPath !== tsaNormalizeColonPath(p.destPath) || r.identity !== p.identity || (p.expectedSize > 0 && p.expectedSize !== r.size)) {
      return { ok: false, why: 'the seal and the record of the last sync disagree' }
    }
  }
  if (!card.catalog) return { ok: false, why: 'the iPod’s song list (iTunesDB) can’t be read' }
  if (card.catalog.md5 !== cat.md5 || card.catalog.bytes !== Number(cat.bytes)) {
    return { ok: false, why: 'the song list on the iPod isn’t the one the last sync wrote' }
  }
  if (card.catalogIdsAscend !== true) {
    return { ok: false, why: 'the song list on the iPod breaks the firmware’s id order' }
  }
  let missing = 0
  let wrongSize = 0
  const expected = new Set<string>()
  for (const r of rows.values()) {
    expected.add(r.destPath)
    const sz = card.files.get(r.destPath)
    if (sz === undefined) missing++
    else if (sz !== r.size) wrongSize++
  }
  if (missing + wrongSize > 0) {
    const parts = [missing ? `${plural(missing, 'song')} missing` : '', wrongSize ? `${plural(wrongSize, 'song')} the wrong size` : ''].filter(Boolean)
    return { ok: false, why: `the iPod has ${parts.join(' and ')} from the last sync` }
  }
  // macOS litters FAT with ._ / .DS_Store files; the firmware never reads
  // them and a removal pass deletes them, so they don't count against proof.
  let strangers = 0
  for (const p of card.files.keys()) {
    if (expected.has(p)) continue
    if ((p.split(':').pop() || '').startsWith('.')) continue
    strangers++
  }
  if (strangers > 0) {
    return { ok: false, why: `the iPod holds ${plural(strangers, 'file')} the last sync didn’t put there` }
  }
  return { ok: true, rows, history: { swapsSinceFull, bytesRemovedSinceFull } }
}

/** One song this sync wants on the card. */
export interface SwapCandidate {
  id: number
  /** Card path this sync would write, colon form. */
  destPath: string
  identity: string
  /** Size of the exact file this sync would copy (master, or its mirror). */
  copySize: number
  /** Size of the library master; 0 = unknown. */
  sourceSize: number
}

export interface SwapPlan {
  /** Ids whose card file stays exactly as it is. */
  stay: Set<number>
  /** Ids this sync copies (new songs, and changed ones). */
  arrive: number[]
  /** Manifest rows whose file comes off the card (gone from the set, or changed). */
  leave: SwapManifestRow[]
  /** Ids in both arrive and leave: same song, its library file changed. */
  changed: number[]
}

export type StayVerdict = 'stay' | 'new' | 'moved' | 'identity-changed' | 'file-changed'

/**
 * A song with no fingerprint yet (a fresh download, before the fingerprint
 * pass reaches it) boards under its path (`path:`). It used to never stay:
 * 2026-11-08, four Cramps songs downloaded the day before were re-copied on
 * every swap over a slow link. And the seal records that path in its CARD form
 * ("imported_14505.m4a" rides as "14505.m4a"), so the two never matched
 * anyway. Such a song stays on the same proof the CLAUDE.md rule allows
 * (track id, exact path, sizes): the same id, the same card path, and both the
 * card file's size and the library master's size known and equal. The same
 * holds the one time a song gains its fingerprint after the sync that put it
 * there. A fingerprint the card's record has is never traded for less, and a
 * fingerprint that differs is a changed song.
 */
function identityHolds(c: SwapCandidate, row: SwapManifestRow): boolean {
  if (row.identity.startsWith('fp:')) return c.identity === row.identity
  if (!row.identity.startsWith('path:')) return false
  if (!c.identity.startsWith('fp:') && !c.identity.startsWith('path:')) return false
  return c.sourceSize > 0 && row.sourceSize > 0
}

export function stayVerdict(c: SwapCandidate, row: SwapManifestRow | undefined): StayVerdict {
  if (!row) return 'new'
  if (tsaNormalizeColonPath(c.destPath) !== row.destPath) return 'moved'
  if (!identityHolds(c, row)) return 'identity-changed'
  if (!(c.copySize > 0) || c.copySize !== row.size) return 'file-changed'
  if (c.sourceSize > 0 && row.sourceSize > 0 && c.sourceSize !== row.sourceSize) return 'file-changed'
  return 'stay'
}

export function planSwap(candidates: SwapCandidate[], rows: Map<number, SwapManifestRow>): SwapPlan {
  const stay = new Set<number>()
  const arrive: number[] = []
  const changed: number[] = []
  for (const c of candidates) {
    const row = rows.get(c.id)
    const v = stayVerdict(c, row)
    if (v === 'stay') stay.add(c.id)
    else {
      arrive.push(c.id)
      if (row) changed.push(c.id)
    }
  }
  const leave = [...rows.values()].filter((r) => !stay.has(r.id))
  return { stay, arrive, leave, changed }
}

/** null = swap; otherwise the plain reason a full copy is simpler. */
export function swapTooBig(plan: SwapPlan, target: number): string | null {
  if (target <= 0) return 'there is nothing to keep'
  if (plan.arrive.length / target > SWAP_MAX_CHANGE_FRACTION) {
    return `${plan.arrive.length.toLocaleString('en-US')} of ${target.toLocaleString('en-US')} songs are changing, so a full copy is simpler`
  }
  return null
}

/**
 * null = this swap may go ahead; otherwise the plain reason the card gets a
 * fresh full copy instead (the fragmentation backstop). `leaveBytes` is what
 * this swap would remove; `capacityBytes` the card's size (null = unknown).
 */
export function swapBackstop(history: SwapHistory, leaveBytes: number, capacityBytes: number | null): string | null {
  if (leaveBytes <= 0) return null      // nothing leaves: no new holes, nothing to count
  if (history.swapsSinceFull >= SWAP_FULL_EVERY) {
    return `it’s been ${history.swapsSinceFull} swaps since the last full copy, and a fresh copy keeps the iPod’s free space in one piece`
  }
  if (!(capacityBytes && capacityBytes > 0)) return 'the iPod’s size can’t be read'
  const removed = history.bytesRemovedSinceFull + leaveBytes
  if (removed > capacityBytes * SWAP_MAX_REMOVED_SHARE) {
    const pct = Math.round((removed / capacityBytes) * 100)
    return `swaps since the last full copy would have cleared ${pct}% of the iPod, and a fresh copy keeps its free space in one piece`
  }
  return null
}

/** What the next manifest records: a full copy starts the count over. */
export function nextSwapHistory(prev: SwapHistory | null, leaveBytes: number): SwapHistory {
  if (!prev) return { swapsSinceFull: 0, bytesRemovedSinceFull: 0 }
  // Only a swap that removed songs counts: one that only added, or changed
  // nothing, leaves no holes behind.
  if (!(leaveBytes > 0)) return { ...prev }
  return { swapsSinceFull: prev.swapsSinceFull + 1, bytesRemovedSinceFull: prev.bytesRemovedSinceFull + leaveBytes }
}

/** "Swapped 7 songs: 7 out, 7 in. 993 stayed." */
export function swapResultLine(out: number, into: number, stayed: number): string {
  const n = (x: number) => x.toLocaleString('en-US')
  const stayedPart = `${n(stayed)} stayed.`
  if (out === 0 && into === 0) return `Nothing to swap: all ${n(stayed)} stayed.`
  if (out === 0) return `Added ${plural(into, 'song')}. ${stayedPart}`
  if (into === 0) return `Removed ${plural(out, 'song')}. ${stayedPart}`
  return `Swapped ${plural(Math.max(out, into), 'song')}: ${n(out)} out, ${n(into)} in. ${stayedPart}`
}

/** "Full copy: the last sync didn’t finish." */
export function fullCopyLine(why: string): string {
  return `Full copy: ${why}.`
}

/**
 * The "never catalog a missing file" guard. Rows whose file is not on the card
 * at the size the catalog will claim. A catalog is only written when this is
 * empty (Mini 1.4.1 aborts Songs on a missing file; it does not skip it).
 */
export function rowsMissingOnCard(
  rows: Array<{ id: number; destPath: string; size: number }>,
  onCard: Map<string, number>,
): number[] {
  const out: number[] = []
  for (const r of rows) {
    const sz = onCard.get(tsaNormalizeColonPath(r.destPath))
    if (sz === undefined || sz <= 0 || sz !== r.size) out.push(r.id)
  }
  return out
}

/** md5 + length, the same digest the catalog proof uses. */
export function catalogDigest(buf: Buffer): { md5: string; bytes: number } {
  return { md5: createHash('md5').update(buf).digest('hex'), bytes: buf.length }
}

/** Walk mhit records; true when their 32-bit ids ascend in file order. */
export function catalogIdsAscend(buf: Buffer): boolean | null {
  try {
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
    let p = mhlt + buf.readUInt32LE(mhlt + 4)
    let prev = -1
    for (let i = 0; i < n; i++) {
      if (buf.toString('latin1', p, p + 4) !== 'mhit') return null
      const id = buf.readUInt32LE(p + 0x10)
      if (id <= prev) return false
      prev = id
      const tl = buf.readUInt32LE(p + 8)
      if (tl <= 0) return null
      p += tl
    }
    return true
  } catch {
    return null
  }
}
