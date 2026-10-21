/**
 * Names never clip on the LCD — the phone's TickerText, as numbers.
 *
 * The toolbar pill's song / artist / album lines used to end in "…" when a
 * name was longer than the pill (Jake's rule: names never clip). The phone
 * solved the same problem on its Now Playing screen with an iPod-mini
 * ticker; this is that ticker's decision and timing, shared so the desktop
 * reads long names the way the phone does:
 *
 *   • fits                       → static, centred (unchanged);
 *   • up to 20% too long         → shrink the line just enough to fit, never
 *                                  below 83% (invisible at LCD sizes);
 *   • more than 20% too long     → scroll it: hold 1.5 s, slide left at
 *                                  24 px/s until the end shows (+16 px), hold
 *                                  0.8 s, snap back, rest 0.4 s, repeat.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/TickerText.swift — the same
 *    tunables (overflowPad, scrollSpeed, minScrollDistance, warmupSeconds,
 *    endPauseSeconds, resetPauseSeconds, tickerOverageThreshold,
 *    staticMinScaleFactor). Change one, change both.
 *
 * Pure: no DOM, no imports. components/playback/lcdTicker.ts measures and
 * animates.
 */

export const LCD_TICKER = {
  overflowPad: 16,
  scrollSpeed: 24,          // px per second — the iPod mini's cadence
  minScrollDistance: 28,
  warmupSeconds: 1.5,
  endPauseSeconds: 0.8,
  resetPauseSeconds: 0.4,
  overageThreshold: 1.2,
  minScale: 0.83,
} as const

export type LcdFit =
  | { kind: 'static' }
  | { kind: 'shrink'; scale: number }
  | { kind: 'ticker'; distance: number; durationMs: number; keyframes: Array<{ offset: number; x: number }> }

/** How one LCD line shows a name `textWidth` px wide in `containerWidth` px. */
export function planLcdFit(textWidth: number, containerWidth: number): LcdFit {
  const T = LCD_TICKER
  if (!(containerWidth > 0) || !(textWidth > containerWidth)) return { kind: 'static' }
  if (textWidth <= containerWidth * T.overageThreshold) {
    return { kind: 'shrink', scale: Math.max(T.minScale, Math.floor((containerWidth / textWidth) * 1000) / 1000) }
  }
  const distance = Math.max(T.minScrollDistance, Math.ceil(textWidth - containerWidth + T.overflowPad))
  const scroll = Math.max(2, distance / T.scrollSpeed)
  const cycle = T.warmupSeconds + scroll + T.endPauseSeconds + T.resetPauseSeconds
  const at = (s: number): number => Math.round((s / cycle) * 10000) / 10000
  const endOfScroll = T.warmupSeconds + scroll
  const endOfPause = endOfScroll + T.endPauseSeconds
  return {
    kind: 'ticker',
    distance,
    durationMs: Math.round(cycle * 1000),
    // Two keyframes share the end-of-pause offset: the snap back to the
    // start is a cut, not a slide (the phone returns 0 for the reset rest).
    keyframes: [
      { offset: 0, x: 0 },
      { offset: at(T.warmupSeconds), x: 0 },
      { offset: at(endOfScroll), x: -distance },
      { offset: at(endOfPause), x: -distance },
      { offset: at(endOfPause), x: 0 },
      { offset: 1, x: 0 },
    ],
  }
}
