/**
 * The Island Albums front cover's CD jewel case (Jake, 2026-10-21: "was
 * hoping the cd animation would be for all devices involved here not just
 * phone"). Drawn INSIDE the front cover's button, around its art: the art
 * keeps its exact place (the booklet under the lid IS the cover) and the
 * case's plastic grows out around it — the ribbed hinge strip on the LEFT,
 * the clear rims on the other three sides.
 *
 * The plastic is a photograph of a real case (Jake 2026-10-30: "im serious
 * when i say make it look real"), the same layers as the album page's case —
 * assets/jewel-case/, proportions in common/jewel-case-photo.ts: the lid's
 * front face is the art under the photo's frame (window cut out) under the
 * lid's optics; the base under the lid is the same frame; the tray is the
 * photo's black tray. The disc is still drawn (no photograph of one).
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/LaunchPageG.swift — `CaseLid`
 * (the lid, its own camera, inside face, shading, lid shadow) and
 * `FlowCaseTray` (tray, rosette hub, the pressed disc). The motion, the
 * camera, the disc and the tabs are the phone's numbers in
 * common/jewel-case.ts × 240/160; the case's box is the photo's.
 *
 * Modes:
 *   rest       the closed case (plastic only shows on the front cover)
 *   arrive     a cover stepping to the front: the plastic fades in over the
 *              end of the move
 *   leave      the old front cover stepping aside: its plastic fades out
 *   open       latch pop → spring swing to 108° → the disc lifts; `onDiscUp`
 *              at +390 ms (the album page comes out of the disc)
 *   held-open  back on Home, open with the disc up, while the album page
 *              shrinks into the disc (discHandoff.ts)
 *   close      the disc drops onto the hub, the lid snaps shut; `onShut`
 *
 * Every moving part is a Web Animation on transform / opacity sampled from
 * common/jewel-case.ts — the compositor runs them; no per-frame JS, no
 * layout. The tray, the disc and the inside of the lid exist only while the
 * case runs.
 */
import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import AlbumArtImage from './AlbumArtImage'
import {
  JEWEL_CASE, JEWEL_CASE_MOTION, EASE_IN, EASE_OUT,
  cssLidAngle, lidClosingFrames, lidOpenLook, lidOpeningFrames,
  type LidFrame,
} from '../../common/jewel-case'
import { photoCaseGeometry } from '../../common/jewel-case-photo'

export type JewelCaseMode = 'rest' | 'arrive' | 'leave' | 'open' | 'held-open' | 'close'

interface Props {
  hash?: string
  /** The front cover's side, px (the flow's centre size). */
  artPx: number
  mode: JewelCaseMode
  /** The front cover's reflection: it fades as the lid lifts (a shut cover's reflection under an open case was a tell). */
  reflection?: () => HTMLElement | null
  /** open: the disc is up — time for the album page. */
  onDiscUp?: () => void
  /** close: the lid has seated. */
  onShut?: () => void
}

const OPEN_FRAMES_MS = 520
const bezier = (b: readonly number[]): string => `cubic-bezier(${b.join(', ')})`
/** The gloss streak shows as the lid lifts (a shut lid is the photo's own sheen). */
const glossOpacity = (f: LidFrame): number => Math.min(1, Math.max(0, f.deg / 15))

export default function JewelCase({ hash, artPx, mode, reflection, onDiscUp, onShut }: Props): JSX.Element {
  const g = photoCaseGeometry(artPx)
  const k = g.scale
  const running = mode === 'open' || mode === 'held-open' || mode === 'close'

  const lidRef = useRef<HTMLSpanElement>(null)
  const frontShadeRef = useRef<HTMLSpanElement>(null)
  const insideShadeRef = useRef<HTMLSpanElement>(null)
  const glossRef = useRef<HTMLSpanElement>(null)
  const shadowRef = useRef<HTMLSpanElement>(null)
  const discRef = useRef<HTMLSpanElement>(null)
  const discRestShadowRef = useRef<HTMLSpanElement>(null)
  const discLiftShadowRef = useRef<HTMLSpanElement>(null)
  const onDiscUpRef = useRef(onDiscUp)
  onDiscUpRef.current = onDiscUp
  const onShutRef = useRef(onShut)
  onShutRef.current = onShut
  const reflectionRef = useRef(reflection)
  reflectionRef.current = reflection

  // The gloss streak's peak slides along the diagonal: move the band by the
  // same fraction of the case's width and height.
  const glossShift = (f: LidFrame): string => {
    const d = f.glossAt - 0.3
    return `translate3d(${(d * g.width).toFixed(2)}px, ${(d * g.height).toFixed(2)}px, 0)`
  }
  const lifted = `translate3d(0, ${JEWEL_CASE_MOTION.liftDy * k}px, 0) scale(${JEWEL_CASE_MOTION.liftScale})`

  useLayoutEffect(() => {
    if (mode !== 'open' && mode !== 'close') return
    const anims: Animation[] = []
    const timers: number[] = []
    const play = (el: Element | null | undefined, keyframes: Keyframe[], opts: KeyframeAnimationOptions): void => {
      if (el) anims.push(el.animate(keyframes, opts))
    }
    const lidTrack = (frames: LidFrame[], duration: number, delay: number): void => {
      const at = (f: LidFrame): number => f.t / duration
      const opts: KeyframeAnimationOptions = { duration, delay, fill: 'both', easing: 'linear' }
      play(lidRef.current, frames.map((f) => ({ offset: at(f), transform: `rotateY(${cssLidAngle(f.deg)}deg)` })), opts)
      play(frontShadeRef.current, frames.map((f) => ({ offset: at(f), opacity: f.frontShade })), opts)
      play(insideShadeRef.current, frames.map((f) => ({ offset: at(f), opacity: f.insideShade })), opts)
      play(glossRef.current, frames.map((f) => ({ offset: at(f), transform: glossShift(f), opacity: glossOpacity(f) })), opts)
      play(shadowRef.current, frames.map((f) => ({ offset: at(f), transform: `scaleX(${f.shadowWidth.toFixed(4)})`, opacity: f.shadowOpacity })), opts)
      play(reflectionRef.current?.(), frames.map((f) => ({ offset: at(f), opacity: f.reflection })), opts)
    }
    const m = JEWEL_CASE_MOTION
    if (mode === 'open') {
      // Latch pop → the spring takes over mid-pop → settles on the hinge stop.
      lidTrack(lidOpeningFrames(10, OPEN_FRAMES_MS), OPEN_FRAMES_MS, 0)
      // The disc lifts off the hub toward you.
      const lift: KeyframeAnimationOptions = { delay: m.liftStartMs, duration: m.liftMs, easing: bezier(EASE_OUT), fill: 'both' }
      play(discRef.current, [{ transform: 'translate3d(0, 0, 0) scale(1)' }, { transform: lifted }], lift)
      play(discRestShadowRef.current, [{ opacity: 1 }, { opacity: 0 }], lift)
      play(discLiftShadowRef.current, [{ opacity: 0, transform: 'translate3d(0, 0, 0) scale(1)' }, { opacity: 1, transform: lifted }], lift)
      timers.push(window.setTimeout(() => onDiscUpRef.current?.(), m.navigateAtMs))
    } else {
      // Back: the disc drops onto the hub (easeIn) …
      const dropAt = 0
      const snapAt = m.snapAtMs - m.dropAtMs
      const drop: KeyframeAnimationOptions = { delay: dropAt, duration: m.dropMs, easing: bezier(EASE_IN), fill: 'both' }
      play(discRef.current, [{ transform: lifted }, { transform: 'translate3d(0, 0, 0) scale(1)' }], drop)
      play(discRestShadowRef.current, [{ opacity: 0 }, { opacity: 1 }], drop)
      play(discLiftShadowRef.current, [{ opacity: 1, transform: lifted }, { opacity: 0, transform: 'translate3d(0, 0, 0) scale(1)' }], drop)
      // … and the lid swings shut, accelerating, stopping dead.
      lidTrack(lidClosingFrames(10), m.snapMs, snapAt)
      timers.push(window.setTimeout(() => onShutRef.current?.(), snapAt + m.snapMs))
    }
    return () => {
      for (const t of timers) window.clearTimeout(t)
      for (const a of anims) a.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // held-open: the settled open pose, static (the reverse starts here).
  const held = mode === 'held-open' ? lidOpenLook() : null
  const vars = {
    '--jc-w': `${g.width}px`,
    '--jc-h': `${g.height}px`,
    '--jc-spine': `${g.spine}px`,
    '--jc-rim': `${g.rim}px`,
    '--jc-r': `${g.radius}px`,
    '--jc-k': String(k),
    '--jc-art': `${g.art}px`,
    '--jc-disc': `${g.disc}px`,
    '--jc-cam': `${g.camera}px`,
    '--jc-cam-x': `${g.cameraX}px`,
    '--jc-cam-y': `${g.cameraY}px`,
  } as CSSProperties
  const tabs = JEWEL_CASE.tab.at.map((f) => (
    <span key={f} className="tn-case-tab" style={{ top: `${g.height * f - (JEWEL_CASE.tab.h / 2) * k}px` }} />
  ))

  return (
    <span className={`tn-case tn-case--${mode}`} style={vars} aria-hidden="true">
      {running && (
        <span className="tn-case-tray">
          <span ref={discRestShadowRef} className="tn-case-disc-shadow" style={held ? { opacity: 0 } : undefined} />
          <span ref={discLiftShadowRef} className="tn-case-disc-shadow tn-case-disc-shadow--lifted" style={held ? { opacity: 1, transform: lifted } : undefined} />
          <span ref={discRef} className="tn-case-disc" style={held ? { transform: lifted } : undefined}>
            <span className="tn-case-disc-data" />
            <span className="tn-case-disc-spokes" />
            {hash
              ? <AlbumArtImage hash={hash} alt="" size={480} priority className="tn-case-disc-label" />
              : <span className="tn-case-disc-label tn-case-disc-label--plain" />}
            <span className="tn-case-disc-mirror" />
            <span className="tn-case-disc-clear" />
            <span className="tn-case-disc-hole" />
            <span className="tn-case-disc-rim" />
          </span>
        </span>
      )}
      <span className="tn-case-base tn-case-plastic">
        <span className="tn-case-knuckle" style={{ top: `${JEWEL_CASE.knuckle.top * k}px` }} />
        <span className="tn-case-knuckle" style={{ top: `${g.height - JEWEL_CASE.knuckle.bottomFromEnd * k}px` }} />
      </span>
      {running && (
        <span
          ref={shadowRef}
          className="tn-case-shadow"
          style={held ? { transform: `scaleX(${held.shadowWidth})`, opacity: held.shadowOpacity } : undefined}
        />
      )}
      <span ref={lidRef} className="tn-case-lid" style={held ? { transform: `rotateY(${cssLidAngle(held.deg)}deg)` } : undefined}>
        <span className="tn-case-face tn-case-face--front">
          {hash
            ? <AlbumArtImage hash={hash} alt="" size={480} priority className="tn-case-art" />
            : <span className="tn-case-art tn-flow-ph" />}
          <span className="tn-case-frame tn-case-plastic" />
          <span className="tn-case-glass tn-case-plastic" />
          <span ref={glossRef} className="tn-case-gloss tn-case-plastic" style={held ? { transform: glossShift(held), opacity: glossOpacity(held) } : undefined} />
          <span ref={frontShadeRef} className="tn-case-shade" style={held ? { opacity: held.frontShade } : undefined} />
        </span>
        {running && (
          <span className="tn-case-face tn-case-face--inside">
            <span className="tn-case-plate tn-case-plate--inside" />
            <span className="tn-case-ribs tn-case-ribs--inside" />
            <span className="tn-case-paper" />
            {tabs}
            <span className="tn-case-edge" />
            <span ref={insideShadeRef} className="tn-case-shade" style={held ? { opacity: held.insideShade } : undefined} />
          </span>
        )}
      </span>
    </span>
  )
}
