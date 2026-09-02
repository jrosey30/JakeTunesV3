import { Howl } from 'howler'

// ── Concert crowd ambience (LC-7) ───────────────────────────────────────────
// "That night's crowd, gaps only." A second low-volume layer — the show's OWN
// between-song crowd, extracted from a real gap in the recording — that swells
// up as each song ends and fades before the next begins. It lives ONLY in the
// transitions, never over the body of a song. Toggle-gated, OFF by default; the
// user A/Bs it by ear.
//
// Deliberately standalone: it polls Howler directly for the concert's playhead,
// so it needs zero changes to useAudio / PlaybackContext (do-not-touch). If a
// show has no crowd clip, every call is a graceful no-op.

let enabled = false
let crowd: Howl | null = null
let clipUrl: string | null = null
let poll: ReturnType<typeof setInterval> | null = null
let boundariesSec: number[] = []   // song-start times (skip index 0 = show start)
let totalSec = 0
let attachedId: number | null = null
const listeners = new Set<() => void>()

// Envelope (all seconds / 0-1) — TUNABLE BY EAR (the concert view's crowd panel).
// The crowd rises over `rise` before a song boundary, then fades over `tail` so
// the next downbeat is clean. `level` is the swell ceiling (the clip is already
// loudnorm'd quiet). Persisted so a dial-in sticks.
// ONE preset, no knobs (2026-09-02, Jake: "crowd noise settings are
// confusing… it should be a slight enhancement"). The room rises gently into
// each seam and is gone quickly after the downbeat; the level is a whisper
// under the mix, never a feature. The tuning IPCs stay (harmless), but the
// page no longer exposes them and saved tunings are ignored.
let leadIn = 3.0   // rise
let fadeOut = 1.2  // tail
let peak = 0.32    // level

function emit(): void { for (const l of listeners) l() }
export function subscribeConcertCrowd(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb) } }
export function isConcertCrowdEnabled(): boolean { return enabled }

export function getCrowdParams(): { level: number; rise: number; tail: number } {
  return { level: peak, rise: leadIn, tail: fadeOut }
}
export async function setCrowdParams(partial: { level?: number; rise?: number; tail?: number }): Promise<void> {
  if (partial.level != null) peak = Math.max(0, Math.min(1, partial.level))
  if (partial.rise != null) leadIn = Math.max(0.5, Math.min(8, partial.rise))
  if (partial.tail != null) fadeOut = Math.max(0.3, Math.min(5, partial.tail))
  emit()
  try { await window.electronAPI.saveCrowdTuning({ level: peak, rise: leadIn, tail: fadeOut }) } catch { /* best effort */ }
}
// Load the persisted dial-in once at startup.
// (Saved tunings are deliberately NOT loaded — the preset is the product.)

export function setConcertCrowdEnabled(on: boolean): void {
  enabled = on
  emit()
  if (!on && crowd) crowd.fade(crowd.volume(), 0, 350)
}

/** Load the crowd clip for a concert and start the swell engine. Idempotent per id. */
export async function attachConcert(mergedTrackId: number, cueStartsSec: number[], totalDurationSec: number): Promise<void> {
  if (attachedId === mergedTrackId && crowd) { ensurePoll(); return }
  detachConcert()
  attachedId = mergedTrackId
  boundariesSec = cueStartsSec.slice(1)   // skip the show-start boundary
  totalSec = totalDurationSec
  try {
    const b64 = await window.electronAPI.getConcertCrowd(mergedTrackId)
    if (!b64) { attachedId = null; return }   // no clip for this show → no-op
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    clipUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mp4' }))
    crowd = new Howl({ src: [clipUrl], format: ['m4a'], loop: true, volume: 0 })
  } catch { attachedId = null; return }
  ensurePoll()
}

export function detachConcert(): void {
  if (poll) { clearInterval(poll); poll = null }
  if (crowd) { try { crowd.stop(); crowd.unload() } catch { /* ignore */ } crowd = null }
  if (clipUrl) { URL.revokeObjectURL(clipUrl); clipUrl = null }
  attachedId = null
}

function ensurePoll(): void {
  if (poll) return
  poll = setInterval(tick, 140)
}

// The concert plays as ONE Howl whose duration ≈ the whole show; find it and read
// its playhead. (Only one track plays at a time, so this is unambiguous.)
function concertSeek(): number | null {
  const H = ((window as unknown as { Howler?: { _howls?: Howl[] } }).Howler?._howls) || []
  for (const h of H) {
    try {
      if (Math.abs((h.duration() || 0) - totalSec) < 3 && h.playing()) return h.seek() as number
    } catch { /* skip */ }
  }
  return null
}

// Crowd gain at a playhead position: an asymmetric swell around the nearest
// song boundary — up over LEAD_IN before it, quick FADE_OUT after — so the
// crowd fills the gap but never rides over the next song.
function gainAt(posSec: number): number {
  let g = 0
  for (const b of boundariesSec) {
    const d = posSec - b
    let v = 0
    if (d <= 0 && d > -leadIn) v = 1 - (-d / leadIn)          // rising into the boundary
    else if (d > 0 && d < fadeOut) v = 1 - (d / fadeOut)      // falling out of it
    if (v > g) g = v
  }
  // ease the linear ramp into a soft cosine bell
  const bell = 0.5 * (1 - Math.cos(Math.PI * g))
  return peak * bell
}

function tick(): void {
  if (!crowd) return
  if (!enabled) { if (crowd.playing() && crowd.volume() > 0.001) crowd.volume(0); if (crowd.playing()) crowd.pause(); return }
  const pos = concertSeek()
  if (pos == null) { if (crowd.playing()) { crowd.volume(0); crowd.pause() } return }
  const target = gainAt(pos)
  if (target <= 0.002) {
    if (crowd.playing()) { const v = crowd.volume(); if (v > 0.002) crowd.volume(v * 0.6); else crowd.pause() }
    return
  }
  if (!crowd.playing()) { crowd.volume(0); crowd.play() }
  const cur = crowd.volume()
  crowd.volume(cur + (target - cur) * 0.28)   // glide toward target — no clicks
}
