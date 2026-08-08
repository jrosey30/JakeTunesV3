/**
 * Cassette voicing for tape playback — the files are never touched; this
 * is a live insert on Howler's master bus, engaged ONLY while a tape
 * session is live (mixtapes.ts setTapeSession / cleared by TapeMonitor).
 *
 * The recipe stays deliberately subtle — "you know it's a tape" without
 * wrecking the music: gentle top-end rolloff, a whisper of hiss that wows
 * with the program, slow wow + fast flutter + long drift via a modulated
 * delay line, light tape-glue compression, rare oxide dropouts, and a
 * mechanical clunk on play/stop.
 *
 * 2026-07-19 ("on every button touch, the music should sound like its a
 * tape"): the deck is also a MACHINE — mechanicalSound() key noises for
 * every faceplate/strip button, tapeMotorStart() lazy spin-up on every
 * resume, tapeMotorPause() pressure sag before pause commits, and
 * tapeFlipRitual() at the Side A→B boundary (dead air, door, cassette
 * turned in hand, door, PLAY, spin-up).
 *
 * ⚠️ Howler rule (learned the hard way): NEVER create or assign
 * Howler.ctx ourselves — only read it after Howler has made it. If the
 * session lands before Howler's first play, we retry until ctx exists.
 */
import { subscribeMixtapes, getTapeSession } from './mixtapes'

type HowlerGlobal = {
  ctx?: AudioContext
  masterGain?: GainNode
  _howls?: Array<{ playing: () => boolean; rate: (r?: number) => number }>
}

const howler = (): HowlerGlobal | undefined => (window as unknown as { Howler?: HowlerGlobal }).Howler

let engaged = false
let retryTimer: number | null = null

// Live nodes (only while engaged). Just the transparent pass-through now —
// the hiss source, dropout timer and filter refs went with the tape voicing
// on 2026-08-08 (see engage()).
let input: GainNode | null = null
let outNodes: AudioNode[] = []
let noiseBuf: AudioBuffer | null = null

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf
  const len = Math.floor(ctx.sampleRate * 2)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  // Lightly lowpassed white noise — closer to Type I hiss than raw white.
  let last = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    last = 0.6 * last + 0.4 * w
    d[i] = last
  }
  noiseBuf = buf
  return buf
}

/** Short mechanical transport clunk — filtered tick + low thump. */
function clunk(ctx: AudioContext, stop: boolean): void {
  try {
    const t = ctx.currentTime + 0.01
    const nb = ctx.createBufferSource()
    nb.buffer = noiseBuffer(ctx)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = stop ? 900 : 1400
    bp.Q.value = 1.2
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.11, t)
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.045)
    nb.connect(bp).connect(ng).connect(ctx.destination)
    nb.start(t)
    nb.stop(t + 0.06)
    const osc = ctx.createOscillator()
    osc.frequency.setValueAtTime(stop ? 70 : 85, t)
    const og = ctx.createGain()
    og.gain.setValueAtTime(0.09, t)
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
    osc.connect(og).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.08)
  } catch { /* cosmetic — never let the clunk break playback */ }
}

function engage(): void {
  const H = howler()
  const ctx = H?.ctx
  const master = H?.masterGain
  if (!ctx || !master) return
  if (engaged) return
  try {
    // 2026-08-08, Jake: "do not make them sound like a tape … fast forward
    // and rewind … those sound effects can stay … but the actual music
    // should sound normal."
    //
    // So the deck no longer COLORS the music at all. Everything that used
    // to live on this bus is gone: wow/flutter/long-drift via a modulated
    // delay line, tanh saturation, the -3 dB shelf at 9.5 kHz, the 15 kHz
    // lowpass, the +2.5 dB bump at 85 Hz, the glue compressor, the oxide
    // dropouts, and the hiss bed. A song played off a tape now measures
    // and sounds exactly like the same song played anywhere else.
    //
    // What remains is a single UNITY-GAIN pass-through. It applies no
    // processing — it exists only so tapeFlipRitual() has something to
    // duck the music with at the Side A→B boundary, which is a transport
    // gap, not a tape tone. Everything Jake kept — the FF/REW wind, key
    // clunks, door, cassette-in-hand rustle, PLAY — are separate one-shot
    // sources that never touched the music bus and are untouched here.
    input = ctx.createGain()
    input.gain.value = 1
    master.disconnect()
    master.connect(input)
    input.connect(ctx.destination)
    outNodes = []

    engaged = true
    clunk(ctx, false)
  } catch {
    // If anything went sideways, put the bus back the way we found it.
    try { master.disconnect(); master.connect(ctx.destination) } catch { /* already sane */ }
    engaged = false
  }
}

function disengage(): void {
  const H = howler()
  const ctx = H?.ctx
  const master = H?.masterGain
  if (!engaged || !ctx || !master) return
  try {
    clunk(ctx, true)
    master.disconnect()
    for (const n of outNodes) { try { n.disconnect() } catch { /* fine */ } }
    input?.disconnect()
    master.connect(ctx.destination)
  } finally {
    input = null
    outNodes = []
    engaged = false
  }
}

function sync(): void {
  const live = getTapeSession() != null
  if (live && !engaged) {
    // Session is set just BEFORE the first play — Howler's ctx may not
    // exist yet. Retry briefly instead of creating it ourselves.
    if (howler()?.ctx) {
      engage()
    } else if (retryTimer == null) {
      retryTimer = window.setInterval(() => {
        if (!getTapeSession()) { clearInterval(retryTimer!); retryTimer = null; return }
        if (howler()?.ctx) { clearInterval(retryTimer!); retryTimer = null; engage() }
      }, 250)
    }
  } else if (!live && engaged) {
    disengage()
  }
}

// ── Spool wind — the FF/REW sound while the tape is being held ──────
// Motor whir under a rising squeal with a slow wobble; starts with the
// engage clunk, ends with the stop clunk. Straight to the destination
// (it's the DECK making this noise, not the tape).
let windNodes: AudioNode[] = []
let windOn = false

export function startWindSound(): void {
  const ctx = howler()?.ctx
  if (!ctx || windOn) return
  try {
    const t = ctx.currentTime
    const whirSrc = ctx.createBufferSource()
    whirSrc.buffer = noiseBuffer(ctx)
    whirSrc.loop = true
    const whirLp = ctx.createBiquadFilter()
    whirLp.type = 'lowpass'
    whirLp.frequency.value = 260
    const whirGain = ctx.createGain()
    whirGain.gain.setValueAtTime(0.0001, t)
    whirGain.gain.exponentialRampToValueAtTime(0.05, t + 0.15)
    whirSrc.connect(whirLp).connect(whirGain).connect(ctx.destination)
    whirSrc.start()

    const sqSrc = ctx.createBufferSource()
    sqSrc.buffer = noiseBuffer(ctx)
    sqSrc.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 7
    bp.frequency.setValueAtTime(1500, t)
    // The squeal climbs as the spools pick up speed — same feel as the
    // accelerating wind ramp in MixtapeView.
    bp.frequency.exponentialRampToValueAtTime(3400, t + 2.2)
    const wob = ctx.createOscillator()
    wob.frequency.value = 5.2
    const wobDepth = ctx.createGain()
    wobDepth.gain.value = 220
    wob.connect(wobDepth).connect(bp.frequency)
    wob.start()
    const sqGain = ctx.createGain()
    sqGain.gain.setValueAtTime(0.0001, t)
    sqGain.gain.exponentialRampToValueAtTime(0.035, t + 0.4)
    sqSrc.connect(bp).connect(sqGain).connect(ctx.destination)
    sqSrc.start()

    windNodes = [whirSrc, whirLp, whirGain, sqSrc, bp, sqGain, wob, wobDepth]
    windOn = true
    clunk(ctx, false)
  } catch {
    windOn = false
    windNodes = []
  }
}

export function stopWindSound(): void {
  if (!windOn) return
  for (const n of windNodes) {
    try { (n as AudioScheduledSourceNode).stop?.() } catch { /* not a source */ }
    try { n.disconnect() } catch { /* already gone */ }
  }
  windNodes = []
  windOn = false
  const ctx = howler()?.ctx
  if (ctx) clunk(ctx, true)
}

// ── The mechanical deck (2026-07-19, Jake: "on every button touch, the
// music should sound like its a tape") ─────────────────────────────────
// Every key on the faceplate/strip makes the noise the REAL key would;
// the motor is lazy (spin-up drawl on play, pressure sag on pause); the
// A→B boundary is a full flip ritual. All synthesized — no samples.

export type MechKind = 'play' | 'pause' | 'stop' | 'rec' | 'eject' | 'mic'

/** The physical key. Plays even when no tape session is engaged — a dead
 *  deck still clunks. No ctx yet (nothing ever played) → silent, fine. */
export function mechanicalSound(kind: MechKind): void {
  const ctx = howler()?.ctx
  if (!ctx) return
  try {
    switch (kind) {
      case 'play':
        clunk(ctx, false)
        break
      case 'stop':
        clunk(ctx, true)
        // the latched key popping back out, a beat later
        window.setTimeout(() => { const c = howler()?.ctx; if (c) tick(c, 2100, 0.05) }, 130)
        break
      case 'rec':
        // REC latches two keys at once — a heavier, doubled clunk
        clunk(ctx, false)
        window.setTimeout(() => { const c = howler()?.ctx; if (c) clunk(c, false) }, 55)
        break
      case 'pause':
        tick(ctx, 1700, 0.07)
        break
      case 'mic':
        tick(ctx, 2600, 0.045)
        break
      case 'eject': {
        clunk(ctx, true)
        // door spring pop + a little case rattle
        window.setTimeout(() => { const c = howler()?.ctx; if (c) doorPop(c) }, 120)
        break
      }
    }
  } catch { /* cosmetic */ }
}

/** Small switch/latch tick — lighter than a transport clunk. */
function tick(ctx: AudioContext, freq: number, level: number): void {
  try {
    const t = ctx.currentTime + 0.005
    const nb = ctx.createBufferSource()
    nb.buffer = noiseBuffer(ctx)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = freq
    bp.Q.value = 2.5
    const g = ctx.createGain()
    g.gain.setValueAtTime(level, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
    nb.connect(bp).connect(g).connect(ctx.destination)
    nb.start(t)
    nb.stop(t + 0.04)
  } catch { /* cosmetic */ }
}

/** Cassette-door spring pop (eject) / shut (flip). */
function doorPop(ctx: AudioContext, shut = false): void {
  try {
    const t = ctx.currentTime + 0.005
    const nb = ctx.createBufferSource()
    nb.buffer = noiseBuffer(ctx)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 1.1
    bp.frequency.setValueAtTime(shut ? 1400 : 600, t)
    bp.frequency.exponentialRampToValueAtTime(shut ? 700 : 2200, t + 0.09)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.09, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    nb.connect(bp).connect(g).connect(ctx.destination)
    nb.start(t)
    nb.stop(t + 0.14)
  } catch { /* cosmetic */ }
}

/** Plastic-on-plastic handling rustle (flipping the cassette in hand). */
function caseRustle(ctx: AudioContext): void {
  try {
    for (let i = 0; i < 3; i++) {
      const t = ctx.currentTime + 0.01 + i * (0.07 + Math.random() * 0.05)
      const nb = ctx.createBufferSource()
      nb.buffer = noiseBuffer(ctx)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 900 + Math.random() * 2200
      bp.Q.value = 3
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.02 + Math.random() * 0.025, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
      nb.connect(bp).connect(g).connect(ctx.destination)
      nb.start(t)
      nb.stop(t + 0.06)
    }
  } catch { /* cosmetic */ }
}

/** Every currently-playing howl (the music the deck is turning). */
/** Play. The mechanical noise is made by the caller's key click; the music
 *  itself starts at normal speed.
 *
 *  2026-08-08: this used to drawl the PITCH up from 93% over ~360ms and
 *  sweep a lowpass from 2.4 kHz — a capstan reaching speed. That is the
 *  music sounding like a tape, which Jake ruled out ("the actual music
 *  should sound normal"), so the rate ramp and the filter sweep are gone.
 *  Kept as a named no-op rather than deleted: it is called from several
 *  transport paths, and a deck that wants a spin-up NOISE later belongs
 *  here, next to the other mechanical sounds — not on the music bus. */
export function tapeMotorStart(): void {
  /* music plays at speed — nothing to do */
}

/** Pause. The key clunk still fires; the music stops cleanly.
 *
 *  2026-08-08: the ~140ms pitch sag (pinch roller letting go) applied to
 *  the music itself, so it went with the rest of the tape voicing. commit()
 *  now runs immediately instead of after the sag. */
export function tapeMotorPause(commit: () => void): void {
  mechanicalSound('pause')
  commit()
}

/** The A→B boundary: the whole flip, ears only — clunk, door, cassette
 *  flipped in hand, door shut, play. The transport underneath keeps
 *  moving (next track starts immediately); the DECK ducks it to silence
 *  and brings it back with the spin-up, so the music emerges exactly the
 *  way Side B always did. */
export function tapeFlipRitual(): void {
  if (!engaged || !input) return
  const ctx = howler()?.ctx
  if (!ctx) return
  try {
    const g = input.gain
    const t = ctx.currentTime
    g.cancelScheduledValues(t)
    g.setTargetAtTime(0.0001, t, 0.03)               // tape runs out — dead air
    clunk(ctx, true)                                  // PLAY pops out
    window.setTimeout(() => { const c = howler()?.ctx; if (c) doorPop(c) }, 220)
    window.setTimeout(() => { const c = howler()?.ctx; if (c) caseRustle(c) }, 480)
    window.setTimeout(() => { const c = howler()?.ctx; if (c) caseRustle(c) }, 760)
    window.setTimeout(() => { const c = howler()?.ctx; if (c) doorPop(c, true) }, 1150)
    window.setTimeout(() => { const c = howler()?.ctx; if (c) clunk(c, false) }, 1340)
    window.setTimeout(() => {
      try {
        const c = howler()?.ctx
        if (c && input) {
          input.gain.cancelScheduledValues(c.currentTime)
          input.gain.setTargetAtTime(1, c.currentTime, 0.05)
        }
        tapeMotorStart()
      } catch { /* cosmetic */ }
    }, 1400)
  } catch {
    try { if (input && ctx) input.gain.setTargetAtTime(1, ctx.currentTime, 0.05) } catch { /* fine */ }
  }
}

let inited = false
/** Idempotent — called from the always-mounted TapeMonitor. */
export function initTapeDeck(): void {
  if (inited) return
  inited = true
  subscribeMixtapes(sync)
  sync()
}
