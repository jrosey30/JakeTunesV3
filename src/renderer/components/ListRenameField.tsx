// Rename… for an iPod list or the Top 1000 (2026-11-09, Jake: "allow me to
// rename the ipod playlists too!! if i want"). One inline box, used by the
// sidebar's iPODS row and the list's playlist header:
//   Enter saves, Esc cancels, clicking away saves a good name and drops a bad one;
//   a name the rules refuse (common/ipod-list-name.ts: empty, over 60, another
//   list's) stays in the box with the reason under it.
// Never a native dialog: Electron's renderer blocks them (V3 CLAUDE.md).
import { useEffect, useRef, useState } from 'react'
import { checkListName, LIST_NAME_MAX } from '../../common/ipod-list-name'

export interface ListRenameFieldProps {
  initial: string
  /** Every OTHER list's name as shown now (the Top 1000's included for an iPod list). */
  others: readonly string[]
  /** Save the name; a refusal comes back as { ok: false, error } and stays in the box. */
  onSave: (name: string) => Promise<{ ok: true } | { ok: false; error: string }>
  onDone: () => void
  /** One quiet line under the box (the hub: the iPod keeps its own name). */
  hint?: string | null
  /** 'sidebar' (the row's box) or 'header' (the playlist page's title). */
  variant: 'sidebar' | 'header'
}

export default function ListRenameField({ initial, others, onSave, onDone, hint, variant }: ListRenameFieldProps) {
  const ref = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const saving = useRef(false)
  const finished = useRef(false)

  useEffect(() => {
    const t = setTimeout(() => ref.current?.select(), 0)
    return () => clearTimeout(t)
  }, [])

  const finish = () => {
    if (finished.current) return
    finished.current = true
    onDone()
  }

  /** viaBlur: a bad name is dropped instead of kept in the box. */
  const commit = async (value: string, viaBlur: boolean) => {
    if (saving.current || finished.current) return
    if (value.trim() === initial.trim()) { finish(); return }
    const check = checkListName(value, others)
    if (!check.ok) {
      if (viaBlur) finish()
      else setError(check.error)
      return
    }
    saving.current = true
    const r = await onSave(check.name).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'Couldn’t rename it.' }))
    saving.current = false
    if (r.ok || viaBlur) finish()
    else setError(r.error)
  }

  return (
    <div className={`list-rename list-rename--${variant}`}>
      <input
        ref={ref}
        className={variant === 'sidebar' ? 'sidebar-inline-input' : 'playlist-view-name-input list-rename-header-input'}
        defaultValue={initial}
        maxLength={LIST_NAME_MAX + 20}
        aria-label="New name"
        aria-invalid={error !== null}
        autoFocus
        onClick={(e) => e.stopPropagation()}
        onChange={() => { if (error) setError(null) }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); void commit(e.currentTarget.value, false) }
          if (e.key === 'Escape') { e.preventDefault(); finish() }
        }}
        onBlur={(e) => { void commit(e.currentTarget.value, true) }}
      />
      {error && <div className="list-rename-error" role="alert">{error}</div>}
      {!error && hint && <div className="list-rename-hint">{hint}</div>}
    </div>
  )
}
