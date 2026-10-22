import { useCallback, useState } from 'react'
import type React from 'react'
import type { ArtistProfileMember, ArtistProfileState } from '../../../common/artist-profile'

/**
 * One band member on the artist page (2026-10-20): a clear photo of their
 * face, the name they go by, their legal name under it when that differs,
 * what they play, and — when they are an artist in Jake's library too — a way
 * to their own page.
 *
 * The photo is also the one control Jake asked for: drop a picture on it, or
 * click to choose one, to make it that member's photo ("Jake's own pick always
 * wins"). Same hover hint and interaction as a custom playlist cover. It goes
 * to homemini, so the phone shows it too; a failure says so right here.
 *
 * A sourced photo's credit is never printed (Jake: no footnotes); it rides
 * only as the picture's hover title.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/ArtistPage.swift ArtistMemberTile
 * (tap the photo → PhotosPicker; same "Set photo" / "Saving…" hint, same
 * inline errors) — both send to the same homemini route and store.
 */
export interface MemberTileProps {
  artist: string
  member: ArtistProfileMember
  /** artist-image:// slug the photo is saved under on this Mac, if it is. */
  photoSlug?: string
  /** No photo passed Jake's bar (profile needsPhoto): the "Set photo" hint
   *  stays up on the initials tile, so the empty ones are easy to fill. */
  needsPhoto?: boolean
  /** The library artist to open when this member is also one. */
  soloArtist?: string
  onOpenSolo: (name: string) => void
  onPhotoSet: (state: ArtistProfileState) => void
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toUpperCase()
}

export default function MemberTile({ artist, member, photoSlug, needsPhoto, soloArtist, onOpenSolo, onPhotoSet }: MemberTileProps) {
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState('')

  const setPhoto = useCallback(async (file: File | null) => {
    if (busy) return
    const api = window.electronAPI
    if (!api.artistMemberPhotoSet) { setError('This build cannot set member photos.'); return }
    setBusy(true)
    setError('')
    try {
      const r = await api.artistMemberPhotoSet(artist, member.name, file)
      if (r.ok) onPhotoSet(r.state)
      else if (!r.canceled) setError(r.error || 'The photo could not be saved.')
    } catch (err) {
      setError(`The photo could not be saved (${err instanceof Error ? err.message : String(err)}).`)
    } finally {
      setBusy(false)
    }
  }, [busy, artist, member.name, onPhotoSet])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const f = e.dataTransfer.files?.[0]
    if (!f) return
    if (!f.type.startsWith('image/')) { setError('That is not a picture. Drop a JPEG, PNG or HEIC.'); return }
    void setPhoto(f)
  }, [setPhoto])

  const roles = member.roles.join(', ')
  return (
    <div className="ad-member">
      <button
        type="button"
        className={`ad-member-photo ad-lift${drag ? ' is-drag' : ''}${busy ? ' is-busy' : ''}${needsPhoto ? ' is-needed' : ''}`}
        onClick={() => { void setPhoto(null) }}
        onDragOver={(e) => { e.preventDefault(); if (!drag) setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        title={needsPhoto ? `No photo of ${member.name} yet — click to choose one, or drop one here` : `Click to choose a photo of ${member.name}, or drop one here`}
        aria-label={`Set photo of ${member.name}`}
      >
        {photoSlug
          ? <img src={`artist-image://${photoSlug}.jpg`} alt={member.name} className="ad-member-img" draggable={false} title={member.photo?.credit ? `${member.name} photo: ${member.photo.credit}` : undefined} />
          : <span className="ad-member-mono" aria-hidden="true">{initials(member.name)}</span>}
        <span className="ad-member-hint">{busy ? 'Saving…' : drag ? 'Drop photo' : 'Set photo'}</span>
      </button>
      <div className="ad-member-text">
        <div className="ad-member-name">{member.name}</div>
        {member.legalName && <div className="ad-member-legal">{member.legalName}</div>}
        {roles && <div className="ad-member-role">{roles}{member.years ? ` · ${member.years}` : ''}</div>}
        {soloArtist && (
          <button type="button" className="ad-member-solo" onClick={() => onOpenSolo(soloArtist)}>
            Solo artist in your library →
          </button>
        )}
        {error && <div className="ad-member-error" role="alert">{error}</div>}
      </div>
    </div>
  )
}
