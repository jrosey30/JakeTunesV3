import React from 'react'

interface AlbumArtImageProps {
  hash: string
  alt: string
  className?: string
  /** Eager + high fetch priority for hero / now-playing covers. */
  priority?: boolean
  onLoad?: React.ReactEventHandler<HTMLImageElement>
  onError?: React.ReactEventHandler<HTMLImageElement>
}

/**
 * Shared album cover <img>. Uses lazy/async decode for grids and
 * eager/high-priority for above-the-fold slots. The album-art:// URL
 * carries a versioned hash so browser + main-process caches stay hot
 * until the cover actually changes.
 */
export default function AlbumArtImage({
  hash,
  alt,
  className,
  priority = false,
  onLoad,
  onError,
}: AlbumArtImageProps) {
  return (
    <img
      key={hash}
      src={`album-art://${hash}.jpg`}
      alt={alt}
      className={className}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={priority ? 'high' : 'auto'}
      draggable={false}
      onLoad={onLoad}
      onError={onError}
    />
  )
}
