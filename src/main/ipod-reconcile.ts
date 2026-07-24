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
