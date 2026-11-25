/**
 * Needs You (V7, File › Library › Needs You…): the only things the library
 * can't decide by itself. Everything else (leftover files, file sizes, tags,
 * the play cache, the Music Man's index, tempo and key) the nightly check does on
 * its own (main/self-care.ts).
 *
 *   - Songs that may be in the library twice: Jake picks which copy goes.
 *   - Song files in the music folder that no song points at, when the night
 *     found any, and songs whose file is gone (counted when this opens, whatever
 *     the night found): Jake decides whether they go. Both open the same review.
 *   - A play-cache tidy the night held back (its brake): shown, so it isn't silent.
 *   - Albums the genre filer wasn't sure about (GenreCheckList, moved here
 *     from Settings › Library).
 */
import { useEffect, useState } from 'react'
import CloseButton from './CloseButton'
import { useEscape } from '../hooks/useKeyboard'
import GenreCheckList from './GenreCheckList'
import '../styles/import-convert.css'

interface Props {
  onClose: () => void
  onShowDuplicates: () => void
  onShowOrphans: () => void
}

type Status = { lastRunAt: number | null; needsYou: { orphanFiles: number; orphanBytes: number; playCacheHeld: string | null } } | null

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
  const [deadCount, setDeadCount] = useState(0)
  useEffect(() => {
    let live = true
    window.electronAPI.selfCareStatus().then((s) => { if (live) setStatus(s) }).catch(() => { /* shows "not checked yet" */ })
    // Fresh each time the list opens, not last night's number.
    window.electronAPI.scanDeadTracks().then((r) => { if (live && r.ok) setDeadCount(r.count ?? 0) }).catch(() => { /* row stays hidden */ })
    return () => { live = false }
  }, [])
  useEscape('needs-you', true, onClose)

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
          {deadCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
              <span>{deadCount === 1 ? 'One song has no file and can’t play.' : `${deadCount.toLocaleString()} songs have no file and can’t play.`}</span>
              <button type="button" className="imp-btn" onClick={onShowOrphans}>Review…</button>
            </div>
          )}
          {/* Shown, never "tidied anyway": a brake that holds is often a library that read back short. */}
          {status?.needsYou.playCacheHeld && (
            <p className="imp-help" style={{ fontSize: 13, color: '#3a3a3a' }}>
              Last night’s tidy of the saved copies for quick play was held back: {status.needsYou.playCacheHeld}. Nothing was deleted, and it tries again tonight.
            </p>
          )}
          <GenreCheckList />
          <p className="imp-help" style={{ marginTop: 8 }}>{lastChecked(status?.lastRunAt ?? null)}</p>
        </div>
      </div>
    </div>
  )
}
