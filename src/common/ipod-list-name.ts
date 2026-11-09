/**
 * A name for an iPod list or the Top 1000 (2026-11-09, Jake: "allow me to rename
 * the ipod playlists too!! if i want"). The rules the rename box checks before
 * anything is sent:
 *   - trimmed, never empty, at most 60 characters, one line;
 *   - never another list's name (the Top 1000 included), case and the spaces
 *     around it aside. A list may change the case of its own name.
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/top1000Name.ts (checkListName,
 * sameListName, takenListName): homemini refuses the same names (400 / 409).
 *
 * Pure — node --test loads it.
 */

export const LIST_NAME_MAX = 60
export const TOP_1000_DEFAULT_NAME = 'Top 1000'

/** Two list names are the same when they differ only in case or the spaces around them. */
export function sameListName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('en-US') === b.trim().toLocaleLowerCase('en-US')
}

export type ListNameCheck = { ok: true; name: string } | { ok: false; error: string }

/**
 * `raw` as a list's new name, or the plain reason it can't be one.
 * `others` = every OTHER list's name as shown now (the Top 1000's included when an iPod list is renamed).
 */
export function checkListName(raw: unknown, others: readonly string[]): ListNameCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Give it a name.' }
  const name = raw.trim()
  if (!name) return { ok: false, error: 'Give it a name.' }
  if (name.length > LIST_NAME_MAX) return { ok: false, error: `Keep it to ${LIST_NAME_MAX} characters (this is ${name.length}).` }
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'Keep it to one line.' }
  const taken = others.find((o) => sameListName(o, name))
  if (taken !== undefined) return { ok: false, error: `Another list is already called ${taken.trim()}.` }
  return { ok: true, name }
}
