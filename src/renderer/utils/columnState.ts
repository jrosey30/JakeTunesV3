/**
 * Songs column layout — the cache that survives BOTH view changes and app launch.
 *
 * Jake, more than once: "everytime i leave the song view page key and bpm
 * columns are out of view."
 *
 * Three faults produced that one symptom, and the first two fixes only got the
 * first two:
 *
 *  1. hiddenCols was component state seeded from a hardcoded default, so every
 *     unmount/remount reset it. Fixed by caching at module scope.
 *  2. The saved layout is delivered by a ONE-SHOT CustomEvent that App.tsx
 *     dispatches during startup — while it is still rendering <SplashScreen/>,
 *     so SongsView is not mounted and its listener does not exist yet. The
 *     event is fired into an empty room and lost forever. The module cache
 *     didn't help either, because on a cold start it begins null.
 *  3. Worse than losing it: SongsView's save effect then persists its DEFAULT
 *     hidden-set, overwriting the user's real choice on disk. So the columns
 *     didn't just fail to appear — the preference was actively destroyed on
 *     every launch. Observed 2026-08-02: ui-state.json's columnOrder still
 *     listed bpm and camelotKey while hiddenCols had been rewritten to the
 *     default four.
 *
 * So the layout lives HERE, primed directly by App.tsx the moment ui-state is
 * read, before any view mounts. The CustomEvent still works for live updates;
 * it is simply no longer the only path.
 */

export interface ColumnState {
  hidden: string[]
  widths: Record<string, number>
  order: string[]
}

/** Fits the longest Date Added or Last Played, 12/28/2026 12:59:59 PM, with no "…". */
export const DATE_TIME_COLUMN_WIDTH = 165

/** Opt-in columns start hidden; the header right-click picker reveals them. */
export const DEFAULT_HIDDEN = ['channelMode', 'subgenre', 'bpm', 'camelotKey']

let cache: ColumnState | null = null

export function getColumnCache(): ColumnState | null { return cache }
export function setColumnCache(next: ColumnState): void { cache = next }

interface UiColumnDetail {
  colWidthMap?: unknown
  hiddenCols?: unknown
  columnOrder?: unknown
  colsV?: unknown
}

/**
 * Fold persisted ui-state into the cache, applying the per-version defaults.
 *
 * A column that did not exist when the user last saved cannot appear in their
 * hiddenCols, so each new one is defaulted-hidden EXACTLY ONCE, at its version
 * bump. A save at or after that version carries the user's real decision and is
 * left alone. colsV 2 = channelMode, 3 = subgenre, 4 = bpm + camelotKey.
 * colsV 5 = Date Added grew a time and a Last Played joined it (2026-11-05): Jake
 * asked for that one, so it is NOT hidden, and a saved width too narrow for the
 * stamp is widened once.
 */
export function primeColumnCacheFromUiState(detail: UiColumnDetail): void {
  const v = typeof detail.colsV === 'number' ? detail.colsV : 0

  let hidden: string[] | null = null
  if (Array.isArray(detail.hiddenCols)) {
    hidden = detail.hiddenCols.filter((k): k is string => typeof k === 'string')
    if (v < 2) hidden.push('channelMode')
    if (v < 3) hidden.push('subgenre')
    if (v < 4) { hidden.push('bpm'); hidden.push('camelotKey') }
  }

  const widths = detail.colWidthMap && typeof detail.colWidthMap === 'object'
    ? { ...(cache?.widths ?? {}), ...widenedForDateTime(detail.colWidthMap as Record<string, number>, v) }
    : (cache?.widths ?? {})

  const order = Array.isArray(detail.columnOrder) && detail.columnOrder.length > 0
    ? detail.columnOrder.filter((k): k is string => typeof k === 'string')
    : (cache?.order ?? [])

  cache = { hidden: hidden ?? cache?.hidden ?? [...DEFAULT_HIDDEN], widths, order }
}

/** A save from before the time-of-day (colsV < 5) has Date Added at about 100. */
export function widenedForDateTime(widths: Record<string, number>, colsV: unknown): Record<string, number> {
  const v = typeof colsV === 'number' ? colsV : 0
  if (v >= 5 || !(widths.dateAdded < DATE_TIME_COLUMN_WIDTH)) return widths
  return { ...widths, dateAdded: DATE_TIME_COLUMN_WIDTH }
}

/**
 * The saved column order, with any column the save doesn't know about placed
 * right after its neighbour from the default layout (2026-10-11: Origin lands
 * next to Genre instead of at the far end). Unknown saved keys are dropped.
 */
export function orderColumnKeys(saved: readonly string[], defaults: readonly string[]): string[] {
  const known = new Set(defaults)
  const out: string[] = []
  for (const k of saved) if (known.has(k) && !out.includes(k)) out.push(k)
  defaults.forEach((k, i) => {
    if (out.includes(k)) return
    let at = out.length
    for (let j = i - 1; j >= 0; j--) {
      const p = out.indexOf(defaults[j])
      if (p >= 0) { at = p + 1; break }
    }
    out.splice(at, 0, k)
  })
  return out
}
