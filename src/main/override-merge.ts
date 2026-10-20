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

/**
 * One field into `overrides` (mutated and returned). An explicit fingerprint
 * MISMATCH wipes the entry (the re-parse safeguard: the id now names another
 * song); a save without a fingerprint merges and keeps the entry's own; a
 * fresh entry is stamped with the fingerprint given.
 */
export function mergeOverrideField(
  overrides: Record<string, unknown>, trackId: number | string, field: string, value: string, fingerprint?: string,
): Record<string, unknown> {
  const key = String(trackId)
  const existing = overrides[key] as OvEntry | undefined
  const isV2 = !!existing && typeof existing === 'object' && 'fields' in existing
  const hasNewFp = typeof fingerprint === 'string' && fingerprint !== ''
  const existingFp = isV2 ? (existing!.fp || '') : ''
  if (isV2 && hasNewFp && existingFp && existingFp !== fingerprint) {
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
