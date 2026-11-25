/**
 * The one Play button (V7, 2026-11-24). Before it there were five: a typed
 * "▶" character, "▶ Album", "▶ Play", "Play Album", "▶ Play the show", each
 * its own size and its own words. Now every Play is this button with the drawn
 * triangle (TransportIcons' PlayIcon, optically centred), in one of two looks:
 *
 *   overlay — the white disc with the orange ▶ that appears over a card's art
 *             on hover (the Artists tile's disc, Jake's pick 2026-10-21)
 *   pill    — the labelled button on a page's header: ▶ Play
 */
import { PlayIcon } from './TransportIcons'
import { PLAY_LABEL, playTitle } from '../../common/card-rules'
import '../styles/card.css'

interface PlayButtonProps {
  onPlay: () => void
  /** What it plays, for the tooltip and screen readers ("Play Abbey Road"). */
  name?: string
  variant?: 'overlay' | 'pill'
  /** Pill only; "Play" unless the page needs a state word ("Playing"). */
  label?: string
  disabled?: boolean
  className?: string
  /** A longer tooltip than "Play <name>". */
  title?: string
}

export default function PlayButton({ onPlay, name = '', variant = 'pill', label = PLAY_LABEL, disabled, className, title }: PlayButtonProps): JSX.Element {
  const tip = title ?? playTitle(name)
  return (
    <button
      type="button"
      className={`jt-play jt-play--${variant}${className ? ` ${className}` : ''}`}
      disabled={disabled}
      title={tip}
      aria-label={variant === 'overlay' ? tip : undefined}
      // The ▶ never also opens the card it sits on.
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPlay() }}
      onDoubleClick={(e) => e.stopPropagation()}
      // Only the keys the button itself handles stop here; Escape and the
      // app-wide keys pass through to the keyboard host.
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') e.stopPropagation() }}
      draggable={false}
    >
      <PlayIcon size={variant === 'overlay' ? 16 : 12} className="jt-play-icon" />
      {variant === 'pill' && <span className="jt-play-label">{label}</span>}
    </button>
  )
}
