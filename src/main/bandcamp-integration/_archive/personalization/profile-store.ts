// ════════════════════════════════════════════════════════════════════════
//  Profile cache store (Brief 036 v2.2, Layer 2)
//  Raw Bandcamp scrape + merged unified profile, persisted locally. Privacy:
//  these files never leave the device; clearAll() backs the settings-panel
//  "Clear Bandcamp profile data" action.
// ════════════════════════════════════════════════════════════════════════

import { BandcampProfile, UnifiedProfile } from '../types'
import { readJSON, writeJSON, removeJSON } from '../data/cache'

const PROFILE_FILE = 'bandcamp-profile.json'
const UNIFIED_FILE = 'bandcamp-unified-profile.json'

export function loadProfile(): Promise<BandcampProfile | null> {
  return readJSON<BandcampProfile>(PROFILE_FILE)
}
export function saveProfile(p: BandcampProfile): Promise<void> {
  return writeJSON(PROFILE_FILE, p)
}
export function loadUnified(): Promise<UnifiedProfile | null> {
  return readJSON<UnifiedProfile>(UNIFIED_FILE)
}
export function saveUnified(u: UnifiedProfile): Promise<void> {
  return writeJSON(UNIFIED_FILE, u)
}

export async function clearAll(): Promise<void> {
  await removeJSON(PROFILE_FILE)
  await removeJSON(UNIFIED_FILE)
}
