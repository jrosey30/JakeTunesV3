/**
 * CrateFlip — the flip-through-the-bin (2026-08-22, Jake: "make it like a
 * flip through the bin experience for each").
 *
 * One genre crate: the front record faces you full-size with the clerk's
 * pitch beside it; the rest of the bin stacks behind. Click the stack (or
 * arrow keys while the crate is focused) to flip forward — the front
 * sleeve tips away like a record being riffled past. Albums preview with
 * their brain-chosen HOOK track ("one song… that is going to hook me");
 * songs preview themselves, as before.
 */
import React, { useState } from 'react'
import { PlayIcon, PauseIcon, CloseIcon } from './TransportIcons'

export interface CrateCard {
  lane: string
  type: 'song' | 'album' | 'artist'
  artist: string
  title: string
  year?: string
  why: string
  because?: string
  artUrl?: string
  previewUrl?: string
  brainPct?: number
  bin?: string
  hookPreviewUrl?: string
  hookTitle?: string
}

// Display copy for lane stickers (feed lane ids are a wire contract).
export const SHOP_NAMES: Record<string, string> = {
  'brand-new': 'New Arrivals',
  'scene': 'The Scene Rack',
  'missing': 'House Picks',
  'time-machine': 'The Used Bins',
  'songs': 'The Listening Booth',
}

const LANE_STICKERS: Record<string, string> = {
  'brand-new': 'NEW', 'scene': 'SCENE', 'missing': 'GAP', 'time-machine': 'USED', 'songs': 'SINGLE',
}

export function laneReason(c: CrateCard): string | null {
  switch (c.lane) {
    case 'brand-new': return c.year ? `New in ${c.year}` : 'Out now'
    case 'time-machine': return c.year ? `From ${c.year} — an era you play` : 'From an era you play'
    case 'scene': return 'From the scene around your library'
    case 'missing': return 'A gap in a genre you play'
    case 'songs': return 'One song to try, not a whole record'
    default: return null
  }
}

interface Props {
  bin: string
  cards: CrateCard[]
  cardId: (c: CrateCard) => string
  playingId: string | null
  addedIds: Set<string>
  onPreview: (id: string, url: string, title: string, artist: string) => void
  onAdd: (c: CrateCard) => void
  onNope: (c: CrateCard) => void
}

export default function CrateFlip({ bin, cards, cardId, playingId, addedIds, onPreview, onAdd, onNope }: Props) {
  const [idx, setIdx] = useState(0)
  const [flipDir, setFlipDir] = useState<'fwd' | 'back' | null>(null)
  if (cards.length === 0) return null
  const i = ((idx % cards.length) + cards.length) % cards.length
  const c = cards[i]
  const id = cardId(c)
  const isAdded = addedIds.has(id)

  // Preview: hook sample for albums, own preview for songs.
  const sampleUrl = c.type === 'album' ? c.hookPreviewUrl : c.previewUrl
  const sampleLabel = c.type === 'album' && c.hookTitle ? `Sample: ${c.hookTitle}` : 'Preview'
  const isPlaying = playingId === id

  const flip = (dir: 1 | -1): void => {
    setFlipDir(dir === 1 ? 'fwd' : 'back')
    window.setTimeout(() => setFlipDir(null), 240)
    setIdx((v) => v + dir)
  }

  return (
    <section
      className="crate"
      data-bin={bin}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); flip(1) }
        if (e.key === 'ArrowLeft') { e.preventDefault(); flip(-1) }
      }}
    >
      <div className="crate-plate">
        <span className="crate-plate-genre">{bin}</span>
        <span className="crate-plate-count">{i + 1} / {cards.length}</span>
      </div>
      <div className="crate-body">
        <button
          type="button"
          className="crate-stack"
          title="Flip to the next record (→/←)"
          onClick={() => flip(1)}
        >
          {/* The bin behind the front record — up to four sleeves deep. */}
          {cards.slice(0, 5).map((_, d) => {
            const back = cards[(i + 4 - d) % cards.length]
            if (d < 4 && (i + 4 - d) % cards.length === i) return null
            const front = d === 4
            const card = front ? c : back
            return (
              <div
                key={front ? 'front' : `back-${d}`}
                className={`crate-sleeve${front ? ` crate-sleeve--front${flipDir ? ` crate-sleeve--${flipDir}` : ''}` : ''}`}
                style={front ? undefined : { transform: `translateY(${(4 - d) * -7}px) scale(${1 - (4 - d) * 0.045})` }}
              >
                <div className="df-art-ph" aria-hidden="true">♪</div>
                {card.artUrl && <img src={card.artUrl} alt="" loading="lazy" draggable={false} onError={(e) => { e.currentTarget.style.display = 'none' }} />}
                {front && card.brainPct != null && <div className="df-pct" title="Brain match vs your taste">{card.brainPct}%</div>}
                {front && <span className={`crate-sticker crate-sticker--${card.lane}`}>{LANE_STICKERS[card.lane] ?? ''}</span>}
              </div>
            )
          })}
        </button>
        <div className="crate-detail">
          <div className="df-badge-row">
            <span className={`df-type df-type--${c.type}`}>{c.type}</span>
            {c.year && <span className="df-year">{c.year}</span>}
            <span className="crate-lane-tag">{SHOP_NAMES[c.lane] ?? c.lane}</span>
          </div>
          <div className="crate-title" title={c.title}>{c.type === 'artist' ? c.artist : c.title}</div>
          {c.type !== 'artist' && <div className="crate-artist">{c.artist}</div>}
          {c.because
            ? <div className="df-because">Because you play <b>{c.because}</b></div>
            : laneReason(c) ? <div className="df-because df-because--lane">{laneReason(c)}</div> : null}
          {c.why && <div className="df-why crate-why">{c.why}</div>}
          <div className="crate-actions">
            {sampleUrl && (
              <button
                type="button"
                className={`crate-sample${isPlaying ? ' crate-sample--on' : ''}`}
                onClick={() => onPreview(id, sampleUrl, c.type === 'album' && c.hookTitle ? `${c.title} · ${c.hookTitle}` : c.title, c.artist)}
                title={isPlaying ? 'Stop' : sampleLabel}
              >
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
                <span>{isPlaying ? 'Stop' : sampleLabel}</span>
              </button>
            )}
            <button type="button" className={`df-add${isAdded ? ' df-add--done' : ''}`} disabled={isAdded} onClick={() => onAdd(c)}>
              {isAdded ? 'On your list ✓' : '+ List'}
            </button>
            <button type="button" className="crate-nope" title={`Never show ${c.artist} again`} aria-label="Not for me" onClick={() => onNope(c)}>
              <CloseIcon />
            </button>
          </div>
          <div className="crate-flip-hint">
            <button type="button" className="crate-arrow" onClick={() => flip(-1)} aria-label="Previous record">‹</button>
            <span>flip the bin</span>
            <button type="button" className="crate-arrow" onClick={() => flip(1)} aria-label="Next record">›</button>
          </div>
        </div>
      </div>
    </section>
  )
}
