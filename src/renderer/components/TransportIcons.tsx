/**
 * Transport icons — play / pause / dismiss as real vector art.
 *
 * These exist because the feed was drawing its controls with TEXT: `▶` (U+25B6)
 * for play, `❚❚` (two HEAVY VERTICAL BARs) for pause, `✕` for dismiss. A glyph
 * is not an icon — its weight, size, and where it sits inside its own em box are
 * decided by whatever font wins fallback, and on a circular button that shows up
 * as a triangle floating high and off-centre. The old CSS carried a
 * `padding-left: 2px` fudge trying to hand-nudge it back, which is the tell.
 *
 * OPTICAL CENTERING is baked into the geometry here, not left to the caller. A
 * triangle's visual centre of mass sits left of its bounding box, so a
 * box-centred triangle reads as if it has drifted left. The play path is
 * therefore drawn ~0.6px right of centre in a 16-unit box — that offset is the
 * icon's business, so every button that uses it is right without a per-site
 * tweak. Pause and close are symmetric and sit dead centre.
 *
 * Currency: `currentColor` throughout, so the button owns the colour.
 */

interface IconProps {
  /** Rendered size in px (square). Default 14 suits a ~38px circular button. */
  size?: number
  className?: string
}

/** Solid play triangle, rounded corners, optically centred. */
export function PlayIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 16 16"
      fill="none" aria-hidden="true" focusable="false"
    >
      <path
        d="M4.8 2.9 12.6 8l-7.8 5.1z"
        fill="currentColor" stroke="currentColor"
        strokeWidth="2.1" strokeLinejoin="round" strokeLinecap="round"
      />
    </svg>
  )
}

/** Two rounded bars. Matches the play triangle's visual weight. */
export function PauseIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 16 16"
      fill="none" aria-hidden="true" focusable="false"
    >
      <rect x="4.1" y="2.9" width="2.9" height="10.2" rx="1.35" fill="currentColor" />
      <rect x="9" y="2.9" width="2.9" height="10.2" rx="1.35" fill="currentColor" />
    </svg>
  )
}

/** Dismiss cross — round caps so it reads as drawn, not typed. */
export function CloseIcon({ size = 10, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 16 16"
      fill="none" aria-hidden="true" focusable="false"
    >
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
      />
    </svg>
  )
}
