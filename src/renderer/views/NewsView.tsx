/**
 * Record Shop › News — New This Week, On the Horizon and Music News. They were
 * the bottom of the Home until V7 (2026-11-24, Jake's approved Home: hero,
 * three shelves, Shows; common/home-layout.ts MOVED_OFF_HOME). Same bands, same
 * sources, same caches (homeCache keys 'news', 'releases', 'upcoming'):
 *
 *   New This Week   Pitchfork's best new albums, ▶ previews a song (iTunes,
 *                   Deezer fallback, in main); a click opens the review
 *   On the Horizon  upcoming releases by your artists (MusicBrainz)
 *   Music News      headlines, 70/30: your top 200 artists first
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../previewPlayer'
import { PlayIcon, PauseIcon } from '../components/TransportIcons'
import { useLibrary } from '../context/LibraryContext'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { getCached, setCached } from '../homeCache'
import ScrollTopButton from '../components/ScrollTopButton'
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

/** "today" / "yesterday" / "2 days ago" / "Apr 14". */
function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const diffH = (Date.now() - d.getTime()) / (1000 * 60 * 60)
  if (diffH < 24) return 'today'
  if (diffH < 48) return 'yesterday'
  if (diffH < 24 * 7) return `${Math.floor(diffH / 24)} days ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function NewsView() {
  const { state: lib } = useLibrary()
  const rootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('record-shop-news', rootRef)
  const newsRowRef = useRef<HTMLDivElement>(null)
  const releasesRowRef = useRef<HTMLDivElement>(null)
  const upcomingRowRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('home-row-news', newsRowRef)
  useScrollPersistence('home-row-releases', releasesRowRef)
  useScrollPersistence('home-row-upcoming', upcomingRowRef)

  // Null = still loading; [] = loaded and empty. Main caches both feeds for an hour.
  const [news, setNews] = useState<MusicNewsItem[] | null>(() => getCached('news') ?? null)
  const [releases, setReleases] = useState<MusicNewsItem[] | null>(() => getCached('releases') ?? null)
  const [upcoming, setUpcoming] = useState<UpcomingRelease[] | null>(() => getCached('upcoming') ?? null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [n, r] = await Promise.all([
          window.electronAPI.getMusicNews(),
          window.electronAPI.getNotableReleases(),
        ])
        if (cancelled) return
        const nv = n.ok ? n.items : []; const rv = r.ok ? r.items : []
        setCached('news', nv); setCached('releases', rv); setNews(nv); setReleases(rv)
      } catch {
        if (cancelled) return
        setCached('news', []); setCached('releases', []); setNews([]); setReleases([])
      }
    })()
    void (async () => {
      try {
        const u = await window.electronAPI.getUpcomingReleasesPersonal()
        if (cancelled) return
        const uv = u.ok ? u.items : []; setCached('upcoming', uv); setUpcoming(uv)
      } catch {
        if (cancelled) return
        setCached('upcoming', []); setUpcoming([])
      }
    })()
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

  // 70/30: headlines naming one of your top 200 artists (by plays) first.
  // Names under 3 characters are skipped (no "Of" matching Of Mice & Men).
  const personalizedNews = useMemo(() => {
    if (!news) return null
    if (news.length === 0) return []
    const byArtist = new Map<string, number>()
    for (const t of lib.tracks) {
      const a = t.albumArtist || t.artist
      if (!a) continue
      const folded = a.toLowerCase().trim()
      if (folded.length < 3) continue
      byArtist.set(folded, (byArtist.get(folded) || 0) + (Number(t.playCount) || 0) + 1)
    }
    const patterns = Array.from(byArtist.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([a]) => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'))
    const relevant: MusicNewsItem[] = []
    const universal: MusicNewsItem[] = []
    for (const item of news) (patterns.some((re) => re.test(item.title)) ? relevant : universal).push(item)
    const total = 10
    const out = [...relevant.slice(0, Math.ceil(total * 0.7))]
    out.push(...universal.slice(0, total - out.length))
    return out
  }, [news, lib.tracks])

  const openLink = useCallback((url: string) => {
    void window.electronAPI.openExternalUrl(url)
  }, [])

  const nothing = releases !== null && releases.length === 0 && upcoming !== null && upcoming.length === 0
    && personalizedNews !== null && personalizedNews.length === 0

  return (
    <>
    <div className="home-view news-view" ref={rootRef}>
      {nothing && <p className="news-view-empty">No news right now. It comes back when the feeds answer.</p>}

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
                  <div className="home-release-meta">{[item.genre, formatDate(item.pubDate)].filter(Boolean).join(' · ')}</div>
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

      {personalizedNews !== null && personalizedNews.length > 0 && (
        <section className="home-section">
          <div className="home-section-header">
            <h2 className="home-section-title">Music News</h2>
            <span className="home-section-source">
              via {Array.from(new Set(personalizedNews.map((n) => n.source))).slice(0, 4).join(', ')}
            </span>
          </div>
          <div className="home-card-row" role="list" ref={newsRowRef}>
            {personalizedNews.map((item) => (
              <div
                key={item.link}
                className="home-news-card"
                role="listitem"
                tabIndex={0}
                onClick={() => openLink(item.link)}
                onKeyDown={activateOnKey(() => openLink(item.link))}
                title={`${item.title}\nOpen in browser`}
              >
                {item.imageUrl && (
                  <div className="home-news-art">
                    <img
                      src={item.imageUrl}
                      alt=""
                      draggable={false}
                      onLoad={(e) => e.currentTarget.classList.add('home-album-art-loaded')}
                      onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }}
                    />
                  </div>
                )}
                <div className="home-news-meta">{item.source} · {formatDate(item.pubDate)}</div>
                <div className="home-news-title">{item.title}</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
    <ScrollTopButton targetRef={rootRef} />
    </>
  )
}
