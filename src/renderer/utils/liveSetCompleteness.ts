import type { Track } from '../types'

/// V5 Live Concert Mode — the completeness gate.
///
/// Jake's rule: declaring Live Mode is allowed IF AND ONLY IF the library
/// holds ALL of the live album's tracks. Verification is local and
/// deterministic, from the files' own tags — but tags follow TWO
/// conventions, and the gate must read both (learned the hard way:
/// Random Access Memories is globally numbered 1..14 with vinyl-side
/// disc tags 1/2/4, and v1 of this gate misread that as "disc 3
/// missing" on a complete album):
///
///   GLOBAL numbering — track numbers run 1..N across the whole album
///   (vinyl rips, Bandcamp). Detected when every number is unique.
///   Disc tags are decorative (LP sides) and are ignored.
///
///   PER-DISC numbering — each disc restarts at 1. Detected when
///   numbers repeat. Discs must run 1..D and each disc 1..N.
///
/// Contiguity catches gaps and duplicates outright. The TAIL (tracks
/// 1..14 of a 23-track show look contiguous) can only be proven by a
/// declared total: when the files carry trackCount it must match; when
/// they don't, the result is `complete: true, verifiedTotal: false` —
/// the album's SHAPE is complete but the total is unproven, and the UI
/// asks Jake to confirm before declaring (he is the canonical source
/// when the files aren't). Hard failures stay hard.

export type CompletenessResult =
  | { complete: true; discs: number; total: number; verifiedTotal: boolean }
  | { complete: false; reason: string }

function num(v: number | string | undefined | null): number {
  // Tolerant of "5", 5, and "5/23"-style combined tags.
  const x = parseInt(String(v ?? ''), 10)
  return Number.isFinite(x) && x > 0 ? x : 0
}

export function verifyLiveSetCompleteness(tracks: Track[]): CompletenessResult {
  if (tracks.length === 0) return { complete: false, reason: 'no tracks found for this album' }

  const unnumbered = tracks.filter(t => num(t.trackNumber) === 0)
  if (unnumbered.length > 0) {
    const name = unnumbered[0].title || 'a track'
    return {
      complete: false,
      reason: unnumbered.length === 1
        ? `"${name}" has no track number — can't verify the set is complete (fix via Get Info)`
        : `${unnumbered.length} tracks have no track number — can't verify the set is complete (fix via Get Info)`,
    }
  }

  const allNums = tracks.map(t => num(t.trackNumber))
  const globallyUnique = new Set(allNums).size === allNums.length

  if (globallyUnique) {
    // ── GLOBAL numbering (RAM-style). Disc tags are LP sides — ignored. ──
    const sorted = [...allNums].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i + 1) {
        return { complete: false, reason: `track ${i + 1} is missing` }
      }
    }
    const declared = Math.max(0, ...tracks.map(t => num(t.trackCount)))
    if (declared > 0 && sorted.length < declared) {
      return { complete: false, reason: `the files declare ${declared} tracks — the library has ${sorted.length}` }
    }
    if (declared > 0 && sorted.length > declared) {
      return { complete: false, reason: `more tracks than the files declare (${sorted.length} vs ${declared}) — check for a mixed edition` }
    }
    return { complete: true, discs: 1, total: sorted.length, verifiedTotal: declared > 0 }
  }

  // ── PER-DISC numbering (repeated track numbers ⇒ discs restart at 1). ──
  const discs = new Map<number, Track[]>()
  for (const t of tracks) {
    const d = num(t.discNumber) || 1
    const arr = discs.get(d)
    if (arr) arr.push(t)
    else discs.set(d, [t])
  }

  const discNums = [...discs.keys()].sort((a, b) => a - b)
  for (let i = 0; i < discNums.length; i++) {
    if (discNums[i] !== i + 1) {
      return { complete: false, reason: `the files' disc tags run ${discNums.join(', ')} — disc ${i + 1} is missing` }
    }
  }
  const declaredDiscCount = Math.max(0, ...tracks.map(t => num(t.discCount)))
  if (declaredDiscCount > 0 && discNums.length !== declaredDiscCount) {
    return { complete: false, reason: `the files declare ${declaredDiscCount} discs — the library has ${discNums.length}` }
  }

  let total = 0
  let everyDiscDeclared = true
  for (const d of discNums) {
    const group = discs.get(d)!
    const label = discNums.length > 1 ? ` of disc ${d}` : ''
    const nums = group.map(t => num(t.trackNumber)).sort((a, b) => a - b)

    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === nums[i - 1]) {
        return { complete: false, reason: `two tracks claim #${nums[i]}${label} — resolve the duplicate first` }
      }
    }
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) {
        return { complete: false, reason: `track ${i + 1}${label} is missing` }
      }
    }

    const declared = Math.max(0, ...group.map(t => num(t.trackCount)))
    if (declared > 0 && nums.length < declared) {
      return { complete: false, reason: `the files declare ${declared} tracks${label} — the library has ${nums.length}` }
    }
    if (declared > 0 && nums.length > declared) {
      return { complete: false, reason: `more tracks than the files declare (${nums.length} vs ${declared}${label}) — check for a mixed edition` }
    }
    if (declared === 0) everyDiscDeclared = false
    total += nums.length
  }

  return { complete: true, discs: discNums.length, total, verifiedTotal: everyDiscDeclared }
}
