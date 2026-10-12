/**
 * One picture for a Year in Review fact: a song's or album's cover from the
 * artwork store, an artist's confirmed photo (artist-photo.ts; initials when
 * there is none, never album art in a circle), or a concert's poster.
 */
import { useEffect, useState } from 'react'
import { lookupArtwork } from '../../utils/artworkLookup'
import { findSong } from './yirData'
import type { StoryImage, StoryConcert } from '../../../common/yir-story'
import type { Track } from '../../types'

export interface YirCtx {
  tracks: Track[]
  artworkMap: Record<string, string>
  artIndex: Map<string, string>
  concerts: StoryConcert[]
}

const photoSlugs = new Map<string, string | null>()

function coverHash(image: StoryImage, ctx: YirCtx): string | undefined {
  const look = (artist: string, album: string): string | undefined => lookupArtwork(ctx.artworkMap, ctx.artIndex, artist, album) || undefined
  if (image.kind === 'song') {
    const t = findSong(ctx.tracks, image.artist, image.title)
    return t ? look(t.albumArtist || t.artist || '', t.album || '') ?? look(t.artist || '', t.album || '') : undefined
  }
  if (image.kind === 'album') return look(image.artist, image.album)
  if (image.kind === 'concert') return ctx.concerts.find((c) => c.albumKey === image.albumKey)?.poster || look(image.band, image.show)
  return undefined
}

/** The image URL for a fact, or null while unknown / when there is none. */
export function useYirImage(image: StoryImage | undefined, ctx: YirCtx, size = 600): string | null {
  const name = image?.kind === 'artist' ? image.name : ''
  const [slug, setSlug] = useState<string | null>(name ? photoSlugs.get(name) ?? null : null)
  useEffect(() => {
    if (!name || photoSlugs.has(name)) { setSlug(name ? photoSlugs.get(name) ?? null : null); return }
    let live = true
    window.electronAPI.getArtistImage(name).then((r) => (r.ok ? r.slug : null)).catch(() => null).then((s) => {
      photoSlugs.set(name, s)
      if (live) setSlug(s)
    })
    return () => { live = false }
  }, [name])
  if (!image) return null
  if (image.kind === 'artist') return slug ? `artist-image://${slug}.jpg` : null
  const hash = coverHash(image, ctx)
  return hash ? `album-art://${hash}.jpg?s=${size}` : null
}

const initials = (name: string): string => name.replace(/^the\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase()

export default function YirImg({ image, ctx, className, size }: { image: StoryImage; ctx: YirCtx; className?: string; size?: number }): JSX.Element {
  const src = useYirImage(image, ctx, size)
  if (src) return <img className={className} src={src} alt="" draggable={false} decoding="async" />
  return (
    <span className={`${className ?? ''} yir-img-empty`} aria-hidden="true">
      {image.kind === 'artist' ? initials(image.name) : ''}
    </span>
  )
}
