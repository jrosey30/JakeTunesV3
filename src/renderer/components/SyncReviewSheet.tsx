/**
 * Activity Sync review — the gate between "Music Man built a set" and
 * "bytes move to the iPod". Jake (2026-07-18): "id like to see what is
 * going on the ipod before i confirm activity sync. id also like to make
 * substitutions if necessary and confirm that i am not adding a song that
 * is already in the 1000 songs music man picked."
 *
 * Shows every track in the proposed set badged NEW (will copy) or KEPT
 * (already on the iPod — the sync engine skips byte-identical files, so
 * crossover costs nothing), plus the list of songs leaving the device.
 * Rows can be removed; the search box adds substitutions with a hard
 * duplicate guard (a song already in the set can't be added twice).
 * Nothing touches the iPod, and no state persists anywhere, until
 * "Confirm & Sync". Cancel = the build never happened.
 */
import { useMemo, useState } from 'react'
import type { Track } from '../types'
import '../styles/activity-sheet.css'

interface Props {
  setName: string
  commentary: string
  weatherLine?: string
  initialTracks: Track[]
  /** Track ids the sync PLANNER says are already on the device and will
   *  not copy — computed main-side with the engine's own criteria. */
  keepIds: Set<number>
  /** Device files no track in the proposed set claims — the post-sync
   *  orphan cleanup removes exactly these. */
  leaving: Array<{ path: string; title: string; artist: string }>
  allTracks: Track[]
  onCancel: () => void
  onConfirm: (tracks: Track[]) => void
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export default function SyncReviewSheet({
  setName, commentary, weatherLine, initialTracks, keepIds, leaving: staticLeaving,
  allTracks, onCancel, onConfirm,
}: Props) {
  const [tracks, setTracks] = useState<Track[]>(initialTracks)
  const [query, setQuery] = useState('')
  const [showLeaving, setShowLeaving] = useState(false)

  const idsInSet = useMemo(() => new Set(tracks.map((t) => t.id)), [tracks])

  const { newCount, keptCount } = useMemo(() => {
    let n = 0, k = 0
    for (const t of tracks) (keepIds.has(t.id) ? k++ : n++)
    return { newCount: n, keptCount: k }
  }, [tracks, keepIds])

  // Songs leaving the device = files no proposed track claimed (from the
  // planner) PLUS any on-device (KEPT) track the user removes here.
  const leaving = useMemo(() => {
    const removedKept = initialTracks.filter(
      (t) => keepIds.has(t.id) && !idsInSet.has(t.id),
    ).map((t) => ({ path: String(t.path || ''), title: String(t.title || ''), artist: String(t.artist || '') }))
    return [...staticLeaving, ...removedKept]
  }, [initialTracks, keepIds, idsInSet, staticLeaving])

  const results = useMemo(() => {
    const q = norm(query.trim())
    if (q.length < 2) return []
    const qTokens = q.split(/\s+/)
    const scored: Array<{ t: Track; s: number }> = []
    for (const t of allTracks) {
      const hay = norm(`${t.title || ''} ${t.artist || ''} ${t.album || ''}`)
      if (!qTokens.every((tok) => hay.includes(tok))) continue
      // crude rank: title-prefix beats title-substring beats elsewhere
      const title = norm(String(t.title || ''))
      const s = title.startsWith(q) ? 3 : title.includes(q) ? 2 : 1
      scored.push({ t, s })
      if (scored.length > 200) break
    }
    return scored.sort((a, b) => b.s - a.s).slice(0, 8).map((r) => r.t)
  }, [query, allTracks])

  const removeTrack = (id: number) => setTracks((cur) => cur.filter((t) => t.id !== id))
  const addTrack = (t: Track) => {
    if (idsInSet.has(t.id)) return // dupe guard — button is disabled anyway
    setTracks((cur) => [t, ...cur])
    setQuery('')
  }

  return (
    <div className="activity-sheet-overlay" role="dialog" aria-modal="true" aria-label="Review activity sync">
      <div className="activity-sheet sync-review-sheet">
        <div className="activity-sheet-head">
          <h2 className="activity-sheet-title">“{setName}”</h2>
          <p className="activity-sheet-sub">
            {commentary}{weatherLine ? ` — ${weatherLine}` : ''}
          </p>
          <p className="sync-review-counts">
            <strong>{tracks.length}</strong> songs ·{' '}
            <span className="sync-review-badge sync-review-badge--new">NEW {newCount}</span> will copy ·{' '}
            <span className="sync-review-badge sync-review-badge--kept">KEPT {keptCount}</span> already on iPod
            {leaving.length > 0 && (
              <>
                {' · '}
                <button type="button" className="sync-review-leaving-toggle" onClick={() => setShowLeaving((v) => !v)}>
                  {leaving.length} leaving the iPod {showLeaving ? '▾' : '▸'}
                </button>
              </>
            )}
          </p>
        </div>

        {showLeaving && leaving.length > 0 && (
          <div className="sync-review-leaving">
            {leaving.map((d) => (
              <div key={d.path} className="sync-review-row sync-review-row--leaving">
                <span className="sync-review-row-title">{d.title || d.path.split(':').pop()}</span>
                <span className="sync-review-row-artist">{d.artist}</span>
              </div>
            ))}
          </div>
        )}

        <div className="sync-review-add">
          <input
            className="activity-place"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Add a song — search your library…"
          />
          {results.length > 0 && (
            <div className="sync-review-results">
              {results.map((t) => {
                const dupe = idsInSet.has(t.id)
                return (
                  <div key={t.id} className="sync-review-row">
                    <span className="sync-review-row-title">{t.title}</span>
                    <span className="sync-review-row-artist">{t.artist}</span>
                    {dupe ? (
                      <span className="sync-review-badge sync-review-badge--dupe" title="Music Man already picked this one — it's in the set">In set already</span>
                    ) : (
                      <button type="button" className="sync-review-row-btn" onClick={() => addTrack(t)}>Add</button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="sync-review-list">
          {tracks.map((t) => {
            const kept = keepIds.has(t.id)
            return (
              <div key={t.id} className="sync-review-row">
                <span className={`sync-review-badge ${kept ? 'sync-review-badge--kept' : 'sync-review-badge--new'}`}>
                  {kept ? 'KEPT' : 'NEW'}
                </span>
                <span className="sync-review-row-title">{t.title}</span>
                <span className="sync-review-row-artist">{t.artist}</span>
                <button
                  type="button"
                  className="sync-review-row-btn sync-review-row-btn--remove"
                  onClick={() => removeTrack(t.id)}
                  title="Take this song out of the set"
                >×</button>
              </div>
            )
          })}
        </div>

        <div className="activity-sheet-actions">
          <button type="button" className="activity-btn activity-btn--ghost" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="activity-btn activity-btn--go"
            disabled={tracks.length === 0}
            onClick={() => onConfirm(tracks)}
          >Confirm &amp; Sync {tracks.length} songs ({newCount} new {newCount === 1 ? 'copy' : 'copies'})</button>
        </div>
      </div>
    </div>
  )
}
