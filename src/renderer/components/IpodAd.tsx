// The ad at the top of an iPod's page (2026-11-14, common/ipod-ad.ts). Jake
// approved the second mock; his word on the first was "too quirky and
// cartoony". So: a white field, one iPod, one headline, one line of copy, one
// small grey line. No props, tilts, glows, badges or emoji, and nothing moves.
//
// Everything is placed by CSS from fixed numbers (styles/ipod-ad.css): the
// field is 340px tall whatever is in it, the headline's size comes from its
// length (common/ipod-ad.ts headlineSizePx), and the iPod's box is the same
// for a drawing and a photo. So the page under it never moves when data arrives.
//
// Under the field, Jake's story for the iPod when it has one (2026-11-24,
// homemini's `story`; common/ipod-ad.ts storyParagraphs): the ad's serif at a
// reading size, in a column no wider than reads comfortably. It is part of
// the same scroller, so it scrolls away with the ad. None: nothing at all.
import { memo, useEffect, useState } from 'react'
import { headlineLines, headlineSizePx, HEADLINE_FULL_PX, storyParagraphs } from '../../common/ipod-ad'
import type { IpodLook } from '../../common/ipod-covers'
import { IpodDrawing } from './IpodDrawing'
import top1000Photo from '../assets/playlist-covers/top-1000-photo.jpg'
import top1000Cutout from '../assets/playlist-covers/top-1000-photo-cutout.webp'
import '../styles/ipod-ad.css'

export interface IpodAdProps {
  /** The list's name: the drawn screen's title bar and the picture's label. */
  name: string
  headline: string
  copy: string
  legal: string
  /** null = not known yet: the iPod's place stays empty (and the same size). */
  look: IpodLook | null
  /** A photo Jake gave this iPod (ipodPhotoCovers.ts); null = the drawing. */
  photo: string | null
  /** Black field, white type, no floor shadow. The app has no dark theme yet; this is ready for it. */
  dark?: boolean
  /** Jake's story for this iPod (paragraphs by a blank line); null or absent = nothing under the ad. */
  story?: string | null
}

// ── The Original's photo, cut out ────────────────────────────────────────
// The mock Jake approved shows his own photo of the Original cut out of its
// background, on nothing. That cut-out ships with the app. It stands in for
// the photo only while the photo IS that one: the copy bundled with the app,
// or a kept copy that looks the same. Any other photo is shown as it is.

const judged = new Map<string, boolean>()

function thumb(src: string): Promise<Uint8ClampedArray | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = 16
        c.height = 16
        const g = c.getContext('2d')
        if (!g) { resolve(null); return }
        g.drawImage(img, 0, 0, 16, 16)
        resolve(g.getImageData(0, 0, 16, 16).data)
      } catch {
        // A picture the canvas may not read back: it is shown as it is.
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** The mean difference per channel of two 16x16 thumbnails, 0 to 255. */
export function thumbDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 255
  let sum = 0
  let count = 0
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue
    sum += Math.abs(a[i] - b[i])
    count++
  }
  return sum / count
}

/** true = show the cut-out; false = show the photo itself; null = not known yet (nothing is drawn for those few frames). */
function useIsOriginalPhoto(photo: string | null): boolean | null {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!photo || photo === top1000Photo || judged.has(photo)) return
    let live = true
    void Promise.all([thumb(photo), thumb(top1000Photo)]).then(([a, b]) => {
      judged.set(photo, !!a && !!b && thumbDistance(a, b) < 12)
      if (live) bump((v) => v + 1)
    })
    return () => { live = false }
  }, [photo])
  if (!photo) return false
  if (photo === top1000Photo) return true
  return judged.get(photo) ?? null
}

/** The story under the ad: one paragraph element each. */
export function IpodAdStory({ story, dark }: { story: string | null | undefined; dark?: boolean }) {
  const paragraphs = storyParagraphs(story)
  if (!paragraphs.length) return null
  return (
    <section className={`ipod-ad-story${dark ? ' ipod-ad-story--dark' : ''}`} aria-label="The story">
      <div className="ipod-ad-story-text">
        {paragraphs.map((p, i) => <p key={i} className="ipod-ad-story-p">{p}</p>)}
      </div>
    </section>
  )
}

function IpodAdInner({ name, headline, copy, legal, look, photo, dark, story }: IpodAdProps) {
  const lines = headlineLines(headline)
  const scale = headlineSizePx(lines) / HEADLINE_FULL_PX
  const original = useIsOriginalPhoto(photo)
  return (
    <>
    <section className={`ipod-ad${dark ? ' ipod-ad--dark' : ''}${photo ? ' ipod-ad--photo' : ''}`} aria-label={`${name}: ${headline}`}>
      <div className="ipod-ad-text">
        <h1 className="ipod-ad-headline" style={{ ['--ipod-ad-hl' as string]: scale }}>
          {lines.map((l, i) => <span key={i} className="ipod-ad-headline-line">{l}</span>)}
        </h1>
        <p className="ipod-ad-copy">{copy}</p>
      </div>
      <div className="ipod-ad-pod">
        {!photo
          ? look && <IpodDrawing model={look.model} color={look.color} name={name} />
          : original === null ? null
            : original
              ? <img className="ipod-ad-photo" src={top1000Cutout} alt={`${name} iPod`} draggable={false} />
              : <img className="ipod-ad-photo ipod-ad-photo--whole" src={photo} alt={`${name} iPod`} draggable={false} />}
      </div>
      <p className="ipod-ad-legal">{legal}</p>
    </section>
    <IpodAdStory story={story} dark={dark} />
    </>
  )
}

export const IpodAd = memo(IpodAdInner)
