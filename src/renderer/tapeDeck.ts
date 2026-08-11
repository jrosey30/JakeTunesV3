/**
 * The deck's MECHANICAL SOUNDS. It is not an audio processor and it is not
 * in the signal path — the music is never touched, routed or rewired.
 *
 * It used to be a live insert on Howler's master bus (wow/flutter, hiss,
 * saturation, rolloff, dropouts). Jake killed the voicing on 2026-08-08
 * ("the actual music should sound normal"), and the vestigial pass-through
 * that survived it was worse than useless: engage() called
 * master.disconnect(), which drops EVERY consumer of that bus including
 * eq.ts's analyser tap. Songs sounded muffled inside a mix and fine on
 * their own. Both are gone. See engage().
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
let inited = false
let retryTimer: number | null = null

// The deck owns NO nodes in the music path (see engage()). Only the noise
// buffer the mechanical sounds are built from.
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
  if (!ctx) return
  if (engaged) return
  // ⚠️ THE DECK DOES NOT TOUCH THE AUDIO PATH. AT ALL.
  //
  // 2026-08-08, Jake: "the song quality of daily mix 1 is horrifying... i
  // care by turnstile sounded muffling and like absolute dog crap... if i
  // play the track individually it sounds fine. only in the mix does it
  // sound like dog shit."
  //
  // Cause: this function used to rewire Howler's master bus —
  //   master.disconnect(); master.connect(input); input.connect(destination)
  // `master.disconnect()` drops EVERY connection from masterGain, not just
  // the one to destination. eq.ts's tapHowlerMaster() hangs the analyser off
  // masterGain, and anything else downstream goes with it. The bus came back
  // as a bare gain node with the rest of the chain severed. It only happened
  // during a tape session, which is why a song was fine on its own and wrong
  // inside a mix — and it got far more visible the moment daily mixes
  // started opening tape sessions.
  //
  // The pass-through only ever existed so tapeFlipRitual could duck to dead
  // air at the Side A→B boundary. There are no sides any more, so there is
  // nothing to duck and no reason to be in the signal path. The deck is
  // mechanical sound ONLY: key clunks, FF/REW wind, door, PLAY. Those are
  // independent one-shot sources that never touched the music.
  //
  // If a future change genuinely needs to duck the music, insert a node
  // between masterGain and its EXISTING outputs and put it back on
  // disengage — never blanket-disconnect a bus other code has tapped.
  engaged = true
  clunk(ctx, false)
}

function disengage(): void {
  const H = howler()
  const ctx = H?.ctx
  if (!engaged || !ctx) return
  // Nothing to unwire — engage() no longer touches the bus. Just the eject
  // clunk. (Kept as a function so the session lifecycle reads the same.)
  try { clunk(ctx, true) } finally { engaged = false }
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
/** The A→B flip — sound only.
 *
 *  2026-08-08: there are no sides any more, so this fires only for a
 *  grandfathered two-sided tape that still carries a Side A cut. It used to
 *  duck the music to dead air through the deck's bus node; that node is gone
 *  (see engage()), so the ritual is now purely the noises: clunk, door,
 *  cassette turned in hand, door, PLAY. The transport underneath keeps
 *  running, which is what it did during the duck anyway. */
export function tapeFlipRitual(): void {
  if (!engaged) return
  const ctx = howler()?.ctx
  if (!ctx) return
  try {
    clunk(ctx, true)
    window.setTimeout(() => { try { doorPop(ctx) } catch { /* cosmetic */ } }, 180)
    window.setTimeout(() => { try { caseRustle(ctx) } catch { /* cosmetic */ } }, 430)
    window.setTimeout(() => { try { doorPop(ctx, true) } catch { /* cosmetic */ } }, 800)
    window.setTimeout(() => { try { clunk(ctx, false) } catch { /* cosmetic */ } }, 1050)
  } catch { /* cosmetic */ }
}

export function initTapeDeck(): void {
  if (inited) return
  inited = true
  subscribeMixtapes(sync)
  sync()
}
