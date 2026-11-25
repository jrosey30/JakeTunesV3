/**
 * The shared card (V7, 2026-11-24): click OPENS, the ▶ that appears on hover
 * PLAYS, right-click is the menu for its kind, and it drags its songs onto Up
 * Next or a playlist. Every card, tile and row outside the song table is built
 * on this, so the rule (common/card-rules.ts) lives in one place.
 *
 * The card keeps each page's own look: the caller passes its own class names
 * for the card and for the art box, and its own art and words. Card only adds
 * the behaviour and the hover ▶ (placed inside the art box).
 *
 * There is deliberately no double-click handler: the first click already opened the
 * card, so a double-click would play something on a page the user just left.
 */
import type { CSSProperties, ReactNode } from 'react'
import PlayButton from './PlayButton'
import { cardAction, canDrag, type CardKind } from '../../common/card-rules'
import { setAlbumDragPayload } from '../utils/trackDrag'
import '../styles/card.css'

export interface CardProps {
  kind: CardKind
  /** The card's name ("Abbey Road"), for the ▶'s tooltip. */
  name: string
  /** Click / Enter / Space. */
  onOpen: () => void
  /** The hover ▶. Omitted: no ▶ (nothing to play). */
  onPlay?: () => void
  /** Right-click: open this card's menu at the event. */
  onMenu?: (e: React.MouseEvent) => void
  /** The songs a drag carries, in order (asked at drag time). */
  dragIds?: () => number[]
  /** The page's own classes for the card and its art box. */
  className: string
  artClassName: string
  artStyle?: CSSProperties
  art: ReactNode
  /** Under the art: the page's own name / artist / note lines. */
  children?: ReactNode
  title?: string
  playTitle?: string
  role?: 'button' | 'listitem'
  /** Extra data-* the page keys on (data-album-key, …). */
  data?: Record<string, string>
  ariaLabel?: string
  extraClassName?: string
  onPointerEnter?: () => void
  /** The card's element (a page that observes its cards for photos, …). */
  innerRef?: (el: HTMLDivElement | null) => void
}

export default function Card(p: CardProps): JSX.Element {
  const act = (a: ReturnType<typeof cardAction>): void => {
    if (a === 'open') p.onOpen()
  }
  const draggable = canDrag(p.kind) && !!p.dragIds
  const dataAttrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(p.data ?? {})) dataAttrs[`data-${k}`] = v
  return (
    <div
      ref={p.innerRef}
      className={`jt-card ${p.className}${p.extraClassName ? ` ${p.extraClassName}` : ''}`}
      data-card-kind={p.kind}
      {...dataAttrs}
      role={p.role ?? 'button'}
      tabIndex={0}
      title={p.title}
      aria-label={p.ariaLabel}
      onClick={() => act(cardAction('click'))}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter') { e.preventDefault(); act(cardAction('enter')) }
        else if (e.key === ' ') { e.preventDefault(); act(cardAction('space')) }
      }}
      onContextMenu={p.onMenu ? (e) => { e.preventDefault(); e.stopPropagation(); p.onMenu!(e) } : undefined}
      draggable={draggable || undefined}
      onDragStart={draggable ? (e) => {
        const ids = p.dragIds!()
        if (ids.length) setAlbumDragPayload(e, ids)
        else e.preventDefault()
      } : undefined}
      onPointerEnter={p.onPointerEnter}
    >
      <div className={`jt-card-art ${p.artClassName}`} style={p.artStyle}>
        {p.art}
        {p.onPlay && <PlayButton variant="overlay" className="jt-card-play" name={p.name} title={p.playTitle} onPlay={p.onPlay} />}
      </div>
      {p.children}
    </div>
  )
}
