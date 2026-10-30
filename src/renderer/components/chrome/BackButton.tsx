import '../../styles/back-pill.css'

/**
 * The ONE back control (Jake, 2026-10-30: "never used those arrows. make going
 * back obvious on every page"). Lifted from the album page's "‹ Albums" pill so
 * every page shows the same thing: a drawn chevron and the name of the page
 * Back lands on (hooks/useBackLabel.ts — the 10/20 rule: the label comes from
 * the same history step the click uses). MainContent renders it in a strip
 * above every view that has no back control of its own (backPill.ts); the
 * album, artist and concert pages render it themselves, where their own sat.
 *
 * `label` is the label function's text ("← Albums"); the chevron is drawn, so
 * the text arrow is dropped here. `className` is for PLACEMENT only (a page
 * positioning its pill) — the look is the pill's, everywhere.
 */
const ICON_BACK = (
  <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><path d="M6 1L2 5l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)

interface Props {
  label: string
  onClick: () => void
  className?: string
}

export default function BackButton({ label, onClick, className }: Props) {
  const text = label.replace(/^[←‹]\s*/, '')
  return (
    <button type="button" className={className ? `back-pill ${className}` : 'back-pill'} onClick={onClick} aria-label={text}>
      {ICON_BACK}<span>{text}</span>
    </button>
  )
}
