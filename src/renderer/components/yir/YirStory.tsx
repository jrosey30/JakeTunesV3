/**
 * The Year in Review story (2026-10-12): one portrait card at a time, the
 * December 17 reveal. Cards come from src/common/yir-story.ts; a card that
 * features a song or a record plays it through the regular player, so the
 * music stays when the story closes. ← / → step, Esc closes; the keys are
 * claimed here so App.tsx's transport doesn't also skip the song.
 *
 * 2026-10-29 (Jake: "too many words not enough visuals", "more music and artist visuals and
 * album", "more animations. more fun."): every card carries a picture made of his covers and
 * photos (yir-story.ts Viz) and a moment of motion — covers fly in and the last card's cover
 * carries over, the race races, the calendar stamps day by day, the dial sweeps, number ones
 * flip, the seat map bursts, the record spins while it plays, covers rain on the birthday.
 * Motion is transform/opacity only (compositor), all of it inside
 * `prefers-reduced-motion: no-preference`; Reduce Motion gets a plain crossfade. A playing
 * card's cover breathes at the song's own BPM (tempo-matched from when it started, not
 * beat-detected).
 *
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/YirStoryView.swift (taps for clicks, swipes for the keys).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useAudio } from '../../hooks/useAudio'
import YirImg, { useYirImage, type YirCtx } from './YirImg'
import { findSong, albumSongs } from './yirData'
import { slidePlay, type Slide, type StoryPlay, type StoryImage, type Viz, type Tile } from '../../../common/yir-story'
import type { Track } from '../../types'

const LAYERS = ['The tip', 'Just below', 'Below', 'Deep water', 'Abyss']
/** Seat-map colors per legend place (the artist of the year is always the orange). */
const SEAT_COLORS = ['#f6f1ea', '#c9b8a3', '#8fbcd6', '#e9c46a', '#9d8df1', '#7fd1a8']
const reduced = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function resolvePlay(p: StoryPlay | undefined, tracks: Track[]): { queue: Track[]; label: string } | null {
  if (!p) return null
  if (p.kind === 'song') {
    const t = findSong(tracks, p.artist, p.title)
    return t ? { queue: [t], label: `${t.title} — ${t.artist}` } : null
  }
  const songs = albumSongs(tracks, p.artist, p.album)
  return songs.length ? { queue: songs, label: `${p.album} — ${p.artist}` } : null
}

/** The picture a card is "about" (carried into the next card as it opens). */
function heroImage(s: Slide | undefined): StoryImage | undefined {
  if (!s) return undefined
  if (s.kind === 'art') return s.image
  if (s.kind === 'list') return s.rows[0]?.image
  if (s.kind === 'lanes') return s.rows[0]?.image
  if (s.kind === 'champions') return s.rows[0]?.image
  if (s.kind === 'cover') return s.tiles[0]?.image
  if ((s.kind === 'number' || s.kind === 'end') && s.viz?.kind === 'mosaic') return s.viz.tiles[0]?.image
  if (s.kind === 'number' && s.viz?.kind === 'shows') return s.viz.items[0]?.image
  return undefined
}

/** The export's clock (ms since the card opened): when set, count-ups read it instead of
 *  running on their own (YirStoryExport renders frame by frame). */
export const YirClock = createContext<number | null>(null)

/** A number that counts up from zero (once per mount); Reduce Motion shows it at once. */
function useCountUp(target: number, ms = 1100, delayMs = 0): number {
  const clock = useContext(YirClock)
  const [v, setV] = useState(() => (reduced() ? target : 0))
  useEffect(() => {
    if (clock !== null) return
    if (reduced()) { setV(target); return }
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number): void => {
      const k = Math.min(1, (t - t0) / ms)
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms, clock])
  if (clock !== null) {
    const k = Math.min(1, Math.max(0, (clock - delayMs) / ms))
    return Math.round(target * (1 - Math.pow(1 - k, 3)))
  }
  return v
}

/** "1,031 new artists." counts its leading number up; anything else is shown as is. */
function CountText({ text }: { text: string }): JSX.Element {
  const m = /^([\d,]+)(.*)$/s.exec(text)
  const target = m ? Number(m[1].replace(/,/g, '')) : 0
  const v = useCountUp(target)
  if (!m || !Number.isFinite(target) || target < 10) return <>{text}</>
  return <>{v.toLocaleString('en-US')}{m[2]}</>
}

export function Backdrop({ slide, ctx }: { slide: Slide; ctx: YirCtx }): JSX.Element | null {
  const image = slide.kind === 'art' ? slide.image : slide.kind === 'lanes' ? slide.rows[0]?.image : undefined
  const src = useYirImage(image, ctx, 320)
  return src ? <div className="yir-bg" style={{ backgroundImage: `url("${src}")` }} aria-hidden="true" /> : null
}

const delay = (i: number, step: number, base = 0): CSSProperties => ({ ['--d' as string]: `${base + i * step}ms` })

function TileButton({ tile, ctx, className, style, onPlay, size = 240 }: { tile: Tile; ctx: YirCtx; className: string; style?: CSSProperties; onPlay: (p: StoryPlay | undefined) => void; size?: number }): JSX.Element {
  const img = <YirImg image={tile.image} ctx={ctx} className="yir-tile-img" size={size} />
  return tile.play
    ? <button type="button" className={`${className} yir-tile`} style={style} onClick={() => onPlay(tile.play)} title={tile.play.kind === 'song' ? `Play ${tile.play.title}` : `Play ${tile.play.album}`}>{img}{tile.label && <span className="yir-tile-label">{tile.label}</span>}</button>
    : <span className={`${className} yir-tile`} style={style}>{img}{tile.label && <span className="yir-tile-label">{tile.label}</span>}</span>
}

function VizView({ viz, ctx, onPlay, finale }: { viz: Viz; ctx: YirCtx; onPlay: (p: StoryPlay | undefined) => void; finale?: boolean }): JSX.Element {
  switch (viz.kind) {
    case 'mosaic': {
      const cols = viz.tiles.length > 24 ? 8 : viz.tiles.length > 9 ? 4 : 3
      return (
        <div className={`yir-mosaic${viz.round ? ' yir-mosaic--round' : ''}${finale ? ' yir-confetti' : ''}`} style={{ ['--cols' as string]: cols }}>
          {viz.tiles.map((t, i) => (
            <TileButton key={i} tile={t} ctx={ctx} onPlay={onPlay} className="yir-fly" size={viz.tiles.length > 24 ? 120 : 240}
              style={{ ...delay(i, viz.tiles.length > 24 ? 22 : 60), ['--x' as string]: `${((i * 37) % 21) - 10}`, ['--r' as string]: `${((i * 53) % 61) - 30}deg` }} />
          ))}
          {viz.chips && <div className="yir-chips">{viz.chips.map((c, i) => <span key={c} className="yir-fly" style={delay(i, 70, 500)}>{c}</span>)}</div>}
        </div>
      )
    }
    case 'hours': {
      const max = Math.max(1, ...viz.bars.map((b) => b.plays))
      return (
        <div className="yir-hours">
          {viz.bars.map((b, i) => (
            <div key={b.hour} className="yir-hour" style={delay(i, 70)}>
              {b.tile && b.plays > 0 ? <TileButton tile={b.tile} ctx={ctx} onPlay={onPlay} className="yir-hour-cover" size={120} /> : <span className="yir-hour-cover yir-hour-cover--none" />}
              <i style={{ height: `${Math.max(3, (b.plays / max) * 100)}%` }} />
            </div>
          ))}
          <b className="yir-playhead" aria-hidden="true" />
          <div className="yir-hours-axis"><span>12 AM</span><span>6 AM</span><span>Noon</span><span>6 PM</span><span>11 PM</span></div>
        </div>
      )
    }
    case 'clock': {
      const hMax = Math.max(1, ...viz.hours), wMax = Math.max(1, ...viz.weekdays)
      return (
        <div className="yir-clock">
          <div className="yir-clock-hours">{viz.hours.map((v, h) => <i key={h} className={h === viz.hotHour ? 'hot' : ''} style={{ height: `${Math.max(3, (v / hMax) * 100)}%`, ...delay(h, 30) }} />)}</div>
          <div className="yir-hours-axis"><span>12 AM</span><span>6 AM</span><span>Noon</span><span>6 PM</span><span>11 PM</span></div>
          <div className="yir-clock-week">{viz.weekdays.map((v, d) => <div key={d}><i className={d === viz.hotDay ? 'hot' : ''} style={{ height: `${Math.max(4, (v / wMax) * 100)}%`, ...delay(d, 60, 700) }} /><small>{'SMTWTFS'[d]}</small></div>)}</div>
        </div>
      )
    }
    case 'calendar':
      return (
        <div className="yir-cal">
          {viz.days.map((d, i) => (
            <div key={d.date} className="yir-cal-day yir-stamp" style={delay(i, 55)}>
              {d.tile ? <TileButton tile={d.tile} ctx={ctx} onPlay={onPlay} className="yir-cal-cover" size={120} /> : <span className="yir-cal-cover yir-cal-cover--none" />}
              <small>{Number(d.date.slice(8))}</small>
            </div>
          ))}
        </div>
      )
    case 'pipeline':
      return (
        <ol className="yir-pipe">
          {viz.steps.map((s, i) => (
            <li key={s.label} className="yir-fly" style={delay(i, 260)}>
              <span className="yir-pipe-stack">{s.tiles.map((t, k) => <TileButton key={k} tile={t} ctx={ctx} onPlay={onPlay} className="yir-pipe-cover" size={120} style={{ ['--k' as string]: k }} />)}</span>
              <span className="yir-pipe-text"><b>{s.value}</b><small>{s.label}</small></span>
            </li>
          ))}
        </ol>
      )
    case 'shows':
      return (
        <ol className="yir-shows">
          {viz.items.map((sh, i) => (
            <li key={`${sh.artist}|${sh.where}`} className="yir-fly" style={delay(i, 140)}>
              <YirImg image={sh.image} ctx={ctx} className={`yir-show-img${sh.image.kind === 'artist' ? ' yir-show-img--round' : ''}`} size={240} />
              <span className="yir-show-who"><b>{sh.artist}</b><small>{sh.where}</small>
                {sh.songs.length > 0 && <span className="yir-show-songs">{sh.songs.map((t, k) => (
                  <button key={k} type="button" className="yir-show-song" onClick={() => onPlay(t.play)}>{t.play?.kind === 'song' ? t.play.title : ''}</button>
                ))}</span>}
              </span>
            </li>
          ))}
        </ol>
      )
    case 'gauges': return <Gauges items={viz.items} />
    case 'seats': return <Seats cells={viz.cells} legend={viz.legend} />
  }
}

/** An iPod: its most-played covers on the screen, the play count ticking up under them, the
 *  click wheel, and the JakeTunes mark (the same wordmark-and-wheel as every Story frame). */
function IpodView({ plays, tiles, ctx, onPlay }: { plays: number; tiles: Tile[]; ctx: YirCtx; onPlay: (p: StoryPlay | undefined) => void }): JSX.Element {
  const v = useCountUp(plays, 1600, 300)
  return (
    <div className="yir-ipod" role="img" aria-label={`An iPod: ${plays.toLocaleString('en-US')} plays`}>
      <div className="yir-ipod-body yir-fly">
        <div className="yir-ipod-screen">
          <div className="yir-ipod-covers">
            {tiles.slice(0, 9).map((t, i) => <TileButton key={i} tile={t} ctx={ctx} onPlay={onPlay} className="yir-fly" size={120} style={delay(i, 70, 250)} />)}
          </div>
          <div className="yir-ipod-count"><b>{v.toLocaleString('en-US')}</b> plays</div>
        </div>
        <div className="yir-ipod-wheel"><span>MENU</span><i /></div>
      </div>
      <div className="yir-ipod-mark"><i />JAKETUNES</div>
    </div>
  )
}

/** One dial: the lead number sweeps in and passes the others' markers. */
function Gauges({ items }: { items: Array<{ pct: number; label: string; lead: boolean }> }): JSX.Element {
  const lead = items.find((g) => g.lead) ?? items[0]
  const others = items.filter((g) => g !== lead)
  const v = useCountUp(lead.pct, 1400, 200)
  const R = 90, L = Math.PI * R
  const at = (pct: number): [number, number] => { const a = Math.PI * (1 - pct / 100); return [110 + R * Math.cos(a), 110 - R * Math.sin(a)] }
  return (
    <div className="yir-gauge">
      <svg viewBox="0 0 220 128" role="img" aria-label={items.map((g) => `${g.label}: ${g.pct}%`).join(', ')}>
        <path d="M20 110 A90 90 0 0 1 200 110" className="yir-gauge-track" />
        <path d="M20 110 A90 90 0 0 1 200 110" className="yir-gauge-fill" style={{ strokeDasharray: L, ['--off' as string]: L * (1 - lead.pct / 100), ['--len' as string]: L }} />
        {others.map((g) => { const [x, y] = at(g.pct); const [x2, y2] = [110 + (x - 110) * 1.16, 110 + (y - 110) * 1.16]; return <line key={g.label} x1={x} y1={y} x2={x2} y2={y2} className="yir-gauge-mark" /> })}
        <text x="110" y="104" textAnchor="middle" className="yir-gauge-num">{v}%</text>
      </svg>
      <div className="yir-gauge-key">
        <span><i className="lead" />{lead.label}</span>
        {others.map((g) => <span key={g.label}><i />{g.label}: {g.pct}%</span>)}
      </div>
    </div>
  )
}

/** The seat map: 1,000 seats by rank, burst in from the middle; the artist of the year pulses. */
function Seats({ cells, legend }: { cells: number[]; legend: Array<{ name: string; seats: number; hot: boolean }> }): JSX.Element {
  const cols = 40, rows = Math.ceil(cells.length / cols)
  const hot = legend.findIndex((l) => l.hot)
  const color = (k: number): string => (k < 0 ? 'rgba(246,241,234,0.16)' : k === hot ? 'var(--yir-orange)' : SEAT_COLORS[k % SEAT_COLORS.length])
  return (
    <div className="yir-seats">
      <div className="yir-seat-grid" style={{ ['--cols' as string]: cols }} role="img" aria-label={legend.map((l) => `${l.name}: ${l.seats} seats`).join(', ')}>
        {cells.map((k, i) => {
          const x = i % cols - cols / 2, y = Math.floor(i / cols) - rows / 2
          return <i key={i} className={k === hot && hot >= 0 ? 'hot' : ''} style={{ background: color(k), ['--d' as string]: `${Math.round(Math.hypot(x, y * 1.6) * 28)}ms` }} />
        })}
      </div>
      <div className="yir-seat-key">{legend.map((l, k) => <span key={l.name} className={l.hot ? 'hot' : ''}><i style={{ background: color(k) }} />{l.name} {l.seats}</span>)}</div>
    </div>
  )
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
            <div className="yir-track"><i style={{ ['--w' as string]: `${(r.plays / max) * 100}%` }} /></div>
            <small>{r.sub}</small>
          </div>
        </div>
      ))}
    </div>
  )
}

export function SlideBody({ slide, ctx, playing, beat, onPlayRow }: { slide: Slide; ctx: YirCtx; playing: string | null; beat: number | null; onPlayRow: (p: StoryPlay | undefined) => void }): JSX.Element {
  const beatStyle = beat ? ({ ['--beat' as string]: `${beat}ms` } as CSSProperties) : undefined
  const nowPlaying = playing && (
    <div className="yir-playing">
      <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 0l9 5-9 5z" fill="currentColor" /></svg>
      Playing: {playing}
    </div>
  )
  switch (slide.kind) {
    case 'cover': {
      const y = String(slide.year)
      return (
        <>
          <div className="yir-cover-wall">
            {slide.tiles.map((t, i) => <span key={i} className="yir-fly" style={delay(i, 80)}><YirImg image={t.image} ctx={ctx} className="yir-tile-img" size={240} /></span>)}
          </div>
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-year">{y.slice(0, 2)}<span>{y.slice(2)}</span></div>
          <div className="yir-cover-line">{slide.line}</div>
          <div className="yir-stats">{slide.stats.map(([v, l]) => <div key={l}><b><CountText text={v} /></b><span>{l}</span></div>)}</div>
        </>
      )
    }
    case 'art':
      return (
        <>
          {slide.vinyl
            ? <div className={`yir-vinyl${playing ? ' yir-vinyl--on' : ''}`} style={beatStyle}><YirImg image={slide.image} ctx={ctx} className="yir-vinyl-img" size={900} /><i aria-hidden="true" /></div>
            : <div className={`yir-art-wrap${beat ? ' yir-beat' : ''}`} style={beatStyle}><YirImg image={slide.image} ctx={ctx} className={slide.poster ? 'yir-poster' : 'yir-art'} size={900} /></div>}
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-big">{slide.big}</div>
          <div className="yir-line">{slide.line}</div>
          {nowPlaying}
        </>
      )
    case 'list':
      return (
        <>
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-list">
            {slide.rows.map((r, k) => (
              <button key={`${r.name}|${r.sub}`} type="button" className="yir-row yir-fly" style={delay(k, 120)} onClick={() => onPlayRow(r.play)} title={`Play ${r.name}`}>
                <span className="yir-row-n">{k + slide.firstRank}</span>
                <YirImg image={r.image} ctx={ctx} className="yir-row-img" size={320} />
                <span className="yir-row-who"><b>{r.name}</b><small>{r.sub}</small></span>
                <span className="yir-row-c">{r.plays}</span>
              </button>
            ))}
          </div>
          {nowPlaying}
        </>
      )
    case 'lanes':
      return (
        <>
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-big">{slide.big}</div>
          <Lanes rows={slide.rows} ctx={ctx} />
          <div className="yir-line yir-reveal">{slide.line}</div>
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
                <i className={`yir-berg-${k} yir-grow`} style={{ width: `${(v / max) * 100}%`, ...delay(k, 140) }} />
                <em>{Math.round((v / tot) * 100)}%</em>
              </div>
            ))}
          </div>
          <div className="yir-line">{slide.line}</div>
        </>
      )
    }
    case 'ipod':
      return (
        <>
          <IpodView plays={slide.plays} tiles={slide.tiles} ctx={ctx} onPlay={onPlayRow} />
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-big">{slide.big}</div>
          <div className="yir-line">{slide.line}</div>
          {nowPlaying}
        </>
      )
    case 'champions':
      return (
        <>
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-big">{slide.big}</div>
          <div className="yir-champs">
            {slide.rows.map((r, i) => (
              <button key={r.bracket} type="button" className="yir-champ" onClick={() => onPlayRow(r.play)} title={`Play ${r.title}`}>
                <span className="yir-flip" style={delay(i, 280, 200)}><YirImg image={r.image} ctx={ctx} className="yir-tile-img" size={240} /></span>
                <em>{r.bracket}</em>
                <b>{r.title}</b>
                <small>#{r.rank} overall</small>
              </button>
            ))}
          </div>
          {slide.line && <div className="yir-line">{slide.line}</div>}
        </>
      )
    case 'number':
    case 'end':
      return (
        <>
          {slide.viz && <VizView viz={slide.viz} ctx={ctx} onPlay={onPlayRow} finale={slide.kind === 'end'} />}
          <div className="yir-eyebrow">{slide.eyebrow}</div>
          <div className="yir-big"><CountText text={slide.big} /></div>
          <div className="yir-line">{slide.line}</div>
          {slide.kind === 'number' && nowPlaying}
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
  const [beat, setBeat] = useState<number | null>(null)
  const [carry, setCarry] = useState<{ image: StoryImage; key: number } | null>(null)
  const [share, setShare] = useState<string | null>(null)
  const slide = slides[Math.min(i, slides.length - 1)]

  // Instagram Story files for this card or the whole year, saved to Downloads (main/yir-export.ts).
  const exportStory = useCallback((which: number[] | 'all') => {
    const api = window.electronAPI
    if (!api.yirExport) return
    setShare('Making your Story…')
    const off = api.onYirExportProgress?.((p) => setShare(`Making your Story… ${Math.round((100 * p.done) / Math.max(1, p.total))}%`))
    void api.yirExport(which).then((r) => {
      off?.()
      if (!r.ok) { setShare(r.error ?? 'The export didn\'t finish.'); return }
      const n = (r.videos?.length ?? 0) + (r.stills?.length ?? 0)
      setShare(`${n} file${n === 1 ? '' : 's'} saved to Downloads, 1080 × 1920.${r.note ? ` ${r.note}` : ''}`)
    }).catch(() => { off?.(); setShare('The export didn\'t finish.') })
  }, [])

  const play = useCallback((p: StoryPlay | undefined, force = false) => {
    const r = resolvePlay(p, ctx.tracks)
    if (!r) return
    const key = r.queue.map((t) => t.id).join(',')
    const bpm = Number(r.queue[0]?.bpm) || 0
    setBeat(bpm >= 50 && bpm <= 220 ? Math.round(60000 / bpm) : null)
    if (!force && key === lastPlay.current) { setPlaying(r.label); return }
    lastPlay.current = key
    setPlaying(r.label)
    playTrack(r.queue[0], r.queue, 0, undefined, true)
  }, [ctx.tracks, playTrack])

  // A card that features a song or a record plays it; other cards keep the music going.
  useEffect(() => {
    const p = slide ? slidePlay(slide) : undefined
    if (p) play(p)
    else { setPlaying(null); setBeat(null) }
  }, [slide, play])

  useEffect(() => { stageRef.current?.focus() }, [])
  const step = useCallback((d: number) => {
    if (d > 0 && i >= slides.length - 1) { onSeeAll(); return }
    const next = Math.max(0, Math.min(slides.length - 1, i + d))
    if (next === i) return
    // The card's cover flies on into the next one.
    const img = heroImage(slides[i])
    setCarry(img ? { image: img, key: Date.now() } : null)
    setI(next)
  }, [i, slides, onSeeAll])
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }, [step, onClose])

  if (!slide) return <div className="yir-stage" />
  const last = i === slides.length - 1
  return (
    <div className="yir-stage" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="Year in Review story">
      <button type="button" className="yir-share" onClick={() => exportStory([i])} title="Save this card as an Instagram Story (1080 × 1920 video + image)">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1v7M3 4l3-3 3 3M2 7v4h8V7" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Share
      </button>
      {share && <div className="yir-share-status" role="status">{share}</div>}
      <button type="button" className="yir-close" onClick={onClose} aria-label="Close the story" title="Close (Esc)">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
      <div className={`yir-card yir-k-${slide.kind}${slide.kind === 'art' && slide.poster ? ' yir-k-poster' : ''}${slide.kind === 'number' && slide.viz ? ` yir-v-${slide.viz.kind}` : ''}`} key={i}>
        <Backdrop slide={slide} ctx={ctx} />
        {carry && <span className="yir-carry" key={carry.key} aria-hidden="true"><YirImg image={carry.image} ctx={ctx} className="yir-tile-img" size={320} /></span>}
        <div className="yir-bars" aria-hidden="true">
          {slides.map((_, k) => <i key={k} className={k < i ? 'done' : k === i ? 'now' : ''}><b /></i>)}
        </div>
        <div className="yir-nav">
          <button type="button" aria-label="Previous card" onClick={() => step(-1)} />
          <button type="button" aria-label={last ? 'See the whole year' : 'Next card'} onClick={() => step(1)} />
        </div>
        <div className="yir-body">
          <SlideBody slide={slide} ctx={ctx} playing={playing} beat={beat} onPlayRow={(p) => play(p, true)} />
          {last && (
            <div className="yir-last-actions">
              <button type="button" className="yir-seeall" onClick={onSeeAll}>See the whole year</button>
              <button type="button" className="yir-seeall yir-seeall--quiet" onClick={() => exportStory('all')}>Share my whole year</button>
            </div>
          )}
        </div>
      </div>
      <div className="yir-hint">{i + 1} of {slides.length} · Click or press → to go on · ← to go back · Esc to close</div>
    </div>
  )
}
