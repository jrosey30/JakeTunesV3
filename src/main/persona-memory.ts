/**
 * What each voice recently SAID — so it doesn't contradict itself.
 *
 * Music Man and Cynthia are stateless between calls: every request builds a
 * fresh prompt and the model has no idea what it told Jake ninety seconds ago.
 * Without this, Music Man cheerfully gives opposite takes on the same record
 * in consecutive presses, and Cynthia re-announces work she just finished.
 * So each persona keeps a short rolling log of its own last utterances, and
 * that log is injected back into the next prompt.
 *
 * Two personas, two very different lifetimes, and the difference is the point:
 *
 *   Music Man — 12 entries, in STATE_DIR (the shared NAS-backed state dir),
 *     routed through JsonFileCache. It is shared across devices, because
 *     anti-repeat has to hold no matter which machine Jake pressed the button
 *     on. The cache owns the file path.
 *   Cynthia — 8 entries, in local userData, written directly. Her jobs are
 *     machine-local by nature; a metadata pass on this laptop means nothing
 *     to another device.
 *
 * ⚠️ The blocks these produce are PROMPT TEXT. Both strings are byte-identical
 * to what shipped in index.ts and must stay that way — Music Man's in
 * particular is doing real work in its second half. It exists because he kept
 * scolding Jake for asking twice ("we just did this"), which reads as attitude
 * from a button whose whole job is to be pressed again. The memory is for
 * consistency ONLY, never a licence to comment on repetition, and the prompt
 * has to say so out loud or the model draws the obvious wrong conclusion.
 *
 * Extracted from index.ts 2026-08-09. The state lives HERE now: every reader
 * goes through these functions, so nothing can capture a stale binding.
 */

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'

/** The slice of JsonFileCache this module needs. Structural on purpose — the
 *  cache is index.ts infrastructure and shouldn't be imported back here. */
interface MemoryCache {
  get(): Promise<unknown[]>
  set(value: unknown[]): void
}

let musicmanMemoryCache: MemoryCache | null = null

/** Hand over the Music Man cache. Called once at startup, before load. */
export function initPersonaMemory(cache: MemoryCache): void {
  musicmanMemoryCache = cache
}

// ── Music Man ──

interface MusicManUtterance { mode: string; text: string; at: number }
let recentMusicManUtterances: MusicManUtterance[] = []
const MM_MEMORY_MAX = 12

export async function loadMusicManMemory(): Promise<void> {
  if (!musicmanMemoryCache) return
  const parsed = await musicmanMemoryCache.get()
  if (Array.isArray(parsed)) {
    recentMusicManUtterances = parsed.slice(-MM_MEMORY_MAX) as typeof recentMusicManUtterances
  }
}

function saveMusicManMemory(): void {
  // Routed through the cache: background NAS flush, never blocks a response.
  musicmanMemoryCache?.set(recentMusicManUtterances as unknown[])
}

export function noteMusicManUtterance(mode: string, text: string): void {
  const trimmed = (text || '').trim()
  if (!trimmed) return
  recentMusicManUtterances.push({ mode, text: trimmed, at: Date.now() })
  if (recentMusicManUtterances.length > MM_MEMORY_MAX) {
    recentMusicManUtterances = recentMusicManUtterances.slice(-MM_MEMORY_MAX)
  }
  saveMusicManMemory()
}

export function recentUtterancesBlock(): string {
  if (recentMusicManUtterances.length === 0) return ''
  const lines = recentMusicManUtterances.map(u => `  [${u.mode}] ${u.text}`)
  return `Recently you said — this is YOUR memory, kept here ONLY so you stay CONSISTENT (don't contradict any of it):\n${lines.join('\n')}\n\nThis log is NOT a cue to comment on repetition. If the user wants a take on a track you've already covered, find a genuinely FRESH angle — a different detail, a new comparison, another mood, a contrary read. NEVER tell the user you "already talked about this," that it's "still the same track," "we just did this," or otherwise give them attitude for asking again. They pressed the button because they want a NEW thought, not a complaint about pressing it.`
}

// ── Cynthia ──

interface CynthiaUtterance { text: string; at: number }
let recentCynthiaUtterances: CynthiaUtterance[] = []
/** Lazy: app.getPath is only valid once Electron has resolved its paths, and
 *  this module is imported at the very top of main. */
const cynthiaMemoryPath = () => join(app.getPath('userData'), 'cynthia-memory.json')
const CYNTHIA_MEMORY_MAX = 8

export async function loadCynthiaMemory(): Promise<void> {
  try {
    const raw = await readFile(cynthiaMemoryPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) recentCynthiaUtterances = parsed.slice(-CYNTHIA_MEMORY_MAX)
  } catch { /* first run */ }
}

async function saveCynthiaMemory(): Promise<void> {
  try {
    await writeFile(cynthiaMemoryPath(), JSON.stringify(recentCynthiaUtterances), 'utf-8')
  } catch { /* non-fatal */ }
}

export function noteCynthiaUtterance(text: string): void {
  const trimmed = (text || '').trim()
  if (!trimmed) return
  recentCynthiaUtterances.push({ text: trimmed, at: Date.now() })
  if (recentCynthiaUtterances.length > CYNTHIA_MEMORY_MAX) {
    recentCynthiaUtterances = recentCynthiaUtterances.slice(-CYNTHIA_MEMORY_MAX)
  }
  void saveCynthiaMemory()
}

export function recentCynthiaBlock(): string {
  if (recentCynthiaUtterances.length === 0) return ''
  const lines = recentCynthiaUtterances.map(u => `  - ${u.text}`)
  return `Recent jobs you've finished:\n${lines.join('\n')}`
}
