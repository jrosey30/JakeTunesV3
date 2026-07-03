/// V5 facelift: SVG sort-direction arrow for table column headers.
/// Replaces the ▲/▼ unicode glyphs in SongsView / PlaylistView /
/// SmartPlaylistView — one hand-authored triangle (house rule: SVG, not
/// font glyphs), rotated for descending, inheriting the header cell's
/// color via currentColor. 7×7 icon inside the header cell's existing
/// 3px-gap flex flow — same footprint the glyph occupied.
/// NOTE: SmartPlaylistView's chart rank-delta ▲/▼ (a different feature)
/// deliberately still uses glyphs — only SORT indicators route here.
export default function SortArrowIcon({ direction }: { direction: 'asc' | 'desc' }) {
  return (
    <svg
      className="sort-arrow-icon"
      width="7"
      height="7"
      viewBox="0 0 8 8"
      style={{ transform: direction === 'desc' ? 'rotate(180deg)' : undefined }}
      aria-hidden="true"
    >
      <path d="M4 1 L7 6 L1 6 Z" fill="currentColor" />
    </svg>
  )
}
