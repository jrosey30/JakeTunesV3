/**
 * iPod sync reconciliation — know the TRUE device state cheaply, never guess.
 *
 * Jake 2026-07-23: "you need a great smart way of figuring out what is being
 * synced without taking up too much space." The old sync trusted a cached
 * mirror of what it *thought* was on the iPod. On a flaky connection (the
 * iFlash Mini drops off the USB bus mid-copy) that cache lies: it writes a
 * 100-track catalog while only 76 files actually landed, and reports success.
 *
 * The fix costs almost nothing: **file size is the fingerprint.** A fully
 * copied file has exactly the bytes we wrote; a copy killed by a bus drop is
 * truncated (wrong size) or absent. So to know if track T is really on the
 * device we `stat` its file and compare the byte size to what we intended —
 * metadata only, no content read, no hashing, no stored manifest. The
 * iTunesDB the device already carries records {trackId → path, size}, so it
 * IS the ledger; we just re-verify it by size each sync.
 *
 * This module is the PURE decision core (no fs). The sync layer supplies:
 *   - the intended set (trackId → the exact bytes' size we will/ did write)
 *   - the current device catalog (trackId → recorded size), from the iTunesDB
 *   - which of those catalog files actually verify on disk right now
 *     (caller stat()s them — cheap), plus post-copy read-back results.
 */

/** One track we intend to have on the device, with the size of the exact
 *  bytes we put there (post-transcode if converting, else the source size). */
export interface IntendedTrack {
  id: number
  /** Size in bytes of the file that lands on the iPod. */
  expectedSize: number
}

/** What the device's own iTunesDB claims is present. */
export interface DeviceCatalogEntry {
  id: number
  /** Size the catalog recorded when this track was (verified) written. */
  recordedSize: number
}

export interface ReconcilePlan {
  /** Intended, already on device, file verified at the right size — skip. */
  kept: number[]
  /** Intended, but missing or wrong-size on device — must (re)copy. */
  toCopy: number[]
  /** On device but not in the intended set — remove. */
  toRemove: number[]
}

/** True only if a landed file is exactly the size we meant to write.
 *  Exact match — a truncated (bus-drop) or stale-different file fails. */
export function sizeVerified(actualSize: number | null | undefined, expectedSize: number): boolean {
  return typeof actualSize === 'number' && actualSize > 0 && actualSize === expectedSize
}

/**
 * Decide the sync from ACTUAL device truth, not a cache.
 *
 * @param intended       the set we want on the device
 * @param deviceCatalog  the device's current iTunesDB entries
 * @param verifiedSizeById  trackId → the file's real on-disk size RIGHT NOW
 *        (from a cheap stat of each catalog file; absent/0 = not present).
 *        Only ids the caller could confirm belong here.
 */
export function planReconcile(
  intended: IntendedTrack[],
  deviceCatalog: DeviceCatalogEntry[],
  verifiedSizeById: Map<number, number>,
): ReconcilePlan {
  const intendedById = new Map(intended.map((t) => [t.id, t]))
  const catalogIds = new Set(deviceCatalog.map((e) => e.id))

  const kept: number[] = []
  const toCopy: number[] = []
  for (const t of intended) {
    // "Present" requires BOTH: the catalog claims it AND the actual file
    // verifies at the intended size. Either one alone is a lie waiting to
    // happen — a catalog entry with no file (the 76/100 bug) or a stray file
    // with no catalog record.
    const actual = verifiedSizeById.get(t.id)
    if (catalogIds.has(t.id) && sizeVerified(actual, t.expectedSize)) {
      kept.push(t.id)
    } else {
      toCopy.push(t.id)
    }
  }

  const toRemove: number[] = []
  for (const e of deviceCatalog) {
    if (!intendedById.has(e.id)) toRemove.push(e.id)
  }

  return { kept, toCopy, toRemove }
}

/**
 * After a copy pass, split the intended set by what verifiably landed, so the
 * catalog is built from ONLY real files and the caller can report honestly.
 *
 * @param landedSizeById  trackId → size read back after copy (stat). A track
 *        counts as landed only if its read-back size equals expectedSize.
 */
export function partitionLanded(
  intended: IntendedTrack[],
  landedSizeById: Map<number, number>,
): { landed: number[]; failed: number[] } {
  const landed: number[] = []
  const failed: number[] = []
  for (const t of intended) {
    if (sizeVerified(landedSizeById.get(t.id), t.expectedSize)) landed.push(t.id)
    else failed.push(t.id)
  }
  return { landed, failed }
}

/**
 * Activity wipe+rebuild may only report success after TWO consecutive cold
 * remounts that both showed the full target.
 *
 * A single lucky remount is the 500/500 → 33 roulette: macOS fskit still
 * reports the mount-cache set, JakeTunes greens the sync, eject shows what
 * the card actually kept, and the Mini's Songs count jumps around as the
 * firmware indexes a catalog of missing files.
 */
export function activitySetProven(consecutiveFullProofs: number, landed: number, target: number): boolean {
  return target > 0 && landed >= target && consecutiveFullProofs >= 2
}

/**
 * The iTunesDB file itself must be on the CF, not in the Mac mount cache.
 *
 * 2026-08-16: Jake — "the catalog of 500 was never ever on the card."
 * Audio already requires two remounts. The catalog was written straight
 * onto /Volumes/JAKETUNES, "verified" with F_NOCACHE (a no-op on fskit),
 * then parsed as 500 rows from cache. Mini Songs was 450: firmware walked
 * whatever file was actually on the CF. Same rule as activitySetProven —
 * two consecutive cold remounts, byte+hash+track-count match, or it is
 * not on the card.
 */
export function catalogBytesMatch(opts: {
  onCardBytes: number
  localBytes: number
  onCardMd5: string
  localMd5: string
  trackCount: number
  target: number
}): boolean {
  const target = Math.max(0, Math.floor(opts.target))
  const tracks = Math.max(0, Math.floor(opts.trackCount))
  const onBytes = Math.max(0, Math.floor(opts.onCardBytes))
  const localBytes = Math.max(0, Math.floor(opts.localBytes))
  const onMd5 = String(opts.onCardMd5 || '')
  const localMd5 = String(opts.localMd5 || '')
  return target > 0
    && tracks === target
    && onBytes > 0
    && onBytes === localBytes
    && localMd5.length > 0
    && onMd5 === localMd5
}

export function catalogOnCardProven(consecutiveFullProofs: number, match: boolean): boolean {
  return match && consecutiveFullProofs >= 2
}

/**
 * Bytes the iTunesDB mhit 0x24 field must carry: the file ON THE CARD.
 *
 * ⚠️ TWIN: core/db_reader.py write_itunesdb restat from --ipod-root (the
 * mount), never from the local temp output path.
 * add_file_sizes() is READ-only and stats the library mirror, not the USB
 * volume. 2026-08-15 cold-plug: 500 files on the Mini, 55 mhit sizes from
 * stale library.json (Foo Fighters "Beyond Me" 31,481,234 ALAC vs 7,549,180
 * on card). Mini 1.4.1 skips or aborts Songs indexing on size mismatch —
 * that's 79 / 111 / 340 with a green 500/500.
 *
 * Never fall back to library.json. No on-card stat → 0 (writer must not
 * pack a lie into an old mhit header).
 */
export function fileSizeForItunesDb(onCardBytes: number | null | undefined): number {
  const n = Number(onCardBytes)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * mhit 0x3C sample rate (Hz). Firmware 1.4.1 skips or aborts Songs on 0.
 *
 * ⚠️ TWIN: core/db_reader.py sample_rate_for_itunesdb
 * 2026-08-15: 4 of 500 activity tracks shipped sampleRate=0 / mediatype=0
 * because build_mhit_record only packed those fields when is_new. The files
 * were fine (AAC 44.1k). Never pack 0.
 */
export function sampleRateForItunesDb(hz: number | null | undefined): number {
  const n = Math.floor(Number(hz) || 0)
  return n >= 8000 && n <= 192000 ? n : 44100
}

/**
 * mhit 0xD0 mediatype. 1 = audio/music.
 *
 * ⚠️ TWIN: core/db_reader.py packs 0xD0 = 1 on every mhit, not only is_new.
 */
export function mediaTypeForItunesDb(): 1 {
  return 1
}

/** Two consecutive empty readdirs — one empty listing is a fskit lie. */
export const ACTIVITY_WIPE_EMPTY_STREAK = 2
export const ACTIVITY_WIPE_MAX_PASSES = 8

/** After deleting whatever this readdir returned, how many empty listings in a row? */
export function activityWipeEmptyStreak(listedAfterPass: number, prevStreak: number): number {
  const n = Math.max(0, Math.floor(Number(listedAfterPass) || 0))
  const prev = Math.max(0, Math.floor(Number(prevStreak) || 0))
  return n === 0 ? prev + 1 : 0
}

export function activityWipeProvenEmpty(emptyStreak: number): boolean {
  return emptyStreak >= ACTIVITY_WIPE_EMPTY_STREAK
}

/**
 * Session files iTunes and libgpod retire on every iTunesDB write.
 *
 * ipodlinux: Play Counts is erased after autosync so the iPod cannot
 * duplicate/merge it; OTG playlists "cannot survive changing the contents
 * of the iPod." libgpod itdb_write / itdb_rename_files rename Play Counts
 * to .bak and unlink OTGPlaylistInfo.
 *
 * 2026-08-16: catalog 500, file-readback said 4 missing, we returned
 * ok:false WITHOUT deleting scratch. Mini Songs went to 450 — firmware
 * merged a partial-index Play Counts into the new catalog and aborted.
 * These names must be gone before the Mini boots onto a new iTunesDB,
 * including on a failed verify.
 */
export const IPOD_FIRMWARE_SCRATCH_NAMES = [
  'Play Counts',
  'Play Counts.bak',
  'OTGPlaylistInfo',
  'OTGPlaylistInfo_DND',
  'OTGPlaylist',
] as const

export function isIpodFirmwareScratchName(name: string): boolean {
  const n = String(name || '')
  if (!n) return false
  if ((IPOD_FIRMWARE_SCRATCH_NAMES as readonly string[]).includes(n)) return true
  if (/^OTGPlaylist(\d+|_\d+|_DND)?$/i.test(n)) return true
  if (/^OTGPlaylistInfo/i.test(n)) return true
  if (/^Play Counts/i.test(n)) return true
  return false
}

/**
 * Bytes we expect a track to occupy ON THE IPOD after sync.
 *
 * When convert-higher-bitrate is on, lossless sources land as AAC — often
 * 4–6× smaller than the library master. Using the master size here is how a
 * 500-song activity sync used to report "syncing 500" and then leave ~100
 * on a Mini: verify compared AAC-on-card to ALAC-in-library, failed every
 * track, recopied the full ALAC over the AAC, and the card filled up.
 */
export function estimateIpodBytes(opts: {
  fileSize?: number | null
  durationMs?: number | null
  convertEnabled?: boolean
  targetKbps?: number
  isLossless?: boolean
}): number {
  const fileSize = Math.max(0, Number(opts.fileSize) || 0)
  if (opts.convertEnabled && opts.isLossless) {
    const durSec = Math.max(0, Number(opts.durationMs) || 0) / 1000
    const kbps = Math.max(64, Number(opts.targetKbps) || 128)
    if (durSec > 0) return Math.ceil(durSec * kbps * 1000 / 8)
    // No duration → rough AAC estimate from the lossless master (~5:1).
    return Math.max(1, Math.ceil((fileSize || 5_000_000) / 5))
  }
  return Math.max(1, fileSize || 5_000_000)
}

/** True when codec/path say the library master is lossless (convert candidate). */
export function looksLossless(codec?: string | null, pathOrExt?: string | null): boolean {
  const c = String(codec || '').toLowerCase()
  if (c === 'alac' || c.includes('alac') || c.includes('apple lossless') || c === 'flac' || c.includes('flac') || c.startsWith('pcm')) {
    return true
  }
  const p = String(pathOrExt || '').toLowerCase()
  const ext = p.includes('.') ? p.slice(p.lastIndexOf('.')) : p
  return ext === '.alac' || ext === '.flac' || ext === '.wav' || ext === '.wave' || ext === '.aiff' || ext === '.aif'
}

/**
 * How many leading tracks fit in `freeBytes` (after a small DB/overhead reserve).
 * Pure — the sync layer supplies already-estimated per-track ipod byte sizes.
 */
export function packTracksToCapacity<T extends { bytes: number }>(
  tracks: T[],
  freeBytes: number,
  reserveBytes = 64 * 1024 * 1024,
): { packed: T[]; dropped: T[]; budgetBytes: number; usedBytes: number } {
  const budget = Math.max(0, freeBytes - Math.max(0, reserveBytes))
  const packed: T[] = []
  const dropped: T[] = []
  let used = 0
  for (const t of tracks) {
    const b = Math.max(0, Number(t.bytes) || 0)
    if (b > 0 && used + b <= budget) {
      packed.push(t)
      used += b
    } else {
      dropped.push(t)
    }
  }
  return { packed, dropped, budgetBytes: budget, usedBytes: used }
}

/**
 * Extensions Mini 1.4.1 will actually put in Music > Songs.
 * .flac is NOT here — the Mini cannot index FLAC. .alac as a filename
 * isn't either; ALAC belongs in an .m4a. Garbage FAT temps (.0i4zLU)
 * are not here — 2026-08-15 Activity 500 → Songs 497: three ALAC files
 * named that way were stamped MP3 and skipped.
 */
export const IPOD_FIRMWARE_EXTS = new Set([
  '.m4a', '.mp3', '.mp4', '.aac', '.wav', '.wave', '.aiff', '.aif',
])

/** ⚠️ TWIN: core/db_reader.py IPOD_CHAR_FOLD */
const IPOD_CHAR_FOLD: Record<string, string> = {
  '‘': "'", '’': "'",
  '‚': "'", '‛': "'",
  '“': '"', '”': '"',
  '„': '"', '‟': '"',
  '–': '-', '—': '-', '‒': '-', '―': '-',
  '‐': '-', '‑': '-',
  '…': '...',
  '\u00a0': ' ', '\u2007': ' ', '\u202f': ' ', '\u2009': ' ',
  '™': 'TM', '®': '(R)', '©': '(C)',
  '′': "'", '″': '"',
  '´': "'", '`': "'",
}

export function ipodPathExtension(pathOrExt: string): string {
  const p = String(pathOrExt || '')
  const i = p.lastIndexOf('.')
  return i >= 0 ? p.slice(i).toLowerCase() : ''
}

/**
 * Dest the Mini can index. Garbage FAT temps and .flac/.alac filenames
 * become .m4a. Real audio extensions are left alone.
 */
export function ipodPlayableDestPath(colonOrFsPath: string): string {
  const p = String(colonOrFsPath || '')
  if (!p) return p
  const ext0 = ipodPathExtension(p)
  const ext = IPOD_FIRMWARE_EXTS.has(ext0) ? ext0 : '.m4a'
  // Split off the last path segment — colon (library) or fs separators both
  // arrive here (dstToCopy re-checks land as absolute fs paths).
  const cut = Math.max(p.lastIndexOf(':'), p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const dir = cut >= 0 ? p.slice(0, cut + 1) : ''
  const base = cut >= 0 ? p.slice(cut + 1) : p
  const stem = base.replace(/\.[^.]*$/, '')
  // 8.3-SAFE stems (2026-08-31). Names longer than 8 chars force VFAT
  // long-filename chains + generated aliases on the card. macOS's FSKit
  // msdos driver writes LFN structures the Mini 1.4.1 FAT parser rejects
  // for a deterministic slice of files — every "About says 897/862/908
  // of 1000" undercount traced to this (full forensic record in the
  // 2026-08-31 session: catalog, files, FS, and card all exonerated;
  // legacy 4-char names never failed in years of full syncs). So:
  // 'imported_10926.m4a' → '10926.m4a'; short legacy names pass through.
  let stem83 = stem
  if (!/^[A-Za-z0-9_~-]{1,8}$/.test(stem)) {
    const digits = stem.replace(/[^0-9]/g, '')
    stem83 = (digits || stem.replace(/[^A-Za-z0-9_-]/g, '')).slice(-8) || 'X'
  }
  return dir + stem83 + ext
}

export function needsIpodAlacTranscode(pathOrExt?: string | null): boolean {
  return ipodPathExtension(String(pathOrExt || '')) === '.flac'
}

/**
 * Fold characters Mini 1.4.1 silently drops, without blanking a title
 * that has no Latin equivalent (Hebrew "דג" must not become "").
 *
 * ⚠️ TWIN: core/db_reader.py fold_for_ipod
 * 2026-07-25: 250 → 247 from three U+2019 titles.
 * 2026-08-15: 500 → 497 also had Hebrew folded to whitespace — keep
 * the original UTF-16 when the map would leave nothing to list.
 */
export function foldForIpod(text: string | null | undefined): string {
  const s = String(text ?? '')
  if (!s) return ''
  let out = ''
  for (const c of s) out += IPOD_CHAR_FOLD[c] ?? c
  if ([...out].some((c) => (c.codePointAt(0) ?? 0) > 0xFF)) {
    let folded = ''
    for (const c of out) {
      const cp = c.codePointAt(0) ?? 0
      if (cp <= 0xFF) {
        folded += c
        continue
      }
      const dec = c.normalize('NFKD')
      const ascii = [...dec]
        .filter((x) => (x.codePointAt(0) ?? 0) <= 0xFF && !/\p{M}/u.test(x))
        .join('')
      folded += ascii
    }
    out = folded
  }
  if (!out.trim() && s.trim()) return s
  return out
}

/**
 * Would Mini 1.4.1 put this catalog row in Music > Songs?
 *
 * File-count 500 + catalog 500 with Songs 497 is this returning false
 * for three rows. 79, 12, 33, 471, 497 are the same class.
 */
export function ipodFirmwareWillList(t: {
  title?: unknown
  artist?: unknown
  path?: unknown
  codec?: unknown
}): boolean {
  if (!foldForIpod(String(t.title ?? '')).trim()) return false
  if (!foldForIpod(String(t.artist ?? '')).trim()) return false
  const ext = ipodPathExtension(String(t.path ?? ''))
  return IPOD_FIRMWARE_EXTS.has(ext)
}
