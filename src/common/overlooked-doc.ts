/**
 * The Overlooked page's document (Jake, 2026-10-22: "a place to browse but
 * also done for me ... AI brain oriented ... focus more on songs").
 *
 *   GET {MOBILE_BACKEND_URL}/api/overlooked
 *   → { version: 1, generatedAt, day,
 *       lanes: [{ genre: string | null, items: [{ track, reason }] }] }
 *
 * homemini ranks it with the shared hidden-gems rulebook (JakeTunesMobile
 * backend/src/util/homeShelves.ts overlookedLanes) over the MERGED play
 * history: a "Best bets" lane (genre null), then one lane per genre the brain
 * rates highest. The desktop reads ids + reasons and draws its OWN library
 * rows. parseOverlooked is strict about meaning — a song with no id or no
 * reason is dropped, an empty lane is dropped, an unknown version is no
 * document at all — never guessed. Pure; main, preload and renderer share it.
 */
export interface OverlookedItem { id: number; reason: string }
export interface OverlookedLane {
  /** null = the Best Bets lane; otherwise the broad genre family ("Rock") */
  genre: string | null
  /** "Like your Geese, Jigitz and Fat Dog" — what the lane was learned from */
  subtitle: string | null
  items: OverlookedItem[]
}
export interface Overlooked {
  version: 1
  generatedAt: string | null
  day: string | null
  lanes: OverlookedLane[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseOverlooked(raw: unknown): Overlooked | null {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.lanes)) return null
  const lanes: OverlookedLane[] = []
  for (const l of raw.lanes) {
    if (!isRecord(l) || !Array.isArray(l.items)) continue
    const genre = typeof l.genre === 'string' && l.genre.trim() ? l.genre.trim() : null
    const subtitle = typeof l.subtitle === 'string' && l.subtitle.trim() ? l.subtitle.trim() : null
    const items: OverlookedItem[] = []
    for (const it of l.items) {
      if (!isRecord(it) || !isRecord(it.track)) continue
      const id = it.track.id
      const reason = typeof it.reason === 'string' ? it.reason.trim() : ''
      if (typeof id !== 'number' || !Number.isFinite(id) || !reason) continue
      items.push({ id, reason })
    }
    if (items.length) lanes.push({ genre, subtitle, items })
  }
  if (!lanes.length) return null
  return {
    version: 1,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
    day: typeof raw.day === 'string' ? raw.day : null,
    lanes,
  }
}
