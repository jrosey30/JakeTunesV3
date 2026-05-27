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

  // Adjust position so the menu never overflows the viewport.
  // 4.5.0-108: full rewrite. The previous version only nudged the top
  // when rect.bottom overran the viewport, which didn't help if the
  // menu was taller than the available space ABOVE the click either —
  // items still ended up under the 24px statusbar. New logic picks the
  // best of three slots: (a) fits below, leave; (b) fits above, flip;
  // (c) fits in neither, clamp to top + apply explicit max-height so
  // the menu scrolls instead of silently hiding items below.
  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.maxHeight = ''
    const rect = el.getBoundingClientRect()
    const BUFFER = 12         // breathing room from viewport edges
    const STATUS_H = 24       // bottom statusbar height (var --statusbar-height)
    const maxBottom = window.innerHeight - STATUS_H - BUFFER
    const maxRight = window.innerWidth - BUFFER

    if (rect.bottom > maxBottom) {
      const flippedTop = y - rect.height
      if (flippedTop >= BUFFER) {
        el.style.top = `${flippedTop}px`
      } else {
        // Doesn't fit above or below — clamp to top, scroll.
        el.style.top = `${BUFFER}px`
        el.style.maxHeight = `${maxBottom - BUFFER}px`
      }
    }
    if (rect.right > maxRight) {
      el.style.left = `${Math.max(BUFFER, x - rect.width)}px`
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
