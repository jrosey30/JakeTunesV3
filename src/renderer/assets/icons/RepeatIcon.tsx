export default function RepeatIcon({ active = false, one = false }: { active?: boolean; one?: boolean }) {
  return (
    <svg width="23" height="23" viewBox="0 0 16 16" fill="none" stroke={active ? '#4a90d9' : '#666'} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 1l2 2-2 2" />
      <path d="M3 7V5a2 2 0 012-2h8" />
      <path d="M5 15l-2-2 2-2" />
      <path d="M13 9v2a2 2 0 01-2 2H3" />
      {one && <text x="8" y="10.5" textAnchor="middle" fill={active ? '#4a90d9' : '#666'} stroke="none" fontSize="7" fontWeight="bold">1</text>}
    </svg>
  )
}
