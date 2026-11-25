/**
 * Needs You (V7, File › Library › Needs You…): the only things the library
 * can't decide by itself. Everything else (leftover files, file sizes, tags,
 * the play cache, Music Man's index, tempo and key) the nightly check does on
 * its own (main/self-care.ts).
 *
 *   - Songs that may be in the library twice: Jake picks which copy goes.
 *   - Song files in the music folder that no song points at, when the night
 *     found any: Jake decides whether they go.
 *   - Albums the genre filer wasn't sure about (GenreCheckList, moved here
 *     from Settings › Library).
 */
import { useEffect, useState } from 'react'
import CloseButton from './CloseButton'
import GenreCheckList from './GenreCheckList'
import '../styles/import-convert.css'

interface Props {
  onClose: () => void
  onShowDuplicates: () => void
  onShowOrphans: () => void
}

type Status = { lastRunAt: number | null; needsYou: { orphanFiles: number; orphanBytes: number } } | null

function lastChecked(at: number | null): string {
  if (!at) return 'Not checked yet. It runs at night, when no music is playing.'
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const days = Math.floor((Date.now() - at) / 86_400_000)
  if (days < 1) return `Last checked at ${time}.`
  return `Last checked ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}.`
}

export default function NeedsYouSheet({ onClose, onShowDuplicates, onShowOrphans }: Props): JSX.Element {
  const [status, setStatus] = useState<Status>(null)
  useEffect(() => {
    let live = true
    window.electronAPI.selfCareStatus().then((s) => { if (live) setStatus(s) }).catch(() => { /* shows "not checked yet" */ })
    return () => { live = false }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const orphans = status?.needsYou.orphanFiles ?? 0
  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal" role="dialog" aria-modal="true" style={{ minWidth: 440 }}>
        <div className="imp-header">
          <h2>Needs You</h2>
          <CloseButton onClick={onClose} />
        </div>
        <div className="imp-body">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
            <span>Songs that may be in your library twice.</span>
            <button type="button" className="imp-btn" onClick={onShowDuplicates}>Review…</button>
          </div>
          {orphans > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
              <span>{orphans === 1 ? 'One song file in your music folder isn’t in your library.' : `${orphans.toLocaleString()} song files in your music folder aren’t in your library.`}</span>
              <button type="button" className="imp-btn" onClick={onShowOrphans}>Review…</button>
            </div>
          )}
          <GenreCheckList />
          <p className="imp-help" style={{ marginTop: 8 }}>{lastChecked(status?.lastRunAt ?? null)}</p>
        </div>
      </div>
    </div>
  )
}
