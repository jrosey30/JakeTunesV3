/**
 * Share Song / Share Album (2026-10-29) — the desktop twin of the phone's
 * share sheet (JakeTunesMobile FriendShare.swift).
 *
 * homemini builds the message (signature line first, then a direct Spotify
 * link and an Apple Music link) so both Macs and the phone send the same
 * thing; this dialog shows it, draws the iPod card (Story 9:16 or Square),
 * and hands either to macOS's Share menu (Messages, Mail, AirDrop…), the
 * clipboard, or a file.
 *
 * Opened from the song and album menus through `openFriendShare` (a window
 * event, so the menus stay plain data); <FriendShareHost /> in App owns it.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Track } from '../types'
import { useLibrary } from '../context/LibraryContext'
import { albumKeyOf } from '../utils/albumKey'
import { albumArtUrl } from '../artRevision'
import { renderShareCard, type CardContent } from '../utils/friendShareCard'
import { cardName, type CardFormat } from '../../common/friend-share-card'
import { offlineShareText, type ShareInfo } from '../../common/friend-share-doc'
import '../styles/friend-share.css'

export interface FriendShareRequest {
  kind: 'song' | 'album'
  /** The song, or any track of the album (homemini names an album by it). */
  track: Track
  /** Album only: its songs (for the "12 songs · 1997" line). */
  albumTracks?: Track[]
}

const EVENT = 'jt:friend-share'

export function openFriendShare(req: FriendShareRequest): void {
  window.dispatchEvent(new CustomEvent<FriendShareRequest>(EVENT, { detail: req }))
}

export function FriendShareHost() {
  const [req, setReq] = useState<FriendShareRequest | null>(null)
  useEffect(() => {
    const on = (e: Event) => setReq((e as CustomEvent<FriendShareRequest>).detail)
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  return req ? <FriendShareDialog req={req} onClose={() => setReq(null)} /> : null
}

function FriendShareDialog({ req, onClose }: { req: FriendShareRequest; onClose: () => void }) {
  const { state: lib } = useLibrary()
  const [info, setInfo] = useState<ShareInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  const [format, setFormat] = useState<CardFormat>('story')
  const [cards, setCards] = useState<Partial<Record<CardFormat, string>>>({})

  const t = req.track
  const title = req.kind === 'album' ? (t.album || 'Unknown Album') : (t.title || 'Unknown Title')
  const artist = req.kind === 'album' ? (t.albumArtist || t.artist || 'Unknown Artist') : (t.artist || 'Unknown Artist')
  const text = info?.text ?? offlineShareText(title, artist)

  useEffect(() => {
    let live = true
    void (async () => {
      const r = await window.electronAPI.friendShareInfo?.(t.id, req.kind)
      if (!live) return
      if (r?.ok) setInfo(r.value)
      else setNote(r?.error ?? 'homemini isn’t answering.')
      setLoading(false)
    })()
    return () => { live = false }
  }, [t.id, req.kind])

  const content = useCallback((): CardContent => {
    const hash = lib.artworkMap[albumKeyOf(t)]
    const n = req.albumTracks?.length ?? 0
    const year = t.year ? String(t.year) : ''
    return {
      title: info?.title ?? title,
      artist: info?.artist ?? artist,
      detail: req.kind === 'album' ? [n ? `${n} song${n === 1 ? '' : 's'}` : '', year].filter(Boolean).join(' · ') : (t.album || undefined),
      artUrl: hash ? albumArtUrl(hash) : undefined,
      durationMs: req.kind === 'album' ? 0 : (t.duration || 0),
      counter: info?.counter ?? null,
      cardLine: info?.signature.card ?? "from Jake's library",
      link: info?.links.primary ?? null,
    }
  }, [info, lib.artworkMap, req, t, title, artist])

  useEffect(() => {
    if (loading || cards[format]) return
    let live = true
    void renderShareCard(content(), format).then((png) => { if (live) setCards((c) => ({ ...c, [format]: png })) })
    return () => { live = false }
  }, [loading, format, cards, content])

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])

  const png = cards[format]
  const name = cardName(title, artist, format)
  const flash = (s: string) => { setNote(s); window.setTimeout(() => setNote((n) => (n === s ? null : n)), 2200) }

  return (
    <div className="fshare-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="fshare-dialog" role="dialog" aria-label={req.kind === 'album' ? 'Share Album' : 'Share Song'}>
        <div className="fshare-head">
          <span className="fshare-eyebrow">{req.kind === 'album' ? 'SHARE ALBUM' : 'SHARE SONG'}</span>
          <button className="fshare-close" onClick={onClose} aria-label="Close">Done</button>
        </div>
        <div className="fshare-body">
          <div className={`fshare-preview fshare-preview--${format}`}>
            {png ? <img src={png} alt="Share card" /> : <div className="fshare-wait">Drawing the card…</div>}
          </div>
          <div className="fshare-side">
            <div className="fshare-seg" role="tablist">
              {(['story', 'square'] as const).map((f) => (
                <button key={f} role="tab" aria-selected={format === f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
                  {f === 'story' ? 'Story 9:16' : 'Square'}
                </button>
              ))}
            </div>
            <div className="fshare-label">THE MESSAGE</div>
            <pre className="fshare-text">{loading ? 'Finding it on Spotify and Apple Music…' : text}</pre>
            <div className="fshare-row">
              <button disabled={loading} onClick={() => void window.electronAPI.friendShareShare?.({ text })}>Send Link…</button>
              <button disabled={loading} onClick={() => void window.electronAPI.friendShareCopy?.({ text }).then((r) => r?.ok && flash('Message copied'))}>Copy Message</button>
            </div>
            <div className="fshare-row">
              <button className="primary" disabled={!png} onClick={() => png && void window.electronAPI.friendShareShare?.({ png, name })}>Share Card…</button>
              <button disabled={!png} onClick={() => png && void window.electronAPI.friendShareCopy?.({ png }).then((r) => r?.ok && flash('Card copied'))}>Copy Card</button>
              <button disabled={!png} onClick={() => png && void window.electronAPI.friendShareSave?.({ png, name }).then((r) => r?.ok && flash('Card saved'))}>Save…</button>
            </div>
            {note && <div className="fshare-note">{note}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
