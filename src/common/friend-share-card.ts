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

export function titleSize(title: string, screenWidth: number): number {
  return px(title.length <= 12 ? 31 : title.length <= 22 ? 26 : 23, screenWidth)
}
export function artistSize(artist: string, screenWidth: number): number {
  return px(artist.length <= 14 ? 27 : 23, screenWidth)
}
export function detailSize(detail: string, screenWidth: number): number {
  return px(detail.length <= 14 ? 26 : 22, screenWidth)
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
