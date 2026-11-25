/**
 * List / Grid / Cover Flow, remembered per page across launches (V7,
 * 2026-11-24; context/ViewModeContext.tsx). Pure, tested in song-table.test.ts.
 */
export type ViewMode = 'list' | 'grid' | 'coverflow'

/** The ui-state key the choices are saved under. */
export const VIEW_MODES_KEY = 'viewModes'

const MODES: ReadonlySet<string> = new Set(['list', 'grid', 'coverflow'])

/** The saved choices, keeping only well-formed ones (a bad file is no choice, never a crash). */
export function parseViewModes(raw: unknown): Record<string, ViewMode> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, ViewMode> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && MODES.has(v)) out[k] = v as ViewMode
  }
  return out
}
