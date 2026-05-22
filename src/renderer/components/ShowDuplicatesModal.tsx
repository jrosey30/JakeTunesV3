import { useEffect, useMemo, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import { Track } from '../types'
import '../styles/import-convert.css'
import '../styles/show-duplicates.css'

interface Props {
  tracks: Track[]
  onClose: () => void
  onDelete: (id: number) => void
}

interface DupGroup {
  key: string
  title: string
  artist: string
  album: string
  members: Track[]
}

/**
 * Group library entries that share (artist, title, album) after
 * trim+lowercase. The text comparison only authorizes *display* — the
 * actual delete still goes through an explicit per-row ConfirmDialog
 * per the postmortem rule (destructive ops may not gate on text match
 * alone). The user picks which copies to remove; nothing is auto-deleted.
 *
 * "Not a duplicate" dismissals: persisted in ui-state.json as a map of
 * group-key → member-id signature. The signature pins each dismissal to
 * the *exact set of tracks* that was reviewed — if a new track later
 * joins the group (e.g. a fresh import), the signature no longer matches
 * and the group surfaces again for re-review. This avoids stale
 * dismissals quietly hiding new genuine duplicates.
 *
 * Twin note: MusicManView groups by (title, artist) — different purpose
 * (single-variant playback resolution) and different shape (2-tuple).
 * No twin to keep in sync.
 */
function normalizeKey(t: Track) {
  const artist = (t.artist || '').trim().toLowerCase()
  const title = (t.title || '').trim().toLowerCase()
  const album = (t.album || '').trim().toLowerCase()
  return `${artist}|||${title}|||${album}`
}

function formatDuration(ms: number): string {
  if (!ms || !isFinite(ms)) return '—'
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatBytes(b: number): string {
  if (!b || !isFinite(b)) return '—'
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function pathTail(p: string): string {
  // iPod paths use ":" as separator; show last two segments so the
  // F-dir + filename are visible without flooding the row width.
  if (!p) return ''
  const segs = p.split(':').filter(Boolean)
  return segs.slice(-2).join(':') || p
}

// Member-id signature: sorted, comma-joined. Compared at filter time so
// a dismissal expires the moment the group's membership changes (new
// import joins, existing copy gets deleted elsewhere, etc).
function memberSig(members: Track[]): string {
  return members
    .map((m) => m.id)
    .sort((a, b) => a - b)
    .join(',')
}

const DISMISSED_KEY = 'jaketunes:dup-dismissed-v1'

export default function ShowDuplicatesModal({ tracks, onClose, onDelete }: Props) {
  const [pendingDelete, setPendingDelete] = useState<Track | null>(null)
  const [dismissed, setDismissed] = useState<Map<string, string>>(new Map())
  const [dismissedLoaded, setDismissedLoaded] = useState(false)
  const [showHidden, setShowHidden] = useState(false)

  // Renderer localStorage is unreliable in Electron; use ui-state IPC.
  useEffect(() => {
    let cancelled = false
    window.electronAPI.loadUiState().then((r) => {
      if (cancelled || !r.ok || !r.state) return
      const raw = (r.state as Record<string, unknown>)[DISMISSED_KEY]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
      const next = new Map<string, string>()
      for (const [k, v] of Object.entries(raw)) {
        if (typeof k === 'string' && typeof v === 'string') next.set(k, v)
      }
      setDismissed(next)
    }).catch(() => {
      // Non-fatal — modal still works for this session.
    }).finally(() => {
      if (!cancelled) setDismissedLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!dismissedLoaded) return
    let cancelled = false
    window.electronAPI.loadUiState().then((r) => {
      if (cancelled) return
      const existing = (r.ok && r.state) ? r.state : {}
      window.electronAPI.saveUiState({
        ...existing,
        [DISMISSED_KEY]: Object.fromEntries(dismissed),
      })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [dismissed, dismissedLoaded])

  const allGroups = useMemo<DupGroup[]>(() => {
    const map = new Map<string, Track[]>()
    for (const t of tracks) {
      const artist = (t.artist || '').trim()
      const title = (t.title || '').trim()
      const album = (t.album || '').trim()
      // Skip entries missing core metadata — don't lump unrelated tagless
      // tracks together as a phantom "duplicate group".
      if (!artist || !title || !album) continue
      const k = normalizeKey(t)
      const list = map.get(k) || []
      list.push(t)
      map.set(k, list)
    }
    const out: DupGroup[] = []
    for (const [k, list] of map) {
      if (list.length < 2) continue
      out.push({
        key: k,
        title: list[0].title || '',
        artist: list[0].artist || '',
        album: list[0].album || '',
        members: list,
      })
    }
    out.sort((a, b) => {
      const aa = a.artist.toLowerCase()
      const bb = b.artist.toLowerCase()
      if (aa < bb) return -1
      if (aa > bb) return 1
      return a.title.localeCompare(b.title)
    })
    return out
  }, [tracks])

  // A group is "dismissed" only if the stored signature matches the
  // current member-id set exactly. Any change in membership
  // (added/removed tracks) re-surfaces the group automatically.
  const isDismissed = (g: DupGroup) =>
    dismissed.get(g.key) === memberSig(g.members)

  const visibleGroups = showHidden
    ? allGroups
    : allGroups.filter((g) => !isDismissed(g))
  const hiddenCount = allGroups.filter((g) => isDismissed(g)).length
  const totalCandidates = visibleGroups.reduce((sum, g) => sum + g.members.length, 0)

  const handleDismiss = (g: DupGroup) => {
    setDismissed((prev) => {
      const next = new Map(prev)
      next.set(g.key, memberSig(g.members))
      return next
    })
  }
  const handleRestore = (g: DupGroup) => {
    setDismissed((prev) => {
      const next = new Map(prev)
      next.delete(g.key)
      return next
    })
  }

  return (
    <div className="imp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-modal dup-modal" role="dialog" aria-modal="true">
        <div className="imp-header">
          <h2>Possible Duplicates</h2>
          <button className="imp-close" onClick={onClose} title="Close">×</button>
        </div>

        <div className="imp-body">
          <p className="imp-help">
            Songs in your library that share the same <strong>artist + title + album</strong>. Some may be
            intentional — different versions, AAC vs ALAC, album cut vs bonus track, full song vs clip. Review
            each before deleting. Per-row delete only — there is no bulk action. Use{' '}
            <strong>Not a duplicate</strong> to permanently hide a group you've already vetted; it
            re-surfaces if a new track later joins.
          </p>

          {allGroups.length === 0 ? (
            <div className="dup-empty">No duplicates found in your library.</div>
          ) : visibleGroups.length === 0 ? (
            <div className="dup-empty">
              All {allGroups.length} possible duplicate {allGroups.length === 1 ? 'group has' : 'groups have'} been marked as not duplicates.
              <br />
              Click <strong>Show {hiddenCount} hidden</strong> below to review them.
            </div>
          ) : (
            <div className="dup-summary">
              <strong>{totalCandidates}</strong> {totalCandidates === 1 ? 'entry' : 'entries'} in{' '}
              <strong>{visibleGroups.length}</strong> {visibleGroups.length === 1 ? 'group' : 'groups'}
              {hiddenCount > 0 && (
                <>
                  {' · '}
                  {hiddenCount} marked not-a-duplicate
                </>
              )}
            </div>
          )}

          <div className="dup-groups">
            {visibleGroups.map((g) => {
              const dismissedNow = isDismissed(g)
              return (
                <div
                  className={`dup-group${dismissedNow ? ' dup-group--hidden' : ''}`}
                  key={g.key}
                >
                  <div className="dup-group-header">
                    <span className="dup-group-title">{g.title}</span>
                    <span className="dup-group-artist">{g.artist}</span>
                    <span className="dup-group-album">{g.album}</span>
                    <span className="dup-group-count">{g.members.length}×</span>
                    {dismissedNow ? (
                      <button
                        className="dup-group-dismiss-btn dup-group-dismiss-btn--restore"
                        onClick={() => handleRestore(g)}
                        title="Restore — un-mark this group as not-a-duplicate"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        className="dup-group-dismiss-btn"
                        onClick={() => handleDismiss(g)}
                        title="Hide this group — these are intentionally distinct (e.g. clip vs full, AAC vs ALAC). Reappears if a new track joins the group."
                      >
                        Not a duplicate
                      </button>
                    )}
                  </div>
                  <div className="dup-group-rows">
                    {g.members.map((t) => (
                      <div className="dup-row" key={t.id}>
                        <div className="dup-row-meta">
                          <span className="dup-tn">#{t.trackNumber || '?'}</span>
                          <span className="dup-dur">{formatDuration(t.duration || 0)}</span>
                          <span className="dup-size">{formatBytes(t.fileSize || 0)}</span>
                          {t.audioFingerprint && (
                            <span className="dup-fp" title={t.audioFingerprint}>
                              fp:{t.audioFingerprint.slice(0, 8)}
                            </span>
                          )}
                        </div>
                        <div className="dup-row-path" title={t.path}>{pathTail(t.path || '')}</div>
                        <button
                          className="dup-delete-btn"
                          onClick={() => setPendingDelete(t)}
                          // Last-copy guard: never let this modal delete the
                          // sole remaining instance of a song. Once the
                          // group shrinks to 1 it disappears from the UI
                          // anyway, but if the user has rapid-clicked we
                          // prevent the final tap landing.
                          disabled={g.members.length <= 1}
                          title="Delete this copy from the library"
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="imp-footer">
          {hiddenCount > 0 && (
            <button
              className="dup-show-hidden-toggle"
              onClick={() => setShowHidden((v) => !v)}
              title={
                showHidden
                  ? 'Hide groups marked as not-a-duplicate'
                  : 'Show groups marked as not-a-duplicate'
              }
            >
              {showHidden ? `Hide ${hiddenCount} not-a-duplicate` : `Show ${hiddenCount} hidden`}
            </button>
          )}
          <button className="imp-btn imp-btn--cancel" onClick={onClose}>Done</button>
        </div>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          message="Delete this copy from your library?"
          detail={`${pendingDelete.title} — ${pendingDelete.artist}\n${formatBytes(
            pendingDelete.fileSize || 0
          )} · ${formatDuration(
            pendingDelete.duration || 0
          )}\n\nOther copies in this duplicate group will remain. This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => {
            onDelete(pendingDelete.id)
            setPendingDelete(null)
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
