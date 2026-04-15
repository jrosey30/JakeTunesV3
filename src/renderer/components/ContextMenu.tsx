import { useEffect, useRef } from 'react'
import '../styles/contextmenu.css'

export interface MenuItem {
  label: string
  onClick: () => void
  separator?: false
  disabled?: boolean
  checked?: boolean
}

export interface MenuSeparator {
  separator: true
}

export type MenuEntry = MenuItem | MenuSeparator

interface ContextMenuProps {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const el = ref.current
    if (rect.right > window.innerWidth) {
      el.style.left = `${x - rect.width}px`
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${y - rect.height}px`
    }
  }, [x, y])

  return (
    <div className="context-menu" ref={ref} style={{ left: x, top: y }}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-sep" />
        ) : (
          <div
            key={i}
            className={`context-menu-item ${item.disabled ? 'context-menu-item--disabled' : ''} ${item.checked !== undefined ? 'context-menu-item--checkable' : ''}`}
            onMouseDown={(e) => {
              e.stopPropagation()
              if (!item.disabled) {
                item.onClick()
                if (item.checked === undefined) onClose()
              }
            }}
          >
            {item.checked !== undefined && (
              <span className="context-menu-check">{item.checked ? '✓' : ''}</span>
            )}
            {item.label}
          </div>
        )
      )}
    </div>
  )
}
