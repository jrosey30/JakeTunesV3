import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import '../styles/contextmenu.css'

export interface MenuItem {
  label: string
  /** Optional when `submenu` is present — a parent row opens its flyout
   *  instead of performing an action. */
  onClick?: () => void
  separator?: false
  disabled?: boolean
  checked?: boolean
  /** Nested flyout, 2006-iTunes style ("Add to Playlist ▸"). Rendered in a
   *  PORTAL, not as a DOM child: `.context-menu` sets `overflow-y: auto` for
   *  long menus, which would clip an in-flow flyout to the parent's box. */
  submenu?: MenuEntry[]
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
  const subRef = useRef<HTMLDivElement>(null)
  // Which row's flyout is open, and where to draw it.
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // The flyout lives in a portal, so it is NOT a DOM descendant of `ref`.
      // Both boxes have to count as "inside" or clicking a submenu row would
      // dismiss the menu before its onClick ran.
      const t = e.target as Node
      const inside = (ref.current && ref.current.contains(t)) ||
                     (subRef.current && subRef.current.contains(t))
      if (!inside) {
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

  // Same three-slot fitting for the flyout. A 26-playlist submenu is taller
  // than most screens, so without this the bottom entries land under the
  // statusbar with no way to reach them.
  useEffect(() => {
    const el = subRef.current
    if (!el || !sub) return
    const BUFFER = 12
    const STATUS_H = 24
    const maxBottom = window.innerHeight - STATUS_H - BUFFER
    el.style.left = `${sub.x}px`
    el.style.top = `${sub.y}px`
    el.style.maxHeight = ''
    const rect = el.getBoundingClientRect()
    // Prefer opening to the right; flip to the parent menu's left if it
    // would overflow, which is what the item's own menu edge gives us.
    if (rect.right > window.innerWidth - BUFFER) {
      const menu = ref.current?.getBoundingClientRect()
      const flipped = (menu ? menu.left : sub.x) - rect.width + 2
      el.style.left = `${Math.max(BUFFER, flipped)}px`
    }
    if (rect.bottom > maxBottom) {
      const lifted = maxBottom - rect.height
      if (lifted >= BUFFER) {
        el.style.top = `${lifted}px`
      } else {
        el.style.top = `${BUFFER}px`
        el.style.maxHeight = `${maxBottom - BUFFER}px`
      }
    }
  }, [sub])

  // Anchor a flyout to its parent row: to the right, top-aligned, flipping to
  // the left when the right edge would run off screen.
  const openSub = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    const menu = ref.current?.getBoundingClientRect()
    setSub({ i, x: (menu ? menu.right : r.right) - 2, y: r.top - 4 })
  }

  return (
    <div className="context-menu" ref={ref} style={{ left: x, top: y }}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-sep" />
        ) : (
          <div
            key={i}
            className={`context-menu-item ${item.disabled ? 'context-menu-item--disabled' : ''} ${item.checked !== undefined ? 'context-menu-item--checkable' : ''} ${item.submenu ? 'context-menu-item--parent' : ''} ${sub?.i === i ? 'context-menu-item--subopen' : ''}`}
            onMouseEnter={(e) => {
              if (item.disabled) return
              // Entering any other row closes an open flyout; entering a parent
              // row opens its own. Moving right INTO the flyout never crosses
              // another row, so it stays open.
              if (item.submenu) openSub(i, e.currentTarget)
              else setSub(null)
            }}
            onMouseDown={(e) => {
              e.stopPropagation()
              if (item.disabled) return
              if (item.submenu) { openSub(i, e.currentTarget); return }
              item.onClick?.()
              if (item.checked === undefined) onClose()
            }}
          >
            {item.checked !== undefined && (
              <span className="context-menu-check">{item.checked ? '✓' : ''}</span>
            )}
            {item.label}
            {item.submenu && <span className="context-menu-arrow">▸</span>}
          </div>
        )
      )}

      {sub && (() => {
        const parent = items[sub.i]
        const entries = (!parent.separator && parent.submenu) || []
        return createPortal(
          <div
            className="context-menu context-menu--sub"
            ref={subRef}
            style={{ left: sub.x, top: sub.y }}
          >
            {entries.map((s, j) =>
              s.separator ? (
                <div key={j} className="context-menu-sep" />
              ) : (
                <div
                  key={j}
                  className={`context-menu-item ${s.disabled ? 'context-menu-item--disabled' : ''}`}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    if (s.disabled) return
                    s.onClick?.()
                    onClose()
                  }}
                >
                  {s.label}
                </div>
              )
            )}
          </div>,
          document.body
        )
      })()}
    </div>
  )
}
