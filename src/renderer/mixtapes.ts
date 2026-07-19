/**
 * Mixtape nav + cache store — same module-store pattern as concertNav.ts
 * (routes through the generic SET_VIEW so the do-not-touch LibraryContext
 * reducer stays untouched). Holds which tape 'mixtape-detail' shows plus
 * a cached list for the sidebar section.
 */
import type { Mixtape } from './types'

let currentMixtapeId = ''
let cache: Mixtape[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

export function setMixtapeId(id: string): void {
  currentMixtapeId = id
  notify()
}
export function getMixtapeId(): string {
  return currentMixtapeId
}
export function getMixtapes(): Mixtape[] {
  return cache
}
export function subscribeMixtapes(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export async function refreshMixtapes(): Promise<Mixtape[]> {
  try {
    const r = await window.electronAPI.listMixtapes?.()
    if (r?.ok && Array.isArray(r.mixtapes)) {
      cache = r.mixtapes
      notify()
    }
  } catch { /* main not ready yet — sidebar just shows none */ }
  return cache
}

// ── Tape play session — TRUE tape physics enforcement ──────────────
// Set when a tape starts playing; the always-mounted <TapeMonitor />
// watches playback and, when the boundary song reaches the point where
// the cassette runs out, cuts it off (advance = the flip to Side B,
// stop = end of Side B). Cleared when playback leaves the tape.
export interface TapeCut { trackId: number; cutSec: number; thenStop: boolean }
export interface TapeSession { mixtapeId: string; tapeTrackIds: number[]; cuts: TapeCut[] }

let tapeSession: TapeSession | null = null

export function setTapeSession(s: TapeSession | null): void {
  tapeSession = s
  notify()
}
export function getTapeSession(): TapeSession | null {
  return tapeSession
}

// ── The deck — record-on-play state ─────────────────────────────────
// A tape "in the deck" + REC armed means: every song that PLAYS gets
// laid onto the active side, in the order it played, true physics.
// That's how mixtapes are made.
export interface DeckState {
  mixtapeId: string
  side: 'A' | 'B'
  recArmed: boolean
}

let deckState: DeckState | null = null

export function setDeckState(d: DeckState | null): void {
  deckState = d
  notify()
}
export function getDeckState(): DeckState | null {
  return deckState
}

/** Stable per-tape ink color for the handwritten label. */
const INKS = ['#1d3f8f', '#8f1d1d', '#1d6f3f', '#3f1d8f', '#8f5f1d']
export function pickInk(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return INKS[h % INKS.length]
}
