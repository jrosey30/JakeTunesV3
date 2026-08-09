import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { usePlayback } from '../../context/PlaybackContext'
import { useAudio } from '../../hooks/useAudio'
import { subscribe, getSnapshot, getRip, getSync, getImport, getNotice, getBroadcast, getRadio, getCaptionsOn, setCaptionsOn } from '../../activity'
import { subscribePreview, getPreviewSnapshot, seekPreview } from '../../previewPlayer'
// V5 Live Concert Mode — approved surgical addition (Jake, 2026-07-02):
// map the playhead to the current setlist song while a merged live set
// plays. Store lives OUTSIDE the protected contexts (liveSets.ts).
import { subscribeLiveSets, getLiveSetsSnapshot, ensureLiveSetsLoaded, mergedTrackIndex, cueAt, cueIndexAt } from '../../liveSets'
import { subscribeMixtapes, getTapeSession } from '../../mixtapes'
import { useLibrary } from '../../context/LibraryContext'
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

type PillMode = 'playing' | 'rip' | 'sync' | 'import' | 'notice' | 'broadcast'

/**
 * The importer reports a FILE, not a song — e.g.
 * "terry malts – Nobody Realizes This Is Nowhere – 03 Life's A Dream.m4a".
 * Dumping that into the LCD read as a jammed path (Jake, 2026-08-08: "looks
 * weird and forced"). Split it back into something a person would say.
 * Falls through gracefully: an unparseable name just becomes the title.
 */
function prettyImportName(raw: string): { title: string; artist: string } {
  const noExt = (raw || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim()
  // Both en-dash and hyphen show up as separators, with or without spaces.
  const parts = noExt.split(/\s+[–-]\s+/).map((x) => x.trim()).filter(Boolean)
  const stripNo = (t: string): string => t.replace(/^\d{1,3}[\s._-]+/, '').trim()
  if (parts.length >= 3) return { title: stripNo(parts[parts.length - 1]), artist: parts[0] }
  if (parts.length === 2) return { title: stripNo(parts[1]), artist: parts[0] }
  return { title: stripNo(noExt), artist: '' }
}

function formatTime(s: number): string {
  if (!s || s < 0) return '0:00'
  const total = Math.floor(s)
  const secs = total % 60
  const mins = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  // Roll over to H:MM:SS for hour-long tracks (full live concerts) so a
  // 2½-hour show reads 1:30:00 / -1:30:00, not 155:59. Sub-hour tracks
  // stay M:SS exactly as before — display only, no scrubber-math change.
  return hours > 0
    ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function NowPlaying() {
  const { state } = usePlayback()
  const { seek, togglePlayPause, playTrack } = useAudio()
  const barRef = useRef<HTMLDivElement>(null)
  const previewBarRef = useRef<HTMLDivElement>(null)

  // Brief 122 — the "Listen to the List" preview plays here in the pill
  // (iTunes-style), via a dedicated player kept OUT of the music engine.
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const previewActive = preview.playingId != null
  const previewProgress = preview.duration > 0 ? (preview.position / preview.duration) * 100 : 0

  // V5 Live Concert Mode (approved surgical addition) — when the playing
  // track is a merged live set, derive the current setlist song from the
  // playhead. Zero extra render cost: this component already re-renders
  // on state.position for the scrubber. Everything below this block —
  // including the protected scrubber drag logic — is untouched.
  useSyncExternalStore(subscribeLiveSets, getLiveSetsSnapshot)
  useEffect(() => { void ensureLiveSetsLoaded() }, [])
  const liveEntry = state.nowPlaying ? (mergedTrackIndex().get(state.nowPlaying.id) ?? null) : null
  const liveCue = liveEntry ? cueAt(liveEntry, state.position * 1000) : null

  // MIXTAPES in the pill — THE MERGED TIMELINE (2026-08-08).
  //
  // Jake: "a mix merges the LENGTHS of all the songs in that mix...and you
  // cant skip... you cant start from anywhere either. has to be from the
  // beginning."
  //
  // So a tape is NOT one audio file — the songs stay separate and play as an
  // ordinary queue. What's merged is the CLOCK. While a tape is running the
  // pill stops showing "2:14 of this song" and shows the position and length
  // of the whole tape, so eighteen minutes of music reads as one continuous
  // side rather than eight little ones.
  //
  // (I built this the other way first — actually concatenating the tape into
  // one ALAC and playing that. Wrong: the merged file is an optional EXPORT,
  // not the playback path.)
  //
  // Read-only on purpose. The bar reports where the tape is; it does not
  // accept clicks, because dropping the needle at an arbitrary point is
  // exactly what "has to be from the beginning" rules out. Winding lives on
  // the tape's own page, where FF/REW belong.
  useSyncExternalStore(subscribeMixtapes, getTapeSession)
  const { state: libState } = useLibrary()
  const tapeSession = getTapeSession()
  const tapeOnAir = (() => {
    if (!tapeSession || !state.nowPlaying) return null
    const ids = tapeSession.tapeTrackIds
    const idx = ids.indexOf(state.nowPlaying.id)
    if (idx < 0) return null
    const durOf = (id: number) => libState.tracks.find((t) => t.id === id)?.duration || 0
    let before = 0
    for (let i = 0; i < idx; i++) before += durOf(ids[i])
    const totalMs = ids.reduce((sum, id) => sum + durOf(id), 0)
    return {
      elapsedMs: before + state.position * 1000,
      totalMs,
      slot: idx + 1,
      of: ids.length,
    }
  })()

  // Pause the user's music while a preview plays; resume it when the
  // preview ends/stops (the "pause music, resume after" behavior). Acts
  // only on the preview's start/stop transition — reading isPlaying in
  // deps is safe because the was/now guard ignores plain isPlaying flips.
  const prevPreviewId = useRef<string | null>(null)
  const pausedForPreview = useRef(false)
  useEffect(() => {
    const was = prevPreviewId.current
    const now = preview.playingId
    prevPreviewId.current = now
    if (!was && now) {
      if (state.isPlaying) { pausedForPreview.current = true; togglePlayPause() }
    } else if (was && !now) {
      if (pausedForPreview.current) { pausedForPreview.current = false; togglePlayPause() }
    }
  }, [preview.playingId, state.isPlaying, togglePlayPause])

  const handlePreviewMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (preview.duration <= 0) return
    const pctToSec = (clientX: number) => {
      const el = previewBarRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return pct * preview.duration
    }
    seekPreview(pctToSec(e.clientX))
    const onMove = (ev: MouseEvent) => seekPreview(pctToSec(ev.clientX))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [preview.duration])

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

  // Backlight behavior (2026-08-07, Jake: the iPod-mini experience) — the
  // LCD rests dim and BLOOMS when the track changes or the pill is
  // touched, fading back down after a few seconds. Display-only; the
  // scrubber's drag logic below is untouched.
  const [backlit, setBacklit] = useState(false)
  const backlitTimer = useRef<number | null>(null)
  const bloomBacklight = useCallback(() => {
    setBacklit(true)
    if (backlitTimer.current) window.clearTimeout(backlitTimer.current)
    // ~10s lit in total ('keep the backlight on for a teeny bit longer'):
    // 9.3s held + the 650ms fade-down.
    backlitTimer.current = window.setTimeout(() => setBacklit(false), 9300)
  }, [])
  useEffect(() => {
    if (track?.id != null) bloomBacklight()
  }, [track?.id, bloomBacklight])

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
  const broadcast = getBroadcast()
  const radio = getRadio()
  const captionsOn = getCaptionsOn()
  // 4.5 radioV2: restore the radio-captions toggle from UI state, once on mount.
  useEffect(() => {
    window.electronAPI.loadUiState().then((r) => {
      if (r?.ok && r.state && typeof r.state.radioCC === 'boolean') setCaptionsOn(r.state.radioCC)
    }).catch(() => { /* default: captions on */ })
  }, [])
  const ripActive = !!rip?.active
  const syncActive = !!syn?.active
  const importActive = !!imp?.active
  const noticeActive = !!notice
  const broadcastActive = !!broadcast

  // Which modes have anything to show right now?
  const available: PillMode[] = []
  if (track) available.push('playing')
  if (ripActive) available.push('rip')
  if (syncActive) available.push('sync')
  if (importActive) available.push('import')
  if (noticeActive) available.push('notice')
  if (broadcastActive) available.push('broadcast')

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
  const prevBroadcastRef = useRef(broadcastActive)
  useEffect(() => {
    // Broadcast (live mic / DJ caption) beats everything else while
    // active — it's the user's voice they're listening to right now.
    if (broadcastActive && !prevBroadcastRef.current) setMode('broadcast')
    else if (noticeActive && !prevNoticeRef.current) setMode('notice')
    else if (syncActive && !prevSyncRef.current) setMode('sync')
    else if (ripActive && !prevRipRef.current) setMode('rip')
    else if (importActive && !prevImportRef.current) setMode('import')
    prevRipRef.current = ripActive
    prevSyncRef.current = syncActive
    prevImportRef.current = importActive
    prevNoticeRef.current = noticeActive
    prevBroadcastRef.current = broadcastActive
  }, [ripActive, syncActive, importActive, noticeActive, broadcastActive])

  // Also: if the current mode disappears from the available set
  // (e.g. sync ended and nothing else is selected), fall through to
  // the best remaining option.
  useEffect(() => {
    if (available.length === 0) return
    if (!available.includes(mode)) {
      const priority: PillMode[] = ['broadcast', 'notice', 'sync', 'rip', 'import', 'playing']
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
      (['broadcast', 'notice', 'sync', 'rip', 'import', 'playing'] as PillMode[]).find(m => available.includes(m)) || available[0]
    ))

  // Activity modes (rip / sync / import / notice / broadcast) get tighter
  // symmetric padding (16 px) for more text room. Playing mode uses the
  // base symmetric padding from toolbar.css (4.4.43: 22 px after the
  // mini-visualizer was retired).
  const isActivity = effectiveMode === 'rip' || effectiveMode === 'sync' || effectiveMode === 'import' || effectiveMode === 'notice' || effectiveMode === 'broadcast'

  // 4.5: render a thin "ON AIR · WJLR 330.9 · elapsed / remaining"
  // strip inside the pill whenever Radio Mode is active. Replaces the
  // external red pill that sat awkwardly next to the transport row.
  // Strip is the same color language as the existing radio-on-air-pill
  // (brand orange/red) so the visual ID survives the relocation.
  function formatSec(s: number): string {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = s % 60
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : `${m}:${String(ss).padStart(2, '0')}`
  }
  const radioActive = !!radio?.active
  // 4.5.0-53: two variants of the radio strip.
  //  - HERO: shown when the pill has no other content (no track playing,
  //    no broadcast caption, no activity). Centered, big, EQ bars, station
  //    callsign stacked above the time. Fills the empty pill so "Radio
  //    Mode is on" reads at a glance instead of being a tiny corner label.
  //  - COMPACT: shown when something else IS playing inside the pill so
  //    the radio strip doesn't fight the foreground for attention. Same
  //    small top-bar treatment as before.
  const radioElapsedSec = radio ? Math.floor(radio.elapsedMs / 1000) : 0
  const radioRemainingSec = radio ? Math.max(0, Math.floor((radio.capMs - radio.elapsedMs) / 1000)) : 0
  const isPillEmpty = effectiveMode === null
  const radioStrip = radioActive && radio && !isPillEmpty ? (
    <div className="np-radio-strip" aria-live="polite">
      <span className="np-radio-strip__dot" /> ON AIR · WJLR 330.9 · {formatSec(radioElapsedSec)} / {formatSec(radioRemainingSec)} left
    </div>
  ) : null
  const radioHero = radioActive && radio && isPillEmpty ? (
    <div className="np-radio-hero" aria-live="polite">
      <div className="np-radio-hero__eq" aria-hidden="true">
        <span /><span /><span /><span />
      </div>
      <div className="np-radio-hero__main">
        <div className="np-radio-hero__label">
          <span className="np-radio-hero__dot" /> ON AIR
          <span className="np-radio-hero__sep">·</span>
          <span className="np-radio-hero__call">WJLR 330.9</span>
        </div>
        <div className="np-radio-hero__time">
          <span className="np-radio-hero__elapsed">{formatSec(radioElapsedSec)}</span>
          <span className="np-radio-hero__time-sep">/</span>
          <span className="np-radio-hero__remaining">{formatSec(radioRemainingSec)}</span>
          <span className="np-radio-hero__left">left</span>
        </div>
      </div>
      <div className="np-radio-hero__eq np-radio-hero__eq--mirror" aria-hidden="true">
        <span /><span /><span /><span />
      </div>
    </div>
  ) : null

  return (
    <div
      className={`now-playing-pill ${backlit ? 'now-playing-pill--backlit' : ''} ${isActivity ? 'now-playing-pill--activity' : ''} ${effectiveMode === 'broadcast' ? 'now-playing-pill--broadcast' : ''} ${radioActive ? 'now-playing-pill--radio' : ''} ${radioHero ? 'now-playing-pill--radio-hero' : ''}`}
      onPointerDownCapture={bloomBacklight}
    >
      {radioStrip}
      {radioHero}
      {showCycle && (
        <button className="np-cycle-btn" onClick={cycleMode} title="Toggle display">
          <svg width="10" height="12" viewBox="0 0 10 12" fill="none">
            <path d="M5 1 L8 4 L2 4 Z M5 11 L2 8 L8 8 Z" fill="#5a5540" />
          </svg>
        </button>
      )}
      {previewActive ? (
        // Brief 122 — preview takes over the pill while it plays. Same
        // scrubber markup as the real player, bound to the preview clip.
        <>
          <div className="now-playing-info now-playing-info--stacked">
            <div className="now-playing-line-primary">
              <span className="now-playing-title">{preview.title || 'Preview'}</span>
            </div>
            <div className="now-playing-line-secondary">
              {preview.artist && <span className="now-playing-artist">{preview.artist}</span>}
            </div>
            <div className="now-playing-line-tertiary">
              <span className="now-playing-album">Preview</span>
            </div>
          </div>
          <div className="scrubber-row">
            <span className="scrubber-time">{formatTime(Math.floor(preview.position))}</span>
            <div className="scrubber-track" ref={previewBarRef} onMouseDown={handlePreviewMouseDown}>
              <div className="scrubber-fill" style={{ width: `${previewProgress}%` }} />
              <div className="scrubber-knob" style={{ left: `${previewProgress}%` }} />
            </div>
            <span className="scrubber-time">-{formatTime(Math.max(0, Math.floor(preview.duration) - Math.floor(preview.position)))}</span>
          </div>
        </>
      ) : effectiveMode === 'playing' && track ? (
        <>
          {/* 4.4.41: MiniVisualizer removed. Jake: "get rid of the
              visualizer on the far right it is useless and kills
              battery". The rAF loop computed RMS from the audio
              waveform every frame — ~60fps continuously while
              playing — which kept the renderer's compositor busy
              for a 60×8px squiggle nobody used. Component definition
              kept above in case it gets revived; just not rendered. */}
          <div className="now-playing-info now-playing-info--stacked">
            {/* V5 Live Mode: during a merged live set, the primary line is
                the CURRENT setlist song and the secondary carries the set
                position — otherwise exactly the pre-V5 rendering. */}
            <div className="now-playing-line-primary">
              <span className="now-playing-title">{liveCue ? liveCue.cue.title : track.title}</span>
            </div>
            <div className="now-playing-line-secondary">
              {tapeOnAir ? (
                <span className="now-playing-artist">{track.artist} · {tapeOnAir.slot}/{tapeOnAir.of}</span>
              ) : liveCue && liveEntry ? (
                <span className="now-playing-artist">{liveCue.index + 1}/{liveEntry.cues.length}</span>
              ) : (
                <span className="now-playing-artist">{track.artist}</span>
              )}
            </div>
            {track.album && (
              <div className="now-playing-line-tertiary">
                <span className="now-playing-album">{track.album}</span>
              </div>
            )}
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
            {tapeOnAir ? (
              <>
                {/* The tape's clock: whole-tape elapsed and remaining, and a
                    bar that reports rather than accepts clicks. */}
                <span className="scrubber-time">{formatTime(Math.floor(tapeOnAir.elapsedMs / 1000))}</span>
                <div className="scrubber-track scrubber-track--tape" title="The whole tape — it plays start to finish">
                  <div className="scrubber-fill scrubber-fill--tape" style={{ width: `${Math.min(100, (tapeOnAir.elapsedMs / Math.max(1, tapeOnAir.totalMs)) * 100)}%` }} />
                  <div className="scrubber-knob" style={{ left: `${Math.min(100, (tapeOnAir.elapsedMs / Math.max(1, tapeOnAir.totalMs)) * 100)}%` }} />
                </div>
                <span className="scrubber-time">-{formatTime(Math.max(0, Math.floor((tapeOnAir.totalMs - tapeOnAir.elapsedMs) / 1000)))}</span>
              </>
            ) : (
              <>
                <span className="scrubber-time">{formatTime(Math.floor(state.position))}</span>
                <div className="scrubber-track" ref={barRef} onMouseDown={handleMouseDown}>
                  <div className="scrubber-fill" style={{ width: `${progress}%` }} />
                  <div className="scrubber-knob" style={{ left: `${progress}%` }} />
                </div>
                <span className="scrubber-time">-{formatTime(Math.max(0, Math.floor(state.duration) - Math.floor(state.position)))}</span>
              </>
            )}
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
          {(() => {
            const p = prettyImportName(rip.trackTitle || '')
            return (
              <div className="now-playing-info now-playing-info--stacked">
                <div className="now-playing-line-primary">
                  <span className="now-playing-title">{p.title || 'Importing…'}</span>
                </div>
                {p.artist && (
                  <div className="now-playing-line-secondary">
                    <span className="now-playing-artist">{p.artist}</span>
                  </div>
                )}
                <div className="now-playing-line-tertiary">
                  <span className="now-playing-album">
                    Importing {rip.current} of {rip.total}
                    {rip.errors > 0 ? ` · ${rip.errors} skipped` : ''}
                  </span>
                </div>
              </div>
            )
          })()}
          <div className="scrubber-row">
            <div className="activity-bar">
              <div className="activity-bar-fill" style={{ width: `${(rip.current / Math.max(1, rip.total)) * 100}%` }} />
            </div>
          </div>
        </>
      ) : effectiveMode === 'import' && imp ? (
        <>
          {(() => {
            const p = prettyImportName(imp.trackTitle || '')
            return (
              <div className="now-playing-info now-playing-info--stacked">
                <div className="now-playing-line-primary">
                  <span className="now-playing-title">{p.title || 'Importing…'}</span>
                </div>
                {p.artist && (
                  <div className="now-playing-line-secondary">
                    <span className="now-playing-artist">{p.artist}</span>
                  </div>
                )}
                <div className="now-playing-line-tertiary">
                  <span className="now-playing-album">
                    Importing {imp.current} of {imp.total}
                    {imp.errors > 0 ? ` · ${imp.errors} failed` : ''}
                  </span>
                </div>
              </div>
            )
          })()}
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
      ) : effectiveMode === 'broadcast' && broadcast ? (
        (() => {
          // 4.5: closed-caption stack. Thinking phase shows speaker +
          // pulsing dots with no progress bar (the prior single-line
          // "is listening" text typewriter-revealed in 300ms and read
          // as a visual spazz). Speaking phase wraps the revealed text
          // greedily by word into ~40-char lines, then renders the
          // most recent two stacked on top of each other — like a TV
          // captions track. Older lines slide up off-screen as new
          // ones arrive; the bottom (current) line carries the caret.
          if (broadcast.mode === 'thinking') {
            return (
              <div className="now-playing-info now-playing-info--activity now-playing-info--broadcast np-broadcast-thinking">
                <span className="now-playing-title">{broadcast.speaker}</span>
                <span className="np-thinking-dots" aria-hidden>
                  <span /><span /><span />
                </span>
              </div>
            )
          }
          const reveal = broadcast.revealedChars
          const visibleText = broadcast.text.slice(0, reveal)
          const stillRevealing = reveal < broadcast.text.length
          // Greedy word wrap to ~40 chars per line. Hyphenated long
          // words get broken on the dash; otherwise we never split a
          // word — better to spill over by a few chars than to render
          // mid-word splits that read as broken.
          const LINE_LIMIT = 40
          const lines: string[] = []
          let current = ''
          for (const word of visibleText.split(/(\s+)/)) {
            if (!word) continue
            if (current.length + word.length > LINE_LIMIT && current.trim().length > 0) {
              lines.push(current.trimEnd())
              current = word.trimStart()
            } else {
              current += word
            }
          }
          if (current) lines.push(current)
          const lastTwo = lines.slice(-2)
          const isFirstLine = lastTwo.length < 2
          return (
            <div className="now-playing-info now-playing-info--activity now-playing-info--broadcast np-broadcast-cc">
              <div className="np-broadcast-speaker">{broadcast.speaker}</div>
              {captionsOn && (
                <div className="np-broadcast-lines">
                  {lastTwo.length === 2 && (
                    <div className="np-broadcast-line np-broadcast-line--older">{lastTwo[0]}</div>
                  )}
                  <div className="np-broadcast-line np-broadcast-line--current">
                    {isFirstLine ? lastTwo[0] || '' : lastTwo[1]}
                    {stillRevealing && <span className="np-caret" aria-hidden>▍</span>}
                  </div>
                </div>
              )}
            </div>
          )
        })()
      ) : (
        <div className="now-playing-empty" />
      )}
    </div>
  )
}
