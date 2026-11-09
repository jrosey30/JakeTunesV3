/**
 * Sidebar section order (2026-11-07). Jake: "i want to be able to have the side
 * bar categories customizeable as to where i place them, click and drag and drop".
 *
 * Each top-level section has a stable key ('library', 'ipods', 'year:2026', ...).
 * The saved order is a per-machine list of keys in ui-state.json
 * (`sidebarSectionOrder`). Sections come and go (DEVICES only with an iPod or a
 * CD, a new year's section), so the saved list is never the whole truth:
 *   - a saved key that isn't showing is skipped, and keeps its place for when it returns
 *   - a showing key the save never heard of goes to its default slot: right
 *     after the section that comes before it by default
 *
 * The hub publishes the saved list to homemini (main/sidebar-order-publish.ts) and
 * the phone orders its Playlists tab's sections by it. ⚠️ TWIN: JakeTunesMobile
 * ios PlaylistGroups.swift `order` / `defaultOrder` / `parseSavedOrder`.
 *
 * Pure — node --test loads it.
 */

export const SIDEBAR_ORDER_KEY = 'sidebarSectionOrder'

/** Year sections share one default slot; they sort among themselves newest first. */
export const YEAR_PREFIX = 'year:'
export const YEARS_SLOT = 'years'

/** The order the sidebar has always drawn its sections in. */
export const DEFAULT_SECTION_ORDER: readonly string[] = [
  'library',
  'store',
  'archive',
  'devices',
  'ipods',
  'mixtapes',
  YEARS_SLOT,
  'playlists',
]

/**
 * Sections that no longer exist. A saved order written by an older build may
 * still name one; it is dropped on read, so it never takes a slot and the next
 * save forgets it. 'synced-sets' went 2026-11-08: nothing has made one since the
 * Activity Sync sheet left (#372), and a playlist still marked as one simply
 * shows in PLAYLISTS.
 */
export const RETIRED_SECTION_KEYS: ReadonlySet<string> = new Set(['synced-sets'])

/** Where a key sits by default (years share their slot). */
function defaultRank(key: string, defaults: readonly string[]): number {
  const k = key.startsWith(YEAR_PREFIX) ? YEARS_SLOT : key
  const i = defaults.indexOf(k)
  return i === -1 ? defaults.length : i
}

/** A saved value read back from ui-state: only strings, no repeats, bounded. */
export function parseSavedOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    if (typeof v !== 'string' || !v || v.length > 64 || seen.has(v) || RETIRED_SECTION_KEYS.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= 200) break
  }
  return out
}

/** The default order of the sections showing now (years newest first within their slot). */
export function defaultOrder(present: readonly string[], defaults: readonly string[] = DEFAULT_SECTION_ORDER): string[] {
  return [...present].sort((a, b) => {
    const d = defaultRank(a, defaults) - defaultRank(b, defaults)
    if (d !== 0) return d
    // Both years: newest first (the order the sidebar has drawn them in). Else stable.
    if (a.startsWith(YEAR_PREFIX) && b.startsWith(YEAR_PREFIX)) return b.localeCompare(a)
    return present.indexOf(a) - present.indexOf(b)
  })
}

/**
 * The order to draw the showing sections in. `saved` may name sections not
 * showing (skipped) and may miss sections that are (each goes right after the
 * nearest section that precedes it in the default order and is already placed;
 * with none, first).
 */
export function orderSections(present: readonly string[], saved: readonly string[], defaults: readonly string[] = DEFAULT_SECTION_ORDER): string[] {
  const showing = new Set(present)
  const out = saved.filter((k, i) => showing.has(k) && saved.indexOf(k) === i)
  const placed = new Set(out)
  const def = defaultOrder(present, defaults)
  for (let i = 0; i < def.length; i++) {
    const key = def[i]
    if (placed.has(key)) continue
    // The nearest earlier section (by default order) that is already placed.
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.indexOf(def[j])
      if (idx !== -1) { at = idx + 1; break }
    }
    out.splice(at, 0, key)
    placed.add(key)
  }
  return out
}

/**
 * Move `key` so it sits just before `beforeKey` (null = at the end), in the
 * order currently drawn. Returns the new full order to save: the drawn order,
 * plus any saved keys not showing right now, each kept after the key it
 * followed before, so a hidden DEVICES section comes back where it was.
 */
export function moveSection(drawn: readonly string[], saved: readonly string[], key: string, beforeKey: string | null): string[] {
  if (!drawn.includes(key) || key === beforeKey) return mergeHidden(drawn, saved)
  const next = drawn.filter((k) => k !== key)
  const at = beforeKey === null ? next.length : next.indexOf(beforeKey)
  next.splice(at === -1 ? next.length : at, 0, key)
  return mergeHidden(next, saved)
}

/** Move one step up (-1) or down (+1) — the keyboard way to do the same thing. */
export function nudgeSection(drawn: readonly string[], saved: readonly string[], key: string, step: -1 | 1): string[] {
  const i = drawn.indexOf(key)
  if (i === -1) return mergeHidden(drawn, saved)
  const j = i + step
  if (j < 0 || j >= drawn.length) return mergeHidden(drawn, saved)
  const next = [...drawn]
  next[i] = drawn[j]
  next[j] = key
  return mergeHidden(next, saved)
}

/** Put back the saved keys that aren't drawn right now, each after the key it followed. */
function mergeHidden(drawn: readonly string[], saved: readonly string[]): string[] {
  const out = [...drawn]
  const inOut = new Set(out)
  for (let i = 0; i < saved.length; i++) {
    const k = saved[i]
    if (inOut.has(k)) continue
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.indexOf(saved[j])
      if (idx !== -1) { at = idx + 1; break }
    }
    out.splice(at, 0, k)
    inOut.add(k)
  }
  return out
}
