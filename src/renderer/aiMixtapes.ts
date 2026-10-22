// Daily AI tapes — renderer store (2026-10-22, parity gap #9: the phone's
// daily tapes rail on Home, Keep, and the kept tapes on the shelf).
//
// Same module-store idiom as homeShelves.ts and mixtapes.ts. Main owns the
// network and the cache (src/main/ai-mixtapes-client.ts) and keeps it fresh
// (boot, every 10 min, window focus, and right after Home's /api/mixes call
// mints today's batch). Nothing here writes this Mac's mixtapes.json: an AI
// tape lives on homemini, and its only switch is Keep.
//
// ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/MixesSection.swift — the rail's
//   Keep (optimistic flip, roll back and say so on failure) and its toasts.
// ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/MixtapesCollectionView.swift —
//   the shelf's "Remove from Mixtapes" (waits for homemini, then moves).

import { dailyAiTapes, keptAiTapes, withAiTapeKept, type AiMixtape, type AiMixtapesState } from '../common/ai-mixtapes'
import { MAX_TAPE_SONGS } from '../common/tape-physics'
import { setNotice } from './activity'
import { pickInk } from './mixtapes'
import type { Mixtape } from './types'

let tapes: AiMixtape[] = []
let loaded = false
/** Keeps on their way to homemini: id → the flag Jake set. A refresh that
 *  lands mid-flight must not flip the tape back for a moment. */
const pending = new Map<string, boolean>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

export function subscribeAiMixtapes(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
export function getAiMixtapes(): AiMixtape[] {
  return tapes
}

function withPending(list: AiMixtape[]): AiMixtape[] {
  let out = list
  for (const [id, kept] of pending) out = withAiTapeKept(out, id, kept)
  return out
}

function put(state: AiMixtapesState | undefined): void {
  if (!state || typeof state !== 'object' || !Array.isArray(state.tapes)) return
  tapes = withPending(state.tapes)
  notify()
}

/** Paint from main's cache at once, then listen for its refreshes. */
export function ensureAiMixtapesLoaded(): void {
  if (loaded) return
  loaded = true
  const api = window.electronAPI
  api.onAiMixtapesUpdated?.((state) => put(state))
  void api.aiMixtapesGet?.().then((r) => { if (r?.ok) put(r.state) }).catch((err: unknown) => {
    console.warn('[ai-mixtapes] read failed:', err instanceof Error ? err.message : err)
  })
}

/** Ask main for homemini's current list. `force` skips main's once-a-minute
 *  throttle (Home calls it straight after /api/mixes minted today's batch). */
export async function refreshAiMixtapes(force = false): Promise<void> {
  ensureAiMixtapesLoaded()
  try {
    const r = await window.electronAPI.aiMixtapesRefresh?.(force)
    if (r?.ok) put(r.state)
  } catch (err) {
    console.warn('[ai-mixtapes] refresh failed:', err instanceof Error ? err.message : err)
  }
}

/** Home's rail: today's batch, not kept. */
export function getDailyAiTapes(): AiMixtape[] {
  return dailyAiTapes(tapes)
}
/** The shelf's kept tapes (kept on this Mac or on the phone). */
export function getKeptAiTapes(): AiMixtape[] {
  return keptAiTapes(tapes)
}
export function findAiTape(id: string): AiMixtape | undefined {
  return tapes.find((t) => t.id === id)
}

function flip(id: string, kept: boolean): void {
  tapes = withAiTapeKept(tapes, id, kept)
  notify()
}

/**
 * Keep / un-keep from the rail or the tape page — the phone's rail rule.
 * The tape moves on THIS frame (kept → onto the shelf, off the rail), then
 * homemini is told. Keep is the one irreversible flag on a daily tape:
 * tomorrow's mint replaces every unkept tape, so a Keep that silently failed
 * would lose the tape overnight after saying it wouldn't roll over. On
 * failure the tape goes back and the notice says so.
 */
export async function toggleAiTapeKept(tape: AiMixtape, next: boolean): Promise<boolean> {
  pending.set(tape.id, next)
  flip(tape.id, next)
  // One line in the pill (the phone's toast has two: "Moved to Mixtapes" /
  // "“title” won't roll over"), so the tape's name leads and stays readable.
  setNotice(next
    ? `“${tape.title}” moved to Mixtapes — it won't roll over`
    : `“${tape.title}” is back in the dailies`, { kind: 'success' })
  let ok = false
  try {
    ok = (await window.electronAPI.aiMixtapesKeep?.(tape.id, next))?.ok === true
  } catch (err) {
    console.warn('[ai-mixtapes] keep failed:', err instanceof Error ? err.message : err)
  }
  // A second press while this one was in flight owns the entry now.
  if (pending.get(tape.id) === next) pending.delete(tape.id)
  if (!ok) {
    flip(tape.id, !next)
    setNotice(next
      ? `Couldn't keep “${tape.title}” — it will still roll over`
      : `Couldn't unkeep “${tape.title}”`, { kind: 'error', durationMs: 6000 })
  }
  return ok
}

/**
 * "Remove from Mixtapes" on the shelf — the phone shelf's unkeep: it waits
 * for homemini, then the tape leaves the shelf and rejoins the dailies (so
 * the next mint clears it). Said plainly, never called "delete".
 */
export async function removeKeptAiTape(tape: AiMixtape): Promise<boolean> {
  let ok = false
  try {
    ok = (await window.electronAPI.aiMixtapesKeep?.(tape.id, false))?.ok === true
  } catch (err) {
    console.warn('[ai-mixtapes] unkeep failed:', err instanceof Error ? err.message : err)
  }
  if (ok) {
    flip(tape.id, false)
    setNotice(`“${tape.title}” is back in the dailies — it rolls over with the next batch`, { kind: 'success' })
  } else {
    setNotice("Couldn't move that tape — the Mini didn't answer", { kind: 'error', durationMs: 6000 })
  }
  return ok
}

/**
 * An AI tape in the desktop's own Mixtape shape, so the tape page and the
 * tape rules (from the top, no skipping, one clock) treat it like any other
 * tape. One flat run of songs: no sides, no cuts, no intro, no talkovers.
 * Never saved — it is homemini's, not this Mac's.
 */
export function aiTapeAsMixtape(t: AiMixtape): Mixtape {
  return {
    id: t.id,
    title: t.title,
    commentary: t.commentary,
    tracks: t.trackIds.slice(0, MAX_TAPE_SONGS),
    tapeLength: 90,
    sideA: [],
    sideB: [],
    linerNotes: [],
    createdAt: t.createdAt,
    inkColor: pickInk(t.id),
  }
}
