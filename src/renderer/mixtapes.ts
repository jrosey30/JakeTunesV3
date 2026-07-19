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
  /** MIC switch: on = mic is live/ready; it only records onto the tape
   *  while REC is also down (Jake's rule). */
  micOn?: boolean
}

let deckState: DeckState | null = null

export function setDeckState(d: DeckState | null): void {
  deckState = d
  notify()
}
export function getDeckState(): DeckState | null {
  return deckState
}

/**
 * Lay songs straight onto the tape in the deck — the right-click path
 * ("adding songs by search is bogus" — Jake). Same physics as the
 * recorder: fills the active side in order, boundary song gets cut,
 * flips A→B, stops when the tape is full. Persists once. Returns a
 * human sentence for the notice.
 */
import { fitSide, effectiveDurationFn } from '../common/tape-physics'

export async function layOnDeck(
  trackIds: number[],
  durOf: (id: number) => number | undefined,
): Promise<string> {
  const deck = deckState
  if (!deck) return 'No tape in the deck.'
  const tape = cache.find((m) => m.id === deck.mixtapeId)
  if (!tape) return 'No tape in the deck.'
  const budget = (tape.tapeLength / 2) * 60_000
  const effDur = effectiveDurationFn(durOf, tape.startOffsets)
  let sideA = [...tape.sideA]
  let sideB = [...tape.sideB]
  let cutA = tape.sideACutMs
  let cutB = tape.sideBCutMs
  let side: 'A' | 'B' = deck.side
  let laid = 0
  for (const id of trackIds) {
    if (sideA.includes(id) || sideB.includes(id)) continue // already on the tape
    const tryside = (which: 'A' | 'B'): boolean => {
      const cur = which === 'A' ? sideA : sideB
      const cut = which === 'A' ? cutA : cutB
      if (cut !== undefined) return false
      const fit = fitSide([...cur, id], effDur, budget)
      if (!fit.ids.includes(id)) return false
      if (which === 'A') { sideA = fit.ids; cutA = fit.cutMs } else { sideB = fit.ids; cutB = fit.cutMs }
      return true
    }
    let ok = tryside(side)
    if (!ok && side === 'A') { ok = tryside('B'); if (ok) side = 'B' }
    if (!ok) break
    laid++
    if ((side === 'A' ? cutA : cutB) !== undefined && side === 'A') side = 'B'
  }
  if (laid === 0) return 'Tape full — nothing landed.'
  const next = { ...tape, sideA, sideB, sideACutMs: cutA, sideBCutMs: cutB }
  await window.electronAPI.saveMixtape?.(next)
  await refreshMixtapes()
  setDeckState({ ...deck, side })
  const skipped = trackIds.length - laid
  return `${laid} song${laid === 1 ? '' : 's'} laid on the tape${skipped > 0 ? ` — tape ran out, ${skipped} didn't fit` : ''}.`
}

/**
 * The tape counter — ONE calculation for every display (faceplate window,
 * deck strip). Committed songs count whole (effective, offset-aware); the
 * side's TAIL song rolls live with the playhead, so time-left ticks down
 * second by second while recording (or while playing the tape's tail).
 */
export function liveTapeCounter(
  tape: Mixtape,
  activeSide: 'A' | 'B',
  nowId: number | null | undefined,
  positionSec: number,
  isPlaying: boolean,
  durOf: (id: number) => number | undefined,
): { side: 'A' | 'B'; leftMs: number; usedMs: number; budgetMs: number; cutCountdown: boolean } {
  const budgetMs = (tape.tapeLength / 2) * 60_000
  const effDur = effectiveDurationFn(durOf, tape.startOffsets)
  const staticFor = (side: 'A' | 'B') => {
    const ids = side === 'A' ? tape.sideA : tape.sideB
    const cut = side === 'A' ? tape.sideACutMs : tape.sideBCutMs
    const used = cut !== undefined ? budgetMs : fitSide(ids, effDur, budgetMs).usedMs
    return { side, leftMs: Math.max(0, budgetMs - used), usedMs: used, budgetMs, cutCountdown: false }
  }
  if (isPlaying && nowId != null) {
    for (const cfg of [
      { side: 'A' as const, ids: tape.sideA, cut: tape.sideACutMs },
      { side: 'B' as const, ids: tape.sideB, cut: tape.sideBCutMs },
    ]) {
      const idx = cfg.ids.indexOf(nowId)
      if (idx < 0 || idx !== cfg.ids.length - 1) continue
      let before = 0
      for (let i = 0; i < idx; i++) before += effDur(cfg.ids[i])
      const off = tape.startOffsets?.[String(nowId)] || 0
      const live = before + Math.max(0, positionSec * 1000 - off)
      if (live < budgetMs) {
        return { side: cfg.side, leftMs: budgetMs - live, usedMs: live, budgetMs, cutCountdown: cfg.cut !== undefined }
      }
    }
  }
  return staticFor(activeSide)
}

/** Stable per-tape ink color for the handwritten label. */
const INKS = ['#1d3f8f', '#8f1d1d', '#1d6f3f', '#3f1d8f', '#8f5f1d']
export function pickInk(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return INKS[h % INKS.length]
}
