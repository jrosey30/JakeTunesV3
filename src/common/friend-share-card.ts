/**
 * Friend share card — the pure half (2026-10-29): sizes and text rules for the
 * desktop's drawn card, shared with node:test. The drawing is
 * renderer/utils/friendShareCard.ts.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/ShareCard.swift
 * (IPodShareScreen / TrackShareCard / SquareShareCard). Same canvas sizes,
 * same integral Chicago sizes, same line rules: names never clip — the title
 * wraps to three lines, artist and album to two.
 *
 * THE EASTER EGG lives in counterText: a real iPod's Now Playing screen shows
 * "3 of 12", the song's place in what is playing. A song in Jake's Top 1000
 * shows its RANK there ("212 of 1000"). The card's printed line only ever says
 * "from Jake's Top 1000", so the exact number is in the counter and nowhere else.
 */

export type CardFormat = 'story' | 'square'

export const CARD_SIZE: Record<CardFormat, { w: number; h: number }> = {
  story: { w: 1080, h: 1920 },
  square: { w: 1080, h: 1080 },
}

/** The iPod screen's width on each card (the phone's numbers). */
export const SCREEN_WIDTH: Record<CardFormat, number> = { story: 560, square: 700 }

/**
 * Instagram Stories' safe zone on a 1080x1920 story: its own UI covers about
 * the top 250 px and the bottom 340 px, so a story's content stays between.
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/StoryShare.swift (safeTop / safeBottom).
 */
export const STORY_SAFE = { top: 250, bottom: 340 } as const

/** Chicago is a bitmap face: every size is a whole number at any scale. */
export function px(v: number, screenWidth: number): number {
  return Math.round(v * (screenWidth / 640))
}

/** A longer name steps down once more before it wraps; it never truncates
 *  (Jake's rule: names never clip). */
export function titleSize(title: string, screenWidth: number): number {
  const n = title.length
  return px(n <= 12 ? 31 : n <= 22 ? 26 : n <= 40 ? 23 : 20, screenWidth)
}
export function artistSize(artist: string, screenWidth: number): number {
  const n = artist.length
  return px(n <= 14 ? 27 : n <= 30 ? 23 : 20, screenWidth)
}
export function detailSize(detail: string, screenWidth: number): number {
  const n = detail.length
  return px(n <= 14 ? 26 : n <= 30 ? 22 : 19, screenWidth)
}

/** The square can't grow, so it steps down until the screen fits: the
 *  eyebrow goes, the cover shrinks (a wider text column needs fewer lines),
 *  the QR gets smaller, and last the scrubber goes. Names never truncate.
 *  ⚠️ TWIN: the phone's SquareShareCard.steps. */
export interface SquareStep { eyebrow: boolean; screen: number; art: number; qr: number; top: number; pad: number; progress: boolean }
export const SQUARE_STEPS: SquareStep[] = [
  { eyebrow: true, screen: 700, art: 1, qr: 130, top: 36, pad: 30, progress: true },
  { eyebrow: false, screen: 740, art: 0.75, qr: 120, top: 40, pad: 30, progress: true },
  { eyebrow: false, screen: 800, art: 0.55, qr: 100, top: 32, pad: 24, progress: true },
  { eyebrow: false, screen: 820, art: 0.42, qr: 96, top: 28, pad: 20, progress: true },
  { eyebrow: false, screen: 840, art: 0.34, qr: 84, top: 18, pad: 16, progress: true },
  { eyebrow: false, screen: 840, art: 0.34, qr: 84, top: 18, pad: 16, progress: false },
]
/** Everything on the square but the screen. */
export function squareChrome(s: SquareStep): number {
  return (s.eyebrow ? 52 + 44 : 0) + s.top + 2 * s.pad + 24 + (s.qr + 24 + 10 + 26) + 48 + 24
}
/** The first step whose screen (measured by drawing it) fits the square. */
export function pickSquareStep(screenHeight: (s: SquareStep) => number): number {
  for (let i = 0; i < SQUARE_STEPS.length; i++) if (screenHeight(SQUARE_STEPS[i]) + squareChrome(SQUARE_STEPS[i]) <= 1080) return i
  return SQUARE_STEPS.length - 1
}

export function counterText(counter: { index: number; total: number } | null | undefined): string | null {
  return counter && counter.index >= 1 && counter.index <= counter.total ? `${counter.index} of ${counter.total}` : null
}

/** "1:11" / "-2:00" — the fake 37% scrub the phone's card shows. */
export function scrubTimes(durationMs: number): { elapsed: string; remaining: string } | null {
  if (!(durationMs > 0)) return null
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const elapsed = Math.floor((durationMs * 0.37) / 1000)
  const remaining = Math.max(0, Math.floor(durationMs / 1000) - elapsed)
  return { elapsed: clock(elapsed), remaining: `-${clock(remaining)}` }
}

/**
 * Greedy word wrap into at most `maxLines`; the last line ends in "…" when
 * text is left over (the iPod's own truncation). `measure` is the canvas's.
 */
export function wrapText(text: string, maxWidth: number, maxLines: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let i = 0
  while (i < words.length && lines.length < maxLines) {
    let line = words[i]
    i++
    while (i < words.length && measure(`${line} ${words[i]}`) <= maxWidth) { line += ` ${words[i]}`; i++ }
    lines.push(line)
  }
  const last = lines.length - 1
  if (last >= 0 && (i < words.length || measure(lines[last]) > maxWidth)) {
    let s = lines[last]
    while (s.length > 1 && measure(`${s}…`) > maxWidth) s = s.slice(0, -1).trimEnd()
    lines[last] = i < words.length || s !== lines[last] ? `${s}…` : s
  }
  return lines
}

/** A safe download name for the card. */
export function cardName(title: string, artist: string, format: CardFormat): string {
  return `${artist} - ${title} (${format === 'story' ? 'Story' : 'Square'})`
}

/** A safe file name for the card: letters, numbers, spaces, dashes, parens. */
export function cardFileName(name: unknown): string {
  const base = typeof name === 'string' ? name.replace(/[^\p{L}\p{N} ()-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  return `${base || 'JakeTunes'}.png`
}
