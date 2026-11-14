// The cover card at the top of a month's playlist, and of the year's
// (2026-11-13, common/event-covers.ts).
//
//   • "Use a photo…" / "Use the drawing": any month, and the year, can wear a
//     photo of Jake's, the way an iPod does. homemini builds the cover around
//     it (the photo edge to edge, the month and year in words), in full colour
//     or printed in the month's ink.
//   • A month only: an event proposed for it, with what happened, why, the
//     sources it was checked against, the photo's author and licence when the
//     app found an open one, and the preview. Approve or Skip; an approved
//     month offers "Use the normal cover".
//   • "This month's cover is…": Jake names any event; it is checked against
//     sources before anything is made.
// Nothing changes a cover but his click.
import { useCallback, useEffect, useState } from 'react'
import {
  EVENT_COVER_AWAY, EVENT_COVER_HEADING, EVENT_COVER_NEEDS_PHOTO, EVENT_COVER_WISH_LABEL, EVENT_COVER_WISH_SENT, eventCoverIntro, eventCoverMonth, eventCoverPhotoLine,
  type EventCoverDecision, type EventCoverProposal, type PhotoTone,
} from '../../common/event-covers'
import { periodCoverRemoteId } from '../../common/period-covers'
import { refreshPeriodPlaylistCover } from '../utils/periodCovers'
import { BEST_OF_YEAR } from '../utils/smartPlaylists'
import '../styles/ipod-proposals.css'

export default function EventCoverPanel({ playlistId, name }: { playlistId: string | null | undefined; name: string }) {
  const remoteId = periodCoverRemoteId(playlistId, BEST_OF_YEAR)
  const ym = eventCoverMonth(playlistId)
  const [p, setP] = useState<EventCoverProposal | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [hasPhoto, setHasPhoto] = useState(false)
  const [tone, setTone] = useState<PhotoTone>('colour')
  const [note, setNote] = useState<string | null>(null)
  const [wish, setWish] = useState('')
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    if (!remoteId) return
    const photo = await window.electronAPI.ipodPhotoGet?.(remoteId).catch(() => null)
    setHasPhoto(photo?.shown === 'kept')
    const r = await window.electronAPI.eventCoverGet?.(ym ?? '').catch(() => null)
    if (!r?.ok) return
    setP(ym ? r.proposal ?? null : null)
    setPreview(ym ? r.preview ?? null : null)
    setTone(r.tones?.[remoteId] ?? 'colour')
  }, [remoteId, ym])

  useEffect(() => { setP(null); setPreview(null); setHasPhoto(false); setTone('colour'); setNote(null); setWish(''); setOpen(false); void load() }, [load])

  const changed = useCallback(() => { if (playlistId) refreshPeriodPlaylistCover(playlistId); void load() }, [playlistId, load])

  const decide = useCallback(async (decision: EventCoverDecision) => {
    if (!ym) return
    const r = await window.electronAPI.eventCoverDecide?.({ ym, decision }).catch(() => null)
    setNote(r?.ok ? null : r?.away ? EVENT_COVER_AWAY : (r?.error ?? EVENT_COVER_AWAY))
    changed()
  }, [ym, changed])

  const usePhoto = useCallback(async () => {
    if (!remoteId) return
    const r = await window.electronAPI.ipodPhotoChoose?.(remoteId).catch(() => null)
    if (!r) { setNote('Photos need a newer JakeTunes.'); return }
    if (!r.ok) { if (!r.cancelled) setNote(r.error ?? 'couldn’t use that photo'); return }
    setNote(r.homemini === 'saved' ? `${name} wears your photo, here and on the phone.` : `Your photo is kept. ${name} wears it when homemini answers.`)
    changed()
  }, [remoteId, name, changed])

  const useDrawing = useCallback(async () => {
    if (!remoteId) return
    const r = await window.electronAPI.ipodPhotoDrawing?.(remoteId).catch(() => null)
    setNote(!r ? 'Photos need a newer JakeTunes.' : !r.ok ? r.error : r.homemini === 'saved' ? `${name} wears its drawn cover again.` : `${name} wears its drawn cover again when homemini answers.`)
    changed()
  }, [remoteId, name, changed])

  const flipTone = useCallback(async () => {
    if (!remoteId) return
    const next: PhotoTone = tone === 'colour' ? 'duotone' : 'colour'
    const r = await window.electronAPI.eventCoverTone?.({ id: remoteId, tone: next }).catch(() => null)
    setNote(r?.ok ? null : r?.away ? EVENT_COVER_AWAY : (r?.error ?? EVENT_COVER_AWAY))
    changed()
  }, [remoteId, tone, changed])

  const sendWish = useCallback(async () => {
    if (!ym || !wish.trim()) return
    const r = await window.electronAPI.eventCoverWish?.({ ym, text: wish }).catch(() => null)
    setNote(r?.ok ? EVENT_COVER_WISH_SENT : r?.away ? EVENT_COVER_AWAY : (r?.error ?? EVENT_COVER_AWAY))
    if (r?.ok) { setWish(''); setOpen(false) }
  }, [ym, wish])

  if (!remoteId) return null
  const showing = p && p.status !== 'skipped'
  const needsPhoto = showing && p && p.status !== 'approved' && !p.photo && !hasPhoto
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
            {p.photo && !hasPhoto && (
              <div className="ipod-proposals-why">
                {eventCoverPhotoLine(p.photo)}{' '}
                <button className="event-cover-link" onClick={() => void window.electronAPI.openExternalUrl(p.photo!.pageUrl)}>Its page</button>
              </div>
            )}
            {needsPhoto && <p className="ipod-proposals-away">{EVENT_COVER_NEEDS_PHOTO}</p>}
          </div>
          <div className="ipod-proposals-actions">
            {p.status === 'approved'
              ? <button className="playlist-view-save" onClick={() => void decide('restore')}>Use the normal cover</button>
              : <>
                <button className="playlist-view-save" onClick={() => void decide('approve')} disabled={!!needsPhoto}>Approve</button>
                <button className="playlist-view-save" onClick={() => void decide('skip')}>Skip</button>
              </>}
          </div>
        </div>
      )}
      <div className="event-cover-tools">
        <button className="event-cover-link" onClick={() => void usePhoto()} title={`A photo of yours for ${name}'s cover, here and on the phone`}>Use a photo…</button>
        {hasPhoto && <button className="event-cover-link" onClick={() => void useDrawing()}>Use the drawing</button>}
        {(hasPhoto || (p?.status === 'approved' && p.photo)) && (
          <button className="event-cover-link" onClick={() => void flipTone()}>{tone === 'colour' ? 'Print it in the month’s ink' : 'Show it in full colour'}</button>
        )}
        {ym && !open && <button className="event-cover-link" onClick={() => setOpen(true)}>{EVENT_COVER_WISH_LABEL}</button>}
      </div>
      {ym && open && (
        <div className="event-cover-wish">
          <input className="event-cover-wish-input" value={wish} maxLength={300} autoFocus placeholder="what happened, in your words"
            onChange={(e) => setWish(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sendWish(); if (e.key === 'Escape') setOpen(false) }} />
          <button className="playlist-view-save" onClick={() => void sendWish()} disabled={!wish.trim()}>Send</button>
        </div>
      )}
      {note && <p className="ipod-proposals-away">{note}</p>}
    </section>
  )
}
