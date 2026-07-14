import React, { useCallback, useRef } from 'react'

interface AlbumArtImageProps {
  hash: string
  alt: string
  className?: string
  /** Eager + high fetch priority for hero / now-playing covers. */
  priority?: boolean
  /**
   * Thumbnail tier (2026-07-08): request a downscaled server-side thumb
   * (`?s=NNN`) instead of the full cover. Grids pass ~300 — a ~15KB decode
   * instead of a ~400KB-3MB one, which is what made art "load
   * sporadically". Omit for heroes / Get Info / anywhere full quality
   * matters.
   */
  size?: number
  onLoad?: React.ReactEventHandler<HTMLImageElement>
  onError?: React.ReactEventHandler<HTMLImageElement>
}

/**
 * Shared album cover <img>. Uses lazy/async decode for grids and
 * eager/high-priority for above-the-fold slots. The album-art:// URL
 * carries a versioned hash so browser + main-process caches stay hot
 * until the cover actually changes.
 *
 * Non-priority images fade in on decode instead of popping — cache hits
 * (img.complete at ref time) render instantly with no fade, so scrolling
 * back over loaded art never flickers.
 */
export default function AlbumArtImage({
  hash,
  alt,
  className,
  priority = false,
  size,
  onLoad,
  onError,
}: AlbumArtImageProps) {
  const fadedRef = useRef(false)
  const refCb = useCallback((el: HTMLImageElement | null) => {
    if (!el || priority) return
    if (el.complete && el.naturalWidth > 0) {
      // Cache hit — show immediately, no fade.
      el.style.opacity = '1'
      el.style.transition = ''
      fadedRef.current = true
    } else {
      el.style.opacity = '0'
      fadedRef.current = false
    }
  }, [priority, hash])
  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget
    if (!priority && !fadedRef.current) {
      el.style.transition = 'opacity 200ms ease'
      el.style.opacity = '1'
      fadedRef.current = true
    }
    onLoad?.(e)
  }, [priority, onLoad])
  return (
    <img
      key={`${hash}${size ? `@${size}` : ''}`}
      ref={refCb}
      src={`album-art://${hash}.jpg${size ? `?s=${size}` : ''}`}
      alt={alt}
      className={className}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={priority ? 'high' : 'auto'}
      draggable={false}
      onLoad={handleLoad}
      // A missing/corrupt artwork file must degrade to the parent's clean
      // placeholder background — never the browser's broken-image glyph
      // (spotted live on the Home "Recently Added" row, 2026-07-14).
      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; onError?.(e) }}
    />
  )
}
