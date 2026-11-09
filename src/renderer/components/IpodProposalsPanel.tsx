// "Picks to review" (2026-11-09). Jake: punkPod's every-other-week additions
// become proposals he approves; nothing goes on the list without his OK.
//
// At the top of an iPod list's playlist (SmartPlaylistView), only while the
// brain has picks waiting: each row is "Artist — Title", the brain's reason,
// Play (normal playback), Approve and Skip; plus Approve all / Skip all.
// Approved songs go on the list; skipped ones are never proposed again. A
// decision is kept on disk by main before it goes to homemini, so no signal
// loses nothing (main/ipod-list-proposals.ts). Contract and words:
// common/ipod-list-proposals.ts.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { refreshIpodLists } from '../ipodLists'
import { proposalLine, proposalsHeading, type IpodProposal } from '../../common/ipod-list-proposals'
import type { Track } from '../types'
import '../styles/ipod-proposals.css'

export const PROPOSALS_INTRO = (ipodName: string): string =>
  `The brain’s picks for ${ipodName}. Nothing goes on the list until you approve it.`
export const PROPOSALS_AWAY = 'homemini is away. Your choices are saved and go to homemini when it’s back.'

export default function IpodProposalsPanel({ deviceId, ipodName }: { deviceId: string; ipodName: string }) {
  const { state: libState } = useLibrary()
  const { playTrack } = useAudio()
  const [rows, setRows] = useState<IpodProposal[]>([])
  const [away, setAway] = useState(false)

  const load = useCallback(async () => {
    const r = await window.electronAPI.ipodListProposals?.(deviceId).catch(() => null)
    if (!r?.ok) return
    setRows(Array.isArray(r.proposals) ? r.proposals : [])
    setAway(!!r.offline || (r.queued ?? 0) > 0)
  }, [deviceId])

  useEffect(() => { setRows([]); setAway(false); void load() }, [load])

  const byId = useMemo(() => {
    const ids = new Set(rows.map((p) => p.id))
    const m = new Map<number, Track>()
    for (const t of libState.tracks) if (ids.has(t.id)) m.set(t.id, t)
    return m
  }, [rows, libState.tracks])

  const decide = useCallback(async (approve: number[], reject: number[]) => {
    if (!approve.length && !reject.length) return
    const gone = new Set([...approve, ...reject])
    setRows((cur) => cur.filter((p) => !gone.has(p.id)))
    const r = await window.electronAPI.ipodListDecide?.({ deviceId, approve, reject }).catch(() => null)
    if (r?.ok && !r.sent) setAway(true)
    if (r?.ok && r.sent && approve.length) void refreshIpodLists() // the approved songs show in the list below
    if (!r?.ok) void load() // refused: show what homemini says is still waiting
  }, [deviceId, load])

  const play = useCallback((id: number) => {
    const queue = rows.map((p) => byId.get(p.id)).filter((t): t is Track => !!t)
    const idx = queue.findIndex((t) => t.id === id)
    if (idx >= 0) playTrack(queue[idx], queue, idx, undefined, true)
  }, [rows, byId, playTrack])

  if (rows.length === 0) return null
  const all = rows.map((p) => p.id)
  return (
    <section className="ipod-proposals" aria-label={proposalsHeading(rows.length)}>
      <div className="ipod-proposals-head">
        <div className="ipod-proposals-titles">
          <h3 className="ipod-proposals-title">{proposalsHeading(rows.length)}</h3>
          <p className="ipod-proposals-intro">{PROPOSALS_INTRO(ipodName)}</p>
          {away && <p className="ipod-proposals-away">{PROPOSALS_AWAY}</p>}
        </div>
        <div className="ipod-proposals-all">
          <button className="playlist-view-save" onClick={() => void decide(all, [])}>Approve all</button>
          <button className="playlist-view-save" onClick={() => void decide([], all)}>Skip all</button>
        </div>
      </div>
      <ul className="ipod-proposals-list">
        {rows.map((p) => {
          const t = byId.get(p.id)
          return (
            <li key={p.id} className="ipod-proposals-row">
              <button className="ipod-proposals-play" onClick={() => play(p.id)} disabled={!t} title={t ? 'Play this song' : 'This song isn’t in the library on this Mac'}>
                Play
              </button>
              <div className="ipod-proposals-text">
                <div className="ipod-proposals-name">{proposalLine(p, t)}</div>
                {p.why && <div className="ipod-proposals-why">{p.why}</div>}
              </div>
              <div className="ipod-proposals-actions">
                <button className="playlist-view-save" onClick={() => void decide([p.id], [])}>Approve</button>
                <button className="playlist-view-save" onClick={() => void decide([], [p.id])}>Skip</button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
