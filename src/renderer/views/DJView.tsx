import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import type { Track } from '../types'
import { DJEngine, type DeckId } from '../dj/engine'
import { beatsInRange, camelotCompatible, tempoDistance, phaseDelta, secondsToNextPhrase, beatPeriod } from '../dj/beatgrid'
import { advise, type DeckReading } from '../dj/coach'
import {
  gradeOnBoundary, gradePhase, summarise, type MoveGrade,
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
  // A run scores the MIX, not a reflex game: each real move is graded as it
  // happens, so a good score and a good mix are the same event.
  const [challenge, setChallenge] = useState(false)
  const [grades, setGrades] = useState<MoveGrade[]>([])
  const [lastGrade, setLastGrade] = useState<MoveGrade | null>(null)
  const [summary, setSummary] = useState<ReturnType<typeof summarise> | null>(null)

  const [picker, setPicker] = useState<DeckId | null>(null)
  const [query, setQuery] = useState('')
  // Lesson is the DEFAULT. The console — two decks, tempo, three-band EQ,
  // filter, crossfader, all live at once — is a cockpit, and every control on
  // it can wreck the sound. Someone learning needs one thing at a time; the
  // full desk is there for when they want it, not before.
  const [mode, setMode] = useState<'lesson' | 'console'>('lesson')
  const [browse, setBrowse] = useState('')
  const [onlyCompatible, setOnlyCompatible] = useState(false)

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
  const liveDeckRef = useRef<DeckId>('A')
  // gradeMove is defined further down (it needs liveDeck); the transport
  // callbacks above reach it through a ref rather than being reordered, which
  // keeps every other dependency chain intact.
  const gradeMoveRef = useRef<((m: 'bring-in' | 'bass-swap') => void) | null>(null)
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
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ready, challenge])

  const absPathFor = useCallback((t: Track): string => {
    return musicRoot + String(t.path || '').replace(/:/g, '/')
  }, [musicRoot])

  // ── drag a track onto a deck ─────────────────────────────────────────────
  // Every real DJ program works this way: the library sits under the decks and
  // you throw a record onto whichever one is free. Clicking a row to load works
  // too, but drag is the gesture people already have in their hands.
  //
  // Custom MIME rather than text/plain: the songs list already puts a row key
  // on text/plain for its own reordering, and a deck accepting that would try
  // to load whatever happened to be dragged past it.
  const DRAG_TYPE = 'application/x-jaketunes-dj-track'

  const onTrackDragStart = useCallback((t: Track, e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, String(t.id))
    e.dataTransfer.effectAllowed = 'copy'
  }, [])

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

  const [dragOver, setDragOver] = useState<DeckId | null>(null)
  const onDeckDragOver = useCallback((id: DeckId, e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()                 // without this the drop never fires
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(id)
  }, [])
  const onDeckDrop = useCallback((id: DeckId, e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(null)
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    const t = tracks.find((x) => x.id === Number(raw))
    if (t) void loadDeck(id, t)
  }, [tracks, loadDeck])

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
    else {
      hushLibrary()
      // Starting the deck that ISN'T live is the bring-in — the graded move.
      if (id !== liveDeckRef.current) gradeMoveRef.current?.('bring-in')
      d.play()
    }
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
    // Killing the LOW on the live deck is the bass swap — the moment the mix
    // turns over, and the move worth grading.
    if (band === 'low' && id === liveDeckRef.current) gradeMoveRef.current?.('bass-swap')
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
  const startChallenge = useCallback(() => {
    setGrades([])
    setLastGrade(null)
    setSummary(null)
    setChallenge(true)
  }, [])

  const stopChallenge = useCallback(() => {
    setChallenge(false)
    setSummary(summarise(grades))
  }, [grades])

  /**
   * Grade a move at the instant it happens.
   *
   * Hooked to the REAL controls rather than to a separate prompt chart, so
   * there is no way to score well without having actually mixed. `live` is the
   * deck the crowd is hearing; every move is measured against its block grid.
   */
  const gradeMove = useCallback((move: 'bring-in' | 'bass-swap') => {
    const e = engineRef.current
    if (!e || !challenge) return
    const live = e.deck(liveDeckRef.current)
    if (!live.bpm) return
    const block = beatPeriod(live.bpm) * 16
    const toBoundary = secondsToNextPhrase(live.position, live.bpm, live.beatOffset)
    const g = gradeOnBoundary(move, toBoundary, block)
    setGrades((prev) => [...prev, g])
    setLastGrade(g)

    // Bringing a track in is two skills at once: WHEN you started it, and
    // whether the beats were together when you did. Grade both or the lesson
    // is only half taught.
    if (move === 'bring-in') {
      const inc = e.deck(liveDeckRef.current === 'A' ? 'B' : 'A')
      if (inc.bpm) {
        const pg = gradePhase(phaseDelta(
          live.position, live.bpm, live.beatOffset,
          inc.position, inc.bpm, inc.beatOffset,
        ))
        setGrades((prev) => [...prev, pg])
        setLastGrade(pg)
      }
    }
  }, [challenge])
  gradeMoveRef.current = gradeMove

  // ── nudge (pitch bend) ───────────────────────────────────────────────────
  // Held, not toggled. This is the motion that fixes PHASE without touching
  // TEMPO, and it is the one thing in DJing that can only be learned by feel,
  // so it has to behave like a finger on a platter rather than like a setting.
  const [bending, setBending] = useState<Record<DeckId, -1 | 0 | 1>>({ A: 0, B: 0 })
  const startBend = useCallback((id: DeckId, dir: -1 | 1) => {
    const e = engineRef.current
    if (!e) return
    e.startBend(id, dir)
    setBending((s) => ({ ...s, [id]: dir }))
  }, [])
  const endBend = useCallback((id: DeckId) => {
    const e = engineRef.current
    if (!e) return
    e.endBend(id)
    setBending((s) => ({ ...s, [id]: 0 }))
  }, [])

  // ── keyboard: this is the instrument ─────────────────────────────────────
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return
      // Modified keys stay with the app -- Cmd-F, Cmd-Q and friends are not ours.
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return
      const k = ev.key.toLowerCase()
      const claim = () => { ev.preventDefault(); ev.stopPropagation() }

      if (k === 'q') { claim(); void togglePlay('A') }
      else if (k === 'p') { claim(); void togglePlay('B') }
      else if (k === 'w') { claim(); cue('A') }
      else if (k === 'o') { claim(); cue('B') }
      else if (k === 's') { claim(); doSync('A') }
      else if (k === 'l') { claim(); doSync('B') }
      else if (ev.key === 'ArrowLeft') { claim(); moveXfader(Math.max(-1, xfader - 0.1)) }
      else if (ev.key === 'ArrowRight') { claim(); moveXfader(Math.min(1, xfader + 0.1)) }
      else if (k === 'z') { claim(); if (!ev.repeat) startBend('A', -1) }
      else if (k === 'x') { claim(); if (!ev.repeat) startBend('A', 1) }
      else if (k === ',') { claim(); if (!ev.repeat) startBend('B', -1) }
      else if (k === '.') { claim(); if (!ev.repeat) startBend('B', 1) }
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
    const onKeyUp = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase()
      if (k === 'z' || k === 'x') endBend('A')
      else if (k === ',' || k === '.') endBend('B')
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      // A bend still held when the view unmounts would leave the deck
      // permanently detuned. Release both on the way out.
      endBend('A'); endBend('B')
    }
  }, [togglePlay, cue, doSync, moveXfader, xfader, startBend, endBend])

  // ── what the coach sees ──────────────────────────────────────────────────
  // "Live" is whichever deck the crossfader is currently favouring; the other
  // one is what you are bringing in. With only one running, that one is live.
  const readingFor = useCallback((id: DeckId): DeckReading => {
    const e = engineRef.current
    const d = e?.deck(id)
    return {
      loaded: !!loaded[id],
      playing: !!playing[id],
      position: pos[id],
      bpm: d?.bpm ?? 0,
      beatOffset: d?.beatOffset ?? 0,
      rate: rate[id],
      camelotKey: loaded[id]?.camelotKey,
      bassKilled: kills[id].low,
    }
  }, [loaded, playing, pos, rate, kills])

  const liveDeck: DeckId = useMemo(() => {
    if (playing.A && !playing.B) return 'A'
    if (playing.B && !playing.A) return 'B'
    return xfader <= 0 ? 'A' : 'B'
  }, [playing.A, playing.B, xfader])
  const incomingDeck: DeckId = liveDeck === 'A' ? 'B' : 'A'
  liveDeckRef.current = liveDeck

  const coach = useMemo(
    () => advise(readingFor(liveDeck), readingFor(incomingDeck)),
    [readingFor, liveDeck, incomingDeck],
  )

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

  // Crate: what you drag from. Capped at 120 rows — this is a browse-and-grab
  // list, not the full library view, and rendering 8,800 draggable rows would
  // cost more than it gives.
  // One list, not two. Search and "only what mixes" are filters ON the crate
  // rather than a separate suggestions section further down the page — the
  // library has to be reachable without scrolling past everything else.
  const crateRows = useMemo(() => {
    const q = browse.trim().toLowerCase()
    const base = onlyCompatible && suggestions.length > 0 ? suggestions : tracks
    const pool = q
      ? base.filter((t) =>
          String(t.title || '').toLowerCase().includes(q) ||
          String(t.artist || '').toLowerCase().includes(q) ||
          String(t.album || '').toLowerCase().includes(q))
      : base
    return pool.slice(0, 300)
  }, [tracks, browse, onlyCompatible, suggestions])


  return (
    <div className="booth-view">
      <header className="booth-header">
        <h1 className="booth-title">DJ</h1>
        <div className="booth-header-right">
          <button
            className="booth-mode-toggle"
            onClick={() => setMode((m) => (m === 'lesson' ? 'console' : 'lesson'))}
          >
            {mode === 'lesson' ? 'Show all controls' : 'Back to lesson'}
          </button>
          {challenge ? (
            <>
              <div className="booth-score">
                <span className="booth-score-value">{grades.reduce((a, g) => a + g.points, 0).toLocaleString()}</span>
                <span className="booth-score-meta">
                  {grades.length} move{grades.length === 1 ? '' : 's'} graded
                </span>
              </div>
              <button className="booth-btn booth-btn-stop" onClick={stopChallenge}>End run</button>
            </>
          ) : (
            <button
              className="booth-btn booth-btn-challenge"
              disabled={!loaded.A && !loaded.B}
              onClick={startChallenge}
            >
              Challenge
            </button>
          )}
        </div>
      </header>

      {err && <div className="booth-error" role="alert">{err}</div>}


      {mode === 'lesson' ? (
        <LessonStage
          advice={coach}
          live={liveDeck}
          incoming={incomingDeck}
          loaded={loaded}
          playing={playing}
          kills={kills}
          bending={bending[incomingDeck]}
          crate={crateRows}
          browse={browse}
          onBrowse={setBrowse}
          onLoad={loadDeck}
          onSync={() => doSync(incomingDeck)}
          onPlayIncoming={() => void togglePlay(incomingDeck)}
          onPlayLive={() => void togglePlay(loaded[liveDeck] ? liveDeck : incomingDeck)}
          onKill={toggleKill}
          onNudge={startBend}
          onNudgeEnd={endBend}
          onDragStart={onTrackDragStart}
        />
      ) : (
      <>
      <CoachPanel
        advice={coach}
        incoming={incomingDeck}
        onNudge={startBend}
        onNudgeEnd={endBend}
        bending={bending[incomingDeck]}
      />

      <div className="booth-decks">
        {(['A', 'B'] as DeckId[]).map((id) => (
          <DeckPanel
            key={id}
            id={id}
            dragOver={dragOver === id}
            onDragOver={(e) => onDeckDragOver(id, e)}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => onDeckDrop(id, e)}
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

      <section className="booth-crate">
        <div className="booth-crate-head">
          <h2 className="booth-crate-title">Your crate</h2>
          <input
            className="booth-crate-search"
            placeholder="Search your library…"
            value={browse}
            onChange={(e) => setBrowse(e.target.value)}
          />
          {suggestions.length > 0 && (
            <label className="booth-crate-filter">
              <input
                type="checkbox"
                checked={onlyCompatible}
                onChange={(e) => setOnlyCompatible(e.target.checked)}
              />
              mixes with what is playing
            </label>
          )}
          <span className="booth-crate-hint">drag onto a deck · double-click loads the free one</span>
        </div>
        <ul className="booth-crate-list">
          {crateRows.map((t) => (
            <li key={t.id}>
              <div
                className="booth-crate-item"
                draggable
                onDragStart={(e) => onTrackDragStart(t, e)}
                onDoubleClick={() => void loadDeck(loaded.A ? 'B' : 'A', t)}
              >
                <span className="booth-crate-name">{t.title}</span>
                <span className="booth-crate-artist">{t.artist}</span>
                <span className="booth-crate-meta">
                  {t.bpm ? Math.round(Number(t.bpm)) : '—'} · {t.camelotKey || '—'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>




      </>
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
                    draggable
                    onDragStart={(e) => onTrackDragStart(t, e)}
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

// ── lesson stage ───────────────────────────────────────────────────────────
/**
 * One step. One control. Nothing else on screen.
 *
 * The console shows every control at once, which is right for someone who
 * already knows what they all do and wrong for everyone else — it reads as a
 * wall where any button might ruin the sound. This shows the single control the
 * current step needs, at a size you cannot miss, with the reason underneath.
 *
 * It drives off the SAME coach advice as the console, so the two can never
 * disagree about what to do next.
 */
function LessonStage(props: {
  advice: ReturnType<typeof advise>
  live: DeckId
  incoming: DeckId
  loaded: Record<DeckId, Track | null>
  playing: Record<DeckId, boolean>
  kills: Record<DeckId, Record<'low' | 'mid' | 'high', boolean>>
  bending: -1 | 0 | 1
  crate: Track[]
  browse: string
  onBrowse: (v: string) => void
  onLoad: (id: DeckId, t: Track) => void
  onSync: () => void
  onPlayIncoming: () => void
  onPlayLive: () => void
  onKill: (id: DeckId, band: 'low' | 'mid' | 'high') => void
  onNudge: (id: DeckId, dir: -1 | 1) => void
  onNudgeEnd: (id: DeckId) => void
  onDragStart: (t: Track, e: React.DragEvent) => void
}) {
  const a = props.advice
  const step = a.step
  // 'idle' covers two different situations: nothing loaded yet (pick a song),
  // and something loaded but stopped (press play). Treating both as "pick a
  // song" left the stage telling you to press play with no button on it.
  const anyLoaded = !!props.loaded.A || !!props.loaded.B
  const needsTrack = step === 'load' || (step === 'idle' && !anyLoaded)
  const needsStart = step === 'idle' && anyLoaded
  const drift = a.drift ?? 0
  const pct = 50 + Math.max(-0.5, Math.min(0.5, drift)) * 100
  const locked = a.drift !== undefined && step !== 'phase'

  // Which deck the step's control belongs to. The bass swap acts on the track
  // that is currently out there; everything else acts on the one coming in.
  const target = step === 'bass-swap' ? props.live : props.incoming

  return (
    <div className="lesson">
      <div className="lesson-now">
        {(['A', 'B'] as DeckId[]).map((d) => (
          <span key={d} className={`lesson-now-deck${props.playing[d] ? ' is-playing' : ''}`}>
            <em>{d}</em>
            {props.loaded[d] ? props.loaded[d]!.title : 'empty'}
          </span>
        ))}
      </div>

      <p className="lesson-instruction">{a.instruction}</p>
      <p className="lesson-why">{a.why}</p>

      {typeof a.countdown === 'number' && Number.isFinite(a.countdown) && (
        <div className="lesson-count">
          <span className="lesson-count-num">{a.countdown.toFixed(1)}</span>
          <span className="lesson-count-label">seconds — go when this hits zero</span>
        </div>
      )}

      {needsStart && (
        <button className="lesson-action" onClick={props.onPlayLive}>
          PLAY deck {props.loaded[props.live] ? props.live : props.incoming}
        </button>
      )}

      {step === 'tempo' && (
        <button className="lesson-action" onClick={props.onSync}>SYNC</button>
      )}

      {step === 'cue' && (
        <button className="lesson-action" onClick={props.onPlayIncoming}>
          PLAY deck {props.incoming}
        </button>
      )}

      {step === 'phase' && (
        <div className="lesson-phase">
          <div className="lesson-meter">
            <div className="lesson-meter-centre" />
            <div
              className={`lesson-meter-marker${locked ? ' is-locked' : ''}`}
              style={{ left: `${pct}%` }}
            />
          </div>
          <div className="lesson-nudge">
            <button
              className={`lesson-action lesson-action-wide${props.bending === -1 ? ' is-on' : ''}`}
              onMouseDown={() => props.onNudge(props.incoming, -1)}
              onMouseUp={() => props.onNudgeEnd(props.incoming)}
              onMouseLeave={() => props.onNudgeEnd(props.incoming)}
            >
              − SLOW IT
            </button>
            <button
              className={`lesson-action lesson-action-wide${props.bending === 1 ? ' is-on' : ''}`}
              onMouseDown={() => props.onNudge(props.incoming, 1)}
              onMouseUp={() => props.onNudgeEnd(props.incoming)}
              onMouseLeave={() => props.onNudgeEnd(props.incoming)}
            >
              SPEED IT +
            </button>
          </div>
        </div>
      )}

      {(step === 'bring-in' || step === 'bass-swap') && (
        <button
          className={`lesson-action${props.kills[target].low ? ' is-on' : ''}`}
          onClick={() => props.onKill(target, 'low')}
        >
          {props.kills[target].low ? 'BASS IS OFF' : 'TURN BASS OFF'} — deck {target}
        </button>
      )}

      {needsTrack && (
        <div className="lesson-pick">
          <input
            className="lesson-pick-search"
            placeholder="Search your songs…"
            value={props.browse}
            onChange={(e) => props.onBrowse(e.target.value)}
          />
          <ul className="lesson-pick-list">
            {props.crate.slice(0, 60).map((t) => (
              <li key={t.id}>
                <button
                  className="lesson-pick-item"
                  draggable
                  onDragStart={(e) => props.onDragStart(t, e)}
                  onClick={() => props.onLoad(props.loaded[props.live] ? props.incoming : props.live, t)}
                >
                  <span className="lesson-pick-name">{t.title}</span>
                  <span className="lesson-pick-artist">{t.artist}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── the coach ──────────────────────────────────────────────────────────────
/**
 * One instruction at a time, plus the reason for it.
 *
 * The "why" line is the part that actually teaches. A prompt that says "press
 * SYNC" trains a button-press; the same prompt with "match tempo first, or any
 * alignment you make drifts apart within a bar" trains the reasoning, and the
 * reasoning is what transfers to real equipment.
 */
function CoachPanel(props: {
  advice: ReturnType<typeof advise>
  incoming: DeckId
  bending: -1 | 0 | 1
  onNudge: (id: DeckId, dir: -1 | 1) => void
  onNudgeEnd: (id: DeckId) => void
}) {
  const { advice: a, incoming } = props
  const drift = a.drift ?? 0
  const locked = a.step !== 'phase' && a.drift !== undefined
  // Meter spans +/- half a beat; clamp so a wild reading can't leave the box.
  const pct = 50 + Math.max(-0.5, Math.min(0.5, drift)) * 100

  return (
    <section className={`booth-coach booth-coach-${a.step}`}>
      <div className="booth-coach-main">
        <span className="booth-coach-step">{a.step.replace('-', ' ')}</span>
        <p className="booth-coach-instruction">{a.instruction}</p>
        <p className="booth-coach-why">{a.why}</p>
      </div>

      <div className="booth-coach-side">
        {typeof a.countdown === 'number' && Number.isFinite(a.countdown) && (
          <div className="booth-coach-count">
            <span className="booth-coach-count-num">{a.countdown.toFixed(1)}s</span>
            <span className="booth-coach-count-label">til drop-in point</span>
          </div>
        )}

        {a.drift !== undefined && (
          <div className="booth-align">
            <div className="booth-align-scale">
              <span className="booth-align-edge">slow</span>
              <span className="booth-align-edge">fast</span>
            </div>
            <div className="booth-align-track">
              <div className="booth-align-centre" />
              <div
                className={`booth-align-marker${locked ? ' is-locked' : ''}`}
                style={{ left: `${pct}%` }}
              />
            </div>
            <span className={`booth-align-read${locked ? ' is-locked' : ''}`}>
              {locked ? 'IN PHASE' : `${drift > 0 ? '+' : ''}${drift.toFixed(2)} beat`}
            </span>
          </div>
        )}

        <div className="booth-nudge">
          <button
            className={`booth-nudge-btn${props.bending === -1 ? ' is-on' : ''}`}
            onMouseDown={() => props.onNudge(incoming, -1)}
            onMouseUp={() => props.onNudgeEnd(incoming)}
            onMouseLeave={() => props.onNudgeEnd(incoming)}
          >
            − NUDGE
          </button>
          <span className="booth-nudge-deck">deck {incoming}</span>
          <button
            className={`booth-nudge-btn${props.bending === 1 ? ' is-on' : ''}`}
            onMouseDown={() => props.onNudge(incoming, 1)}
            onMouseUp={() => props.onNudgeEnd(incoming)}
            onMouseLeave={() => props.onNudgeEnd(incoming)}
          >
            NUDGE +
          </button>
        </div>
      </div>
    </section>
  )
}

// ── one deck ───────────────────────────────────────────────────────────────
function DeckPanel(props: {
  id: DeckId
  dragOver: boolean
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
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
    ctx.fillStyle = '#F9864C'
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
    <section
      className={`booth-deck booth-deck-${id}${props.dragOver ? ' is-drag-over' : ''}`}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
    >
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
        {!track && <div className="booth-wave-empty">{props.dragOver ? 'drop to load' : 'drag a track here'}</div>}
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
