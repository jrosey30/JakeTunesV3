// 4.3.3: procedural radio stingers — synthesized in Web Audio at play
// time, so we don't need to bundle SFX files or hit any external API.
// Each generator creates the nodes, plays them through the broadcast
// preamp (so they're EQ'd and captured by recording), and tears them
// down on the scheduled stop. All sounds are short — 0.3 to 1.5 sec.
//
// Why procedural: zero deps, zero file bundling, deterministic output,
// trivial to swap for sampled SFX later if we ever want premium audio
// (just replace `playStinger` with a sampler that picks a random file).

import { getBroadcastDestination } from './eq'

export type StingerType =
  | 'riser'        // rising sweep, builds tension before announcer line
  | 'swoosh'       // filtered noise sweep — quick transition
  | 'drum-hit'     // big tom / kick impact
  | 'bell-hit'     // tuned resonant bell — endcap accent
  | 'sub-drop'     // sine drop — drama bed under the line
  | 'whoosh-pad'   // softer pad swell — gentler version of riser
  | 'scratch'      // 4.4.49: turntable scratch — DJ Mode transition punch

/** Total duration in seconds (so callers can wait the right amount). */
export const STINGER_DURATIONS: Record<StingerType, number> = {
  'riser':       1.1,
  'swoosh':      0.45,
  'drum-hit':    0.6,
  'bell-hit':    0.9,
  'sub-drop':    0.8,
  'whoosh-pad':  1.4,
  'scratch':     0.62,
}

function destination(): { ctx: AudioContext; node: AudioNode } | null {
  return getBroadcastDestination()
}

function envelope(ctx: AudioContext, gain: GainNode, attack: number, peak: number, release: number, peakLevel = 0.6) {
  const now = ctx.currentTime
  const total = attack + peak + release
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(peakLevel, now + attack)
  gain.gain.setValueAtTime(peakLevel, now + attack + peak)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + total)
  return total
}

function playRiser(): void {
  const dest = destination(); if (!dest) return
  const { ctx, node } = dest
  const now = ctx.currentTime
  const dur = STINGER_DURATIONS.riser

  // Sawtooth pitch sweep + LP filter sweep + envelope
  const osc = ctx.createOscillator()
  const filter = ctx.createBiquadFilter()
  const gain = ctx.createGain()

  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(80, now)
  osc.frequency.exponentialRampToValueAtTime(900, now + dur)

  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(200, now)
  filter.frequency.exponentialRampToValueAtTime(4000, now + dur)
  filter.Q.value = 4

  envelope(ctx, gain, 0.01, dur * 0.85, dur * 0.15, 0.32)

  osc.connect(filter); filter.connect(gain); gain.connect(node)
  osc.start(now)
  osc.stop(now + dur + 0.1)
}

function playSwoosh(): void {
  const dest = destination(); if (!dest) return
  const { ctx, node } = dest
  const now = ctx.currentTime
  const dur = STINGER_DURATIONS.swoosh

  // White noise burst + bandpass sweep
  const bufferSize = Math.floor(ctx.sampleRate * dur)
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1
  const noise = ctx.createBufferSource()
  noise.buffer = noiseBuffer

  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 6
  filter.frequency.setValueAtTime(800, now)
  filter.frequency.exponentialRampToValueAtTime(6000, now + dur)

  const gain = ctx.createGain()
  envelope(ctx, gain, 0.02, dur * 0.4, dur * 0.6, 0.28)

  noise.connect(filter); filter.connect(gain); gain.connect(node)
  noise.start(now)
  noise.stop(now + dur + 0.05)
}

function playDrumHit(): void {
  const dest = destination(); if (!dest) return
  const { ctx, node } = dest
  const now = ctx.currentTime
  const dur = STINGER_DURATIONS['drum-hit']

  // Tom hit: sine pitch drop + click transient
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(180, now)
  osc.frequency.exponentialRampToValueAtTime(45, now + dur * 0.5)

  const oscGain = ctx.createGain()
  oscGain.gain.setValueAtTime(0.6, now)
  oscGain.gain.exponentialRampToValueAtTime(0.0001, now + dur)

  // Click transient (short noise burst)
  const clickBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.02), ctx.sampleRate)
  const clickData = clickBuf.getChannelData(0)
  for (let i = 0; i < clickData.length; i++) {
    clickData[i] = (Math.random() * 2 - 1) * (1 - i / clickData.length)
  }
  const click = ctx.createBufferSource()
  click.buffer = clickBuf
  const clickGain = ctx.createGain()
  clickGain.gain.value = 0.35

  osc.connect(oscGain); oscGain.connect(node)
  click.connect(clickGain); clickGain.connect(node)
  osc.start(now); click.start(now)
  osc.stop(now + dur + 0.1)
}

function playBellHit(): void {
  const dest = destination(); if (!dest) return
  const { ctx, node } = dest
  const now = ctx.currentTime
  const dur = STINGER_DURATIONS['bell-hit']

  // Two stacked sines a perfect-fifth apart with long decay
  const fundamental = 880
  const fifth = 1318.51
  for (const freq of [fundamental, fifth]) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const gain = ctx.createGain()
    const peak = freq === fundamental ? 0.32 : 0.18
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur)
    osc.connect(gain); gain.connect(node)
    osc.start(now)
    osc.stop(now + dur + 0.1)
  }
}

function playSubDrop(): void {
  const dest = destination(); if (!dest) return
  const { ctx, node } = dest
  const now = ctx.currentTime
  const dur = STINGER_DURATIONS['sub-drop']

  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(120, now)
  osc.frequency.exponentialRampToValueAtTime(35, now + dur)

  const gain = ctx.createGain()
  envelope(ctx, gain, 0.02, dur * 0.5, dur * 0.5, 0.4)

  osc.connect(gain); gain.connect(node)
  osc.start(now)
  osc.stop(now + dur + 0.1)
}

function playWhooshPad(): void {
  const dest = destination(); if (!dest) return
  const { ctx, node } = dest
  const now = ctx.currentTime
  const dur = STINGER_DURATIONS['whoosh-pad']

  // Low-pass filtered noise pad swell — softer riser, no fundamental
  const bufferSize = Math.floor(ctx.sampleRate * dur)
  const noiseBuffer = ctx.createBuffer(2, bufferSize, ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = noiseBuffer.getChannelData(ch)
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1
  }
  const noise = ctx.createBufferSource()
  noise.buffer = noiseBuffer

  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(200, now)
  filter.frequency.exponentialRampToValueAtTime(2200, now + dur * 0.7)
  filter.Q.value = 1

  const gain = ctx.createGain()
  envelope(ctx, gain, dur * 0.6, 0.05, dur * 0.35, 0.18)

  noise.connect(filter); filter.connect(gain); gain.connect(node)
  noise.start(now)
  noise.stop(now + dur + 0.05)
}

// 4.4.49: turntable scratch — the "wikki-wikki" punch for DJ Mode
// transitions. A real scratch is a sampled sound being pushed back and
// forth under the needle while the crossfader cuts it in and out;
// procedurally we approximate it with a bandpass-filtered sawtooth
// (the "vox-ish" buzz of a scratched sample), its pitch ramped up-then-
// down several times (the hand motion), gain hard-gated on each pass
// (the crossfader cuts). Not a sampled vinyl scratch — but a clearly
// readable scratch, and consistent with the zero-files procedural-FX
// approach the rest of this file uses.
function playScratch(): void {
  const dest = destination(); if (!dest) return
  const { ctx, node } = dest
  const now = ctx.currentTime
  const dur = STINGER_DURATIONS.scratch

  const osc = ctx.createOscillator()
  const bp = ctx.createBiquadFilter()
  const gain = ctx.createGain()

  osc.type = 'sawtooth'
  bp.type = 'bandpass'
  bp.frequency.value = 1500
  bp.Q.value = 5

  const base = 200          // low end of the scratched-sample pitch
  const passes = 4          // four back-and-forth motions
  const slice = dur / passes

  gain.gain.setValueAtTime(0.0001, now)
  for (let i = 0; i < passes; i++) {
    const t0 = now + i * slice
    // Each pass a touch tighter/faster — accelerating scratch.
    const peak = base * (2.4 - i * 0.2)
    osc.frequency.setValueAtTime(base, t0)
    osc.frequency.linearRampToValueAtTime(peak, t0 + slice * 0.5)
    osc.frequency.linearRampToValueAtTime(base, t0 + slice * 0.98)
    // Crossfader cut: hard on for the first ~55% of the pass, hard off
    // for the rest — that abrupt gate is what reads as "scratch" and
    // not "siren."
    gain.gain.setValueAtTime(0.45, t0)
    gain.gain.setValueAtTime(0.45, t0 + slice * 0.5)
    gain.gain.setValueAtTime(0.0001, t0 + slice * 0.55)
  }
  gain.gain.setValueAtTime(0.0001, now + dur)

  osc.connect(bp); bp.connect(gain); gain.connect(node)
  osc.start(now)
  osc.stop(now + dur + 0.05)
}

/** Play a single procedural stinger. Returns its duration so callers
 *  can chain timing (await the stinger, then play the announcer line). */
export function playStinger(type: StingerType): number {
  switch (type) {
    case 'riser':       playRiser(); break
    case 'swoosh':      playSwoosh(); break
    case 'drum-hit':    playDrumHit(); break
    case 'bell-hit':    playBellHit(); break
    case 'sub-drop':    playSubDrop(); break
    case 'whoosh-pad':  playWhooshPad(); break
    case 'scratch':     playScratch(); break
  }
  return STINGER_DURATIONS[type]
}

/** Pick a random "pre-announcer" stinger — the buildup that happens
 *  before a station ID drop. Riser / whoosh-pad / swoosh are appropriate;
 *  drum-hit and bell-hit feel better as endcaps. */
export function randomPreStinger(): StingerType {
  const choices: StingerType[] = ['riser', 'whoosh-pad', 'swoosh', 'sub-drop']
  return choices[Math.floor(Math.random() * choices.length)]
}

/** Pick a random endcap stinger — short impact at the end of the
 *  announcer line. Drum hit or bell hit work well; the others are too
 *  long for a tail accent. */
export function randomEndStinger(): StingerType {
  const choices: StingerType[] = ['drum-hit', 'bell-hit', 'drum-hit']  // drum-hit weighted
  return choices[Math.floor(Math.random() * choices.length)]
}
