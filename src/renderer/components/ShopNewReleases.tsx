/**
 * The Record Shop's For You tab, its top section (V7, 2026-11-24): New This
 * Week and On the Horizon. They were the bottom of the Home until V7 (Jake's
 * approved plan; common/home-layout.ts MOVED_OFF_HOME). Same bands, same
 * sources, same caches (homeCache 'releases', 'upcoming'):
 *
 *   New This Week   Pitchfork's best new albums, ▶ previews a song (iTunes,
 *                   Deezer fallback, in main); a click opens the review
 *   On the Horizon  upcoming releases by your artists (MusicBrainz)
 *
 * Drawn with the Home's card styles (home.css), inside the shop's own padding.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../previewPlayer'
import { PlayIcon, PauseIcon } from './TransportIcons'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getCached, setCached } from '../homeCache'
import { newsAge } from '../musicNews'
import type { MusicNewsItem, UpcomingRelease } from '../types'
import '../styles/home.css'

/** Enter/Space on role=button cards — mouse click already works. */
function activateOnKey(action: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      action()
    }
  }
}

/** A partial MusicBrainz release date as friendly future tense ("Sep 15", "September 2026", "2027"). */
function formatUpcomingDate(raw: string): string {
  if (!raw) return 'TBA'
  if (raw.length === 4) return raw
  if (raw.length === 7) {
    const [y, m] = raw.split('-')
    const d = new Date(Number(y), Number(m) - 1, 1)
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  }
  // A full date is a calendar day, not an instant: new Date('2026-12-04') is UTC
  // midnight, which reads as Dec 3 in New York (2026-11-17, Getdown Services).
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  const d = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(raw)
  if (isNaN(d.getTime())) return raw
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function ShopNewReleases(): JSX.Element | null {
  const releasesRowRef = useRef<HTMLDivElement>(null)
  const upcomingRowRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('home-row-releases', releasesRowRef)
  useScrollPersistence('home-row-upcoming', upcomingRowRef)

  // Null = still loading; [] = loaded and empty. Main caches both for an hour.
  const [releases, setReleases] = useState<MusicNewsItem[] | null>(() => getCached('releases') ?? null)
  const [upcoming, setUpcoming] = useState<UpcomingRelease[] | null>(() => getCached('upcoming') ?? null)
  useEffect(() => {
    let cancelled = false
    window.electronAPI.getNotableReleases().then((r) => {
      if (cancelled) return
      const v = r.ok ? r.items : []; setCached('releases', v); setReleases(v)
    }).catch(() => { if (!cancelled) setReleases((cur) => cur ?? []) })
    window.electronAPI.getUpcomingReleasesPersonal().then((u) => {
      if (cancelled) return
      const v = u.ok ? u.items : []; setCached('upcoming', v); setUpcoming(v)
    }).catch(() => { if (!cancelled) setUpcoming((cur) => cur ?? []) })
    return () => { cancelled = true }
  }, [])

  // A 30s preview per New This Week album, looked up on the first ▶ (Jake,
  // 2026-08-07). link → url; null = looked up, nothing there (the button stays,
  // muted, with an honest tooltip).
  const [releasePreviews, setReleasePreviews] = useState<Map<string, string | null>>(() => new Map())
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const previewRelease = async (e: React.MouseEvent, item: MusicNewsItem): Promise<void> => {
    e.stopPropagation()   // the card itself opens the review link
    const known = releasePreviews.get(item.link)
    if (known) { togglePreview(item.link, known, item.title, item.artist || ''); return }
    if (known === null) return
    const r = await window.electronAPI.lookupAlbumPreview?.({ artist: item.artist || '', album: item.title })
    const url = r?.previewUrl || null
    setReleasePreviews((m) => new Map(m).set(item.link, url))
    if (url) togglePreview(item.link, url, item.title, item.artist || '')
  }

  const openLink = useCallback((url: string) => {
    void window.electronAPI.openExternalUrl(url)
  }, [])

  if (!releases?.length && !upcoming?.length) return null
  return (
    <div className="shop-new-releases">
      {releases !== null && releases.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">New This Week</h2>
            <span className="home-section-source">via Pitchfork</span>
          </div>
          <div className="home-card-row" role="list" ref={releasesRowRef}>
            {releases.map((item) => (
              <div
                key={item.link}
                className="home-release-card"
                role="listitem"
                tabIndex={0}
                onClick={() => openLink(item.link)}
                onKeyDown={activateOnKey(() => openLink(item.link))}
                title={`${item.title}\nOpen review in browser`}
              >
                <div className="home-release-art">
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.title}
                      draggable={false}
                      onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                    />
                  ) : (
                    <div className="home-album-art-placeholder">
                      <svg width="32" height="32" viewBox="0 0 40 40" fill="none" stroke="#999" strokeWidth="1.5">
                        <circle cx="20" cy="20" r="18" />
                        <circle cx="20" cy="20" r="6" />
                        <circle cx="20" cy="20" r="2" fill="#999" />
                      </svg>
                    </div>
                  )}
                  {item.artist && (
                    <button
                      type="button"
                      className={`home-release-play${preview.playingId === item.link ? ' home-release-play--on' : ''}${releasePreviews.get(item.link) === null ? ' home-release-play--none' : ''}`}
                      title={releasePreviews.get(item.link) === null ? 'No preview available for this album' : preview.playingId === item.link ? 'Stop' : 'Preview a song from this album'}
                      onClick={(e) => void previewRelease(e, item)}
                    >
                      {preview.playingId === item.link ? <PauseIcon /> : <PlayIcon />}
                    </button>
                  )}
                </div>
                <div className="home-album-info">
                  <div className="home-album-title">{item.title}</div>
                  {item.artist && <div className="home-album-artist">{item.artist}</div>}
                  <div className="home-release-meta">{[item.genre, newsAge(item.pubDate)].filter(Boolean).join(' · ')}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {upcoming !== null && upcoming.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">On the Horizon</h2>
            <span className="home-section-source">via MusicBrainz</span>
          </div>
          <div className="home-card-row" role="list" ref={upcomingRowRef}>
            {upcoming.map((item, i) => (
              <div
                key={`${item.mbid}-${i}`}
                className="home-upcoming-card"
                role="listitem"
                tabIndex={0}
                onClick={() => openLink(`https://musicbrainz.org/release-group/${item.mbid}`)}
                onKeyDown={activateOnKey(() => openLink(`https://musicbrainz.org/release-group/${item.mbid}`))}
                title={`${item.title} — ${item.artist}\nReleases ${formatUpcomingDate(item.releaseDate)}\nOpen on MusicBrainz`}
              >
                <div className="home-upcoming-art">
                  <img
                    src={item.coverUrl}
                    alt={item.title}
                    draggable={false}
                    onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                  <div className="home-upcoming-art-fallback" aria-hidden="true">
                    {item.title.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="home-upcoming-date-badge">
                    {formatUpcomingDate(item.releaseDate)}
                  </div>
                </div>
                <div className="home-album-info">
                  <div className="home-album-title">{item.title}</div>
                  <div className="home-album-artist">{item.artist}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

    </div>
  )
}
