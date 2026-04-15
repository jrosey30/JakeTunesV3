export default function PrevIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <rect x="1" y="2" width="2" height="10" rx="0.5" />
      <path d="M12 2L4 7l8 5z" />
    </svg>
  )
}
