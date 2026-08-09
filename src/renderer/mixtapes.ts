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
  /** Legacy (two-sided era). A tape is one sequence now; nothing branches
   *  on this any more, it is kept so old persisted deck state still parses. */
  side?: 'A' | 'B'
  recArmed: boolean
  /** MIC switch: on = mic is live/ready; it only records onto the tape
   *  while REC is also down (Jake's rule). */
  micOn?: boolean
  /** Voice changer for talkovers: 'me' (default) = Jake's own voice;
   *  otherwise a station cast id — ElevenLabs STS re-renders the take. */
  micVoiceId?: string
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
import { fitSide, effectiveDurationFn, tapeTracks, MAX_TAPE_SONGS } from '../common/tape-physics'

export async function layOnDeck(
  trackIds: number[],
  _durOf: (id: number) => number | undefined,
): Promise<string> {
  const deck = deckState
  if (!deck) return 'No tape in the deck.'
  const tape = cache.find((m) => m.id === deck.mixtapeId)
  if (!tape) return 'No tape in the deck.'
  // 2026-08-08: songs append to ONE sequence and the tape is full at
  // MAX_TAPE_SONGS. The old version threaded a minutes budget across two
  // sides, pulled songs forward from B while A rolled, and cut the boundary
  // song — all of that belonged to the cassette-time model Jake retired.
  const current = tapeTracks(tape)
  const have = new Set(current)
  const next: number[] = [...current]
  let laid = 0
  for (const id of trackIds) {
    if (have.has(id)) continue
    if (next.length >= MAX_TAPE_SONGS) break
    next.push(id)
    have.add(id)
    laid++
  }
  if (laid === 0) {
    return next.length >= MAX_TAPE_SONGS
      ? `Tape full — ${MAX_TAPE_SONGS} songs is the whole tape.`
      : 'Already on the tape.'
  }
  await window.electronAPI.saveMixtape?.({ ...tape, tracks: next } as Mixtape)
  await refreshMixtapes()
  const skipped = trackIds.length - laid
  return `${laid} song${laid === 1 ? '' : 's'} laid on the tape`
    + (skipped > 0 ? ` — ${skipped} didn't fit (${MAX_TAPE_SONGS} max).` : '.')
}

/**
 * The tape counter — ONE calculation for every display (faceplate window,
 * deck strip).
 *
 * 2026-08-08: a tape's limit is a SONG COUNT now, not minutes, so the
 * counter reports songs used / left out of MAX_TAPE_SONGS alongside the
 * running time. There is no side, no budget to run out of mid-song, and no
 * boundary cut. Runtime still ticks live with the playhead — the reels
 * turning is the point ("THAT CLOCK NEEDS TO COUNTDOWN!!!") — it just isn't
 * counting against a deadline any more.
 */
export function liveTapeCounter(
  tape: Mixtape,
  nowId: number | null | undefined,
  positionSec: number,
  isPlaying: boolean,
  durOf: (id: number) => number | undefined,
): { songs: number; songsLeft: number; maxSongs: number; totalMs: number; elapsedMs: number } {
  const effDur = effectiveDurationFn(durOf, tape.startOffsets)
  const ids = tapeTracks(tape)
  const totalMs = ids.reduce((sum, id) => sum + effDur(id), 0)
  const base = {
    songs: ids.length,
    songsLeft: Math.max(0, MAX_TAPE_SONGS - ids.length),
    maxSongs: MAX_TAPE_SONGS,
    totalMs,
  }
  if (!isPlaying || nowId == null) return { ...base, elapsedMs: 0 }
  // Merged tape: nowId is the tape's own synthetic track, so the playhead
  // IS the tape position. Per-song playback (old tapes, or a tape not merged
  // yet): sum the slots before the playing one and add the position.
  const idx = ids.indexOf(nowId)
  if (idx < 0) return { ...base, elapsedMs: Math.min(totalMs, positionSec * 1000) }
  let before = 0
  for (let i = 0; i < idx; i++) before += effDur(ids[i])
  const off = tape.startOffsets?.[String(nowId)] || 0
  return { ...base, elapsedMs: before + Math.max(0, positionSec * 1000 - off) }
}

// ── Spooling: FF/REW move the TAPE, not track boundaries. A spool that
// crosses into another slot sets a pending seek; TapeMonitor fires it
// the moment that track starts, landing mid-song like a real deck.
// Live wind position (FF/REW held) — mirrored here so EVERY display
// (faceplate counter, pill scrubber) follows the reels together.
export interface WindDisplay { posMs: number }
let windDisplay: WindDisplay | null = null
export function setWindDisplay(w: WindDisplay | null): void {
  windDisplay = w
  notify()
}
export function getWindDisplay(): WindDisplay | null {
  return windDisplay
}

export interface PendingTapeSeek { trackId: number; seekMs: number }
let pendingSeek: PendingTapeSeek | null = null
export function setPendingTapeSeek(psk: PendingTapeSeek | null): void {
  pendingSeek = psk
}
export function getPendingTapeSeek(): PendingTapeSeek | null {
  return pendingSeek
}

/**
 * Where does the tape land if we spool deltaMs from the current spot?
 * Walks the WHOLE tape in effective time (no sides since 2026-08-08);
 * clamps to [0, end]. Returns the slot to play and how far INTO THE FILE
 * to seek (offset-aware).
 */
export function spoolTarget(
  tape: Mixtape,
  currentElapsedMs: number,
  deltaMs: number,
  durOf: (id: number) => number | undefined,
): { trackId: number; fileSeekMs: number } | null {
  const effDur = effectiveDurationFn(durOf, tape.startOffsets)
  const ids = tapeTracks(tape)
  if (ids.length === 0) return null
  const total = ids.reduce((sum, id) => sum + effDur(id), 0)
  const target = Math.max(0, Math.min(total - 1500, currentElapsedMs + deltaMs))
  let acc = 0
  for (const id of ids) {
    const d = effDur(id)
    if (target < acc + d) {
      const off = tape.startOffsets?.[String(id)] || 0
      return { trackId: id, fileSeekMs: off + (target - acc) }
    }
    acc += d
  }
  const last = ids[ids.length - 1]
  return { trackId: last, fileSeekMs: (tape.startOffsets?.[String(last)] || 0) + effDur(last) - 1500 }
}

/** Stable per-tape ink color for the handwritten label. */
const INKS = ['#1d3f8f', '#8f1d1d', '#1d6f3f', '#3f1d8f', '#8f5f1d']
export function pickInk(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return INKS[h % INKS.length]
}
