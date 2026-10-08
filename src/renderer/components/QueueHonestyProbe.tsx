/**
 * QueueHonestyProbe — observation only (2026-09-02, Jake: "a lot of the
 * time i will drag something to play next in the queue and it flat out
 * does not"). Renders nothing. Watches playback state from OUTSIDE the
 * do-not-touch files and writes two kinds of rows to main.log:
 *
 *   dx.queue.edit  — the queue changed: how (insert-next / insert-at /
 *                    append / replaced / reordered / removed), what is now
 *                    next, and how many seconds were left on the song.
 *   dx.queue.seam  — the playing track changed: what the queue PROMISED
 *                    would be next vs what actually started. `honest:false`
 *                    is the smoking gun; `cause` says which suspect it fits.
 *
 * Suspects: (1) the seam installs a queue SNAPSHOT taken ≤10 s before the
 * end (gapless prime) or at crossfade start, erasing edits made in that
 * window; (2) a drop that landed on blank panel = END of a 9,900-song
 * queue, not next. Flip DIAGNOSTIC_LOGGING off once the fix lands.
 */
import { useEffect, useRef } from 'react'
import { usePlayback } from '../context/PlaybackContext'

const DIAGNOSTIC_LOGGING = false  // 2026-09-02: OFF — 25/25 natural seams honest since the fix; flip on to re-arm

type Snap = { ids: number[]; idx: number; nowId: number | null; remaining: number; at: number }

function classify(prev: Snap, next: { ids: number[]; idx: number }): string {
  const a = prev.ids, b = next.ids
  if (b.length === a.length + 1 || b.length > a.length) {
    // find first divergence
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    const added = b.length - a.length
    if (i === a.length) return `append(+${added})`
    if (i === prev.idx + 1) return `insert-next(+${added})`
    return `insert-at(${i - prev.idx}, +${added})`
  }
  if (b.length < a.length) return `removed(-${a.length - b.length})`
  const same = a.every((id, i) => id === b[i])
  if (same) return next.idx !== prev.idx ? 'index-moved' : 'unchanged'
  const setA = new Set(a); const setB = new Set(b)
  const sameSet = a.length === b.length && a.every((id) => setB.has(id)) && b.every((id) => setA.has(id))
  return sameSet ? 'reordered' : 'replaced'
}

export default function QueueHonestyProbe() {
  const { state } = usePlayback()
  const last = useRef<Snap | null>(null)
  const editsSinceSeam = useRef<string[]>([])

  useEffect(() => {
    if (!DIAGNOSTIC_LOGGING) return
    const ids = state.queue.map((t) => t.id)
    const nowId = state.nowPlaying?.id ?? null
    const remaining = Math.max(0, Math.round(state.duration - state.position))
    const snap: Snap = { ids, idx: state.queueIndex, nowId, remaining, at: Date.now() }
    const prev = last.current
    last.current = snap
    if (!prev) return

    const queueChanged = prev.ids.length !== ids.length || prev.ids.some((id, i) => id !== ids[i])
    const trackChanged = prev.nowId !== nowId

    if (trackChanged && nowId != null) {
      const promised = prev.ids[prev.idx + 1] ?? null
      // A promise only exists for a NATURAL advance: the index steps to
      // idx+1 (or wraps to 0 from the tail under repeat-all). Anything else —
      // Previous, a row click that locates in the queue, a fresh queue from a
      // double-click (index lands at 0, ids rebuilt) — is the user's own jump
      // and says nothing about honesty. 9/2: all 11 "dishonest" rows in the
      // first afternoon were these jumps; the 25 real seams were honest.
      const wrapped = prev.idx === prev.ids.length - 1 && state.queueIndex === 0 && state.repeat === 'all'
      const advanced = state.queueIndex === prev.idx + 1 || wrapped
      const userJump = !advanced || queueChanged
      const honest = userJump || promised == null ? null : promised === nowId
      const cause = userJump
        ? (queueChanged ? 'user-jump:new-queue' : 'user-jump')
        : honest === false
          ? (editsSinceSeam.current.some((e) => e.includes('window≤10s')) ? 'snapshot-erased-late-edit'
            : editsSinceSeam.current.length ? 'edit-lost-other' : 'no-edit-seen')
          : 'ok'
      window.electronAPI.dxRecord?.('queue.seam', {
        from: prev.nowId, promisedNext: promised, actual: nowId, honest, cause,
        editsSinceLastSeam: editsSinceSeam.current.slice(-6),
        shuffle: state.shuffle, repeat: state.repeat,
        idxBefore: prev.idx, idxAfter: state.queueIndex, lenBefore: prev.ids.length, lenAfter: ids.length,
      })
      editsSinceSeam.current = []
      return
    }

    if (queueChanged || prev.idx !== state.queueIndex) {
      const how = classify(prev, { ids, idx: state.queueIndex })
      if (how === 'unchanged') return
      const tag = `${how}${prev.remaining <= 10 ? ' window≤10s' : ''} rem=${prev.remaining}s`
      editsSinceSeam.current.push(tag)
      window.electronAPI.dxRecord?.('queue.edit', {
        how, secondsLeftOnSong: prev.remaining, nextNow: ids[state.queueIndex + 1] ?? null,
        nextBefore: prev.ids[prev.idx + 1] ?? null, len: ids.length, idx: state.queueIndex,
        shuffle: state.shuffle, repeat: state.repeat,
      })
    }
  }, [state.queue, state.queueIndex, state.nowPlaying, state.duration, state.position, state.shuffle, state.repeat])

  return null
}
