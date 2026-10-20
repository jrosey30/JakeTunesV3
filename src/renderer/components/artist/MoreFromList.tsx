import { Fragment, useState } from 'react'
import { RELEASE_KIND_LABEL, type ReleaseKind } from '../../../common/release-kind'
import { plural } from '../../../common/artist-page'
import type { Track } from '../../types'

/**
 * "More from <Artist>" (2026-10-20) — the old "Full discography", kept and
 * restyled: the artist's releases that are NOT in the library, from
 * MusicBrainz, grouped by kind and newest first. Collapsed by default; each
 * release opens to its tracklist, and any song of it Jake already has (on
 * another release) plays from there.
 *
 * Only ever drawn when the artist's identity is confirmed: main refuses a
 * namesake's catalogue (V3 #215, common/artist-identity.ts), so the caller
 * gets nothing to draw rather than a stranger's records.
 */
export interface MoreFromRelease {
  title: string
  year: string
  kind: ReleaseKind
  tracks: { title: string; position: number }[]
}

export interface MoreFromListProps {
  artist: string
  releases: MoreFromRelease[]
  /** The library's copy of a song by its normalized title, if Jake has it. */
  ownedTrack: (title: string) => Track | undefined
  onPlay: (t: Track) => void
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`ad-chev${open ? ' is-open' : ''}`} width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M2.5 1 6 4 2.5 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function MoreFromList({ artist, releases, ownedTrack, onPlay }: MoreFromListProps) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  if (releases.length === 0) return null
  return (
    <div className="ad-more">
      <button type="button" className="ad-more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron open={open} />
        <span className="ad-more-title">More from {artist}</span>
        <span className="ad-more-count">{plural(releases.length, 'release')} not in your library</span>
      </button>
      {open && (
        <div className="ad-more-list">
          {releases.map((r, i) => {
            const showHead = i === 0 || releases[i - 1].kind !== r.kind
            const key = `${r.kind}|${r.title}|${r.year}`
            const isOpen = expanded === key
            const owned = r.tracks.reduce((n, t) => n + (ownedTrack(t.title) ? 1 : 0), 0)
            return (
              <Fragment key={key}>
                {showHead && <div className="ad-row-label ad-more-kind">{RELEASE_KIND_LABEL[r.kind]}</div>}
                <div className={`ad-more-release${isOpen ? ' is-open' : ''}`}>
                  <button type="button" className="ad-more-row" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : key)}
                    title={owned ? `${owned} of ${r.tracks.length} songs are in your library on other releases` : 'Not in your library'}>
                    <Chevron open={isOpen} />
                    <span className="ad-more-name">{r.title}</span>
                    <span className="ad-more-year">{r.year || '—'}</span>
                    <span className="ad-more-songs">{plural(r.tracks.length, 'song')}</span>
                    <span className="ad-more-have">{owned > 0 ? `${owned} you have` : ''}</span>
                  </button>
                  {isOpen && (
                    <ol className="ad-more-tracks">
                      {r.tracks.map((t) => {
                        const have = ownedTrack(t.title)
                        return (
                          <li key={`${t.position}-${t.title}`} className={have ? 'is-owned' : ''}>
                            {have ? (
                              <button type="button" className="ad-more-track" onClick={() => onPlay(have)} title="In your library — click to play">
                                <span className="ad-more-pos">{t.position}</span>
                                <span className="ad-more-dot" aria-hidden="true" />
                                <span className="ad-more-track-title">{t.title}</span>
                              </button>
                            ) : (
                              <span className="ad-more-track" title="Not in your library">
                                <span className="ad-more-pos">{t.position}</span>
                                <span className="ad-more-dot" aria-hidden="true" />
                                <span className="ad-more-track-title">{t.title}</span>
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </div>
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
