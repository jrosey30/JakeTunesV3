export default function RepeatIcon({ active = false, one = false }: { active?: boolean; one?: boolean }) {
  // 4.5: stroke uses currentColor so the parent button's color
  // (.transport-toggle--active → var(--brand-orange)) drives the active
  // tint. Pre-fix this icon hardcoded blue and ignored the CSS change.
  const color = active ? 'currentColor' : '#666'
  return (
    <svg width="23" height="23" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {/* 2026-09-02: redrawn full-width (was x 3–13 in a 16 box — read as
          "narrowed out"). Two arrows spanning 1.5–14.5, same weight as shuffle. */}
      <path d="M12.5 2l2.2 2.2-2.2 2.2" />
      <path d="M2 9V6.7a2.5 2.5 0 012.5-2.5h10" />
      <path d="M3.5 14l-2.2-2.2 2.2-2.2" />
      <path d="M14 7v2.3a2.5 2.5 0 01-2.5 2.5h-10" />
      {one && <text x="8" y="10.5" textAnchor="middle" fill={color} stroke="none" fontSize="7" fontWeight="bold">1</text>}
    </svg>
  )
}
