// Music News for the Home's one line and the news page (V7, 2026-11-24).
//
// Main fetches the RSS feeds and caches them an hour (getMusicNews); this
// keeps the last answer in homeCache ('news') so a revisit paints at once,
// and orders it 70/30: headlines naming one of your top 200 artists (by
// plays) first, then the rest, ten in all. Names under 3 characters are
// skipped, so "Of" never matches Of Mice & Men.

import { useEffect, useMemo, useState } from 'react'
import { getCached, setCached } from './homeCache'
import type { MusicNewsItem, Track } from './types'

export const NEWS_SHOWN = 10

export function personalizeNews(news: readonly MusicNewsItem[], tracks: readonly Track[]): MusicNewsItem[] {
  if (news.length === 0) return []
  const byArtist = new Map<string, number>()
  for (const t of tracks) {
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
  const out = [...relevant.slice(0, Math.ceil(NEWS_SHOWN * 0.7))]
  out.push(...universal.slice(0, NEWS_SHOWN - out.length))
  return out
}

/** Null while loading; [] when the feeds had nothing. */
export function useMusicNews(tracks: readonly Track[]): MusicNewsItem[] | null {
  const [news, setNews] = useState<MusicNewsItem[] | null>(() => getCached('news') ?? null)
  useEffect(() => {
    let cancelled = false
    window.electronAPI.getMusicNews().then((n) => {
      if (cancelled) return
      const v = n.ok ? n.items : []
      setCached('news', v)
      setNews(v)
    }).catch(() => {
      if (!cancelled) setNews((cur) => cur ?? [])
    })
    return () => { cancelled = true }
  }, [])
  return useMemo(() => (news ? personalizeNews(news, tracks) : null), [news, tracks])
}

/** "today" / "yesterday" / "2 days ago" / "Apr 14". */
export function newsAge(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const diffH = (Date.now() - d.getTime()) / (1000 * 60 * 60)
  if (diffH < 24) return 'today'
  if (diffH < 48) return 'yesterday'
  if (diffH < 24 * 7) return `${Math.floor(diffH / 24)} days ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
