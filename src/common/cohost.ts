/**
 * WJLR's other host. Jake, 2026-11-05: "change Megan to Larry" (Mobile Brief
 * 229). The voice lives here so the four places that speak him can't drift.
 *
 * This file is the only code that says the old name, and only to read what is
 * already saved: a host preference, a week's picks, a remembered page, radio
 * memory, a script line. Each is rewritten as it is read, so nothing saved
 * keeps using the name and no one has to wait on a regeneration for a rename.
 * A real person called Megan (Megan Thee Stallion, Megan James) is left alone.
 * src/main/__tests__/cohost-larry.test.ts holds the line.
 */

export type HostId = 'mm' | 'larry'

/** ElevenLabs labels this voice with another name. He is Larry. */
export const LARRY_VOICE_ID = 'E84kZYo2dIe6J7R6AtEK'

const OLD_ID = 'megan'
const OLD_PICKS = 'megan-picks'
const NEW_PICKS = 'larry-picks'
const OLD_SMART_KEY = `smart:${OLD_PICKS}`
const NEW_SMART_KEY = `smart:${NEW_PICKS}`

/** Every speaker tag a radio script can carry, the old host's included: a
 *  script generated before the rename still has to parse and be voiced as Larry.
 *  ONE list for parseRadioScript (Toolbar) and extractCallbacks (radio-memory),
 *  which used to keep their own copies and drifted. */
export const RADIO_SCRIPT_TAGS = 'MM|LARRY|MEGAN|ANNOUNCER|STEPHEN|DJ_HANDS|DJ_STEPHEN|DJ_STEPHEN_HANDS|GIOVANNI|RAJIV|BERNARD|LASHONTE|KRISTINA|DEVIN|MAYA|MIKE|ZOE'

/** A script line's tag as the current cast knows it. */
export function currentRadioTag(tag: string): string {
  const upper = tag.toUpperCase()
  return upper === 'MEGAN' ? 'LARRY' : upper
}

/** A saved cast id (a mixtape deck's chosen voice) as the current cast knows it. */
export function currentCastId(id: string): string {
  return id === OLD_ID ? 'larry' : id
}

/** A saved or passed host preference. Anything unknown is the default host. */
export function normalizeHostId(value: unknown): HostId {
  return value === 'larry' || value === OLD_ID ? 'larry' : 'mm'
}

function renamedKey(key: string): string {
  if (key === OLD_PICKS) return NEW_PICKS
  if (key === OLD_SMART_KEY) return NEW_SMART_KEY
  return key
}

function renamedValue(value: string): string {
  return renamedKey(value)
}

function walk(value: unknown, onChange: () => void): unknown {
  if (typeof value === 'string') {
    const next = renamedValue(value)
    if (next !== value) onChange()
    return next
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, onChange))
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    // The new name's own entries first: a value saved under it is newer than
    // anything still under the old one, and is never overwritten by it.
    for (const [k, v] of Object.entries(source)) {
      if (renamedKey(k) === k) out[k] = k === 'aiHost' && v === OLD_ID ? (onChange(), 'larry') : walk(v, onChange)
    }
    for (const [k, v] of Object.entries(source)) {
      const nk = renamedKey(k)
      if (nk === k) continue
      onChange()
      if (!(nk in out)) out[nk] = walk(v, onChange)
    }
    return out
  }
  return value
}

/** ui-state and settings: the week's picks under the old key, a saved view or
 *  page memory pointing at them, the chosen host. Exact matches only. */
export function migrateSavedState<T>(state: T): { state: T; changed: boolean } {
  let changed = false
  const next = walk(state, () => { changed = true }) as T
  return { state: changed ? next : state, changed }
}

/** picks-cache.json, keyed by persona: Larry inherits the week's list. */
export function migratePicksCache<T>(cache: Record<string, T>): { cache: Record<string, T>; changed: boolean } {
  if (!(OLD_ID in cache)) return { cache, changed: false }
  const { [OLD_ID]: old, ...rest } = cache
  return { cache: 'larry' in rest ? rest : { ...rest, larry: old }, changed: true }
}

/** The host, and not somebody else called Megan: no surname after the name. */
const HOST_NAME = /\bMegan\b(?!\s+[A-Z])/g
const HER_PRONOUN = /\b(she|she's|her|hers|herself)\b/i

/** One remembered radio line. Null when it can't be fixed safely: a line about
 *  the host with a pronoun in it could be about anyone, and a wrong one in the
 *  prompt teaches the model the wrong thing. It is callback fuel; dropping one
 *  costs nothing. */
export function migrateCallback(line: string): string | null {
  HOST_NAME.lastIndex = 0
  if (!HOST_NAME.test(line)) return line
  HOST_NAME.lastIndex = 0
  if (HER_PRONOUN.test(line)) return null
  return line.replace(HOST_NAME, 'Larry')
}

/** A whole remembered script (musicman-memory.json), which every prompt reads as
 *  "this is YOUR memory": tags and name move over; one that also has a pronoun
 *  that could be his is dropped. It's a rolling list of a dozen. */
export function migrateRememberedScript(text: string): string | null {
  const retagged = text.replace(/\[MEGAN\]/gi, '[LARRY]')
  if (retagged !== text && HER_PRONOUN.test(retagged)) return null
  return migrateCallback(retagged)
}

export interface RadioMemoryShape {
  speakers: string[]
  angle: string | null
  callbacks: string[]
}

/** radio-memory.json feeds the radio prompt, so it can't keep the old name. */
export function migrateRadioEntries<E extends RadioMemoryShape>(entries: E[]): { entries: E[]; changed: boolean } {
  let changed = false
  const next = entries.map((entry) => {
    const speakers = Array.isArray(entry.speakers) ? entry.speakers.map((s) => (s === OLD_ID ? 'larry' : s)) : entry.speakers
    const angle = entry.angle === 'MEGAN OFF-TOPIC' ? 'LARRY OFF-TOPIC' : entry.angle
    const callbacks = Array.isArray(entry.callbacks)
      ? entry.callbacks.map(migrateCallback).filter((l): l is string => l !== null)
      : entry.callbacks
    const same = angle === entry.angle
      && (speakers === entry.speakers || speakers.every((s, i) => s === entry.speakers[i]))
      && (callbacks === entry.callbacks || (callbacks.length === entry.callbacks.length && callbacks.every((l, i) => l === entry.callbacks[i])))
    if (same) return entry
    changed = true
    return { ...entry, speakers, angle, callbacks }
  })
  return { entries: changed ? next : entries, changed }
}
