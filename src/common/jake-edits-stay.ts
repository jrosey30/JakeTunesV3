/**
 * Jake's edits stay (2026-11-25). Jake: "The computer can auto edit upon
 * addition to library but if I edit after, the edit stays." and "Unless I
 * direct the code to auto change something."
 *
 * A field Jake set himself (the user-edit journal, common/user-edits.ts: Get
 * Info, stars, a Cynthia finding he applied, a genre he filed or ruled) is
 * never changed by an automatic writer: the genre filer's picks, origins and
 * corrections (ipc/genre-filer-ipc.ts persistWithProvenance) and Cynthia's
 * sweep (cynthia-sweep.ts). Values set when a song is added stay as they are:
 * nothing here looks at songs Jake hasn't touched.
 *
 * The way through is a writer Jake directed: a ruling or check-list File he
 * made, a bulk fix he runs or confirms, a rule he turns on. Such a write may
 * change his field, and it is recorded as his (the journal), so the next
 * automatic writer leaves it alone too.
 *
 * Hub adoption (user-edits-sync.ts planHubAbsorb) is his own edit from
 * another Mac or the phone, decided newest-real-edit-wins; it is not an
 * automatic writer and is not changed here.
 */

/** Who is writing. `auto`: a robot on its own. `jake`: Jake did it, or told the code to. */
export type Writer = { by: 'auto' } | { by: 'jake'; how: string }

/** The journal's entry for one song + field (common/user-edits.ts UserEdit). */
export interface JournalEdit { v: string; at: number; dur?: number }

const same = (a: string, b: string): boolean => a.trim() === b.trim()

/**
 * Whether this write may set the field. An automatic writer may not change a
 * value Jake set; it may still write that same value (putting his choice back
 * is no change). A journal entry from a different song under the same id
 * (another length) is not his edit of this song.
 */
export function mayWriteField(o: { writer: Writer; edit: JournalEdit | undefined; value: string; durationMs?: number }): boolean {
  if (o.writer.by === 'jake') return true
  const e = o.edit
  if (!e) return true
  if (e.dur !== undefined && o.durationMs && e.dur !== o.durationMs) return true
  return same(e.v, o.value)
}

/** The fields of one write that may go through; `held` names the ones that stay Jake's. */
export function fieldsMayWrite(o: {
  writer: Writer
  fields: Record<string, string>
  edit: (field: string) => JournalEdit | undefined
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
