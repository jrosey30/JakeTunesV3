/**
 * The genre filer's one write path, with Jake's edits staying his
 * (common/jake-edits-stay.ts). Electron-free so it can be run with a fake
 * host; ipc/genre-filer-ipc.ts wires the real one.
 *
 *   1. Who writes: a ruling or a check-list File is Jake's (`why.by: 'jake'`);
 *      everything else (picks, re-judges, origins, corrections) is automatic.
 *   2. An automatic write is split field by field against his records (the
 *      journal and the phone's edits). A field he set to something else is
 *      held; if his records can't be read, every field is held.
 *   3. Only what's left reaches the override writer. A held field is logged,
 *      remembered so the live copy for the renderer drops it, and never
 *      returned as written, so callers don't count or log it as filed.
 *   4. Jake's own write is journaled as his (so every device and every later
 *      robot keeps it), then the provenance row is written.
 */
import { createRefusals, fieldsMayWrite, writerOf } from '../common/jake-edits-stay.ts'
import { trackFingerprint, type FilerTrack, type GenreWhy } from './genre-filer.ts'
import type { JakeEditLookup } from './jake-edits-guard.ts'
import type { ProvenanceDoc } from './genre-provenance.ts'

export interface GuardedPersistHost {
  /** `writtenByJake` on his own write: the override writer never holds it (Brief 266). */
  persist(trackId: number, fields: Record<string, string>, fingerprint: string, opts?: { writtenByJake?: boolean }): Promise<void>
  /** His edit into the journal. Required: a write he directed is always journaled. */
  recordEdit(trackId: number, field: string, value: string, at: number): Promise<void>
  updateProvenance(mutate: (doc: ProvenanceDoc) => void): Promise<void>
  /** His records (journal + phone), read once per sweep. Throws when they can't be read. */
  lookup(): Promise<JakeEditLookup>
  refused: ReturnType<typeof createRefusals>
  log(message: string): void
}

/** The fields actually written (empty when everything was held). */
export async function persistGuarded(h: GuardedPersistHost, t: FilerTrack, wanted: Record<string, string>, why?: GenreWhy): Promise<Record<string, string>> {
  const fp = trackFingerprint(t)
  const writer = writerOf(why)
  let fields: Record<string, string> = wanted
  let held: string[] = []
  if (writer.by === 'auto') {
    let look: JakeEditLookup | null = null
    try { look = await h.lookup() } catch (err) {
      h.log(`[genre-filer] ${t.id}: his edits can't be read; nothing written (${err instanceof Error ? err.message : String(err)})`)
    }
    if (!look) {
      fields = {}
      held = Object.keys(wanted)
    } else {
      const split = fieldsMayWrite({ writer, fields: wanted, edit: (f) => look!(t.id, f, fp), durationMs: t.duration })
      fields = split.allowed
      held = split.held
    }
  }
  if (held.length) h.log(`[genre-filer] ${t.id}: ${held.join(', ')} kept as Jake set it`)
  for (const f of held) h.refused.add(t.id, f, wanted[f])
  if (Object.keys(fields).length === 0) return {}
  // His own write says so, so the override writer never holds it while his records can't be read (Brief 266).
  await h.persist(t.id, fields, fp, writer.by === 'jake' ? { writtenByJake: true } : undefined)
  if (fields.genre === undefined || !why) return fields
  const at = new Date().toISOString()
  // His choice (a check-list File, a ruling) is journaled like a Get Info
  // edit, so every device takes it and no filer moves it.
  if (why.by === 'jake') await h.recordEdit(t.id, 'genre', fields.genre, Date.parse(at))
  await h.updateProvenance((doc) => {
    doc.tracks[String(t.id)] = { genre: fields.genre, by: why.by, how: why.how, fp, at, ...(why.confidence ? { confidence: why.confidence } : {}) }
  })
  return fields
}
