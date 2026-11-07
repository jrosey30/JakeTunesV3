import { useState, useCallback, ReactNode } from 'react'

/** The drag type a section header carries (2026-11-07, Jake: "customizeable as to
 *  where i place them, click and drag and drop"). Song drags carry
 *  'application/jaketunes-tracks' and are never taken here, so dropping songs
 *  on a playlist row works exactly as before. */
export const SECTION_DRAG_TYPE = 'application/jaketunes-sidebar-section'

// The section being dragged. dataTransfer can't be read during dragover, and a
// section must not show a drop line for itself.
let draggingKey: string | null = null

interface Props {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  /** Stable key for reordering; without it the section can't be moved. */
  sectionKey?: string
  /** A section header was dropped on this section: put `dragged` before or after it. */
  onSectionDrop?: (dragged: string, target: string, where: 'before' | 'after') => void
  /** Right-click on the header (Move Up / Move Down / Reset order). */
  onHeaderContextMenu?: (e: React.MouseEvent, sectionKey: string) => void
  /** ⌥↑ / ⌥↓ on the focused header: the keyboard way to move it. */
  onNudge?: (sectionKey: string, step: -1 | 1) => void
}

export default function SidebarSection({ title, children, defaultOpen = true, sectionKey, onSectionDrop, onHeaderContextMenu, onNudge }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const [dropAt, setDropAt] = useState<'before' | 'after' | null>(null)
  const movable = !!sectionKey && !!onSectionDrop

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!movable || !e.dataTransfer.types.includes(SECTION_DRAG_TYPE)) return
    if (draggingKey === sectionKey) { setDropAt(null); return }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const box = e.currentTarget.getBoundingClientRect()
    setDropAt(e.clientY < box.top + Math.min(box.height / 2, 24) ? 'before' : 'after')
  }, [movable, sectionKey])

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null)
  }, [])

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const where = dropAt
    setDropAt(null)
    if (!movable || !e.dataTransfer.types.includes(SECTION_DRAG_TYPE)) return
    e.preventDefault()
    const dragged = e.dataTransfer.getData(SECTION_DRAG_TYPE) || draggingKey
    draggingKey = null
    if (dragged && sectionKey && dragged !== sectionKey && where) onSectionDrop?.(dragged, sectionKey, where)
  }, [dropAt, movable, onSectionDrop, sectionKey])

  const cls = ['sidebar-section', dropAt === 'before' ? 'sidebar-section--drop-before' : '', dropAt === 'after' ? 'sidebar-section--drop-after' : ''].filter(Boolean).join(' ')

  return (
    <div className={cls} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <button
        className="sidebar-section-header"
        onClick={() => setOpen(!open)}
        draggable={movable}
        onDragStart={movable ? (e) => {
          draggingKey = sectionKey ?? null
          e.dataTransfer.setData(SECTION_DRAG_TYPE, sectionKey ?? '')
          e.dataTransfer.effectAllowed = 'move'
        } : undefined}
        onDragEnd={() => { draggingKey = null }}
        onContextMenu={sectionKey && onHeaderContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onHeaderContextMenu(e, sectionKey) } : undefined}
        onKeyDown={sectionKey && onNudge ? (e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
          e.preventDefault()
          onNudge(sectionKey, e.key === 'ArrowUp' ? -1 : 1)
        } : undefined}
        title={movable ? 'Drag to move this section (or ⌥↑ / ⌥↓)' : undefined}
      >
        <svg className={`sidebar-chevron ${open ? 'open' : ''}`} width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
          <path d="M2 1l4 3-4 3z" />
        </svg>
        <span>{title}</span>
      </button>
      {open && <ul className="sidebar-section-items">{children}</ul>}
    </div>
  )
}
