import { ReactNode, useState, useCallback } from 'react'
import { setAlbumDragPayload } from '../../utils/trackDrag'

interface Props {
  label: string
  icon?: ReactNode
  selected?: boolean
  indicator?: string
  highlight?: string          // amber/orange row background color
  onClick: () => void
  droppable?: boolean
  onDrop?: (trackIds: number[]) => void
  /** 4.4.0: extra className on the row — used for the WJLR Picks
   *  featured-section treatment. */
  className?: string
  /** Small right-aligned count (iPod Pool: "812"). */
  badge?: string
  /** 2026-09-02: make the row a DRAG SOURCE carrying this whole list —
   *  a playlist dragged onto the iPod Pool brings every song. */
  dragTrackIds?: number[]
}

export default function SidebarItem({ label, icon, selected, indicator, highlight, onClick, droppable, onDrop, className, badge, dragTrackIds }: Props) {
  const [dragOver, setDragOver] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!droppable) return
    if (e.dataTransfer.types.includes('application/jaketunes-tracks')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    }
  }, [droppable])

  const handleDragLeave = useCallback(() => {
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    setDragOver(false)
    if (!droppable || !onDrop) return
    e.preventDefault()
    const raw = e.dataTransfer.getData('application/jaketunes-tracks')
    if (!raw) return
    try {
      const ids: number[] = JSON.parse(raw)
      if (Array.isArray(ids) && ids.length > 0) {
        onDrop(ids)
      }
    } catch { /* ignore bad data */ }
  }, [droppable, onDrop])

  const cls = [
    'sidebar-item',
    selected ? 'sidebar-item--selected' : '',
    highlight ? 'sidebar-item--highlight' : '',
    highlight && selected ? 'sidebar-item--highlight-selected' : '',
    dragOver ? 'sidebar-item--dragover' : '',
    className || '',
  ].filter(Boolean).join(' ')

  const highlightStyle = highlight
    ? selected
      ? { background: '#fff', color: highlight } as React.CSSProperties
      : { background: `linear-gradient(180deg, ${highlight}, ${highlight}dd)`, color: '#fff' } as React.CSSProperties
    : undefined

  return (
    <li
      className={cls}
      style={highlightStyle}
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      draggable={!!dragTrackIds && dragTrackIds.length > 0}
      onDragStart={dragTrackIds && dragTrackIds.length > 0 ? (e) => setAlbumDragPayload(e, dragTrackIds) : undefined}
    >
      {icon && <span className="sidebar-item-icon">{icon}</span>}
      <span className="sidebar-item-label">{label}</span>
      {badge && <span className="sidebar-item-badge">{badge}</span>}
    </li>
  )
}
