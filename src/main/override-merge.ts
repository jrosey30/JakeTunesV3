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
 * His names for this id: the entry's own override, his journal and phone edits
 * (passed in), and this write ONLY when the write is his own (save-metadata-override:
 * a Get Info correction). A robot's write is never its own evidence: Cynthia
 * trimming "Aja " to "Aja" after the id moved must not keep Peg's fields
 * (review of #505).
 */
function evidenceFor(fields: Record<string, string> | undefined, field: string, value: string, jake: JakeNames, writtenByJake: boolean): JakeNames {
  const mine = (f: string): string[] => (writtenByJake && field === f ? [value] : [])
  const title = [...(jake.title ?? []), ...(fields?.title !== undefined ? [fields.title] : []), ...mine('title')]
  const artist = [...(jake.artist ?? []), ...(fields?.artist !== undefined ? [fields.artist] : []), ...mine('artist')]
  return { title, artist }
}

/** Titles and artists Jake himself set for one id: his override, his journal, his phone edits. */
export interface JakeNames { title?: readonly string[]; artist?: readonly string[] }

/**
 * Another song under this id? A changed fingerprint is the same recording only
 * when every part that changed is a value Jake set for this id (re-review of
 * #502: about 1.5% of song pairs fall within 2 s of each other, and two songs
 * by one artist can too, so neither the length nor "only the title changed"
 * proves anything; Peg must never carry over to Blue Monday or to Aja):
 *   - the length agrees (within the edit sync's 2 s), AND
 *   - each of title / artist that changed equals a title / artist Jake set
 *     for this id (his override, his journal or his phone edits, or the very
 *     field being written when Jake is the one writing it: a Get Info correction).
 * Anything else is another song: the entry starts fresh, as it always did.
 */
export function isAnotherSong(oldFp: string, newFp: string, his: JakeNames = {}): boolean {
  const a = fpParts(oldFp), b = fpParts(newFp)
  if (!a || !b) return true
  if (Math.abs(a.dur - b.dur) > DURATION_SLACK_MS) return true
  const set = (vals: readonly string[] | undefined): Set<string> => new Set((vals ?? []).map(norm))
  if (a.title !== b.title && !set(his.title).has(b.title)) return true
  if (a.artist !== b.artist && !set(his.artist).has(b.artist)) return true
  return false
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
  jake: JakeNames = {},
  opts: { writtenByJake?: boolean } = {},
): Record<string, unknown> {
  const key = String(trackId)
  const existing = overrides[key] as OvEntry | undefined
  const isV2 = !!existing && typeof existing === 'object' && 'fields' in existing
  const hasNewFp = typeof fingerprint === 'string' && fingerprint !== ''
  const existingFp = isV2 ? (existing!.fp || '') : ''
  if (isV2 && hasNewFp && existingFp && existingFp !== fingerprint && isAnotherSong(existingFp, fingerprint!, evidenceFor(existing!.fields, field, value, jake, opts.writtenByJake === true))) {
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
