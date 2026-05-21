// ════════════════════════════════════════════════════════════════════════
//  Profile assembly + refresh (Brief 036 v2.2, Layer 2)
//
//  Orchestrates: library rows → library signals + owned sets, optionally a
//  Bandcamp scrape, then merge → unified profile (cached). Cold-start safe:
//  with no Bandcamp profile yet, library-only surfaces still work; Bandcamp
//  surfaces show "Connect Bandcamp" upstream.
// ════════════════════════════════════════════════════════════════════════

import { UnifiedProfile } from '../types'
import { readLibraryRows } from '../data/library-data'
import { fetchProfile } from '../data/profile-data'
import { ingestLibrary } from './library-ingestion'
import { buildOwnedSets } from './overlap-detection'
import { computeUnifiedProfile } from './signal-computation'
import { loadProfile, saveProfile, loadUnified, saveUnified } from './profile-store'

let inFlight: Promise<UnifiedProfile> | null = null
let dailyTimer: ReturnType<typeof setInterval> | null = null

/** Rebuild the unified profile. scrapeBandcamp=true re-fetches the profile;
 *  false reuses the cached Bandcamp scrape (library always re-read). */
export function rebuildUnified(scrapeBandcamp: boolean): Promise<UnifiedProfile> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const rows = await readLibraryRows()
      const libSignals = ingestLibrary(rows)
      const owned = buildOwnedSets(rows)

      let profile = await loadProfile()
      if (scrapeBandcamp) {
        const fresh = await fetchProfile()
        if (fresh) { profile = fresh; await saveProfile(fresh) }
      }

      const unified = computeUnifiedProfile(libSignals, profile, owned)
      await saveUnified(unified)
      return unified
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Cached unified profile, or a library-only build on first run. */
export async function getUnified(): Promise<UnifiedProfile> {
  const cached = await loadUnified()
  if (cached) return cached
  return rebuildUnified(false)
}

export function scheduleDailyRefresh(): void {
  if (dailyTimer) return
  dailyTimer = setInterval(() => { void rebuildUnified(true).catch(() => {}) }, 24 * 60 * 60 * 1000)
}
