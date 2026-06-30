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

export function dedupeSuggestions(incoming: MmSuggestion[], list: Recommendation[]): MmSuggestion[] {
  const onList = new Set(
    list.map((r) => {
      const a = (r.artist || r.matchedArtist || '').toLowerCase().trim()
      const t = (r.song || r.matchedTitle || '').toLowerCase().trim()
      return a && t ? `${a}|${t}` : ''
    }).filter(Boolean),
  )
  const seen = new Set<string>()
  const out: MmSuggestion[] = []
  for (const s of incoming) {
    const k = suggKey(s)
    if (!k || seen.has(k) || onList.has(k)) continue
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
