import { useState, ReactNode } from 'react'

interface Props {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}

export default function SidebarSection({ title, children, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="sidebar-section">
      <button className="sidebar-section-header" onClick={() => setOpen(!open)}>
        <svg className={`sidebar-chevron ${open ? 'open' : ''}`} width="8" height="8" viewBox="0 0 8 8" fill="#777">
          <path d="M2 1l4 3-4 3z" />
        </svg>
        <span>{title}</span>
      </button>
      {open && <ul className="sidebar-section-items">{children}</ul>}
    </div>
  )
}
