import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import type { Track } from '../types'
import { DJEngine, type DeckId } from '../dj/engine'
import { beatsInRange, camelotCompatible, tempoDistance } from '../dj/beatgrid'
import {
  buildPrompts, matchPrompt, judge, applyHit, emptyRun, accuracy, multiplierFor,
  type Prompt, type DJAction, type Verdict, type RunState,
} from '../dj/scoring'
import '../styles/booth.css'

/**
 * DJ mode — two decks you actually play, with an optional scored challenge
 * layered over the same controls.
 *
 * The hybrid is the point: challenge mode does not simulate DJing next to the
 * real thing, it scores the real thing. Every prompt key performs the actual
 * move on the actual audio, so a good run and a good mix are the same event.
 */

const LOOKAHEAD_SEC = 4          // how far up the lane a prompt is visible
const ACTION_KEYS: Record<string, DJAction> = { d: 'bass-kill', f: 'crossfade', j: 'filter', k: 'cue-drop' }
const ACTION_LABEL: Record<DJAction, string> = {
  'bass-kill': 'BASS', 'crossfade': 'FADE', 'filter': 'FILTER', 'cue-drop': 'DROP',
}
const ACTION_KEYCAP: Record<DJAction, string> = {
  'bass-kill': 'D', 'crossfade': 'F', 'filter': 'J', 'cue-drop': 'K',
}

export default function DJView() {
  const { state } = useLibrary()
  const { state: pb, dispatch: pbDispatch } = usePlayback()
  const tracks = state.tracks

  // ── engine ───────────────────────────────────────────────────────────────
  const engineRef = useRef<DJEngine | null>(null)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [musicRoot, setMusicRoot] = useState('')

  // ── per-deck UI state ────────────────────────────────────────────────────
  const [loaded, setLoaded] = useState<Record<DeckId, Track | null>>({ A: null, B: null })
  const [loading, setLoading] = useState<Record<DeckId, boolean>>({ A: false, B: false })
  const [playing, setPlaying] = useState<Record<DeckId, boolean>>({ A: false, B: false })
  const [rate, setRate] = useState<Record<DeckId, number>>({ A: 1, B: 1 })
  const [kills, setKills] = useState<Record<DeckId, Record<'low' | 'mid' | 'high', boolean>>>({
    A: { low: false, mid: false, high: false },
    B: { low: false, mid: false, high: false },
  })
  const [filterAmt, setFilterAmt] = useState<Record<DeckId, number>>({ A: 0, B: 0 })
  const [xfader, setXfader] = useState(0)
  const [pos, setPos] = useState<Record<DeckId, number>>({ A: 0, B: 0 })

  // ── challenge state ──────────────────────────────────────────────────────
  const [challenge, setChallenge] = useState(false)
  const [challengeDeck, setChallengeDeck] = useState<DeckId>('A')
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [run, setRun] = useState<RunState>(emptyRun)
  const [lastVerdict, setLastVerdict] = useState<{ v: Verdict; at: number } | null>(null)
  const resolvedRef = useRef<Set<number>>(new Set())
  const [, forceLane] = useState(0)

  const [picker, setPicker] = useState<DeckId | null>(null)
  const [query, setQuery] = useState('')

  // ── boot the engine once, tear it down completely on unmount ─────────────
  useEffect(() => {
    let disposed = false
    const e = new DJEngine()
    engineRef.current = e
    window.electronAPI?.getMusicLibraryPath?.()
      .then((p: string) => { if (!disposed) setMusicRoot(p) })
      .catch(() => { if (!disposed) setErr('Could not locate the music library.') })
    setReady(true)
    return () => {
      // Cancel path reverses everything the start path did: both buffers
      // released, every node disconnected, the AudioContext closed. Leaving a
      // context open holds an audio device session for the life of the app.
      disposed = true
      engineRef.current = null
      void e.dispose()
    }
  }, [])

  // ── the booth owns the room ──────────────────────────────────────────────
  // The decks run on their own AudioContext, which means nothing stops the
  // library player on its way in — open DJ mode mid-song and you'd hear the
  // song AND the decks on top of each other. Two decks overlapping is the
  // whole point of a crossfader; the library player overlapping them is just
  // two things shouting.
  //
  // So: pause it on the way in, and put it back on the way out, but only if
  // WE were the one who paused it. Resuming something the user had already
  // stopped would be its own surprise.
  const resumeOnLeaveRef = useRef(false)
  useEffect(() => {
    if (pb.isPlaying) {
      resumeOnLeaveRef.current = true
      pbDispatch({ type: 'PAUSE' })
    }
    return () => {
      if (resumeOnLeaveRef.current) {
        resumeOnLeaveRef.current = false
        pbDispatch({ type: 'RESUME' })
      }
    }
    // Mount/unmount only. Re-running this on every isPlaying change would
    // fight the user for control of the transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── playhead / lane refresh ──────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return
    let raf = 0
    const tick = () => {
      const e = engineRef.current
      if (e) {
        setPos({ A: e.a.position, B: e.b.position })
        setPlaying({ A: e.a.playing, B: e.b.playing })
        if (challenge) forceLane((n) => (n + 1) % 1_000_000)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ready, challenge])

  const absPathFor = useCallback((t: Track): string => {
    return musicRoot + String(t.path || '').replace(/:/g, '/')
  }, [musicRoot])

  const loadDeck = useCallback(async (id: DeckId, t: Track) => {
    const e = engineRef.current
    if (!e || !musicRoot) return
    setLoading((s) => ({ ...s, [id]: true }))
    setErr(null)
    try {
      await e.resume()
      const url = 'ipod-audio://' + encodeURIComponent(absPathFor(t))
      await e.loadInto(id, url, t.id, Number(t.bpm) || 0)
      setLoaded((s) => ({ ...s, [id]: t }))
      setRate((s) => ({ ...s, [id]: e.deck(id).rate }))
    } catch (ex) {
      setErr(`Couldn't load "${t.title}" — ${ex instanceof Error ? ex.message : String(ex)}`)
    } finally {
      setLoading((s) => ({ ...s, [id]: false }))
    }
  }, [absPathFor, musicRoot])

  /**
   * Belt and braces for the mount-time pause: if the library player has come
   * back to life while we're in here (auto-advance, a global shortcut), a deck
   * starting must not stack on top of it.
   */
  const hushLibrary = useCallback(() => {
    if (pb.isPlaying) {
      resumeOnLeaveRef.current = true
      pbDispatch({ type: 'PAUSE' })
    }
  }, [pb.isPlaying, pbDispatch])

  const togglePlay = useCallback(async (id: DeckId) => {
    const e = engineRef.current
    if (!e) return
    await e.resume()
    const d = e.deck(id)
    if (d.playing) d.pause()
    else { hushLibrary(); d.play() }
    setPlaying((s) => ({ ...s, [id]: d.playing }))
  }, [hushLibrary])

  const cue = useCallback((id: DeckId) => {
    const e = engineRef.current
    if (!e) return
    const d = e.deck(id)
    if (d.playing) { d.pause(); d.seek(d.cuePoint) }
    else { d.cuePoint = d.position; d.seek(d.cuePoint) }
    setPos((s) => ({ ...s, [id]: d.position }))
  }, [])

  const doSync = useCallback((id: DeckId) => {
    const e = engineRef.current
    if (!e) return
    const r = e.sync(id)
    setRate((s) => ({ ...s, [id]: r }))
  }, [])

  const changeRate = useCallback((id: DeckId, r: number) => {
    const e = engineRef.current
    if (!e) return
    e.deck(id).setRate(r)
    setRate((s) => ({ ...s, [id]: r }))
  }, [])

  const toggleKill = useCallback((id: DeckId, band: 'low' | 'mid' | 'high') => {
    const e = engineRef.current
    if (!e) return
    setKills((s) => {
      const on = !s[id][band]
      e.setEq(id, band, on ? -40 : 0)
      return { ...s, [id]: { ...s[id], [band]: on } }
    })
  }, [])

  const changeFilter = useCallback((id: DeckId, amt: number) => {
    const e = engineRef.current
    if (!e) return
    e.setFilter(id, amt)
    setFilterAmt((s) => ({ ...s, [id]: amt }))
  }, [])

  const moveXfader = useCallback((v: number) => {
    const e = engineRef.current
    if (!e) return
    e.setCrossfader(v)
    setXfader(v)
  }, [])

  // ── challenge: build the chart from the deck's own beat grid ──────────────
  const startChallenge = useCallback((id: DeckId) => {
    const e = engineRef.current
    const d = e?.deck(id)
    // Needs both a decoded buffer and a known tempo — a chart without a grid
    // would be prompts on nothing.
    if (!e || !d || !d.buffer || !d.bpm) return
    resolvedRef.current = new Set()
    setRun(emptyRun())
    setChallengeDeck(id)
    setPrompts(buildPrompts({
      bpm: d.bpm,
      offset: d.beatOffset,
      from: Math.max(d.position, d.beatOffset) + 4,   // a bar of runway before the first call
      to: d.duration,
      deck: id,
    }))
    setChallenge(true)
  }, [])

  const stopChallenge = useCallback(() => {
    setChallenge(false)
    setPrompts([])
    resolvedRef.current = new Set()
  }, [])

  /**
   * Perform a move AND score it. One path, so the game can never reward
   * something the audio didn't actually do.
   */
  const performAction = useCallback((action: DJAction) => {
    const e = engineRef.current
    if (!e) return
    const id = challenge ? challengeDeck : (xfader <= 0 ? 'A' : 'B')
    const other: DeckId = id === 'A' ? 'B' : 'A'

    switch (action) {
      case 'bass-kill': toggleKill(id, 'low'); break
      case 'crossfade': moveXfader(xfader <= 0 ? 1 : -1); break
      case 'filter': {
        // Momentary sweep — open again shortly after, the way a hand does.
        changeFilter(id, -0.75)
        window.setTimeout(() => changeFilter(id, 0), 420)
        break
      }
      case 'cue-drop': {
        const d = e.deck(other)
        if (d.snapshot().loaded) { hushLibrary(); d.seek(d.cuePoint); d.play() }
        break
      }
    }

    if (!challenge) return
    const t = e.deck(challengeDeck).position
    const p = matchPrompt(prompts, resolvedRef.current, action, t)
    if (!p) { setRun((r) => applyHit(r, 'miss')); setLastVerdict({ v: 'miss', at: Date.now() }); return }
    resolvedRef.current.add(p.id)
    const v = judge(t - p.time)
    setRun((r) => applyHit(r, v))
    setLastVerdict({ v, at: Date.now() })
  }, [challenge, challengeDeck, prompts, xfader, toggleKill, moveXfader, changeFilter, hushLibrary])

  // ── keyboard: this is the instrument ─────────────────────────────────────
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return
      // Modified keys stay with the app -- Cmd-F, Cmd-Q and friends are not ours.
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return
      const k = ev.key.toLowerCase()
      const claim = () => { ev.preventDefault(); ev.stopPropagation() }

      if (ACTION_KEYS[k]) { claim(); performAction(ACTION_KEYS[k]); return }
      if (k === 'q') { claim(); void togglePlay('A') }
      else if (k === 'p') { claim(); void togglePlay('B') }
      else if (k === 'w') { claim(); cue('A') }
      else if (k === 'o') { claim(); cue('B') }
      else if (k === 's') { claim(); doSync('A') }
      else if (k === 'l') { claim(); doSync('B') }
      else if (ev.key === 'ArrowLeft') { claim(); moveXfader(Math.max(-1, xfader - 0.1)) }
      else if (ev.key === 'ArrowRight') { claim(); moveXfader(Math.min(1, xfader + 0.1)) }
      // Space would toggle the library transport we deliberately paused on the
      // way in. Swallow it rather than let the booth restart the thing it muted.
      else if (ev.key === ' ') { claim() }
    }
    // CAPTURE phase, and stopPropagation on anything we claim.
    //
    // The app's transport shortcuts live on the window and BUBBLE, so a bubble
    // listener here fires alongside them rather than instead of them: pressing
    // an arrow in the booth nudged the crossfader AND skipped the library to
    // the next song. preventDefault does nothing about that -- it cancels the
    // default action, not other listeners. Capturing means we see the event
    // first and can stop it before the transport ever hears it.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [performAction, togglePlay, cue, doSync, moveXfader, xfader])

  // ── "mixes well out of this" suggestions ─────────────────────────────────
  const suggestions = useMemo(() => {
    const src = loaded.A || loaded.B
    if (!src?.bpm) return []
    const srcBpm = Number(src.bpm)
    return tracks
      .filter((t) => t.id !== loaded.A?.id && t.id !== loaded.B?.id && t.bpm)
      .filter((t) => camelotCompatible(src.camelotKey, t.camelotKey))
      .map((t) => ({ t, d: tempoDistance(srcBpm, Number(t.bpm)) }))
      .filter((x) => x.d < 0.08)
      .sort((a, b) => a.d - b.d)
      .slice(0, 12)
      .map((x) => x.t)
  }, [tracks, loaded.A, loaded.B])

  const pickerResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tracks.slice(0, 60)
    return tracks.filter((t) =>
      String(t.title || '').toLowerCase().includes(q) ||
      String(t.artist || '').toLowerCase().includes(q)).slice(0, 60)
  }, [tracks, query])

  const visiblePrompts = useMemo(() => {
    if (!challenge) return []
    const e = engineRef.current
    if (!e) return []
    const now = e.deck(challengeDeck).position
    return prompts
      .filter((p) => p.time >= now - 0.25 && p.time <= now + LOOKAHEAD_SEC)
      .map((p) => ({ p, frac: (p.time - now) / LOOKAHEAD_SEC, done: resolvedRef.current.has(p.id) }))
  }, [challenge, challengeDeck, prompts, pos])

  return (
    <div className="booth-view">
      <header className="booth-header">
        <h1 className="booth-title">DJ</h1>
        <div className="booth-header-right">
          {challenge ? (
            <>
              <div className="booth-score">
                <span className="booth-score-value">{run.score.toLocaleString()}</span>
                <span className="booth-score-meta">
                  {multiplierFor(run.streak)}× · {run.streak} streak · {accuracy(run)}%
                </span>
              </div>
              <button className="booth-btn booth-btn-stop" onClick={stopChallenge}>End run</button>
            </>
          ) : (
            <button
              className="booth-btn booth-btn-challenge"
              disabled={!loaded.A && !loaded.B}
              onClick={() => startChallenge(loaded.A ? 'A' : 'B')}
            >
              Challenge
            </button>
          )}
        </div>
      </header>

      {err && <div className="booth-error" role="alert">{err}</div>}

      {challenge && (
        <ChallengeLane
          items={visiblePrompts}
          verdict={lastVerdict}
        />
      )}

      <div className="booth-decks">
        {(['A', 'B'] as DeckId[]).map((id) => (
          <DeckPanel
            key={id}
            id={id}
            track={loaded[id]}
            loading={loading[id]}
            playing={playing[id]}
            position={pos[id]}
            rate={rate[id]}
            kills={kills[id]}
            filterAmt={filterAmt[id]}
            engine={engineRef.current}
            onPick={() => setPicker(id)}
            onPlay={() => void togglePlay(id)}
            onCue={() => cue(id)}
            onSync={() => doSync(id)}
            onRate={(r) => changeRate(id, r)}
            onKill={(b) => toggleKill(id, b)}
            onFilter={(v) => changeFilter(id, v)}
          />
        ))}
      </div>

      <div className="booth-crossfader">
        <span className="booth-xf-label">A</span>
        <input
          type="range" min={-1} max={1} step={0.01} value={xfader}
          onChange={(e) => moveXfader(Number(e.target.value))}
          className="booth-xf-range" aria-label="Crossfader"
        />
        <span className="booth-xf-label">B</span>
      </div>

      <div className="booth-keys">
        {(Object.keys(ACTION_LABEL) as DJAction[]).map((a) => (
          <button key={a} className="booth-key" onClick={() => performAction(a)}>
            <span className="booth-key-cap">{ACTION_KEYCAP[a]}</span>
            <span className="booth-key-label">{ACTION_LABEL[a]}</span>
          </button>
        ))}
        <span className="booth-keys-hint">
          Q/P play · W/O cue · S/L sync · ←/→ crossfader
        </span>
      </div>

      {suggestions.length > 0 && (
        <section className="booth-suggest">
          <h2 className="booth-suggest-title">Mixes cleanly out of this</h2>
          <ul className="booth-suggest-list">
            {suggestions.map((t) => (
              <li key={t.id}>
                <button className="booth-suggest-item" onClick={() => void loadDeck(loaded.A ? 'B' : 'A', t)}>
                  <span className="booth-suggest-name">{t.title}</span>
                  <span className="booth-suggest-artist">{t.artist}</span>
                  <span className="booth-suggest-meta">{Math.round(Number(t.bpm))} · {t.camelotKey}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {picker && (
        <div className="booth-picker-backdrop" onClick={() => setPicker(null)}>
          <div className="booth-picker" onClick={(e) => e.stopPropagation()}>
            <input
              className="booth-picker-input" autoFocus placeholder={`Load deck ${picker}…`}
              value={query} onChange={(e) => setQuery(e.target.value)}
            />
            <ul className="booth-picker-list">
              {pickerResults.map((t) => (
                <li key={t.id}>
                  <button
                    className="booth-picker-item"
                    onClick={() => { const d = picker; setPicker(null); setQuery(''); void loadDeck(d, t) }}
                  >
                    <span className="booth-picker-name">{t.title}</span>
                    <span className="booth-picker-artist">{t.artist}</span>
                    <span className="booth-picker-meta">
                      {t.bpm ? Math.round(Number(t.bpm)) : '—'} · {t.camelotKey || '—'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

// ── falling prompt lane ────────────────────────────────────────────────────
function ChallengeLane(props: {
  items: Array<{ p: Prompt; frac: number; done: boolean }>
  verdict: { v: Verdict; at: number } | null
}) {
  const fresh = props.verdict && Date.now() - props.verdict.at < 600 ? props.verdict.v : null
  return (
    <div className="booth-lane">
      <div className="booth-lane-target" />
      {props.items.map(({ p, frac, done }) => (
        <div
          key={p.id}
          className={`booth-note booth-note-${p.action}${done ? ' is-done' : ''}`}
          style={{ left: `${Math.max(0, Math.min(100, frac * 100))}%` }}
        >
          {ACTION_KEYCAP[p.action]}
        </div>
      ))}
      {fresh && <div className={`booth-verdict booth-verdict-${fresh}`}>{fresh.toUpperCase()}</div>}
    </div>
  )
}

// ── one deck ───────────────────────────────────────────────────────────────
function DeckPanel(props: {
  id: DeckId
  track: Track | null
  loading: boolean
  playing: boolean
  position: number
  rate: number
  kills: Record<'low' | 'mid' | 'high', boolean>
  filterAmt: number
  engine: DJEngine | null
  onPick: () => void
  onPlay: () => void
  onCue: () => void
  onSync: () => void
  onRate: (r: number) => void
  onKill: (b: 'low' | 'mid' | 'high') => void
  onFilter: (v: number) => void
}) {
  const { id, track, engine } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const deck = engine?.deck(id)
  const bpm = track?.bpm ? Number(track.bpm) : 0
  const effBpm = bpm * props.rate

  useEffect(() => {
    const cv = canvasRef.current
    const d = deck
    if (!cv || !d) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.clientWidth, h = cv.clientHeight
    if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const peaks = d.peaks
    if (peaks.length === 0) return

    // Waveform
    ctx.fillStyle = '#3a3a3c'
    for (let x = 0; x < w; x++) {
      const v = peaks[Math.floor((x / w) * peaks.length)] || 0
      const bar = Math.max(1, v * h * 0.9)
      ctx.fillRect(x, (h - bar) / 2, 1, bar)
    }
    // Played portion
    const played = d.duration ? (props.position / d.duration) * w : 0
    ctx.fillStyle = '#e0812e'
    for (let x = 0; x < played; x++) {
      const v = peaks[Math.floor((x / w) * peaks.length)] || 0
      const bar = Math.max(1, v * h * 0.9)
      ctx.fillRect(x, (h - bar) / 2, 1, bar)
    }
    // Beat grid — every 4th beat (bar lines), so it reads as structure
    if (bpm && d.duration) {
      ctx.fillStyle = 'rgba(255,255,255,0.16)'
      const beats = beatsInRange(0, d.duration, bpm, d.beatOffset)
      for (let i = 0; i < beats.length; i += 4) {
        const x = (beats[i] / d.duration) * w
        ctx.fillRect(x, 0, 1, h)
      }
    }
    // Cue marker
    if (d.duration) {
      ctx.fillStyle = '#4da3ff'
      ctx.fillRect((d.cuePoint / d.duration) * w, 0, 2, h)
    }
  }, [deck, props.position, bpm])

  return (
    <section className={`booth-deck booth-deck-${id}`}>
      <header className="booth-deck-head">
        <span className="booth-deck-id">{id}</span>
        <button className="booth-deck-load" onClick={props.onPick}>
          {props.loading ? 'Loading…' : track ? track.title : `Load deck ${id}`}
        </button>
      </header>
      <div className="booth-deck-meta">
        <span className="booth-deck-artist">{track?.artist || '—'}</span>
        <span className="booth-deck-nums">
          {effBpm ? effBpm.toFixed(1) : '—'} BPM
          {props.rate !== 1 && <em className="booth-deck-drift"> {props.rate > 1 ? '+' : ''}{((props.rate - 1) * 100).toFixed(1)}%</em>}
          {track?.camelotKey && <span className="booth-deck-key">{track.camelotKey}</span>}
        </span>
      </div>

      <div className="booth-wave-wrap">
        <canvas ref={canvasRef} className="booth-wave" />
        {!track && <div className="booth-wave-empty">no track loaded</div>}
      </div>

      <div className="booth-transport">
        <button className="booth-btn" onClick={props.onCue} disabled={!track}>CUE</button>
        <button className="booth-btn booth-btn-play" onClick={props.onPlay} disabled={!track}>
          {props.playing ? 'PAUSE' : 'PLAY'}
        </button>
        <button className="booth-btn" onClick={props.onSync} disabled={!track}>SYNC</button>
      </div>

      <label className="booth-tempo">
        <span className="booth-tempo-label">TEMPO</span>
        <input
          type="range" min={0.92} max={1.08} step={0.001} value={props.rate}
          onChange={(e) => props.onRate(Number(e.target.value))}
          disabled={!track} aria-label={`Deck ${id} tempo`}
        />
        <button className="booth-tempo-reset" onClick={() => props.onRate(1)} disabled={!track}>0</button>
      </label>

      <div className="booth-eq">
        {(['high', 'mid', 'low'] as const).map((band) => (
          <button
            key={band}
            className={`booth-eq-kill${props.kills[band] ? ' is-killed' : ''}`}
            onClick={() => props.onKill(band)}
            disabled={!track}
          >
            {band.toUpperCase()}
          </button>
        ))}
      </div>

      <label className="booth-filter">
        <span className="booth-filter-label">FILTER</span>
        <input
          type="range" min={-1} max={1} step={0.01} value={props.filterAmt}
          onChange={(e) => props.onFilter(Number(e.target.value))}
          disabled={!track} aria-label={`Deck ${id} filter`}
        />
      </label>
    </section>
  )
}
