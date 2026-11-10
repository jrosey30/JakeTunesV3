import { useEffect, useReducer, useRef, useState } from 'react'
import { heroPhotoFit } from '../../../common/artist-page'
import { heroLayers, type HeroLayer } from '../../artistPageModel'
import { navDxHero } from '../../navDxDom'

/**
 * The artist page's header picture (2026-11-10).
 *
 * The box is always there, at its own size, in the header's ink — a picture
 * arriving never moves or resizes anything. Pictures stack inside it
 * (artistPageModel.ts heroLayers): a new one loads invisibly above the one
 * showing, is framed from its own proportions (heroPhotoFit) BEFORE it is
 * shown, then fades in while the old one fades out beneath it. Before this
 * the header was one <img> whose src changed up to three times a visit
 * (record cover → artist photo → the profile's credited photo), each a hard
 * swap, with the framing class added a moment after the picture appeared.
 */
export interface HeroPhotoProps {
  src: string | null
  alt: string
  /** Hover title (a credited photo's credit; never printed). */
  title?: string
  /** The act's kind (profile.kind): a person's photo always fills the window. */
  kind?: string
  /** The picture was framed for this header by the profile builder (a credited header photo). */
  framed: boolean
  /** A page you came Back to: its first picture shows at once, no fade. */
  instantFirst: boolean
  onFailed: (src: string) => void
}

/** A picture that loads this soon after the page mounted was already decoded: show it, don't fade it. */
const ALREADY_HERE_MS = 80
/** Longer than the fade (artist-detail.css --ad-fade): a faded-out layer whose transitionend never came is removed anyway. */
const OUT_SWEEP_MS = 500

export default function HeroPhoto({ src, alt, title, kind, framed, instantFirst, onFailed }: HeroPhotoProps) {
  const [layers, dispatch] = useReducer(heroLayers, src, (s): readonly HeroLayer[] => (s ? [{ src: s, phase: 'loading' }] : []))
  const mountedAt = useRef(typeof performance !== 'undefined' ? performance.now() : 0)
  const meta = useRef(new Map<string, { title?: string; framed: boolean }>())
  if (src) meta.current.set(src, { title, framed })

  useEffect(() => { dispatch({ type: 'want', src }); navDxHero(src) }, [src])

  // A layer that has faded out leaves on transitionend; this sweep is for the one whose event never fired.
  const hasOut = layers.some((l) => l.phase === 'out')
  useEffect(() => {
    if (!hasOut) return
    const t = setTimeout(() => { for (const l of layers) if (l.phase === 'out') dispatch({ type: 'gone', src: l.src }) }, OUT_SWEEP_MS)
    return () => clearTimeout(t)
  }, [hasOut, layers])

  // The window's size: it follows the page's width.
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setBox((prev) => (prev && prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight }))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="ad-hero-photo" ref={boxRef}>
      {layers.map((l) => {
        const m = meta.current.get(l.src)
        const heroBox = box ?? (boxRef.current ? { width: boxRef.current.clientWidth, height: boxRef.current.clientHeight } : null)
        const heroNatural = l.natural
        const fit = heroBox && heroNatural ? heroPhotoFit(kind, heroBox, heroNatural, !!m?.framed) : 'cover'
        return (
          <div
            key={l.src}
            className={`ad-hero-layer is-${l.phase}${l.instant ? ' is-instant' : ''}${fit === 'width' ? ' ad-hero-photo--whole' : fit === 'height' ? ' ad-hero-photo--tall' : ''}`}
            onTransitionEnd={(e) => { if (l.phase === 'out' && e.propertyName === 'opacity' && e.target === e.currentTarget) dispatch({ type: 'gone', src: l.src }) }}
          >
            <img
              className="ad-drift"
              src={l.src}
              alt={alt}
              decoding="async"
              title={m?.title}
              draggable={false}
              onLoad={(e) => {
                const im = e.currentTarget
                const first = !layers.some((x) => x.phase !== 'loading')
                const instant = first && (instantFirst || performance.now() - mountedAt.current < ALREADY_HERE_MS)
                dispatch({ type: 'loaded', src: l.src, width: im.naturalWidth, height: im.naturalHeight, instant })
              }}
              onError={() => { dispatch({ type: 'failed', src: l.src }); onFailed(l.src) }}
            />
          </div>
        )
      })}
      <div className="ad-hero-fade-x" />
      <div className="ad-hero-fade-y" />
    </div>
  )
}
