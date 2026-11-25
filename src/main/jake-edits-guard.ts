/**
 * The main-process side of "Jake's edits stay" (common/jake-edits-stay.ts):
 * reads his journal (user-edits.json in userData) for an automatic writer.
 * Cynthia's sweep asks this before it auto-applies a fix (cynthia-sweep.ts
 * heldForJake); the genre filer asks the same rule in persistWithProvenance.
 */
import { readUserEditsJournal } from './user-edits-sync.ts'
import { mayWriteField } from '../common/jake-edits-stay.ts'

/** True when an automatic write of `value` to this song's `field` would change something Jake set. */
export function createHeldForJake(dir: () => string, read = readUserEditsJournal) {
  return async (trackId: number, field: string, value: string, durationMs?: number): Promise<boolean> => {
    let doc: Awaited<ReturnType<typeof readUserEditsJournal>> = null
    try { doc = await read(dir()) } catch (err) {
      // A journal that can't be read holds everything back: never guess that a field isn't his.
      console.warn('[jake-edits] journal unreadable; automatic fixes wait:', err instanceof Error ? err.message : err)
      return true
    }
    return !mayWriteField({ writer: { by: 'auto' }, edit: doc?.edits[String(trackId)]?.[field], value, durationMs })
  }
}
