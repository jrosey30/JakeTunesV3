/**
 * In-session cache for Listen to the List. Survives MainContent unmount
 * so returning to the view restores list + scroll instantly.
 */

import type { Recommendation } from '../types'

export interface MmSuggestion {
  song: string
  artist: string
  note: string
}

const RECS_TTL_MS = 5 * 60 * 1000
const SUGGEST_TTL_MS = 30 * 60 * 1000
const MM_VISIBLE = 3

let recs: Recommendation[] | null = null
let recsLoadedAt = 0
let suggestions: MmSuggestion[] | null = null
let suggestionsLoadedAt = 0
let autoSuggestAttempted = false

export function getRecsCache(): Recommendation[] | null {
  return recs
}

export function setRecsCache(list: Recommendation[]): void {
  recs = list
  recsLoadedAt = Date.now()
}

export function isRecsCacheFresh(): boolean {
  return recs !== null && Date.now() - recsLoadedAt < RECS_TTL_MS
}

export function invalidateRecsCache(): void {
  recsLoadedAt = 0
}

export function getSuggestionsCache(): MmSuggestion[] | null {
  return suggestions
}

export function setSuggestionsCache(list: MmSuggestion[]): void {
  suggestions = list
  suggestionsLoadedAt = Date.now()
}

export function isSuggestionsCacheFresh(): boolean {
  return suggestions !== null && Date.now() - suggestionsLoadedAt < SUGGEST_TTL_MS
}

export function wasAutoSuggestAttempted(): boolean {
  return autoSuggestAttempted
}

export function markAutoSuggestAttempted(): void {
  autoSuggestAttempted = true
}

export function suggKey(s: { song: string; artist: string }): string {
  return `${s.artist.toLowerCase().trim()}|${s.song.toLowerCase().trim()}`
}

// ⚠️ TWIN: src/main/reco-match.ts recoArtistMatches — renderer-side copy of the
// same loose artist rule (exact normalized, else 4+-char substring either way);
// no cross-bundle import from src/main, so keep the two in sync. Exists because
// exact keys miss multi-credit strings: a list entry saved as "Daft Punk" must
// still match a suggestion credited "Daft Punk, Pharrell Williams & Nile Rodgers".
function artistLooselyMatches(want: string, got: string): boolean {
  const clean = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const w = clean(want)
  const g = clean(got)
  if (!w || !g) return false
  if (w === g) return true
  return w.length >= 4 && g.length >= 4 && (w.includes(g) || g.includes(w))
}

export function dedupeSuggestions(incoming: MmSuggestion[], list: Recommendation[]): MmSuggestion[] {
  const listPairs = list
    .map((r) => ({
      artist: (r.artist || r.matchedArtist || '').trim(),
      title: (r.song || r.matchedTitle || '').toLowerCase().trim(),
    }))
    .filter((p) => p.artist && p.title)
  const onList = (s: MmSuggestion): boolean => {
    const title = s.song.toLowerCase().trim()
    return listPairs.some((p) => p.title === title && artistLooselyMatches(s.artist, p.artist))
  }
  const seen = new Set<string>()
  const out: MmSuggestion[] = []
  for (const s of incoming) {
    const k = suggKey(s)
    if (!k || seen.has(k) || onList(s)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

export function recsListUnchanged(a: Recommendation[], b: Recommendation[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false
  }
  return true
}

export { MM_VISIBLE }
