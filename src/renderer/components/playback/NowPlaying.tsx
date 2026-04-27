import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useAudio } from '../../hooks/useAudio'
import { subscribe, getSnapshot, getRip, getSync } from '../../activity'
import { getVisualizerWaveform } from '../../audio/eq'

const HISTORY_LENGTH = 60   // pixels of scrolling loudness history
const SAMPLE_FRAMES  = 256  // samples averaged per frame for RMS

/** Mini visualizer — EKG-style scrolling loudness trace. Each rAF
 *  tick computes the RMS amplitude of the current audio snapshot and
 *  pushes it into a circular history buffer; the canvas redraws the
 *  buffer as a polyline that scrolls right-to-left. Quiet passages →
 *  flat baseline; transients → upward spikes. */
function MiniVisualizer({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const historyRef = useRef<Float32Array>(new Float32Array(HISTORY_LENGTH))
  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Honor device pixel ratio for crisp 1 px lines on retina.
    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr
      canvas.height = cssH * dpr
      ctx.scale(dpr, dpr)
    }

    let raf = 0
    const tick = (now: DOMHighResTimeStamp) => {
      // Compute current RMS amplitude (0..1) from the audio snapshot.
      // Procedural breath when the audio chain isn't ready yet.
      const wave = getVisualizerWaveform(SAMPLE_FRAMES)
      let rms = 0
      if (wave) {
        let sumSq = 0
        for (let i = 0; i < wave.length; i++) {
          const v = (wave[i] - 128) / 128
          sumSq += v * v
        }
        rms = Math.sqrt(sumSq / wave.length)
      } else {
        rms = 0.04 + Math.abs(Math.sin(now / 250)) * 0.03
      }
      const value = Math.min(1, rms * 2.4)

      // Shift history left, append new sample at the tail.
      const hist = historyRef.current
      for (let i = 0; i < hist.length - 1; i++) hist[i] = hist[i + 1]
      hist[hist.length - 1] = value

      ctx.clearRect(0, 0, cssW, cssH)
      ctx.strokeStyle = '#5a5540'
      ctx.lineWidth = 1
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      // Baseline at 75% of canvas height — trace lives toward the
      // bottom, peaks shoot up like an EKG.
      const baseline = cssH * 0.75
      const headroom = baseline - 1
      for (let i = 0; i < hist.length; i++) {
        const x = (i / (hist.length - 1)) * cssW
        const y = baseline - hist[i] * headroom
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])
  return <canvas ref={canvasRef} className="mini-viz" aria-hidden />
}

type PillMode = 'playing' | 'rip' | 'sync'

function formatTime(s: number): string {
  if (!s || s < 0) return '0:00'
  const mins = Math.floor(s / 60)
  const secs = Math.floor(s % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function NowPlaying() {
  const { state } = usePlayback()
  const { seek } = useAudio()
  const barRef = useRef<HTMLDivElement>(null)

  const getPercent = useCallback((clientX: number) => {
    if (!barRef.current) return 0
    const rect = barRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (state.duration <= 0) return
    seek(getPercent(e.clientX))

    const onMove = (ev: MouseEvent) => seek(getPercent(ev.clientX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [seek, state.duration, getPercent])

  const progress = state.duration > 0 ? (state.position / state.duration) * 100 : 0
  const track = state.nowPlaying

  // Subscribe to the global activity store so this pill can surface
  // background work (CD rip / iPod sync) in addition to the currently
  // playing track — matches iTunes 7 behavior where a tiny arrow
  // button let the user cycle the LCD between now-playing and
  // import/sync status when multiple things are happening.
  useSyncExternalStore(subscribe, getSnapshot)
  const rip = getRip()
  const syn = getSync()
  const ripActive = !!rip?.active
  const syncActive = !!syn?.active

  // Which modes have anything to show right now?
  const available: PillMode[] = []
  if (track) available.push('playing')
  if (ripActive) available.push('rip')
  if (syncActive) available.push('sync')

  const [mode, setMode] = useState<PillMode>('playing')

  // Auto-follow rule: when a rip or sync STARTS, switch the pill to
  // show it (that's always the most interesting thing to surface).
  // When it ends, fall back to whatever's still active with the same
  // priority (sync > rip > playing). User cycle override still works
  // in between — clicking the arrow locks the pill to their chosen
  // mode until the mode disappears from `available`.
  const prevRipRef = useRef(ripActive)
  const prevSyncRef = useRef(syncActive)
  useEffect(() => {
    if (syncActive && !prevSyncRef.current) setMode('sync')
    else if (ripActive && !prevRipRef.current) setMode('rip')
    prevRipRef.current = ripActive
    prevSyncRef.current = syncActive
  }, [ripActive, syncActive])

  // Also: if the current mode disappears from the available set
  // (e.g. sync ended and nothing else is selected), fall through to
  // the best remaining option.
  useEffect(() => {
    if (available.length === 0) return
    if (!available.includes(mode)) {
      // Priority: sync > rip > playing
      const priority: PillMode[] = ['sync', 'rip', 'playing']
      const next = priority.find(m => available.includes(m)) || available[0]
      setMode(next)
    }
  }, [available.join('|'), mode])  // eslint-disable-line react-hooks/exhaustive-deps

  const cycleMode = useCallback(() => {
    if (available.length <= 1) return
    const idx = available.indexOf(mode)
    const nextIdx = (idx + 1) % available.length
    setMode(available[nextIdx])
  }, [mode, available])

  const showCycle = available.length > 1
  // When nothing is playing and nothing's syncing/ripping, pill is
  // empty (matches idle iTunes LCD).
  const effectiveMode: PillMode | null = available.length === 0 ? null :
    (available.includes(mode) ? mode : 'playing')

  return (
    <div className="now-playing-pill">
      {showCycle && (
        <button className="np-cycle-btn" onClick={cycleMode} title="Toggle display">
          <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
            <path d="M5 1 L8 4 L2 4 Z M5 11 L2 8 L8 8 Z" fill="#5a5540" />
          </svg>
        </button>
      )}
      {effectiveMode === 'playing' && track ? (
        <>
          <MiniVisualizer active={state.isPlaying} />
          <div className="now-playing-info">
            <span className="now-playing-title">{track.title}</span>
            <span className="now-playing-sep"> — </span>
            <span className="now-playing-artist">{track.artist}</span>
            {track.album && <span className="now-playing-sep"> — </span>}
            {track.album && <span className="now-playing-album">{track.album}</span>}
          </div>
          <div className="scrubber-row">
            <span className="scrubber-time">{formatTime(state.position)}</span>
            <div className="scrubber-track" ref={barRef} onMouseDown={handleMouseDown}>
              <div className="scrubber-fill" style={{ width: `${progress}%` }} />
              <div className="scrubber-knob" style={{ left: `${progress}%` }} />
            </div>
            <span className="scrubber-time">-{formatTime(state.duration - state.position)}</span>
          </div>
        </>
      ) : effectiveMode === 'sync' && syn ? (
        <>
          <div className="now-playing-info now-playing-info--activity">
            <span className="now-playing-title">Syncing iPod</span>
            <span className="now-playing-sep"> — </span>
            <span className="now-playing-artist">{syn.step}</span>
          </div>
          <div className="scrubber-row">
            <div className="activity-bar">
              <div className="activity-bar-fill activity-bar-fill--indeterminate" />
            </div>
          </div>
        </>
      ) : effectiveMode === 'rip' && rip ? (
        <>
          <div className="now-playing-info now-playing-info--activity">
            <span className="now-playing-title">Importing {rip.current} of {rip.total}</span>
            {rip.trackTitle && <><span className="now-playing-sep"> — </span>
            <span className="now-playing-artist">{rip.trackTitle}</span></>}
            {rip.errors > 0 && <span className="now-playing-error"> ({rip.errors} skipped)</span>}
          </div>
          <div className="scrubber-row">
            <div className="activity-bar">
              <div className="activity-bar-fill" style={{ width: `${(rip.current / Math.max(1, rip.total)) * 100}%` }} />
            </div>
          </div>
        </>
      ) : (
        <div className="now-playing-empty" />
      )}
    </div>
  )
}
