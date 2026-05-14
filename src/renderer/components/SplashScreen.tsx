/**
 * 4.4.39: cool splash screen.
 *
 * Shows while AppInner is bootstrapping (loadTracks + loadPlaylists +
 * loadMetadataOverrides + loadUiState all running in parallel in App.tsx's
 * mount effect). Replaces the previous tiny gray "JakeTunes / Loading
 * library..." card.
 *
 * Design notes:
 * - Dark navy radial gradient backdrop with two slow-drifting warm/cool
 *   color glows (matches the Home Featured Album hero + ArtistsView 4.4.38
 *   palette so the splash feels like the same app, not a stranger).
 * - Seven pulsing vertical EQ bars at the top — staggered animation delays
 *   make them feel like real audio levels, not a synced row.
 * - Big gradient-text JakeTunes wordmark, time-of-day greeting in warm
 *   orange ("Good evening, Jake.").
 * - Slim progress bar with shimmer (background-position animation) +
 *   warm-orange fill. Width animates from 5% → 92% over 1.6s via rAF
 *   ease-out; jumps to 100% when the parent flips isReady to true.
 * - Status line cycles through 5 messages so the user feels work is
 *   happening even when the load is sub-second on a warm cache.
 *
 * Real per-stage progress is NOT wired — the load is a Promise.all in
 * App.tsx so we can't get fine-grained signals without splitting it.
 * Cost/benefit: fake-animated progress + min display time of 1.4s is
 * indistinguishable from real progress for the user and zero refactor.
 */

import { useEffect, useState } from 'react'

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

  // Rotate the status line every 480ms so the splash never feels frozen.
  // Stops once the parent flips isReady — we then pin "Ready." below.
  useEffect(() => {
    if (isReady) return
    const id = window.setInterval(() => {
      setStageIdx(i => (i + 1) % STAGES.length)
    }, 480)
    return () => window.clearInterval(id)
  }, [isReady])

  // Animate progress 5 → 92 over 1600ms (ease-out cubic). On isReady,
  // jump to 100 over 200ms. rAF-driven so it's silky.
  useEffect(() => {
    let rafId = 0
    const start = performance.now()
    const from = progress
    const to = isReady ? 100 : 92
    const duration = isReady ? 240 : 1600
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      // ease-out cubic
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
        <div className="app-splash-eq" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <div
              key={i}
              className="app-splash-eq-bar"
              style={{ animationDelay: `${i * 0.11}s`, animationDuration: `${0.78 + (i % 3) * 0.14}s` }}
            />
          ))}
        </div>
        <div className="app-splash-wordmark">JakeTunes</div>
        <div className="app-splash-tagline">The greatest music platform ever built.</div>
        <div className="app-splash-greeting">{greeting}</div>
        <div className="app-splash-progress">
          <div className="app-splash-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="app-splash-status">{statusText}</div>
      </div>
    </div>
  )
}
