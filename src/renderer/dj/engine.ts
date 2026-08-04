import { crossfadeGains, syncRate, phaseDelta, beatPeriod } from './beatgrid.ts'

/**
 * Two-deck DJ engine.
 *
 * ── Why its own AudioContext ───────────────────────────────────────────────
 * This builds a PRIVATE AudioContext and never reads or writes `Howler.ctx`.
 * Assigning a pre-created context onto Howler broke normal playback here once
 * already (4.5.0-52, reverted in -54), and the decks need node-level control —
 * per-band EQ, a filter sweep, sample-accurate loop points — that the shared
 * player graph isn't shaped for. Two contexts coexist fine; entangling them
 * does not.
 *
 * ── Why AudioBufferSourceNode and not <audio> ──────────────────────────────
 * Decoding the whole file up front buys sample-accurate looping, instant cue
 * jumps, and a playback rate that can be changed mid-flight without a reload.
 * A 4-minute stereo track is ~40 MB decoded, so two decks sit around 80 MB —
 * acceptable for a feature the user opens deliberately, and buffers are
 * released on unload.
 *
 * Rate and pitch move together, as on a turntable. That's the instrument, not
 * a limitation: key-lock needs a phase vocoder, which is a much larger build
 * and is not what "manual DJing" means.
 */

export type DeckId = 'A' | 'B'

export interface DeckSnapshot {
  loaded: boolean
  playing: boolean
  position: number
  duration: number
  rate: number
  cuePoint: number
  loop: { start: number; end: number } | null
  trackId: number | null
}

const KILL_DB = -40          // an EQ kill is silence-in-practice, not a dip
const EQ_LOW_HZ = 120
const EQ_MID_HZ = 1000
const EQ_HIGH_HZ = 6000
const FILTER_OPEN_HZ = 20000
const FILTER_MIN_HZ = 200

export class Deck {
  readonly id: DeckId
  buffer: AudioBuffer | null = null
  trackId: number | null = null
  bpm = 0
  /** Where beat 0 sits in the file, in seconds. Estimated at load. */
  beatOffset = 0
  peaks: Float32Array = new Float32Array(0)

  private source: AudioBufferSourceNode | null = null
  private startedAtCtx = 0
  private startedFrom = 0
  private _playing = false
  private _rate = 1

  cuePoint = 0
  loop: { start: number; end: number } | null = null

  readonly low: BiquadFilterNode
  readonly mid: BiquadFilterNode
  readonly high: BiquadFilterNode
  readonly filter: BiquadFilterNode
  readonly trim: GainNode
  readonly fader: GainNode

  constructor(private ctx: AudioContext, id: DeckId, destination: AudioNode) {
    this.id = id
    this.low = ctx.createBiquadFilter()
    this.low.type = 'lowshelf'
    this.low.frequency.value = EQ_LOW_HZ
    this.mid = ctx.createBiquadFilter()
    this.mid.type = 'peaking'
    this.mid.frequency.value = EQ_MID_HZ
    this.mid.Q.value = 0.8
    this.high = ctx.createBiquadFilter()
    this.high.type = 'highshelf'
    this.high.frequency.value = EQ_HIGH_HZ
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = FILTER_OPEN_HZ
    this.trim = ctx.createGain()
    this.fader = ctx.createGain()

    this.low.connect(this.mid).connect(this.high).connect(this.filter)
      .connect(this.trim).connect(this.fader).connect(destination)
  }

  get playing(): boolean { return this._playing }
  get rate(): number { return this._rate }
  get duration(): number { return this.buffer?.duration ?? 0 }

  get position(): number {
    if (!this.buffer) return 0
    if (!this._playing) return this.startedFrom
    const elapsed = (this.ctx.currentTime - this.startedAtCtx) * this._rate
    const p = this.startedFrom + elapsed
    if (this.loop) {
      const len = this.loop.end - this.loop.start
      if (len > 0 && p > this.loop.end) {
        return this.loop.start + ((p - this.loop.start) % len)
      }
    }
    return Math.min(p, this.buffer.duration)
  }

  load(buffer: AudioBuffer, trackId: number, bpm: number): void {
    this.stop()
    this.buffer = buffer
    this.trackId = trackId
    this.bpm = bpm
    this.startedFrom = 0
    this.cuePoint = 0
    this.loop = null
    this.beatOffset = estimateFirstBeat(buffer)
    this.peaks = computePeaks(buffer, 1400)
  }

  unload(): void {
    this.stop()
    this.buffer = null
    this.trackId = null
    this.peaks = new Float32Array(0)
  }

  play(): void {
    if (!this.buffer || this._playing) return
    this.spawn(this.startedFrom)
  }

  pause(): void {
    if (!this._playing) return
    const p = this.position
    this.stop()
    this.startedFrom = p
  }

  /** Hard stop; leaves startedFrom where it was so play() resumes. */
  private stop(): void {
    if (this.source) {
      try { this.source.onended = null; this.source.stop() } catch { /* already stopped */ }
      try { this.source.disconnect() } catch { /* already detached */ }
      this.source = null
    }
    this._playing = false
  }

  seek(t: number): void {
    if (!this.buffer) return
    const clamped = Math.max(0, Math.min(t, this.buffer.duration))
    if (this._playing) this.spawn(clamped)
    else this.startedFrom = clamped
  }

  setRate(r: number): void {
    const next = Math.max(0.25, Math.min(4, r))
    if (next === this._rate) return
    // Snapshot position BEFORE changing rate, or the elapsed-time maths is
    // retroactively computed at the new rate and the playhead jumps.
    const p = this.position
    this._rate = next
    if (this._playing) this.spawn(p)
    else this.startedFrom = p
  }

  setLoop(loop: { start: number; end: number } | null): void {
    this.loop = loop && loop.end > loop.start ? loop : null
    if (this._playing) this.spawn(this.position)
  }

  private spawn(from: number): void {
    if (!this.buffer) return
    this.stop()
    const src = this.ctx.createBufferSource()
    src.buffer = this.buffer
    src.playbackRate.value = this._rate
    if (this.loop) {
      src.loop = true
      src.loopStart = this.loop.start
      src.loopEnd = this.loop.end
    }
    src.connect(this.low)
    src.onended = () => {
      // Only a natural end should clear the transport; a stop() we initiated
      // has already nulled this handler.
      if (this.source === src) { this._playing = false; this.startedFrom = this.duration }
    }
    src.start(0, Math.max(0, Math.min(from, this.buffer.duration - 0.001)))
    this.source = src
    this.startedAtCtx = this.ctx.currentTime
    this.startedFrom = from
    this._playing = true
  }

  snapshot(): DeckSnapshot {
    return {
      loaded: !!this.buffer,
      playing: this._playing,
      position: this.position,
      duration: this.duration,
      rate: this._rate,
      cuePoint: this.cuePoint,
      loop: this.loop,
      trackId: this.trackId,
    }
  }
}

export class DJEngine {
  private ctx: AudioContext
  private master: GainNode
  readonly analyser: AnalyserNode
  readonly a: Deck
  readonly b: Deck
  private crossfaderPos = 0

  constructor() {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctor()
    this.master = this.ctx.createGain()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.master.connect(this.analyser).connect(this.ctx.destination)
    this.a = new Deck(this.ctx, 'A', this.master)
    this.b = new Deck(this.ctx, 'B', this.master)
    this.setCrossfader(0)
  }

  get currentTime(): number { return this.ctx.currentTime }
  get state(): AudioContextState { return this.ctx.state }

  deck(id: DeckId): Deck { return id === 'A' ? this.a : this.b }

  /** Chromium starts contexts suspended until a gesture. Cheap and idempotent. */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
  }

  async loadInto(id: DeckId, url: string, trackId: number, bpm: number): Promise<void> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`could not read audio (HTTP ${res.status})`)
    const bytes = await res.arrayBuffer()
    const buf = await this.ctx.decodeAudioData(bytes)
    this.deck(id).load(buf, trackId, bpm)
  }

  setCrossfader(pos: number): void {
    this.crossfaderPos = Math.max(-1, Math.min(1, pos))
    const { a, b } = crossfadeGains(this.crossfaderPos)
    // setTargetAtTime, not direct assignment: a fader yanked across in one
    // frame steps the gain discontinuously and clicks. 8 ms is under the
    // threshold of feeling laggy and well over the threshold of zipper noise.
    this.a.fader.gain.setTargetAtTime(a, this.ctx.currentTime, 0.008)
    this.b.fader.gain.setTargetAtTime(b, this.ctx.currentTime, 0.008)
  }

  get crossfader(): number { return this.crossfaderPos }

  /** band gains in dB; -40 is a kill. */
  setEq(id: DeckId, band: 'low' | 'mid' | 'high', db: number): void {
    const d = this.deck(id)
    const node = band === 'low' ? d.low : band === 'mid' ? d.mid : d.high
    node.gain.setTargetAtTime(Math.max(KILL_DB, Math.min(12, db)), this.ctx.currentTime, 0.01)
  }

  /**
   * Filter sweep, -1 (heavily low-passed) .. 0 (open) .. +1 (high-passed).
   * Exponential mapping, because pitch perception is logarithmic — a linear
   * sweep does nothing for most of its travel and then slams shut at the end.
   */
  setFilter(id: DeckId, amount: number): void {
    const d = this.deck(id)
    const x = Math.max(-1, Math.min(1, amount))
    const t = this.ctx.currentTime
    if (Math.abs(x) < 0.02) {
      d.filter.type = 'lowpass'
      d.filter.frequency.setTargetAtTime(FILTER_OPEN_HZ, t, 0.02)
      return
    }
    if (x < 0) {
      d.filter.type = 'lowpass'
      const f = FILTER_OPEN_HZ * Math.pow(FILTER_MIN_HZ / FILTER_OPEN_HZ, -x)
      d.filter.frequency.setTargetAtTime(f, t, 0.02)
    } else {
      d.filter.type = 'highpass'
      const f = 20 * Math.pow(2000 / 20, x)
      d.filter.frequency.setTargetAtTime(f, t, 0.02)
    }
  }

  setTrim(id: DeckId, gain: number): void {
    this.deck(id).trim.gain.setTargetAtTime(Math.max(0, Math.min(1.5, gain)), this.ctx.currentTime, 0.01)
  }

  /**
   * Pitch bend — the digital equivalent of putting a finger on the platter.
   *
   * Held, not toggled: the deck runs a few percent fast or slow for exactly as
   * long as the key is down, then snaps back to the tempo it had. That is the
   * gesture that fixes PHASE without touching TEMPO, and it is the one motion
   * that actually has to be learned by feel, so it needs to behave like the
   * physical thing rather than like a setting.
   */
  private bendBase = new Map<DeckId, number>()

  startBend(id: DeckId, direction: -1 | 1, amount = 0.04): void {
    const d = this.deck(id)
    if (this.bendBase.has(id)) return          // already bending; don't compound
    this.bendBase.set(id, d.rate)
    d.setRate(d.rate * (1 + direction * amount))
  }

  endBend(id: DeckId): void {
    const base = this.bendBase.get(id)
    if (base === undefined) return
    this.bendBase.delete(id)
    this.deck(id).setRate(base)
  }

  /**
   * SYNC: match the other deck's tempo AND land on its beat.
   *
   * Tempo alone is not sync. Matching BPM and leaving the downbeats wherever
   * they happened to fall is precisely the thing that sounds broken — the two
   * records run at the same speed while stumbling over each other, which is
   * worse than an honest mismatch because nothing about the tempo readout
   * explains it. The phase correction is what makes the button do what its
   * name promises.
   *
   * Only nudges the playhead when both decks are running; aligning a stopped
   * deck against a moving one would be stale by the time it started.
   */
  sync(id: DeckId): number {
    const me = this.deck(id)
    const other = this.deck(id === 'A' ? 'B' : 'A')
    if (!me.bpm || !other.bpm) return me.rate
    const otherEffective = other.bpm * other.rate
    const r = syncRate(me.bpm, otherEffective)
    me.setRate(r)

    if (me.playing && other.playing) {
      const d = phaseDelta(
        other.position, other.bpm, other.beatOffset,
        me.position, me.bpm, me.beatOffset,
      )
      // d > 0 means I'm behind, so jump forward to meet them. The shift is
      // always under half a beat, so it is inaudible as a jump.
      const period = beatPeriod(me.bpm)
      if (period > 0 && Math.abs(d) > 0.001) me.seek(me.position + d * period)
    }
    return r
  }

  /** Effective (fader-adjusted) tempo, for the readout. */
  effectiveBpm(id: DeckId): number {
    const d = this.deck(id)
    return d.bpm ? d.bpm * d.rate : 0
  }

  /** Release everything. Every node, both buffers, and the context itself. */
  async dispose(): Promise<void> {
    this.a.unload()
    this.b.unload()
    try { this.master.disconnect() } catch { /* already detached */ }
    try { this.analyser.disconnect() } catch { /* already detached */ }
    await this.ctx.close().catch(() => {})
  }
}

/**
 * Downsampled absolute-peak envelope for drawing the waveform.
 * One pass over channel 0 — a full stereo scan doubles the cost and the drawn
 * result is visually identical at this resolution.
 */
export function computePeaks(buffer: AudioBuffer, buckets: number): Float32Array {
  const data = buffer.getChannelData(0)
  const out = new Float32Array(buckets)
  const per = Math.floor(data.length / buckets) || 1
  for (let i = 0; i < buckets; i++) {
    let max = 0
    const start = i * per
    const end = Math.min(start + per, data.length)
    for (let j = start; j < end; j++) {
      const v = data[j] < 0 ? -data[j] : data[j]
      if (v > max) max = v
    }
    out[i] = max
  }
  return out
}

/**
 * Estimate where beat 0 sits, by finding the first big jump in short-term
 * energy in the opening seconds.
 *
 * The library stores BPM but not a downbeat, and a grid anchored at 0.000s is
 * wrong for nearly every real file — enough to make a "beatmatched" mix flam
 * audibly. This is not a full beat tracker; it just finds the first transient
 * that stands well clear of what came before it, which for the four-on-the-floor
 * material this feature is for is the first kick.
 */
export function estimateFirstBeat(buffer: AudioBuffer, searchSeconds = 12): number {
  const sr = buffer.sampleRate
  const data = buffer.getChannelData(0)
  const win = Math.floor(sr * 0.01)                  // 10 ms frames
  const frames = Math.min(Math.floor((sr * searchSeconds) / win), Math.floor(data.length / win))
  if (frames < 4) return 0
  const energy = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const s = f * win
    for (let j = s; j < s + win; j++) sum += data[j] * data[j]
    energy[f] = Math.sqrt(sum / win)
  }
  let runningMax = energy[0]
  for (let f = 1; f < frames; f++) {
    // A real onset is several times louder than the recent floor AND loud in
    // absolute terms, so tape hiss or a fade-in doesn't register as a downbeat.
    if (energy[f] > 0.06 && energy[f] > runningMax * 2.5) return (f * win) / sr
    runningMax = Math.max(runningMax * 0.98, energy[f])
  }
  return 0
}
