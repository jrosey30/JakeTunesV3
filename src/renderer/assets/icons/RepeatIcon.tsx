export default function RepeatIcon({ active = false, one = false }: { active?: boolean; one?: boolean }) {
  // 4.5: stroke uses currentColor so the parent button's color
  // (.transport-toggle--active → var(--brand-orange)) drives the active
  // tint. Pre-fix this icon hardcoded blue and ignored the CSS change.
  const color = active ? 'currentColor' : '#666'
  return (
    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {/* The canonical repeat loop (arrowheads outside the corners, two
          parallel rails). 2026-09-02, third pass — Jake: "come on the
          repeat icon can't go like this lol". */}
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      {one && <text x="12" y="15.4" textAnchor="middle" fill={color} stroke="none" fontSize="9" fontWeight="bold">1</text>}
    </svg>
  )
}
