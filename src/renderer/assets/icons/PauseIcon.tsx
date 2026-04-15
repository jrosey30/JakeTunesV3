export default function PauseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <rect x="2.5" y="1.5" width="3" height="11" rx="0.5" />
      <rect x="8.5" y="1.5" width="3" height="11" rx="0.5" />
    </svg>
  )
}
