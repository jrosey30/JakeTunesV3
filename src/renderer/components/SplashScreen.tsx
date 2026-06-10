/**
 * 4.5: Pixar-style splash — burnt orange on off-white, ZERO blue.
 *
 * Shows while AppInner is bootstrapping (loadTracks + loadPlaylists +
 * loadMetadataOverrides + loadUiState all running in parallel in App.tsx's
 * mount effect).
 *
 * The scene (classic animation principles, choreographed to the stinger):
 * - The logo DROPS in under gravity and lands with squash-and-stretch —
 *   squash on impact, rebound stretch, settle. A ground-contact shadow
 *   grows as it falls and squashes wide at the moment of impact.
 * - playIntroStinger() runs a drum pickup into a distorted power chord;
 *   the chord + crash hit at ~0.46s, the exact frame of the landing.
 * - Musical notes BURST out of the logo on impact, then keep rising in a
 *   staggered loop. EQ bars start dancing right after the chord hits.
 * - Wordmark springs up with overshoot; tagline/greeting/progress follow.
 *
 * Real per-stage progress is NOT wired — the load is a Promise.all in
 * App.tsx; fake-animated progress + the min display time reads identically.
 */

import { useEffect, useState } from 'react'
import logoUrl from '../assets/jaketunes-logo.png'
import { playIntroStinger } from '../utils/introStinger'

const STAGES = [
  'Reading your library…',
  'Loading playlists…',
  'Building artwork index…',
  'Tuning the amps…',
  'Almost there…',
]

function getGreeting(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 'Good morning, Jake.'
  if (h >= 12 && h < 17) return 'Good afternoon, Jake.'
  if (h >= 17 && h < 22) return 'Good evening, Jake.'
  return 'Burning the midnight oil, Jake.'
}

interface Props {
  /** Becomes true when the library/UI promise chain in App.tsx settles.
   *  When true, the progress bar snaps to 100% and the status flips to
   *  "Ready." */
  isReady: boolean
}

export default function SplashScreen({ isReady }: Props) {
  const [stageIdx, setStageIdx] = useState(0)
  const [progress, setProgress] = useState(5)
  const [greeting] = useState(getGreeting)

  // The rock'n'roll intro — fires once per launch, synced to the logo drop.
  useEffect(() => { playIntroStinger() }, [])

  // Rotate the status line every 480ms so the splash never feels frozen.
  useEffect(() => {
    if (isReady) return
    const id = window.setInterval(() => {
      setStageIdx(i => (i + 1) % STAGES.length)
    }, 480)
    return () => window.clearInterval(id)
  }, [isReady])

  // Progress fill: 2600ms ease-out to 92%, snap to 100% on ready.
  useEffect(() => {
    let rafId = 0
    const start = performance.now()
    const from = progress
    const to = isReady ? 100 : 92
    const duration = isReady ? 320 : 2600
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setProgress(from + (to - from) * eased)
      if (t < 1) rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  const statusText = isReady ? 'Ready.' : STAGES[stageIdx]

  return (
    <div className="app-splash">
      <div className="app-splash-bg-glow" />
      <div className="app-splash-inner">
        {/* The stage: drop wrapper (gravity) > squash wrapper (impact) > logo.
            Shadow sits on the floor and reacts to the landing. */}
        <div className="app-splash-stage" aria-hidden="true">
          <div className="app-splash-logo-halo" />
          <div className="app-splash-logo-drop">
            <div className="app-splash-logo-squash">
              <img src={logoUrl} alt="" className="app-splash-logo-img" />
              <div className="app-splash-logo-shine" />
            </div>
          </div>
          <div className="app-splash-shadow" />
          {/* Notes burst out on impact, then keep rising — stagger + per-note
              drift direction so the stream never reads as a synced column. */}
          <span className="splash-note splash-note--1" aria-hidden="true">♪</span>
          <span className="splash-note splash-note--2" aria-hidden="true">♫</span>
          <span className="splash-note splash-note--3" aria-hidden="true">♬</span>
          <span className="splash-note splash-note--4" aria-hidden="true">♩</span>
          <span className="splash-note splash-note--5" aria-hidden="true">♪</span>
        </div>
        <div className="app-splash-wordmark">JakeTunes</div>
        <div className="app-splash-tagline">The greatest music platform ever built.</div>
        <div className="app-splash-greeting">{greeting}</div>
        <div className="app-splash-eq" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <div
              key={i}
              className="app-splash-eq-bar"
              style={{ animationDelay: `${0.72 + i * 0.11}s`, animationDuration: `${0.78 + (i % 3) * 0.14}s` }}
            />
          ))}
        </div>
        <div className="app-splash-progress">
          <div className="app-splash-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="app-splash-status">{statusText}</div>
      </div>
    </div>
  )
}
