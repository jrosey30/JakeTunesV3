/**
 * Music News — the full list (V7, 2026-11-24). The Home shows one headline
 * under Shows (the phone's Tonight news line); its See All opens this page
 * (view 'music-news'). Your artists first, then the rest (renderer/musicNews.ts).
 */
import { useCallback, useRef } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import ScrollTopButton from '../components/ScrollTopButton'
import { useMusicNews, newsAge } from '../musicNews'
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

export default function NewsView() {
  const { state: lib } = useLibrary()
  const rootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('music-news', rootRef)
  const personalizedNews = useMusicNews(lib.tracks)
  const openLink = useCallback((url: string) => {
    void window.electronAPI.openExternalUrl(url)
  }, [])

  return (
    <>
    <div className="home-view news-view" ref={rootRef}>
      <h1 className="news-view-title">Music News</h1>
      {personalizedNews !== null && personalizedNews.length === 0 && <p className="news-view-empty">No news right now.</p>}
      {personalizedNews !== null && personalizedNews.length > 0 && (
        <section className="home-section" aria-label="Music News">
          <div className="home-section-header">
            <span className="home-section-source">
              via {Array.from(new Set(personalizedNews.map((n) => n.source))).slice(0, 4).join(', ')}
            </span>
          </div>
          <div className="news-list" role="list">
            {personalizedNews.map((item) => (
              <div
                key={item.link}
                className="home-news-card news-list-item"
                role="listitem"
                tabIndex={0}
                onClick={() => openLink(item.link)}
                onKeyDown={activateOnKey(() => openLink(item.link))}
                title={item.title}
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
                <div className="home-news-meta">{item.source} · {newsAge(item.pubDate)}</div>
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
