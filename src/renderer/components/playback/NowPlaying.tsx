import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useAudio } from '../../hooks/useAudio'
import { subscribe, getSnapshot, getRip, getSync, getImport, getNotice } from '../../activity'
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

type PillMode = 'playing' | 'rip' | 'sync' | 'import' | 'notice'

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
  // background work (CD rip / iPod sync / drag-drop import / transient
  // notice) in addition to the currently playing track — matches
  // iTunes 7 behavior where a tiny arrow button let the user cycle the
  // LCD between now-playing and import/sync status when multiple
  // things were happening.
  useSyncExternalStore(subscribe, getSnapshot)
  const rip = getRip()
  const syn = getSync()
  const imp = getImport()
  const notice = getNotice()
  const ripActive = !!rip?.active
  const syncActive = !!syn?.active
  const importActive = !!imp?.active
  const noticeActive = !!notice

  // Which modes have anything to show right now?
  const available: PillMode[] = []
  if (track) available.push('playing')
  if (ripActive) available.push('rip')
  if (syncActive) available.push('sync')
  if (importActive) available.push('import')
  if (noticeActive) available.push('notice')

  const [mode, setMode] = useState<PillMode>('playing')

  // Auto-follow rule: when any non-playing activity STARTS, switch the
  // pill to show it. Notices are transient (auto-clear at 4 s) so they
  // beat everything else while shown; otherwise priority is sync > rip
  // > import > playing. User cycle override still works in between —
  // clicking the arrow locks the pill to their chosen mode until that
  // mode disappears from `available`.
  const prevRipRef = useRef(ripActive)
  const prevSyncRef = useRef(syncActive)
  const prevImportRef = useRef(importActive)
  const prevNoticeRef = useRef(noticeActive)
  useEffect(() => {
    if (noticeActive && !prevNoticeRef.current) setMode('notice')
    else if (syncActive && !prevSyncRef.current) setMode('sync')
    else if (ripActive && !prevRipRef.current) setMode('rip')
    else if (importActive && !prevImportRef.current) setMode('import')
    prevRipRef.current = ripActive
    prevSyncRef.current = syncActive
    prevImportRef.current = importActive
    prevNoticeRef.current = noticeActive
  }, [ripActive, syncActive, importActive, noticeActive])

  // Also: if the current mode disappears from the available set
  // (e.g. sync ended and nothing else is selected), fall through to
  // the best remaining option.
  useEffect(() => {
    if (available.length === 0) return
    if (!available.includes(mode)) {
      const priority: PillMode[] = ['notice', 'sync', 'rip', 'import', 'playing']
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
  // When nothing is playing and nothing's syncing/ripping/importing,
  // pill is empty (matches idle iTunes LCD). If the selected mode
  // isn't available (e.g. a notice fired while we were on 'playing'
  // with no track), fall through to the highest-priority available
  // mode so we don't flash an empty pill before the auto-follow effect
  // catches up.
  const effectiveMode: PillMode | null = available.length === 0 ? null :
    (available.includes(mode) ? mode : (
      (['notice', 'sync', 'rip', 'import', 'playing'] as PillMode[]).find(m => available.includes(m)) || available[0]
    ))

  // Activity modes (rip / sync / import / notice) get tighter symmetric
  // padding (16 px) for slightly more text room. Playing mode uses the
  // base symmetric padding from toolbar.css (4.4.43: 22 px after the
  // mini-visualizer was retired).
  const isActivity = effectiveMode === 'rip' || effectiveMode === 'sync' || effectiveMode === 'import' || effectiveMode === 'notice'

  return (
    <div className={`now-playing-pill ${isActivity ? 'now-playing-pill--activity' : ''}`}>
      {showCycle && (
        <button className="np-cycle-btn" onClick={cycleMode} title="Toggle display">
          <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
            <path d="M5 1 L8 4 L2 4 Z M5 11 L2 8 L8 8 Z" fill="#5a5540" />
          </svg>
        </button>
      )}
      {effectiveMode === 'playing' && track ? (
        <>
          {/* 4.4.41: MiniVisualizer removed. Jake: "get rid of the
              visualizer on the far right it is useless and kills
              battery". The rAF loop computed RMS from the audio
              waveform every frame — ~60fps continuously while
              playing — which kept the renderer's compositor busy
              for a 60×8px squiggle nobody used. Component definition
              kept above in case it gets revived; just not rendered. */}
          <div className="now-playing-info">
            <span className="now-playing-title">{track.title}</span>
            <span className="now-playing-sep"> — </span>
            <span className="now-playing-artist">{track.artist}</span>
            {track.album && <span className="now-playing-sep"> — </span>}
            {track.album && <span className="now-playing-album">{track.album}</span>}
          </div>
          <div className="scrubber-row">
            {/* Brief 025: floor position + duration ONCE, then compute
                remaining as their integer difference, so the count-up and
                countdown labels never drift apart by the ~half-second
                rounding asymmetry. Pre-fix: formatTime(position) floored
                position, formatTime(duration - position) floored AFTER
                subtraction — e.g. position=4.6 / duration=75.4 produced
                "0:04" + "-1:10" while the actual duration read as 1:15.
                Fix keeps position + |remaining| === floor(duration) at
                every render. Math.max(0, ...) clamps the countdown to
                -0:00 when position briefly overshoots duration near
                track end. Strictly read-only; the scrubber drag-logic
                seam (handleMouseDown, barRef) on the next line is
                untouched per the do-not-touch list. */}
            <span className="scrubber-time">{formatTime(Math.floor(state.position))}</span>
            <div className="scrubber-track" ref={barRef} onMouseDown={handleMouseDown}>
              <div className="scrubber-fill" style={{ width: `${progress}%` }} />
              <div className="scrubber-knob" style={{ left: `${progress}%` }} />
            </div>
            <span className="scrubber-time">-{formatTime(Math.max(0, Math.floor(state.duration) - Math.floor(state.position)))}</span>
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
      ) : effectiveMode === 'import' && imp ? (
        <>
          <div className="now-playing-info now-playing-info--activity">
            <span className="now-playing-title">Importing {imp.current} of {imp.total}</span>
            {imp.trackTitle && <><span className="now-playing-sep"> — </span>
            <span className="now-playing-artist">{imp.trackTitle}</span></>}
            {imp.errors > 0 && <span className="now-playing-error"> ({imp.errors} failed)</span>}
          </div>
          <div className="scrubber-row">
            <div className="activity-bar">
              <div className="activity-bar-fill" style={{ width: `${(imp.barFraction ?? imp.current / Math.max(1, imp.total)) * 100}%` }} />
            </div>
          </div>
        </>
      ) : effectiveMode === 'notice' && notice ? (
        <>
          <div className={`now-playing-info now-playing-info--activity now-playing-info--notice-${notice.kind}`}>
            <span className="now-playing-title">{notice.kind === 'error' ? 'Notice' : 'JakeTunes'}</span>
            <span className="now-playing-sep"> — </span>
            <span className="now-playing-artist">{notice.message}</span>
          </div>
          <div className="scrubber-row">
            <div className="activity-bar">
              <div className="activity-bar-fill activity-bar-fill--indeterminate" />
            </div>
          </div>
        </>
      ) : (
        <div className="now-playing-empty" />
      )}
    </div>
  )
}
