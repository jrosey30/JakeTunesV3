/**
 * The toolbar's Lyrics button (parity audit #6) — the phone's bottom-right
 * Lyrics corner button on Now Playing, in the toolbar's panel group.
 *
 *   • opens / closes the Lyrics panel (components/playback/LyricsPanel.tsx);
 *   • lit while the panel is open, like Up Next and the Music Man;
 *   • dimmed, and does nothing, when the playing song has no sheet — nothing
 *     to show, nothing to explain (the phone's 0.35). While the panel is open
 *     it always closes it.
 *
 * It also asks for this song's sheet and the next one's whenever the song
 * changes, so the panel lands on a ready sheet instead of a fetch.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/NowPlayingView.swift (the
 *    Lyrics corner button, `prefetchLyrics`). Same quote-bubble mark.
 */
import { useEffect } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { prefetchLyrics, useTrackLyrics } from '../../lyricsStore'

export default function LyricsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { state: pb } = usePlayback()
  const id = pb.nowPlaying?.id
  const nextId = pb.queue[pb.queueIndex + 1]?.id
  useEffect(() => {
    prefetchLyrics(id)
    prefetchLyrics(nextId)
  }, [id, nextId])
  const hasLyrics = useTrackLyrics(id) != null
  const usable = open || hasLyrics

  return (
    <button
      className={`transport-toggle queue-toggle lyrics-toggle${open ? ' queue-toggle--active' : ''}${usable ? '' : ' lyrics-toggle--none'}`}
      onClick={() => { if (usable) onToggle() }}
      title="Lyrics (⇧⌘L)"
      aria-label="Lyrics"
      aria-pressed={open}
      aria-disabled={!usable}
    >
      <QuoteBubbleIcon />
    </button>
  )
}

/** A speech bubble holding a pair of quote marks — the phone's quote.bubble
 *  (not stacked lines: next to Up Next that read as a second queue button). */
function QuoteBubbleIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.5c4.1 0 7.25 2.5 7.25 5.75S14.1 15 10 15c-.85 0-1.67-.1-2.43-.3L3.75 16.5l1.1-3.05C3.5 12.4 2.75 10.9 2.75 9.25 2.75 6 5.9 3.5 10 3.5z" />
      <circle cx="7.9" cy="9.9" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="11.7" cy="9.9" r="1.05" fill="currentColor" stroke="none" />
      <path d="M6.9 10c0-1.25.55-2.05 1.55-2.45M10.7 10c0-1.25.55-2.05 1.55-2.45" strokeWidth="1.2" />
    </svg>
  )
}
