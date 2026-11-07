/**
 * iPod Pool — the hand-built Activity Sync set (Jake, 2026-09-02).
 *
 * Everything dropped onto the sidebar's "iPod Pool" row (or onto this
 * page) lands here in drop order. The page is a plain, honest list: what
 * is in the pool, how long it runs, remove one, clear all, and hand off to
 * the Device page to sync it. No picking happens here. One button per iPod
 * (2026-11-07): the Original's Sync puts its Top 1000 on it, so drops here
 * stay here; another iPod's Sync puts exactly its list on it.
 *
 * Any other iPod plugged in (2026-11-07): the page shows that iPod's list, which
 * homemini writes, read-only and newest first — no drop target, no edit controls.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useLibrary } from '../context/LibraryContext'
import ConfirmDialog from '../components/ConfirmDialog'
import { TRACK_DRAG_TYPE } from '../utils/trackDrag'
import { setNotice } from '../activity'
import {
  getPoolIds, getPoolMax, subscribePool, refreshPool, usePoolHealth, usePoolReadOnly, usePoolDevice,
  usePoolManaged, usePoolManagedNote, addTracksToPool, removeFromPool, clearPool, swapInPool,
} from '../activityPool'
import '../styles/activity-pool.css'
import { ipodListHowSongsArrive } from '../../common/ipod-list-doc'

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
  // workmini: this is the MacBook's pool, mirrored for display. Same list, same
  // order; nothing here can edit it (main refuses edits on a replica too).
  const readOnly = usePoolReadOnly()
  // One Pool per iPod (step 2): the plugged-in iPod's pool, else the Original's.
  const device = usePoolDevice()
  const otherIpod = device && !device.primary ? device : null
  // Every iPod but the Original carries homemini's list (2026-11-07, Jake: "i cannot manually
  // add songs in there"): shown read-only, newest first, no drop target and no edit controls.
  const managed = usePoolManaged()
  const managedNote = usePoolManagedNote()
  const editable = !readOnly && !managed
  const [dragOver, setDragOver] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => { void refreshPool() }, [])

  const byId = useMemo(() => new Map(state.tracks.map((t) => [t.id, t])), [state.tracks])
  // The rows are what will SYNC — the same count the sidebar badge and the
  // Activity sheet show. What can't sync is listed underneath, by name,
  // with the fix beside it (2026-09-19: "1000 in the pool, 992 at the sync").
  const health = usePoolHealth(state.tracks)
  const rows = useMemo(() => {
    const inOrder = health.syncable.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t)
    return managed ? inOrder.reverse() : inOrder   // a list reads newest first, like its playlist
  }, [health, byId, managed])
  const totalMs = useMemo(() => rows.reduce((a, t) => a + (Number(t.duration) || 0), 0), [rows])
  const cantSync = health.dead.length + health.concert.length + health.unsyncable.length

  const onDrop = (e: React.DragEvent) => {
    setDragOver(false)
    if (!editable) return
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
      onDragOver={(e) => { if (editable && e.dataTransfer.types.includes(TRACK_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="pool-head">
        <div>
          <h1 className="pool-title">{otherIpod ? (managed ? otherIpod.name : `${otherIpod.name}’s Pool`) : 'iPod Pool'}</h1>
          <div className="pool-sub">
            {managed && otherIpod
              ? (ids.length > 0
                  ? <>{rows.length.toLocaleString()} songs, newest first · {fmtLong(totalMs)} · a sync puts exactly these on {otherIpod.name}, nothing added{cantSync > 0 ? <> · <strong className="pool-sub-warn">{cantSync} can’t</strong></> : ''}</>
                  : <>No songs on {otherIpod.name}’s list yet.</>)
              : readOnly
              ? (ids.length > 0
                  ? <>{rows.length.toLocaleString()} songs · {fmtLong(totalMs)} · the MacBook’s pool, shown here as it stands there</>
                  : <>Empty — the pool is built on the MacBook.</>)
              : otherIpod
              ? (ids.length > 0
                  ? <>{rows.length.toLocaleString()} dropped in · {fmtLong(totalMs)} · {otherIpod.name}’s own pool — a song rides one iPod, never two · a sync puts exactly these on it, nothing added{cantSync > 0 ? <> · <strong className="pool-sub-warn">{cantSync} can’t</strong></> : ''}</>
                  : <>{otherIpod.name} is plugged in: this is its own pool. Drop songs, albums, artists or playlists here — anything already on another iPod stays there.</>)
              : ids.length > 0
              ? <>{rows.length.toLocaleString()} dropped in · {fmtLong(totalMs)} · the Original’s Sync puts its Top 1000 on it, so these stay here</>
              : <>No songs dropped in yet — right-click songs and choose “Add to iPod Pool”, or drag songs, albums, artists or playlists onto this page.</>}
          </div>
        </div>
        {(editable || managed) && <div className="pool-actions">
          {otherIpod && <button
            type="button"
            className="pool-btn pool-btn--go"
            disabled={rows.length === 0}
            onClick={() => {
              // Hand off to the Device page — but only when there IS one: with
              // no iPod mounted the Sidebar bounces the Device page straight
              // back to Songs, which read as the button doing nothing (and the
              // notice still said "press Activity Sync"). No iPod → stay here.
              // One button per iPod (2026-11-07): only a list-only iPod syncs
              // what this page shows; the Original's Sync is its Top 1000.
              const tail = `${otherIpod.name} gets exactly this list, nothing added.`
              void window.electronAPI.checkIpodMounted().then((r) => r.mounted, () => false).then((mounted) => {
                if (!mounted) {
                  setNotice(`Plug in ${otherIpod.name}, then press Sync ${otherIpod.name} — ${tail}`, { kind: 'info', durationMs: 6000 })
                  return
                }
                dispatch({ type: 'SET_VIEW', view: 'device' })
                setNotice(`Press Sync ${otherIpod.name} — ${tail}`, { kind: 'info', durationMs: 6000 })
              })
            }}
          >{managed ? 'Sync this list…' : 'Sync this pool…'}</button>}
          {editable && <button type="button" className="pool-btn" disabled={rows.length === 0} onClick={() => setConfirmClear(true)}>Clear pool</button>}
        </div>}
      </div>

      {managed && otherIpod && <div className="pool-rules">
        {ipodListHowSongsArrive(otherIpod.name)}
        {managedNote ? <> {managedNote}</> : null}
      </div>}

      {editable && <div className="pool-rules">
        Dropping skips skits, intros and sub-minute fragments (you’ll see the count). Duplicates never double-count.
        The pool is yours — no per-artist limit. The Original’s Sync puts its Top 1000 on it, not this pool.
        The pool holds {max.toLocaleString()} — drop more and the oldest drops roll off to make room (you’ll see how many).
      </div>}

      {(editable || managed) && cantSync > 0 && (
        <div className="pool-attention">
          <div className="pool-attention-title">{cantSync} in the pool won’t reach the iPod</div>
          <ul className="pool-attention-list">
            {health.dead.map((d) => {
              const rep = d.replacement !== undefined ? byId.get(d.replacement) : undefined
              return (
                <li key={`dead-${d.id}`}>
                  <span className="pool-attention-name">{d.label}</span>
                  <span className="pool-attention-why">{rep ? 'no longer in the library — the library has a new copy' : 'no longer in the library'}</span>
                  {editable && rep && <button type="button" className="pool-btn pool-btn--small pool-btn--go" onClick={() => { void swapInPool(d.id, rep) }}>Use the new copy</button>}
                  {editable && <button type="button" className="pool-btn pool-btn--small" onClick={() => { void removeFromPool([d.id]) }}>Remove</button>}
                </li>
              )
            })}
            {health.concert.map((id) => {
              const t = byId.get(id)
              return (
                <li key={`concert-${id}`}>
                  <span className="pool-attention-name">{t ? `${t.artist} — ${t.title}` : `Song #${id}`}</span>
                  <span className="pool-attention-why">part of a Full Live Concert — concerts don’t sync as songs</span>
                  {editable && <button type="button" className="pool-btn pool-btn--small" onClick={() => { void removeFromPool([id]) }}>Remove</button>}
                </li>
              )
            })}
            {health.unsyncable.map((id) => {
              const t = byId.get(id)
              return (
                <li key={`bad-${id}`}>
                  <span className="pool-attention-name">{t ? `${t.artist || '?'} — ${t.title || '?'}` : `Song #${id}`}</span>
                  <span className="pool-attention-why">{t?.audioMissing ? 'its audio file is missing on this Mac' : 'missing a title, artist or file'}</span>
                  {editable && <button type="button" className="pool-btn pool-btn--small" onClick={() => { void removeFromPool([id]) }}>Remove</button>}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <table className="pool-table">
          <thead>
            <tr><th className="pool-col-n">#</th><th>Name</th><th>Artist</th><th>Album</th><th className="pool-col-t">Time</th>{editable && <th className="pool-col-x" />}</tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={t.id}>
                <td className="pool-col-n">{i + 1}</td>
                <td className="pool-cell-name">{t.title}</td>
                <td>{t.artist}</td>
                <td className="pool-cell-album">{t.album}</td>
                <td className="pool-col-t">{fmtClock(Number(t.duration) || 0)}</td>
                {editable && <td className="pool-col-x">
                  <button type="button" className="pool-remove" title="Remove from pool" onClick={() => { void removeFromPool([t.id]) }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 2l6 6M8 2l-6 6" /></svg>
                  </button>
                </td>}
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
