/**
 * iPod Pool — the hand-built Activity Sync set (Jake, 2026-09-02).
 *
 * Everything dropped onto the sidebar's "iPod Pool" row (or onto this
 * page) lands here in drop order. The page is a plain, honest list: what
 * is in the pool, how long it runs, remove one, clear all, and hand off to
 * the Device page to sync it. No picking happens here. Every Activity Sync
 * is half and half (2026-10-16): the newest half-set of this pool goes on,
 * and Music Man picks the other half.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import ConfirmDialog from '../components/ConfirmDialog'
import { TRACK_DRAG_TYPE } from '../utils/trackDrag'
import { setNotice } from '../activity'
import {
  getPoolIds, getPoolMax, subscribePool, refreshPool, usePoolHealth,
  addTracksToPool, removeFromPool, clearPool, swapInPool,
} from '../activityPool'
import '../styles/activity-pool.css'
import { resolvePinnedPoolIds } from '../utils/poolPinnedLists'
import { splitHalfAndHalf } from '../../common/activity-split'

function fmtClock(ms: number): string {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
function fmtLong(ms: number): string {
  const mins = Math.floor(ms / 60000)
  const h = Math.floor(mins / 60)
  return h > 0 ? `${h} hr ${mins % 60} min` : `${mins} min`
}

export default function ActivityPoolView() {
  const { state, dispatch } = useLibrary()
  const ids = useSyncExternalStore(subscribePool, getPoolIds)
  const max = getPoolMax()
  const [dragOver, setDragOver] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => { void refreshPool() }, [])

  const byId = useMemo(() => new Map(state.tracks.map((t) => [t.id, t])), [state.tracks])
  // Always-in lists (2026-10-16), resolved live — the same helper the sync uses.
  const pinned = useMemo(() => resolvePinnedPoolIds(state.tracks, state.playlists), [state.tracks, state.playlists])
  // The rows are what will SYNC — the same count the sidebar badge and the
  // Activity sheet show. What can't sync is listed underneath, by name,
  // with the fix beside it (2026-09-19: "1000 in the pool, 992 at the sync").
  const health = usePoolHealth(state.tracks)
  const rows = useMemo(() => health.syncable.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t), [health, byId])
  const totalMs = useMemo(() => rows.reduce((a, t) => a + (Number(t.duration) || 0), 0), [rows])
  const cantSync = health.dead.length + health.concert.length + health.unsyncable.length

  const onDrop = (e: React.DragEvent) => {
    setDragOver(false)
    const raw = e.dataTransfer.getData(TRACK_DRAG_TYPE)
    if (!raw) return
    e.preventDefault()
    try {
      const dropped: number[] = JSON.parse(raw)
      if (Array.isArray(dropped) && dropped.length) void addTracksToPool(dropped, byId)
    } catch { /* not ours */ }
  }

  return (
    <div
      className={`pool-view${dragOver ? ' is-dragover' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes(TRACK_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="pool-head">
        <div>
          <h1 className="pool-title">iPod Pool</h1>
          <div className="pool-sub">
            Always in, live: {pinned.lists.map((l) => l.found ? `${l.name} (${l.count.toLocaleString()})` : `${l.name} (${l.locked ? 'none in your library' : 'no playlist by that name'})`).join(' · ')}
          </div>
          <div className="pool-sub">
            {ids.length > 0
              ? (() => {
                  const split = splitHalfAndHalf(health.syncable, max, pinned.ids)
                  const dropsOn = split.manualIds.length - split.pinnedCount
                  return <>{rows.length.toLocaleString()} dropped in · a {max.toLocaleString()}-song sync takes those lists + your newest {dropsOn.toLocaleString()} drops, Music Man picks the other {split.brainTarget.toLocaleString()} · {fmtLong(totalMs)}{cantSync > 0 ? <> · <strong className="pool-sub-warn">{cantSync} can’t</strong></> : ''}</>
                })()
              : <>No songs dropped in yet — right-click songs and choose “Add to iPod Pool”, or drag songs, albums, artists or playlists onto this page.</>}
          </div>
        </div>
        <div className="pool-actions">
          <button
            type="button"
            className="pool-btn pool-btn--go"
            disabled={rows.length === 0}
            onClick={() => {
              // Hand off to the Device page — but only when there IS one: with
              // no iPod mounted the Sidebar bounces the Device page straight
              // back to Songs, which read as the button doing nothing (and the
              // notice still said "press Activity Sync"). No iPod → stay here.
              // (Every sync is half and half, so there is no pool "mode" to
              // hand over any more — the Activity sheet ignored it.)
              const tail = 'half the set comes from your newest pool drops, Music Man picks the rest.'
              void window.electronAPI.checkIpodMounted().then((r) => r.mounted, () => false).then((mounted) => {
                if (!mounted) {
                  setNotice(`Plug in the iPod, then press Activity Sync — ${tail}`, { kind: 'info', durationMs: 6000 })
                  return
                }
                dispatch({ type: 'SET_VIEW', view: 'device' })
                setNotice(`Press Activity Sync — ${tail}`, { kind: 'info', durationMs: 6000 })
              })
            }}
          >Sync this pool…</button>
          <button type="button" className="pool-btn" disabled={rows.length === 0} onClick={() => setConfirmClear(true)}>Clear pool</button>
        </div>
      </div>

      <div className="pool-rules">
        Dropping skips skits, intros and sub-minute fragments (you’ll see the count). Duplicates never double-count.
        The pool is yours — no per-artist limit. Every sync takes your newest drops for its half; older drops sit that one out.
        The pool holds {max.toLocaleString()} — drop more and the oldest drops roll off to make room (you’ll see how many).
      </div>

      {cantSync > 0 && (
        <div className="pool-attention">
          <div className="pool-attention-title">{cantSync} in the pool won’t reach the iPod</div>
          <ul className="pool-attention-list">
            {health.dead.map((d) => {
              const rep = d.replacement !== undefined ? byId.get(d.replacement) : undefined
              return (
                <li key={`dead-${d.id}`}>
                  <span className="pool-attention-name">{d.label}</span>
                  <span className="pool-attention-why">{rep ? 'no longer in the library — the library has a new copy' : 'no longer in the library'}</span>
                  {rep && <button type="button" className="pool-btn pool-btn--small pool-btn--go" onClick={() => { void swapInPool(d.id, rep) }}>Use the new copy</button>}
                  <button type="button" className="pool-btn pool-btn--small" onClick={() => { void removeFromPool([d.id]) }}>Remove</button>
                </li>
              )
            })}
            {health.concert.map((id) => {
              const t = byId.get(id)
              return (
                <li key={`concert-${id}`}>
                  <span className="pool-attention-name">{t ? `${t.artist} — ${t.title}` : `Song #${id}`}</span>
                  <span className="pool-attention-why">part of a Full Live Concert — concerts don’t sync as songs</span>
                  <button type="button" className="pool-btn pool-btn--small" onClick={() => { void removeFromPool([id]) }}>Remove</button>
                </li>
              )
            })}
            {health.unsyncable.map((id) => {
              const t = byId.get(id)
              return (
                <li key={`bad-${id}`}>
                  <span className="pool-attention-name">{t ? `${t.artist || '?'} — ${t.title || '?'}` : `Song #${id}`}</span>
                  <span className="pool-attention-why">{t?.audioMissing ? 'its audio file is missing on this Mac' : 'missing a title, artist or file'}</span>
                  <button type="button" className="pool-btn pool-btn--small" onClick={() => { void removeFromPool([id]) }}>Remove</button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <table className="pool-table">
          <thead>
            <tr><th className="pool-col-n">#</th><th>Name</th><th>Artist</th><th>Album</th><th className="pool-col-t">Time</th><th className="pool-col-x" /></tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={t.id}>
                <td className="pool-col-n">{i + 1}</td>
                <td className="pool-cell-name">{t.title}</td>
                <td>{t.artist}</td>
                <td className="pool-cell-album">{t.album}</td>
                <td className="pool-col-t">{fmtClock(Number(t.duration) || 0)}</td>
                <td className="pool-col-x">
                  <button type="button" className="pool-remove" title="Remove from pool" onClick={() => { void removeFromPool([t.id]) }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 2l6 6M8 2l-6 6" /></svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmClear && (
        <ConfirmDialog
          message={`Clear the iPod Pool — all ${rows.length.toLocaleString()} songs?`}
          detail="Nothing leaves your library or the iPod. The pool just empties."
          confirmLabel="Clear"
          onConfirm={() => { setConfirmClear(false); void clearPool() }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  )
}
