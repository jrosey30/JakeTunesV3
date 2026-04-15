import { ReactNode, useState, useCallback } from 'react'

interface Props {
  label: string
  icon?: ReactNode
  selected?: boolean
  indicator?: string
  highlight?: string          // amber/orange row background color
  onClick: () => void
  droppable?: boolean
  onDrop?: (trackIds: number[]) => void
}

export default function SidebarItem({ label, icon, selected, indicator, highlight, onClick, droppable, onDrop }: Props) {
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
    >
      {icon && <span className="sidebar-item-icon">{icon}</span>}
      <span className="sidebar-item-label">{label}</span>
    </li>
  )
}
