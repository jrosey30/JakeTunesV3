export default function ShuffleIcon({ active = false }: { active?: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke={active ? '#4a90d9' : '#666'} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4h3l3 4 3 4h3" />
      <path d="M2 12h3l1.5-2" />
      <path d="M9.5 6L11 4h3" />
      <path d="M12 2l2 2-2 2" />
      <path d="M12 10l2 2-2 2" />
    </svg>
  )
}
