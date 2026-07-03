import { useViewMode, type ViewMode } from '../context/ViewModeContext'

/// V5 facelift: the iTunes-10 segmented List / Grid / Cover Flow control.
/// Mounted by MainContent above the flat-table views (Songs / Playlist /
/// Smart Playlist only — Albums IS the grid metaphor already; Artists /
/// Genres have their own browse structures). Reads/writes the per-view
/// mode in ViewModeContext. Glyphs are hand-authored SVGs (house rule) —
/// list = rows, grid = tiles, coverflow = a centered pane flanked by two
/// receding panes. Each glyph is 12×12 inside a 24px-wide segment.

const SEGMENTS: { mode: ViewMode; title: string; glyph: JSX.Element }[] = [
  {
    mode: 'list',
    title: 'List view',
    glyph: (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="1" y="1.5" width="10" height="1.6" rx="0.5" />
        <rect x="1" y="5.2" width="10" height="1.6" rx="0.5" />
        <rect x="1" y="8.9" width="10" height="1.6" rx="0.5" />
      </svg>
    ),
  },
  {
    mode: 'grid',
    title: 'Grid view',
    glyph: (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="1" y="1" width="4.4" height="4.4" rx="0.8" />
        <rect x="6.6" y="1" width="4.4" height="4.4" rx="0.8" />
        <rect x="1" y="6.6" width="4.4" height="4.4" rx="0.8" />
        <rect x="6.6" y="6.6" width="4.4" height="4.4" rx="0.8" />
      </svg>
    ),
  },
  {
    mode: 'coverflow',
    title: 'Cover Flow',
    glyph: (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        {/* side panes lean away; center pane faces front — the classic glyph */}
        <path d="M1 3.2 L3 3.9 V8.1 L1 8.8 Z" opacity="0.55" />
        <path d="M11 3.2 L9 3.9 V8.1 L11 8.8 Z" opacity="0.55" />
        <rect x="4" y="2.8" width="4" height="6.4" rx="0.6" />
      </svg>
    ),
  },
]

export default function ViewModeToggle() {
  const { mode, setMode } = useViewMode()
  return (
    <div className="view-mode-toggle" role="group" aria-label="View mode">
      {SEGMENTS.map(seg => (
        <button
          key={seg.mode}
          className={`view-mode-segment ${mode === seg.mode ? 'view-mode-segment--active' : ''}`}
          onClick={() => setMode(seg.mode)}
          title={seg.title}
          aria-label={seg.title}
          aria-pressed={mode === seg.mode}
        >
          {seg.glyph}
        </button>
      ))}
    </div>
  )
}
