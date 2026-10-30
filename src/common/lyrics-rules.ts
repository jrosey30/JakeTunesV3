/**
 * Synced lyrics — the phone's rules, shared so the desktop reads a sheet the
 * way the phone does (parity audit #6).
 *
 * The desktop fetches grounded LRCLIB lyrics into lyrics.json (the laptop is
 * the single writer) and the phone's backend serves the same records as
 * `{ lines, plain, instrumental }`. These are that backend's rules, applied to
 * what `get-track-lyrics` returns, so both devices make the same call:
 *
 *   • synced sheet  → `[mm:ss.xx] text` lines, sorted by time; the current
 *                     line is the last one whose stamp has passed;
 *   • plain sheet   → the plain text (or the synced one with its stamps cut);
 *   • instrumental  → a sheet that says so;
 *   • nothing       → null. Never invented: no record, a miss, or an empty
 *                     record all mean "no lyrics for this song".
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/lyricsRules.ts (`parseLRC`,
 *    `stripLRC`) and backend/src/util/lyrics.ts (`lyricsFor`, the shaping in
 *    `trackLyricsFrom`). ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/Lyrics.swift
 *    (`LyricsCard.currentIndex`, the binary search in `currentLyricIndex`).
 *    Change one, change both.
 *
 * Pure: no DOM, no imports. components/playback/LyricsPanel.tsx renders it.
 */

/** One timed line; `t` = ms from the start of the track. */
export interface LyricLine { t: number; text: string }

export interface TrackLyrics {
  /** Timestamped lines when LRCLIB had a synced sheet; empty otherwise. */
  lines: LyricLine[]
  /** The plain sheet (always present when any lyrics exist). */
  plain: string
  instrumental: boolean
}

/** What `get-track-lyrics` hands back (main/ipc/lyrics-ipc.ts LyricsRecord, minus bookkeeping). */
export interface StoredLyrics {
  plain?: string
  synced?: string
  instrumental?: boolean
  miss?: boolean
}

/** `[mm:ss.xx] text` (several stamps per line allowed) → sorted lines. */
export function parseLRC(synced: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of synced.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (stamps.length === 0) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const s of stamps) {
      const frac = s[3] ? Number((s[3] + '00').slice(0, 3)) : 0
      const t = Number(s[1]) * 60_000 + Number(s[2]) * 1000 + frac
      out.push({ t, text })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Drops the stamps and collapses runs of blank lines. */
export function stripLRC(synced: string): string {
  return synced
    .split(/\r?\n/)
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && (arr[i - 1] ?? '').length > 0))
    .join('\n')
    .trim()
}

/** A stored record → the sheet, or null when there are no lyrics to show. */
export function trackLyricsFrom(rec: StoredLyrics | null | undefined): TrackLyrics | null {
  if (!rec || rec.miss) return null
  if (rec.instrumental) return { lines: [], plain: '', instrumental: true }
  const lines = rec.synced ? parseLRC(rec.synced) : []
  const plain = (rec.plain && rec.plain.trim()) || (rec.synced ? stripLRC(rec.synced) : '')
  if (lines.length === 0 && !plain) return null
  return { lines, plain, instrumental: false }
}

/** The last line whose stamp has passed; −1 before the first. */
export function currentLyricIndex(lines: readonly LyricLine[], ms: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= ms) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

/** How long a scroll by hand holds off the auto-follow (the phone's 4 s). */
export const LYRICS_HAND_SCROLL_HOLD_MS = 4000
/** The follow scroll's ease-in-out duration (the phone's 0.35 s). */
export const LYRICS_FOLLOW_MS = 350
