/**
 * Mood-index orphan prune: pure planning, identity-gated.
 *
 * 2026-09-27. Ask #1 from the nightly brain exercise
 * (brain-eval/PROPOSAL-mood-import-clobber.md, fix 2): vibe vectors for
 * tracks that have LEFT the library were never removed, and 18 of them
 * sat in the vibe search's top slots every night. Pruning them measured
 * +0.011 to +0.016 router-truth on eighteen separate nights, with no
 * probe ever getting worse.
 *
 * The danger is the reason the trainer never pruned before: library.json
 * lives on the NAS and has been caught torn mid-write. A short read makes
 * thousands of real songs look "gone". So the plan REFUSES whenever more
 * than a small slice of the index looks orphaned. A real orphan set is a
 * handful of deleted imports; a big number is a bad read, not a cleanup.
 *
 * Used by scripts/brain-trainer.mjs. Tested by
 * src/main/__tests__/brain-prune.test.ts.
 */

/** At most this share of the index may be pruned in one night. */
export const PRUNE_MAX_FRACTION = 0.02
/** And never more than this many vectors, whatever the index size. */
export const PRUNE_MAX_ABSOLUTE = 200
/** Small indexes still get a floor, so a tiny test brain can prune a few. */
export const PRUNE_MIN_CAP = 20

/**
 * @param {Iterable<number>} indexIds  ids that have a vector in the index
 * @param {Iterable<number|string>} libraryIds  every track id in library.json
 * @returns {{ prune: number[], refused?: string, cap: number }}
 */
export function planMoodPrune(indexIds, libraryIds) {
  const lib = new Set()
  for (const raw of libraryIds) {
    const id = Number(raw)
    if (Number.isFinite(id)) lib.add(id)
  }
  const index = [...indexIds].map(Number)
  const cap = Math.min(PRUNE_MAX_ABSOLUTE, Math.max(PRUNE_MIN_CAP, Math.floor(index.length * PRUNE_MAX_FRACTION)))
  if (lib.size === 0) return { prune: [], cap, refused: 'library.json has no tracks: refusing to prune against an empty read' }
  const prune = index.filter((id) => !lib.has(id)).sort((a, b) => a - b)
  if (prune.length > cap) {
    return {
      prune: [],
      cap,
      refused: `${prune.length} of ${index.length} vectors look orphaned (cap ${cap}). A short library read looks exactly like this, so nothing was pruned. If you really deleted that many songs, run: node scripts/brain-trainer.mjs --prune-mood-orphans-anyway`,
    }
  }
  return { prune, cap }
}
