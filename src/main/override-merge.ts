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

/** A fingerprint's parts: `title|artist|duration` (lowercased, trimmed), or null when it isn't one. */
function fpParts(fp: string): { title: string; artist: string; dur: number } | null {
  const p = fp.split('|')
  if (p.length < 3) return null
  const dur = Number(p[p.length - 1])
  if (!Number.isFinite(dur) || dur <= 0) return null
  return { title: p.slice(0, -2).join('|').trim().toLowerCase(), artist: p[p.length - 2].trim().toLowerCase(), dur }
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase()

/**
 * Another song under this id? A changed fingerprint is the same recording only
 * with evidence that it is Jake's correction (re-review of #502: 1.5% of song
 * pairs fall within 2 s of each other, so a length alone proves nothing; Peg
 * must never turn into Blue Monday):
 *   - the length agrees (within the edit sync's 2 s), AND
 *   - exactly one of title / artist changed and the other still matches, OR
 *     the new title or artist is a value his own override set for this id.
 * Anything else is another song: the entry starts fresh, as it always did.
 */
export function isAnotherSong(oldFp: string, newFp: string, entryFields?: Record<string, string>): boolean {
  const a = fpParts(oldFp), b = fpParts(newFp)
  if (!a || !b) return true
  if (Math.abs(a.dur - b.dur) > DURATION_SLACK_MS) return true
  const sameTitle = a.title === b.title, sameArtist = a.artist === b.artist
  if (sameTitle && sameArtist) return false               // only the length moved, within the slack
  if (sameTitle !== sameArtist) return false              // exactly one changed, the other matches
  const his = entryFields ?? {}
  if ((his.title !== undefined && norm(his.title) === b.title) || (his.artist !== undefined && norm(his.artist) === b.artist)) return false
  return true
}

/**
 * One field into `overrides` (mutated and returned). An explicit fingerprint
 * mismatch wipes the entry (the re-parse safeguard: the id now names another
 * song) unless isAnotherSong finds evidence it is Jake's own correction of
 * this song's title or artist; then it merges, so none of his other fields
 * are lost (review of #501, re-review of #502). A save without a fingerprint merges and keeps the
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
  if (isV2 && hasNewFp && existingFp && existingFp !== fingerprint && isAnotherSong(existingFp, fingerprint!, existing!.fields)) {
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
