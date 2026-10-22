/**
 * Lyrics (parity audit #6) — the phone's Now Playing lyric sheet, as a
 * right-hand panel beside Up Next.
 *
 * The phone flips its cover to the song's sheet (the bottom-right Lyrics
 * button, and the Lyrics side of the iPod touch flip). The desktop's top-bar
 * Now Playing is Do-Not-Touch, so the sheet lives where the desktop already
 * keeps its playing-song panels: the right-hand slot Up Next, the Music Man
 * and Downloads share (one at a time), opened from the toolbar.
 *
 * What it shows, exactly as the phone:
 *   • synced sheet → every line; the current one larger, semibold, in the
 *     brand orange; sung lines dimmer than the ones to come. The current
 *     line follows playback and is kept centred (a 0.35 s ease-in-out; a
 *     jump under prefers-reduced-motion). Click a line to jump there. A
 *     scroll by hand holds the follow off for 4 s;
 *   • plain sheet  → the text, to read and scroll;
 *   • instrumental → "Instrumental";
 *   • still asking → a blank sheet (never a flash of "no lyrics");
 *   • none         → "No lyrics for this song" (the iPod touch back face).
 * Nothing is ever invented — the sheet is the grounded LRCLIB record or
 * nothing. Sticky across songs: the next song's sheet replaces this one.
 *
 * Smooth during playback: the desktop clock already ticks at 10 Hz (the rate
 * the phone interpolates to), so the panel reads it straight; the line list
 * is memoised and re-renders only when the current line changes, not per
 * tick.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/Lyrics.swift `LyricsCard`
 *    (the sheet), NowPlayingView.swift (the corner Lyrics button) and
 *    IPodTouchNowPlaying.swift `lyrics(track:)` (the flip side's states and
 *    wording). Rules: common/lyrics-rules.ts.
 */
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, forwardRef } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useAudio } from '../../hooks/useAudio'
import { prefetchLyrics, useTrackLyrics } from '../../lyricsStore'
import { currentLyricIndex, LYRICS_FOLLOW_MS, LYRICS_HAND_SCROLL_HOLD_MS, type LyricLine } from '../../../common/lyrics-rules'
import '../../styles/queue.css'
import '../../styles/lyrics.css'

export type LyricsPanelHandle = { requestClose: () => void }

const LyricsPanel = forwardRef<LyricsPanelHandle, { onClose: () => void }>(function LyricsPanel({ onClose }, ref) {
  const { state } = usePlayback()
  const { seek } = useAudio()
  const track = state.nowPlaying
  const sheet = useTrackLyrics(track?.id)
  const [exiting, setExiting] = useState(false)

  // The panel can open on a song the toolbar never asked about (restored
  // after launch, say) — ask for this one too.
  useEffect(() => { prefetchLyrics(track?.id) }, [track?.id])

  const requestClose = useCallback(() => {
    if (exiting) return
    setExiting(true)
    window.setTimeout(() => onClose(), 220)
  }, [exiting, onClose])

  useImperativeHandle(ref, () => ({ requestClose }), [requestClose])

  let body: JSX.Element | null = null
  if (!track || sheet === undefined) {
    body = null   // nothing playing, or the answer is on its way: a blank sheet
  } else if (sheet === null) {
    body = <div className="lyrics-note lyrics-note--none">No lyrics for this song</div>
  } else if (sheet.instrumental) {
    body = <div className="lyrics-note">Instrumental</div>
  } else if (sheet.lines.length === 0) {
    body = (
      <div className="lyrics-scroll">
        <div className="lyrics-plain">{sheet.plain}</div>
      </div>
    )
  } else {
    body = (
      <SyncedLyrics
        // Fresh sheet per song: the scroll position and the hand-scroll hold
        // belong to ONE song (the phone's `.id(track.id)`).
        key={track.id}
        lines={sheet.lines}
        positionMs={state.position * 1000}
        durationSec={state.duration}
        seek={seek}
      />
    )
  }

  return (
    <div className={`queue-panel lyrics-panel${exiting ? ' queue-panel--exiting' : ''}`}>
      <div className="queue-header">
        <span className="queue-title">Lyrics</span>
        <button className="queue-close" onClick={requestClose} aria-label="Close Lyrics">&times;</button>
      </div>
      <div className="lyrics-sheet">{body}</div>
    </div>
  )
})

export default LyricsPanel

function SyncedLyrics({ lines, positionMs, durationSec, seek }: {
  lines: LyricLine[]
  positionMs: number
  durationSec: number
  seek: (pct: number) => void
}) {
  const idx = currentLyricIndex(lines, positionMs)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const followRaf = useRef(0)
  const handAt = useRef(-Infinity)
  const placed = useRef(false)
  // Read at click time, so the memoised lines never re-render for them.
  const live = useRef({ durationSec, seek })
  live.current = { durationSec, seek }

  useEffect(() => () => cancelAnimationFrame(followRaf.current), [])

  // Click a line → jump there, and let the follow pick up at once.
  const pick = useCallback((t: number) => {
    const { durationSec: d, seek: s } = live.current
    if (d > 0) s(Math.min(1, Math.max(0, t / 1000 / d)))
    handAt.current = -Infinity
  }, [])

  // A scroll by hand holds the follow off for a few seconds.
  const onWheel = useCallback(() => {
    handAt.current = performance.now()
    cancelAnimationFrame(followRaf.current)
  }, [])

  // Keep the current line centred. Layout effect: the line's new (larger)
  // size is laid out, not yet painted, so the target is where it really is.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || idx < 0) return
    if (performance.now() - handAt.current <= LYRICS_HAND_SCROLL_HOLD_MS) return
    const el = scroller.querySelector<HTMLElement>(`[data-i="${idx}"]`)
    if (!el) return
    const max = scroller.scrollHeight - scroller.clientHeight
    const target = Math.max(0, Math.min(max, el.offsetTop + el.offsetHeight / 2 - scroller.clientHeight / 2))
    cancelAnimationFrame(followRaf.current)
    // Opening the panel mid-song lands on the line; after that it glides.
    if (!placed.current || prefersReducedMotion()) {
      scroller.scrollTop = target
    } else {
      glide(scroller, target, followRaf)
    }
    placed.current = true
  }, [idx])

  return (
    <div className="lyrics-scroll lyrics-scroll--synced" ref={scrollerRef} onWheel={onWheel}>
      {/* Breathing room so the first and last lines can sit at centre like
          every other line (the phone's 0.36 / 0.40 of the sheet). */}
      <div className="lyrics-pad lyrics-pad--top" />
      <SyncedLines lines={lines} idx={idx} onPick={pick} />
      <div className="lyrics-pad lyrics-pad--bottom" />
    </div>
  )
}

const SyncedLines = memo(function SyncedLines({ lines, idx, onPick }: {
  lines: LyricLine[]
  idx: number
  onPick: (t: number) => void
}) {
  return (
    <>
      {lines.map((line, i) => line.text === ''
        ? <div key={i} data-i={i} className="lyrics-gap" />
        : (
          <div
            key={i}
            data-i={i}
            className={`lyrics-line${i === idx ? ' lyrics-line--now' : i < idx ? ' lyrics-line--sung' : ''}`}
            onClick={() => onPick(line.t)}
          >
            {line.text}
          </div>
        ))}
    </>
  )
})

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Scroll to `to` over LYRICS_FOLLOW_MS on SwiftUI's easeInOut curve; `raf`
 *  always holds the pending frame so a new line or a hand scroll cancels it. */
function glide(el: HTMLElement, to: number, raf: { current: number }): void {
  const from = el.scrollTop
  const delta = to - from
  if (Math.abs(delta) < 1) { el.scrollTop = to; return }
  const start = performance.now()
  const step = (now: number): void => {
    const p = Math.min(1, (now - start) / LYRICS_FOLLOW_MS)
    el.scrollTop = from + delta * easeInOut(p)
    raf.current = p < 1 ? requestAnimationFrame(step) : 0
  }
  raf.current = requestAnimationFrame(step)
}

/** cubic-bezier(0.42, 0, 0.58, 1) — CSS / SwiftUI ease-in-out. */
function easeInOut(x: number): number {
  // Solve bezier x(t) = x for t (Newton, then bisection), return y(t).
  const bx = (t: number): number => 3 * (1 - t) * (1 - t) * t * 0.42 + 3 * (1 - t) * t * t * 0.58 + t * t * t
  const by = (t: number): number => 3 * (1 - t) * t * t + t * t * t
  let t = x
  for (let i = 0; i < 6; i++) {
    const dx = (bx(t + 1e-4) - bx(t - 1e-4)) / 2e-4
    if (Math.abs(dx) < 1e-6) break
    t -= (bx(t) - x) / dx
  }
  t = Math.max(0, Math.min(1, t))
  return by(t)
}
