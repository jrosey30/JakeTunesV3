// "Cover to review" (2026-11-13, common/event-covers.ts). At the top of a
// month's playlist: an event cover proposed for that month, with what happened,
// why, the sources it was checked against, and the drawn preview. Approve or
// Skip; an approved month offers "Use the normal cover". Under it, a box for
// "This month's cover is…": Jake names any event, and it is checked against
// sources before anything is drawn. Nothing changes a cover but his click.
import { useCallback, useEffect, useState } from 'react'
import {
  EVENT_COVER_AWAY, EVENT_COVER_HEADING, EVENT_COVER_WISH_LABEL, EVENT_COVER_WISH_SENT, eventCoverIntro, eventCoverMonth,
  type EventCoverDecision, type EventCoverProposal,
} from '../../common/event-covers'
import { refreshPeriodPlaylistCover } from '../utils/periodCovers'
import '../styles/ipod-proposals.css'

export default function EventCoverPanel({ playlistId }: { playlistId: string | null | undefined }) {
  const ym = eventCoverMonth(playlistId)
  const [p, setP] = useState<EventCoverProposal | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [wish, setWish] = useState('')
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    if (!ym) return
    const r = await window.electronAPI.eventCoverGet?.(ym).catch(() => null)
    if (!r?.ok) return
    setP(r.proposal ?? null)
    setPreview(r.preview ?? null)
  }, [ym])

  useEffect(() => { setP(null); setPreview(null); setNote(null); setWish(''); setOpen(false); void load() }, [load])

  const decide = useCallback(async (decision: EventCoverDecision) => {
    if (!ym) return
    const r = await window.electronAPI.eventCoverDecide?.({ ym, decision }).catch(() => null)
    setNote(r?.ok ? null : r?.away ? EVENT_COVER_AWAY : (r?.error ?? EVENT_COVER_AWAY))
    if (r?.ok && playlistId) refreshPeriodPlaylistCover(playlistId)
    void load()
  }, [ym, playlistId, load])

  const sendWish = useCallback(async () => {
    if (!ym || !wish.trim()) return
    const r = await window.electronAPI.eventCoverWish?.({ ym, text: wish }).catch(() => null)
    setNote(r?.ok ? EVENT_COVER_WISH_SENT : r?.away ? EVENT_COVER_AWAY : (r?.error ?? EVENT_COVER_AWAY))
    if (r?.ok) { setWish(''); setOpen(false) }
  }, [ym, wish])

  if (!ym) return null
  const showing = p && p.status !== 'skipped'
  return (
    <section className="ipod-proposals event-cover-panel" aria-label={EVENT_COVER_HEADING}>
      {showing && p && (
        <div className="ipod-proposals-row event-cover-row">
          {preview && <img className="event-cover-preview" src={preview} alt="" draggable={false} />}
          <div className="ipod-proposals-text">
            <h3 className="ipod-proposals-title">{p.status === 'approved' ? p.title : `${EVENT_COVER_HEADING}: ${p.title}`}</h3>
            {p.line && <div className="ipod-proposals-name">{p.line}</div>}
            <p className="ipod-proposals-intro">{eventCoverIntro(p)}</p>
            {p.why && <div className="ipod-proposals-why">{p.why}</div>}
            {p.sources.length > 0 && (
              <div className="ipod-proposals-why">
                Sources:{' '}
                {p.sources.map((s, i) => (
                  <span key={`${s.url}-${i}`}>
                    {i > 0 && ', '}
                    <button className="event-cover-link" title={s.quote} onClick={() => void window.electronAPI.openExternalUrl(s.url)}>{s.title}</button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="ipod-proposals-actions">
            {p.status === 'approved'
              ? <button className="playlist-view-save" onClick={() => void decide('restore')}>Use the normal cover</button>
              : <>
                <button className="playlist-view-save" onClick={() => void decide('approve')}>Approve</button>
                <button className="playlist-view-save" onClick={() => void decide('skip')}>Skip</button>
              </>}
          </div>
        </div>
      )}
      {open
        ? (
          <div className="event-cover-wish">
            <input className="event-cover-wish-input" value={wish} maxLength={300} autoFocus placeholder="what happened, in your words"
              onChange={(e) => setWish(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sendWish(); if (e.key === 'Escape') setOpen(false) }} />
            <button className="playlist-view-save" onClick={() => void sendWish()} disabled={!wish.trim()}>Send</button>
          </div>
        )
        : <button className="event-cover-link" onClick={() => setOpen(true)}>{EVENT_COVER_WISH_LABEL}</button>}
      {note && <p className="ipod-proposals-away">{note}</p>}
    </section>
  )
}
