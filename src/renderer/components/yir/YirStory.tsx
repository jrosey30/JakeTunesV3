/**
 * The Year in Review story (2026-10-12): one portrait card at a time, the
 * December 17 reveal. Cards come from src/common/yir-story.ts; a card that
 * names a song or a record plays it through the regular player, so the
 * music stays when the story closes. ← / → step, Esc closes; the keys are
 * claimed here so App.tsx's transport doesn't also skip the song.
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirStoryView.swift (taps for clicks, swipes for the keys).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAudio } from '../../hooks/useAudio'
import YirImg, { useYirImage, type YirCtx } from './YirImg'
import { findSong, albumSongs } from './yirData'
import type { Slide, StoryPlay } from '../../../common/yir-story'
import type { Track } from '../../types'

const LAYERS = ['The tip', 'Just below', 'Below', 'Deep water', 'Abyss']

function resolvePlay(p: StoryPlay | undefined, tracks: Track[]): { queue: Track[]; label: string } | null {
  if (!p) return null
  if (p.kind === 'song') {
    const t = findSong(tracks, p.artist, p.title)
    return t ? { queue: [t], label: `${t.title} — ${t.artist}` } : null
  }
  const songs = albumSongs(tracks, p.artist, p.album)
  return songs.length ? { queue: songs, label: `${p.album} — ${p.artist}` } : null
}

function Backdrop({ slide, ctx }: { slide: Slide; ctx: YirCtx }): JSX.Element | null {
  const image = slide.kind === 'art' ? slide.image : slide.kind === 'lanes' ? slide.rows[0]?.image : undefined
  const src = useYirImage(image, ctx, 320)
  return src ? <div className="yir-bg" style={{ backgroundImage: `url("${src}")` }} aria-hidden="true" /> : null
}

function Lanes({ rows, ctx }: { rows: Extract<Slide, { kind: 'lanes' }>['rows']; ctx: YirCtx }): JSX.Element {
  const max = Math.max(1, ...rows.map((r) => r.plays))
  return (
    <div className="yir-lanes">
      {rows.map((r, k) => (
        <div key={r.name} className={`yir-lane${k === 0 ? ' yir-lane--lead' : ''}`}>
          <YirImg image={r.image} ctx={ctx} className="yir-lane-img" size={320} />
          <div>
            <b>{r.name}</b>
            <div className="yir-track"><i style={{ width: `${(r.plays / max) * 100}%` }} /></div>
            <small>{r.sub}</small>
          </div>
        </div>
      ))}
    </div>
  )
}

function SlideBody({ slide, ctx, playing, onPlayRow }: { slide: Slide; ctx: YirCtx; playing: string | null; onPlayRow: (p: StoryPlay | undefined) => void }): JSX.Element {
  switch (slide.kind) {
    case 'cover': {
      const y = String(slide.year)
      return (
        <>
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-year">{y.slice(0, 2)}<span>{y.slice(2)}</span></div>
          <div className="yir-cover-line">{slide.line}</div>
          <div className="yir-stats">{slide.stats.map(([v, l]) => <div key={l}><b>{v}</b><span>{l}</span></div>)}</div>
          {slide.note && <div className="yir-note">{slide.note}</div>}
        </>
      )
    }
    case 'art':
      return (
        <>
          <YirImg image={slide.image} ctx={ctx} className={slide.poster ? 'yir-poster' : 'yir-art'} size={900} />
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-big">{slide.big}</div>
          <div className="yir-line">{slide.line}</div>
          {playing && (
            <div className="yir-playing">
              <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 0l9 5-9 5z" fill="currentColor" /></svg>
              Playing: {playing}
            </div>
          )}
        </>
      )
    case 'list':
      return (
        <>
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-list">
            {slide.rows.map((r, k) => (
              <button key={`${r.name}|${r.sub}`} type="button" className="yir-row" onClick={() => onPlayRow(r.play)} title={`Play ${r.name}`}>
                <span className="yir-row-n">{k + slide.firstRank}</span>
                <YirImg image={r.image} ctx={ctx} className="yir-row-img" size={240} />
                <span className="yir-row-who"><b>{r.name}</b><small>{r.sub}</small></span>
                <span className="yir-row-c">{r.plays}</span>
              </button>
            ))}
          </div>
        </>
      )
    case 'lanes':
      return (
        <>
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-big">{slide.big}</div>
          <Lanes rows={slide.rows} ctx={ctx} />
          <div className="yir-line">{slide.line}</div>
        </>
      )
    case 'iceberg': {
      const max = Math.max(1, ...slide.layers), tot = slide.layers.reduce((a, b) => a + b, 0) || 1
      return (
        <>
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-big">{slide.big}</div>
          <div className="yir-berg">
            {slide.layers.map((v, k) => (
              <div key={LAYERS[k]}>
                <span>{LAYERS[k]}</span>
                <i className={`yir-berg-${k}`} style={{ width: `${(v / max) * 100}%` }} />
                <em>{Math.round((v / tot) * 100)}%</em>
              </div>
            ))}
          </div>
          <div className="yir-line">{slide.line}</div>
        </>
      )
    }
    default:
      return (
        <>
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-big">{slide.big}</div>
          <div className="yir-line">{slide.line}</div>
        </>
      )
  }
}

export default function YirStory({ slides, ctx, onClose, onSeeAll }: { slides: Slide[]; ctx: YirCtx; onClose: () => void; onSeeAll: () => void }): JSX.Element {
  const [i, setI] = useState(0)
  const { playTrack } = useAudio()
  const stageRef = useRef<HTMLDivElement>(null)
  const lastPlay = useRef('')
  const [playing, setPlaying] = useState<string | null>(null)
  const slide = slides[Math.min(i, slides.length - 1)]

  const play = useCallback((p: StoryPlay | undefined, force = false) => {
    const r = resolvePlay(p, ctx.tracks)
    if (!r) return
    const key = r.queue.map((t) => t.id).join(',')
    if (!force && key === lastPlay.current) { setPlaying(r.label); return }
    lastPlay.current = key
    setPlaying(r.label)
    playTrack(r.queue[0], r.queue, 0, undefined, true)
  }, [ctx.tracks, playTrack])

  // A card that names a song or a record plays it; other cards keep the music going.
  useEffect(() => {
    if (slide?.kind === 'art' && slide.play) play(slide.play)
    else setPlaying(null)
  }, [slide, play])

  useEffect(() => { stageRef.current?.focus() }, [])
  const step = useCallback((d: number) => {
    if (d > 0 && i >= slides.length - 1) { onSeeAll(); return }
    setI((k) => Math.max(0, Math.min(slides.length - 1, k + d)))
  }, [i, slides.length, onSeeAll])
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }, [step, onClose])

  if (!slide) return <div className="yir-stage" />
  const last = i === slides.length - 1
  return (
    <div className="yir-stage" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="Year in Review story">
      <button type="button" className="yir-close" onClick={onClose} aria-label="Close the story" title="Close (Esc)">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      <div className={`yir-card yir-k-${slide.kind}${slide.kind === 'art' && slide.poster ? ' yir-k-poster' : ''}`} key={i}>
        <Backdrop slide={slide} ctx={ctx} />
        <div className="yir-bars" aria-hidden="true">
          {slides.map((_, k) => <i key={k} className={k < i ? 'done' : k === i ? 'now' : ''}><b /></i>)}
        </div>
        <div className="yir-nav">
          <button type="button" aria-label="Previous card" onClick={() => step(-1)} />
          <button type="button" aria-label={last ? 'See the whole year' : 'Next card'} onClick={() => step(1)} />
        </div>
        <div className="yir-body">
          <SlideBody slide={slide} ctx={ctx} playing={playing} onPlayRow={(p) => play(p, true)} />
          {last && <button type="button" className="yir-seeall" onClick={onSeeAll}>See the whole year</button>}
        </div>
      </div>
      <div className="yir-hint">{i + 1} of {slides.length} · Click or press → to go on · ← to go back · Esc to close</div>
    </div>
  )
}
