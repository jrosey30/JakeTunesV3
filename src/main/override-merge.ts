/**
 * The metadata-overrides.json merge rules, pure (moved verbatim out of
 * index.ts 2026-10-20 so the replica-edit absorb, Cynthia's sweep and a
 * local Get Info save all go through ONE writer, and so tests and the
 * no-data-loss proof run the exact code the app runs).
 *
 * Entry format on disk (v2):
 *   { "<trackId>": { "fp": "<fingerprint>", "fields": { "<field>": "<value>" } } }
 * Legacy (v1, no fingerprint): { "<trackId>": { "<field>": "<value>" } } —
 * kept on disk, ignored by the renderer.
 */
type OvEntry = { fp?: string; fields?: Record<string, string> }

const DURATION_SLACK_MS = 2000   // the same 2 s as common/user-edits.ts sameSong

/** The length a fingerprint (`title|artist|duration`) names, or null. */
function fpLength(fp: string): number | null {
  const n = Number(fp.slice(fp.lastIndexOf('|') + 1))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Another song under this id? Only when the length differs. A changed title or
 * artist at the same length is the same recording Jake corrected (his Get Info
 * changes the fingerprint): its other fields stay.
 */
export function isAnotherSong(oldFp: string, newFp: string): boolean {
  const a = fpLength(oldFp), b = fpLength(newFp)
  if (a === null || b === null) return true
  return Math.abs(a - b) > DURATION_SLACK_MS
}

/**
 * One field into `overrides` (mutated and returned). An explicit fingerprint
 * mismatch for a song of ANOTHER LENGTH wipes the entry (the re-parse
 * safeguard: the id now names another song). A mismatch at the same length is
 * a corrected title or artist: it merges, so none of Jake's other fields are
 * lost (review of #501). A save without a fingerprint merges and keeps the
 * entry's own; a fresh entry is stamped with the fingerprint given.
 */
export function mergeOverrideField(
  overrides: Record<string, unknown>, trackId: number | string, field: string, value: string, fingerprint?: string,
): Record<string, unknown> {
  const key = String(trackId)
  const existing = overrides[key] as OvEntry | undefined
  const isV2 = !!existing && typeof existing === 'object' && 'fields' in existing
  const hasNewFp = typeof fingerprint === 'string' && fingerprint !== ''
  const existingFp = isV2 ? (existing!.fp || '') : ''
  if (isV2 && hasNewFp && existingFp && existingFp !== fingerprint && isAnotherSong(existingFp, fingerprint!)) {
    // Explicit fingerprint mismatch — track at this ID has changed
    // identity (re-parse, library shift, etc). Old overrides don't
    // apply anymore; start fresh with just the new field.
    overrides[key] = { fp: fingerprint, fields: { [field]: value } }
  } else if (isV2) {
    // Same track (matching fp, or one side has no fp). MERGE — never
    // drop prior fields. Update fp only if a new one was passed.
    overrides[key] = {
      fp: hasNewFp ? fingerprint : existingFp,
      fields: { ...(existing!.fields || {}), [field]: value },
    }
  } else {
    // No prior entry — fresh write.
    overrides[key] = { fp: fingerprint || '', fields: { [field]: value } }
  }
  return overrides
}
