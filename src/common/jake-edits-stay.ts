/**
 * Jake's edits stay (2026-11-25). Jake: "The computer can auto edit upon
 * addition to library but if I edit after, the edit stays." and "Unless I
 * direct the code to auto change something."
 *
 * A field Jake set himself is never changed by an automatic writer: the genre
 * filer's picks, origins and corrections (main/genre-filer-persist.ts) and
 * Cynthia's sweep (main/cynthia-sweep.ts). "Set himself" is either record of
 * his hand:
 *   - the user-edit journal (common/user-edits.ts): Get Info on a Mac, stars,
 *     a Cynthia finding he applied, a genre he filed or ruled;
 *   - the phone's Get Info edits (homemini's mobile-metadata-overrides.json,
 *     the copy the desktop already reads), when the entry is for this song.
 * Values set when a song is added stay as they are: nothing here looks at
 * songs Jake hasn't touched.
 *
 * The way through is a writer Jake directed: a ruling or check-list File he
 * made, a bulk fix he runs or confirms, a rule he turns on. Such a write may
 * change his field, and it is journaled as his, so the next automatic writer
 * leaves it alone too.
 *
 * Hub adoption (main/user-edits-sync.ts planHubAbsorb) is his own edit from
 * another Mac or the phone, decided newest-real-edit-wins; it is not an
 * automatic writer and is not changed here.
 */
import { DURATION_SLACK_MS } from './user-edits.ts'

/** Who is writing. `auto`: a robot on its own. `jake`: Jake did it, or told the code to. */
export type Writer = { by: 'auto' } | { by: 'jake'; how: string }

/** One record of his hand for a song + field. `dur` (ms) guards against an id that now names another song. */
export interface JournalEdit { v: string; at?: number; dur?: number }

const same = (a: string, b: string): boolean => a.trim() === b.trim()

/** The same song, by length, the way the edit sync decides it (within DURATION_SLACK_MS). */
export function sameLength(a: number | undefined, b: number | undefined): boolean {
  if (!a || !b) return true
  return Math.abs(a - b) <= DURATION_SLACK_MS
}

/**
 * Whether this write may set the field. An automatic writer may not change a
 * value Jake set (in any of his records); it may still write that same value
 * (putting his choice back is no change). A record for a song of another
 * length under the same id is not his edit of this song.
 */
export function mayWriteField(o: { writer: Writer; edit: JournalEdit | readonly JournalEdit[] | undefined; value: string; durationMs?: number }): boolean {
  if (o.writer.by === 'jake') return true
  const edits = o.edit === undefined ? [] : Array.isArray(o.edit) ? o.edit : [o.edit as JournalEdit]
  return edits.every((e) => !sameLength(e.dur, o.durationMs) || same(e.v, o.value))
}

/** The fields of one write that may go through; `held` names the ones that stay Jake's. */
export function fieldsMayWrite(o: {
  writer: Writer
  fields: Record<string, string>
  edit: (field: string) => JournalEdit | readonly JournalEdit[] | undefined
  durationMs?: number
}): { allowed: Record<string, string>; held: string[] } {
  const allowed: Record<string, string> = {}
  const held: string[] = []
  for (const [field, value] of Object.entries(o.fields)) {
    if (mayWriteField({ writer: o.writer, edit: o.edit(field), value, durationMs: o.durationMs })) allowed[field] = value
    else held.push(field)
  }
  return { allowed, held }
}

/** A writer from the filer's "why": a ruling or a check-list File is Jake's; no why, or the filer's, is automatic. */
export function writerOf(why?: { by: string; how: string }): Writer {
  return why?.by === 'jake' ? { by: 'jake', how: why.how } : { by: 'auto' }
}

/** Fingerprints `title|artist|duration`, compared loosely (case, spaces, a 2 s length slack). */
export function sameFingerprint(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true
  const pa = a.split('|'), pb = b.split('|')
  if (pa.length < 3 || pb.length < 3) return a.trim().toLowerCase() === b.trim().toLowerCase()
  const head = (p: string[]): string => p.slice(0, -1).map((x) => x.trim().toLowerCase()).join('|')
  return head(pa) === head(pb) && sameLength(Number(pa[pa.length - 1]) || undefined, Number(pb[pb.length - 1]) || undefined)
}

/** The phone's Get Info edit for this song + field, when its entry is for this song. */
export function phoneEdit(
  phone: Record<string, { fp?: string; fields?: Record<string, string> } | undefined> | null | undefined,
  id: number | string, field: string, fp: string | undefined,
): JournalEdit | undefined {
  const e = phone?.[String(id)]
  const v = e?.fields?.[field]
  if (v === undefined || v === null) return undefined
  if (e?.fp && fp && !sameFingerprint(e.fp, fp)) return undefined
  // The entry's length rides along, so a caller matching by id + length (a title
  // the phone itself just changed) can still tell another song apart.
  const dur = e?.fp ? Number(e.fp.slice(e.fp.lastIndexOf('|') + 1)) || undefined : undefined
  return dur ? { v: String(v), dur } : { v: String(v) }
}

type Update = { trackId: number; field: string; newValue: string }

/**
 * The writes the rule refused, remembered until the live copy for the
 * renderer goes out, so the screen never shows a value the override refused.
 */
export function createRefusals(): { add: (id: number, field: string, value: string) => void; filter: (updates: Update[]) => Update[] } {
  const keys = new Set<string>()
  const key = (id: number, field: string, value: string): string => `${id}\u0000${field}\u0000${value}`
  return {
    add: (id, field, value) => { keys.add(key(id, field, value)) },
    filter: (updates) => {
      const out = updates.filter((u) => !keys.has(key(u.trackId, u.field, u.newValue)))
      for (const u of updates) keys.delete(key(u.trackId, u.field, u.newValue))
      return out
    },
  }
}

/** Did this field land? A persist that returns nothing (older fakes, the plain writer) counts as written. */
export function landed(written: Record<string, string> | void | undefined, field: string): boolean {
  return written === undefined || field in written
}
