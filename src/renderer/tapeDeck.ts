/**
 * Cassette voicing for tape playback — the files are never touched; this
 * is a live insert on Howler's master bus, engaged ONLY while a tape
 * session is live (mixtapes.ts setTapeSession / cleared by TapeMonitor).
 *
 * The recipe stays deliberately subtle — "you know it's a tape" without
 * wrecking the music: gentle top-end rolloff, a whisper of hiss that wows
 * with the program, slow wow + fast flutter via a modulated delay line,
 * light tape-glue compression, and a mechanical clunk on play/stop.
 *
 * ⚠️ Howler rule (learned the hard way): NEVER create or assign
 * Howler.ctx ourselves — only read it after Howler has made it. If the
 * session lands before Howler's first play, we retry until ctx exists.
 */
import { subscribeMixtapes, getTapeSession } from './mixtapes'

type HowlerGlobal = {
  ctx?: AudioContext
  masterGain?: GainNode
  _howls?: Array<{ playing: () => boolean }>
}

const howler = (): HowlerGlobal | undefined => (window as unknown as { Howler?: HowlerGlobal }).Howler

let engaged = false
let retryTimer: number | null = null
let hissWatch: number | null = null

// Live nodes (only while engaged).
let input: GainNode | null = null
let outNodes: AudioNode[] = []
let hissSrc: AudioBufferSourceNode | null = null
let hissGain: GainNode | null = null
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
    input = ctx.createGain()

    // Wow & flutter — a short delay line whose time drifts slowly (wow)
    // with a faster shimmer on top (flutter). Depths sit just at the
    // edge of perception on sustained notes.
    const delay = ctx.createDelay(0.05)
    delay.delayTime.value = 0.02
    const wow = ctx.createOscillator()
    wow.frequency.value = 0.5
    const wowDepth = ctx.createGain()
    wowDepth.gain.value = 0.0005
    wow.connect(wowDepth).connect(delay.delayTime)
    const flutter = ctx.createOscillator()
    flutter.frequency.value = 6.1
    const flutterDepth = ctx.createGain()
    flutterDepth.gain.value = 0.0001
    flutter.connect(flutterDepth).connect(delay.delayTime)
    wow.start()
    flutter.start()

    // Cassette frequency shape: shave the digital sheen, soften the very
    // bottom, keep the mids honest.
    // Soft tape saturation — rounds transients, unmistakably "tape".
    const sat = ctx.createWaveShaper()
    {
      const n = 1024
      const curve = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1
        curve[i] = Math.tanh(1.3 * x) / Math.tanh(1.3)
      }
      sat.curve = curve
      sat.oversample = '2x'
    }

    const shelfHi = ctx.createBiquadFilter()
    shelfHi.type = 'highshelf'
    shelfHi.frequency.value = 9500
    shelfHi.gain.value = -3
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 15000
    lp.Q.value = 0.7
    const shelfLo = ctx.createBiquadFilter()
    shelfLo.type = 'peaking'
    shelfLo.frequency.value = 85
    shelfLo.Q.value = 0.8
    shelfLo.gain.value = 2.5

    // Tape glue — barely-there compression.
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.ratio.value = 1.7
    comp.knee.value = 30
    comp.attack.value = 0.012
    comp.release.value = 0.2

    master.disconnect()
    master.connect(input)
    input.connect(delay)
    delay.connect(sat)
    sat.connect(shelfHi)
    shelfHi.connect(lp)
    lp.connect(shelfLo)
    shelfLo.connect(comp)
    comp.connect(ctx.destination)
    outNodes = [delay, sat, shelfHi, lp, shelfLo, comp, wow, flutter, wowDepth, flutterDepth]

    // Hiss rides INTO the chain (it's on the tape, so it wows too).
    hissGain = ctx.createGain()
    hissGain.gain.value = 0
    hissSrc = ctx.createBufferSource()
    hissSrc.buffer = noiseBuffer(ctx)
    hissSrc.loop = true
    hissSrc.connect(hissGain).connect(input)
    hissSrc.start()

    // Hiss follows the motor: audible only while the reels actually turn
    // (pause = motor stopped = silence, like a real deck).
    hissWatch = window.setInterval(() => {
      const rolling = !!howler()?._howls?.some((h) => h.playing())
      hissGain?.gain.setTargetAtTime(rolling ? 0.0028 : 0, ctx.currentTime, 0.08)
    }, 400)

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
    if (hissWatch != null) { clearInterval(hissWatch); hissWatch = null }
    try { hissSrc?.stop() } catch { /* already stopped */ }
    hissSrc?.disconnect()
    hissGain?.disconnect()
    master.disconnect()
    for (const n of outNodes) { try { n.disconnect() } catch { /* fine */ } }
    input?.disconnect()
    master.connect(ctx.destination)
  } finally {
    hissSrc = null
    hissGain = null
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

let inited = false
/** Idempotent — called from the always-mounted TapeMonitor. */
export function initTapeDeck(): void {
  if (inited) return
  inited = true
  subscribeMixtapes(sync)
  sync()
}
