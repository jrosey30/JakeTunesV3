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
import { createHash } from 'node:crypto'
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
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

/** The card path a catalog may list for this card file (case-insensitive, as FAT and HFS+ compare). */
export function cardListsPath(listed: Map<string, number> | null, colon: string): boolean {
  if (!listed) return false
  const want = colon.toLowerCase()
  for (const p of listed.keys()) if (p.toLowerCase() === want) return true
  return false
}

/**
 * The full-library sync's view of the card's song list (Brief 266 1c). No iTunesDB at all: an
 * empty list (nothing is listed, so nothing is protected, as before). An iTunesDB that exists but
 * can't be read or parsed: 'unreadable', and every file already on the card counts as listed.
 */
export type CardListing = Map<string, number> | 'unreadable'
export async function readCardListing(mount: string): Promise<CardListing> {
  let buf: Buffer
  try {
    buf = await readFile(join(mount, 'iPod_Control', 'iTunes', 'iTunesDB'))
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? new Map() : 'unreadable'
  }
  return catalogSizesByPath(buf) ?? 'unreadable'
}

/** The guard before an in-place copy: true = a song the card lists (or may list) is at `dst`; never overwrite it. */
export async function keepListedOnCard(listing: CardListing, mount: string, dst: string): Promise<boolean> {
  const there = await stat(dst).catch(() => null)
  if (!there) return false
  if (listing === 'unreadable') return true
  const rel = dst.slice(mount.length).replace(/^[\\/]+/, '')
  return cardListsPath(listing, ':' + rel.split(/[\\/]/).join(':'))
}

// ── The waves journal ───────────────────────────────────────────────────────
//
// One file in the iPod's state folder, written ONLY by the waves (never by a catalog's manifest
// write, so no later step can overwrite it). It says what the card holds after the last
// VALIDATED catalog commit (`rows`, `committed`: that catalog's md5 and the Mac backup of it),
// and the wave in progress (`open`). Written before the card is touched, then at every step:
//   open.state 'staged'    → the wave's new copies may be on the card, not yet committed;
//   open.state 'committed' → its catalog was written and proven; the originals may still be there.
// It goes when the run seals. The next run settles an open wave from it (recoverFromJournal) and
// proves the card from it (proveCardFromJournal): a commit is known by the journal, never guessed
// from sizes.

export const WAVES_JOURNAL_FILE = 'ipod-waves-journal.json'

export interface JournalRow { id: number; destPath: string; identity: string; size: number; sourceSize: number }
/** Colon paths (the mount can move between runs). */
export interface JournalItem { id: number; dstColon: string; oldColon: string }

export function absOnCard(mount: string, colon: string): string {
  return join(mount, ...colon.replace(/^:/, '').split(':'))
}
/** A song list that stays unreadable this many syncs in a row: the journal goes and the sync is a full copy. */
export const UNREADABLE_STOPS_BEFORE_FULL = 3

export interface WavesJournal {
  version: 1
  /** Syncs in a row that stopped because the card's song list couldn't be read. */
  unreadableStops?: number
  rows: JournalRow[]
  committed: { md5: string; bytes: number; backupDir: string | null }
  /** The song list being written to the card right now (not yet proven), if any. */
  inflight?: { md5: string } | null
  history: { swapsSinceFull: number; bytesRemovedSinceFull: number }
  open: { state: 'staged' | 'committed'; items: JournalItem[] } | null
}

export async function readWavesJournal(stateDir: string): Promise<WavesJournal | null> {
  try {
    const j = JSON.parse(await readFile(join(stateDir, WAVES_JOURNAL_FILE), 'utf-8')) as WavesJournal
    if (j?.version !== 1 || !Array.isArray(j.rows) || typeof j.committed?.md5 !== 'string') return null
    return j
  } catch { return null }
}

/** Written by rename; a failure THROWS: the caller stops before the card changes further. */
export async function writeWavesJournal(stateDir: string, j: WavesJournal): Promise<void> {
  const path = join(stateDir, WAVES_JOURNAL_FILE)
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(j), 'utf-8')
  await rename(tmp, path)
}

export async function deleteWavesJournal(stateDir: string): Promise<void> {
  await unlink(join(stateDir, WAVES_JOURNAL_FILE)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') console.warn('[ipod-waves] the waves journal could not be removed:', err.message)
  })
}

export function md5Of(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex')
}

export interface RecoveryReport { restored: string[]; released: string[]; removed: string[]; dbRestored: boolean; kept: string[]; stale: boolean; unreadable: boolean; noSongList: boolean }

/**
 * Settle what a run left, from the journal. First, which song list is on the card:
 *   • the committed one: nothing to undo there;
 *   • the one the run was writing (`inflight`, never proven): the committed one comes back from
 *     its Mac backup;
 *   • neither: the card was changed elsewhere (another Mac, iTunes, a restore). The journal no
 *     longer describes it: nothing is touched and the caller drops the journal (`stale`);
 *   • none can be read: "can't tell" (`unreadable`): nothing is touched, the journal is kept,
 *     and the caller stops the sync.
 * Then the open wave:
 *   • committed → its originals go (the hidden `.jtorig`, or the old path of a new extension);
 *   • staged    → never committed: every original goes back under its own name (one rename
 *                 over the new copy) and new-path copies go.
 * Staged copies (`.jtnew`) of the wave go either way. Anything that can't be done is left as
 * found and reported; nothing is deleted on a guess. ok:false = the card can't be trusted.
 */
/** Song files under iPod_Control/Music/F## (hidden files aside); -1 when the folder can't be read. */
async function musicFileCount(mount: string): Promise<number> {
  const root = join(mount, 'iPod_Control', 'Music')
  const dirs = await readdir(root).catch(() => null)
  if (!dirs) return -1
  let n = 0
  for (const d of dirs) for (const f of await readdir(join(root, d)).catch(() => [] as string[])) if (!f.startsWith('.')) n++
  return n
}

export async function recoverFromJournal(
  mount: string,
  j: WavesJournal,
  restoreDb: (backupDir: string) => Promise<void>,
): Promise<{ ok: boolean; report: RecoveryReport }> {
  const rep: RecoveryReport = { restored: [], released: [], removed: [], dbRestored: false, kept: [], stale: false, unreadable: false, noSongList: false }
  const tryDo = async (label: string, f: () => Promise<void>): Promise<boolean> => {
    try { await f(); return true } catch (err) {
      console.warn(`[ipod-waves] ${label} left as found:`, err instanceof Error ? err.message : err)
      rep.kept.push(label)
      return false
    }
  }
  let readErr: NodeJS.ErrnoException | null = null
  const db = await readFile(join(mount, 'iPod_Control', 'iTunes', 'iTunesDB')).catch((err: NodeJS.ErrnoException) => { readErr = err; return null })
  // No song list and no songs (restored, or set up fresh elsewhere): the journal can never
  // describe it again. `noSongList`: nothing is touched; the
  // caller drops the journal and the sync is an ordinary full copy, said plainly.
  // A song list that is there but can't be read (a mount hiccup) is "can't tell", never "changed
  // elsewhere": nothing is touched and the journal is kept for a sync that can read it
  // (`unreadable`; the caller gives up on it after UNREADABLE_STOPS_BEFORE_FULL in a row).
  if (!db) {
    const code = (readErr as NodeJS.ErrnoException | null)?.code
    // A restore empties Music too; a song list missing beside songs still there is a hiccup.
    if (code === 'ENOENT' && (await musicFileCount(mount)) === 0) rep.noSongList = true
    else rep.unreadable = true
    return { ok: false, report: rep }
  }
  const onCard = md5Of(db)
  const inflight = j.inflight?.md5 ?? null
  if (onCard !== j.committed.md5) {
    if (onCard !== inflight) {
      rep.stale = true
      return { ok: false, report: rep }
    }
    if (!j.committed.backupDir) return { ok: false, report: rep }
    const ok = await tryDo('the committed song list', async () => { await restoreDb(j.committed.backupDir!) })
    if (!ok) return { ok: false, report: rep }
    rep.dbRestored = true
  }
  const open = j.open
  if (!open) return { ok: true, report: rep }
  const items = open.items.map((it) => ({ dst: absOnCard(mount, it.dstColon), oldAbs: absOnCard(mount, it.oldColon) }))
  for (const it of items) {
    const staged = sideName(it.dst, NEW_TAG)
    if (await stat(staged).catch(() => null)) await tryDo(staged, async () => { await unlink(staged); rep.removed.push(staged) })
  }
  if (open.state === 'committed') {
    for (const it of items) {
      const gone = it.dst === it.oldAbs ? sideName(it.oldAbs, ORIG_TAG) : it.oldAbs
      if (await stat(gone).catch(() => null)) await tryDo(gone, async () => { await unlink(gone); rep.released.push(gone) })
    }
    return { ok: true, report: rep }
  }
  for (const it of items) {
    if (it.dst === it.oldAbs) {
      const orig = sideName(it.dst, ORIG_TAG)
      if (await stat(orig).catch(() => null)) await tryDo(orig, async () => { await rename(orig, it.dst); rep.restored.push(it.dst) })
    } else if (await stat(it.oldAbs).catch(() => null) && await stat(it.dst).catch(() => null)) {
      await tryDo(it.dst, async () => { await unlink(it.dst); rep.removed.push(it.dst) })
    }
  }
  return { ok: true, report: rep }
}

/**
 * The card proven from the journal: the catalog on it must be the last committed one (same
 * md5) and every journal row's file must be there at its size. Files no row names are strays
 * (the removal pass takes them off). Hidden files never count.
 */
export function proveCardFromJournal(j: WavesJournal, card: { catalog: { md5: string; bytes: number } | null; catalogIdsAscend: boolean | null; files: Map<string, number> }):
  { ok: true; rows: Map<number, JournalRow>; strays: number; history: WavesJournal['history'] } | { ok: false; why: string } {
  if (!card.catalog || card.catalog.md5 !== j.committed.md5) return { ok: false, why: 'the song list on the iPod isn’t the one the replacement left' }
  if (card.catalogIdsAscend !== true) return { ok: false, why: 'the song list on the iPod breaks the firmware’s id order' }
  const rows = new Map<number, JournalRow>()
  for (const r of j.rows) {
    if (card.files.get(r.destPath) !== r.size) return { ok: false, why: 'a song the replacement left isn’t on the iPod at its size' }
    rows.set(r.id, r)
  }
  const known = new Set(j.rows.map((r) => r.destPath))
  let strays = 0
  for (const p of card.files.keys()) if (!known.has(p) && !(p.split(':').pop() || '').startsWith('.')) strays++
  return { ok: true, rows, strays, history: j.history }
}
