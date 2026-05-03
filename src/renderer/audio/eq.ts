/**
 * 10-band parametric equalizer (4.0 §6.5).
 *
 * Web Audio API filter chain that taps into every Howl's HTMLAudio
 * element. Lazy: nothing happens until the user enables EQ in Settings.
 * Once enabled, each playing Howl is routed through:
 *   MediaElementSource → preamp Gain → filter₁ → filter₂ → … → filter₁₀ → destination
 * where each filter is a BiquadFilterNode of type 'peaking' centered
 * on a classic iTunes-style band.
 *
 * Disabled state: filters are never built; new Howls play through
 * Howler's normal HTMLAudio path, no Web Audio involvement. Toggling
 * mid-session takes effect on the NEXT track (existing audio elements
 * already routed cannot be re-routed).
 *
 * MediaElementSource semantics: once an HTMLAudio element is bound
 * to a MediaElementSource, it can't be unbound. We track sources in
 * a WeakMap keyed by the audio element so we don't double-bind.
 */
import { Howl, Howler } from 'howler'

export const EQ_BAND_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
export const EQ_BAND_COUNT = EQ_BAND_FREQUENCIES.length

export interface EqSettings {
  enabled: boolean
  preamp: number          // dB, -12 to +12
  bands: number[]         // 10 entries, dB, -12 to +12 each
  preset: string          // "Flat", "Custom", or a named preset
}

export const DEFAULT_EQ: EqSettings = {
  enabled: false,
  preamp: 0,
  bands: new Array(EQ_BAND_COUNT).fill(0),
  preset: 'Flat',
}

// iTunes-faithful preset table. Values are dB per band, indexed in the
// same order as EQ_BAND_FREQUENCIES (31 Hz first → 16 kHz last).
export const EQ_PRESETS: Record<string, { preamp: number; bands: number[] }> = {
  'Flat':            { preamp: 0,  bands: [ 0,  0,  0,  0,  0,  0,  0,  0,  0,  0] },
  'Acoustic':        { preamp: 0,  bands: [ 5,  4,  4,  2,  3,  2,  3,  4,  3,  2] },
  'Bass Booster':    { preamp: 0,  bands: [ 6,  5,  4,  2,  0,  0,  0,  0,  0,  0] },
  'Bass Reducer':    { preamp: 0,  bands: [-6, -5, -4, -2,  0,  0,  0,  0,  0,  0] },
  'Classical':       { preamp: 0,  bands: [ 5,  4,  3,  2, -2, -2,  0,  3,  4,  4] },
  'Dance':           { preamp: 0,  bands: [ 4,  6,  4,  0,  2,  4,  6,  6,  4,  0] },
  'Deep':            { preamp: 0,  bands: [ 5,  3,  2,  1,  3,  2,  1,  0, -2, -4] },
  'Electronic':      { preamp: 0,  bands: [ 4,  4,  1,  0, -2,  2,  1,  1,  4,  5] },
  'Hip-Hop':         { preamp: 0,  bands: [ 5,  4,  2,  3, -1, -1,  2, -1,  2,  3] },
  'Jazz':            { preamp: 0,  bands: [ 4,  3,  1,  2, -2, -2,  0,  1,  3,  4] },
  'Latin':           { preamp: 0,  bands: [ 5,  3,  0,  0, -2, -2, -2,  0,  3,  5] },
  'Loudness':        { preamp: 0,  bands: [ 6,  4,  0,  0, -2,  0, -1,  0,  4,  5] },
  'Lounge':          { preamp: 0,  bands: [-3, -2, -1,  2,  4,  2,  0, -2,  2,  1] },
  'Piano':           { preamp: 0,  bands: [ 3,  2,  0,  2,  3,  1,  3,  4,  3,  3] },
  'Pop':             { preamp: 0,  bands: [-1, -1,  0,  2,  4,  4,  2,  0, -1, -1] },
  'R&B':             { preamp: 0,  bands: [ 3,  6,  5,  1, -2, -1,  2,  2,  3,  4] },
  'Rock':            { preamp: 0,  bands: [ 5,  4,  3,  1, -1, -1,  2,  3,  4,  4] },
  'Small Speakers':  { preamp: 0,  bands: [ 5,  4,  3,  2,  1,  0, -1, -2, -3, -4] },
  'Spoken Word':     { preamp: 0,  bands: [-3, -1,  0,  1,  3,  4,  4,  3,  2,  0] },
  'Treble Booster':  { preamp: 0,  bands: [ 0,  0,  0,  0,  0,  2,  4,  5,  6,  6] },
  'Treble Reducer':  { preamp: 0,  bands: [ 0,  0,  0,  0,  0, -2, -4, -5, -6, -6] },
  'Vocal Booster':   { preamp: 0,  bands: [-2, -3, -3,  1,  3,  3,  2,  1,  0, -2] },
}

let audioContext: AudioContext | null = null
let preampNode: GainNode | null = null
let filterNodes: BiquadFilterNode[] = []
let analyserNode: AnalyserNode | null = null
let masterTapped = false
let currentSettings: EqSettings = { ...DEFAULT_EQ }
// 4.2.20: tail of the EQ chain (last filter). Held so we can dynamically
// connect a recording-tap MediaStreamDestination after the chain has
// already been built (i.e. when the user clicks Record mid-playback).
let chainTail: AudioNode | null = null

// 4.2.20: recording infrastructure. The tail of the chain is connected
// to a MediaStreamAudioDestinationNode whose stream feeds a MediaRecorder.
// Whatever flows through preampNode → filters (music + TTS that's been
// attached via attachClipToBroadcast) is captured. We also tap Howler's
// master gain so html5:false (gapless preload) Howls don't get dropped
// from the recording.
let recordStreamDest: MediaStreamAudioDestinationNode | null = null
let mediaRecorder: MediaRecorder | null = null
let recordChunks: Blob[] = []
let recordStartedAtMs = 0
let recordHowlerMasterTapped = false

// Tracks which HTMLAudio elements have already been routed through the
// EQ chain. createMediaElementSource throws if called twice on the
// same element, so we guard with this WeakMap. Keyed by the element
// itself; held weakly so it's cleaned up when the Howl is GC'd.
const boundSources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>()

function buildChain(): void {
  if (audioContext) return
  // Reuse Howler's AudioContext so html5:false sounds (post-gapless)
  // and our html5:true MediaElementSource taps are in the SAME ctx.
  // Without this they'd be on separate contexts and the analyser
  // couldn't see the gapless track. Falls back to creating one if
  // Howler hasn't initialized its ctx yet (early app boot).
  const HowlerCtx = (Howler as unknown as { ctx?: AudioContext }).ctx
  if (HowlerCtx) {
    audioContext = HowlerCtx
  } else {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audioContext = new Ctor()
  }
  preampNode = audioContext.createGain()
  preampNode.gain.value = 1.0
  let tail: AudioNode = preampNode
  filterNodes = EQ_BAND_FREQUENCIES.map(freq => {
    const f = audioContext!.createBiquadFilter()
    f.type = 'peaking'
    f.frequency.value = freq
    f.Q.value = 1.0
    f.gain.value = 0
    tail.connect(f)
    tail = f
    return f
  })
  tail.connect(audioContext.destination)
  chainTail = tail
  // If recording was started before the chain existed, wire it up now.
  if (recordStreamDest) {
    chainTail.connect(recordStreamDest)
  }

  // Analyser for the LCD-pill mini visualizer. Side-branched off the
  // preamp so it captures every html5:true source flowing through the
  // chain WITHOUT being part of the audible signal path.
  //
  // Tuning notes:
  //   fftSize 256 → 128 bins, ~172 Hz each at 44.1 kHz.
  //   smoothing 0.3 — peaks decay quickly between transients so the
  //     bars feel BPM-locked rather than smeared. Higher values made
  //     them stick up.
  //   min/maxDecibels -85/-15 — default is -100/-30, which clips the
  //     loud end of typical music (modern masters peak around -20
  //     dBFS) and floors silence too high.
  analyserNode = audioContext.createAnalyser()
  analyserNode.fftSize = 256
  analyserNode.smoothingTimeConstant = 0.3
  analyserNode.minDecibels = -85
  analyserNode.maxDecibels = -15
  preampNode.connect(analyserNode)

  // Tap Howler's master gain so html5:false Howls (used for the
  // gapless preload, where Howler decodes into an AudioBuffer and
  // routes through its own masterGain → ctx.destination) also feed
  // the analyser. Without this tap the visualizer would go silent
  // after the first gapless transition.
  tapHowlerMaster()
}

function tapHowlerMaster(): void {
  if (masterTapped || !analyserNode) return
  const masterGain = (Howler as unknown as { masterGain?: GainNode }).masterGain
  if (!masterGain) return
  try {
    masterGain.connect(analyserNode)
    masterTapped = true
  } catch { /* ignore — already connected, or ctx mismatch */ }
}

function applySettings(): void {
  if (!audioContext || !preampNode || filterNodes.length === 0) return
  // Preamp: convert dB to linear gain (10^(dB/20)).
  const preampDb = currentSettings.enabled ? currentSettings.preamp : 0
  preampNode.gain.value = Math.pow(10, preampDb / 20)
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    const f = filterNodes[i]
    if (!f) continue
    f.gain.value = currentSettings.enabled ? (currentSettings.bands[i] || 0) : 0
  }
}

/** Push new EQ settings; values take effect immediately on tracks
 *  that are already routed through the chain. */
export function setEqSettings(next: EqSettings): void {
  currentSettings = {
    enabled: !!next.enabled,
    preamp: clamp(next.preamp, -12, 12),
    bands: (next.bands || []).slice(0, EQ_BAND_COUNT)
      .concat(new Array(EQ_BAND_COUNT).fill(0))
      .slice(0, EQ_BAND_COUNT)
      .map(v => clamp(v, -12, 12)),
    preset: next.preset || 'Custom',
  }
  if (!currentSettings.enabled) {
    // Don't build the chain just to be a no-op. Settings are stashed
    // and will apply if/when the user enables.
    if (audioContext) applySettings()
    return
  }
  buildChain()
  applySettings()
  // Resume on user gesture if needed (Chromium autoplay policy).
  if (audioContext && audioContext.state === 'suspended') {
    void audioContext.resume()
  }
}

/** Route a Howl's HTMLAudio element through the EQ + analyser chain.
 *  Always attempts to bind (even when EQ is disabled) because the
 *  visualizer's analyser taps off the same chain. With EQ off the
 *  preamp is at unity and filters are at 0 dB, so the signal passes
 *  through transparently. Safe to call repeatedly — duplicate binds
 *  on the same element are guarded by the WeakMap. */
export function attachHowlToEq(howl: Howl | null | undefined): void {
  if (!howl) return
  // Reach into Howler internals to get the underlying HTMLAudio element.
  // Howler doesn't expose a public accessor for the html5 mode element.
  const sounds = (howl as unknown as { _sounds?: Array<{ _node?: HTMLAudioElement }> })._sounds
  const audioEl = sounds && sounds[0] && sounds[0]._node
  if (!audioEl || !(audioEl instanceof HTMLAudioElement)) {
    // html5:false Howl (no audio element). Still ensure the chain
    // exists so Howler.masterGain → analyser is wired for visualizer.
    buildChain()
    tapHowlerMaster()
    return
  }
  if (boundSources.has(audioEl)) return  // already bound
  buildChain()
  tapHowlerMaster()  // retry in case Howler.masterGain wasn't ready at first build
  if (!audioContext || !preampNode) return
  try {
    const src = audioContext.createMediaElementSource(audioEl)
    src.connect(preampNode)
    boundSources.set(audioEl, src)
    if (audioContext.state === 'suspended') {
      void audioContext.resume()
    }
  } catch (err) {
    // createMediaElementSource throws if the element is already bound
    // to a different context, or some browsers throw on cross-origin
    // sources. Either way: silently skip this track.
    console.warn('[eq] could not bind audio element:', err)
  }
}

/** 4.2.20: route an arbitrary HTMLAudioElement (typically a TTS clip)
 *  through the broadcast chain so it (a) plays through the same EQ
 *  pipeline as music, and (b) is captured by an active recording.
 *  Without this, TTS plays direct-to-speakers and is invisible to the
 *  recording tap. Idempotent — duplicate binds on the same element are
 *  guarded by the same boundSources WeakMap as music elements. Caller
 *  is responsible for calling .play() on the returned element. */
export function attachClipToBroadcast(audio: HTMLAudioElement): void {
  buildChain()
  if (!audioContext || !preampNode) return
  if (boundSources.has(audio)) return
  try {
    const src = audioContext.createMediaElementSource(audio)
    src.connect(preampNode)
    boundSources.set(audio, src)
    if (audioContext.state === 'suspended') {
      void audioContext.resume()
    }
  } catch (err) {
    // If MediaElementSource is unavailable (cross-origin, etc.), the
    // clip will still play to the speakers via its native HTMLAudio
    // path — recording just won't capture it. Better than failing.
    console.warn('[broadcast] could not bind clip:', err)
  }
}

/** 4.2.20: start recording the broadcast (music + TTS routed via
 *  attachClipToBroadcast). Builds the chain if it doesn't exist yet,
 *  taps the chain tail + Howler's master gain into a MediaStream, and
 *  starts a MediaRecorder against that stream. Audio is held in chunks
 *  in module state until stopRecording() is called. */
export function startRecording(): { ok: boolean; error?: string } {
  if (mediaRecorder) return { ok: false, error: 'already recording' }
  buildChain()
  if (!audioContext) return { ok: false, error: 'no audio context' }
  try {
    recordStreamDest = audioContext.createMediaStreamDestination()
    if (chainTail) chainTail.connect(recordStreamDest)
    // Also tap Howler's master gain — handles html5:false Howls (gapless
    // preload promotes) that don't go through the chainTail. If we've
    // already tapped it once for this recording, skip; otherwise wire it.
    if (!recordHowlerMasterTapped) {
      const masterGain = (Howler as unknown as { masterGain?: GainNode }).masterGain
      if (masterGain) {
        try { masterGain.connect(recordStreamDest) } catch { /* already connected */ }
        recordHowlerMasterTapped = true
      }
    }
    // Choose the best supported MediaRecorder mimeType. Chromium prefers
    // webm/opus. We hand it to ffmpeg in main for the final MP3 step.
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ]
    const mimeType = candidates.find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || ''
    recordChunks = []
    mediaRecorder = new MediaRecorder(recordStreamDest.stream, mimeType ? { mimeType } : undefined)
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordChunks.push(e.data)
    }
    mediaRecorder.start(1000) // emit a chunk every second so a crash mid-show doesn't lose everything
    recordStartedAtMs = Date.now()
    if (audioContext.state === 'suspended') void audioContext.resume()
    return { ok: true }
  } catch (err) {
    console.warn('[broadcast] startRecording failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 4.2.20: stop recording. Resolves with a Blob of the captured audio
 *  (webm/opus by default) and the duration in seconds. Caller is
 *  responsible for transcoding to MP3 in main and offering save dialog. */
export function stopRecording(): Promise<{ ok: boolean; blob?: Blob; durationSec?: number; mimeType?: string; error?: string }> {
  return new Promise((resolve) => {
    if (!mediaRecorder) {
      resolve({ ok: false, error: 'not recording' })
      return
    }
    const rec = mediaRecorder
    const chunks = recordChunks
    const startedAt = recordStartedAtMs
    const mimeType = rec.mimeType || 'audio/webm'
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType })
      const durationSec = (Date.now() - startedAt) / 1000
      // Tear down the stream destination so future startRecording calls
      // build a fresh tap. Keep the Howler master tap state so we don't
      // double-connect on the next start.
      try {
        if (chainTail && recordStreamDest) chainTail.disconnect(recordStreamDest)
      } catch { /* ignore */ }
      try {
        const masterGain = (Howler as unknown as { masterGain?: GainNode }).masterGain
        if (recordHowlerMasterTapped && masterGain && recordStreamDest) {
          masterGain.disconnect(recordStreamDest)
        }
      } catch { /* ignore */ }
      recordHowlerMasterTapped = false
      recordStreamDest = null
      mediaRecorder = null
      recordChunks = []
      resolve({ ok: true, blob, durationSec, mimeType })
    }
    try {
      rec.stop()
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

export function isRecording(): boolean {
  return mediaRecorder !== null
}

/** Read N visualizer band amplitudes (0–255) from the analyser, with
 *  log-spaced (octave-style) bucketing across 60 Hz–12 kHz and pink-
 *  noise compensation so the bass bin doesn't permanently dominate.
 *
 *  Music's natural spectral energy decays ~3 dB per octave (pink-noise
 *  distribution), so a naive linear-bucketed analyser gives you the
 *  "left-bar-always-tallest" look. We counter with two corrections:
 *
 *    1. Log-spaced edges: each band covers a fixed number of octaves
 *       instead of a fixed number of Hz.
 *    2. Per-band gain that ramps up with frequency (~3 dB/octave) to
 *       offset the energy decay.
 *
 *  Returns null when no audio chain has been built yet. */
export function getVisualizerBins(numBins: number): Uint8Array | null {
  if (!analyserNode || !audioContext) return null
  const raw = new Uint8Array(analyserNode.frequencyBinCount)
  analyserNode.getByteFrequencyData(raw)

  const sampleRate = audioContext.sampleRate
  const nyquist = sampleRate / 2
  const hzPerBin = nyquist / raw.length

  // Visualizer covers 60 Hz to 12 kHz — 7.6 octaves. Below 60 Hz is
  // sub-bass mud that's mostly irrelevant on small speakers; above
  // 12 kHz is air/sparkle that also tends to spike on transients
  // unhelpfully. 5 bands → ~1.5 octaves each.
  const F_MIN = 60
  const F_MAX = 12000
  const out = new Uint8Array(numBins)
  for (let i = 0; i < numBins; i++) {
    const lo = F_MIN * Math.pow(F_MAX / F_MIN, i / numBins)
    const hi = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / numBins)
    const loBin = Math.max(1, Math.floor(lo / hzPerBin))
    const hiBin = Math.min(raw.length, Math.max(loBin + 1, Math.ceil(hi / hzPerBin)))
    let sum = 0, count = 0
    for (let j = loBin; j < hiBin; j++) {
      sum += raw[j]
      count++
    }
    let avg = count > 0 ? sum / count : 0
    // Pink-noise compensation, applied ADDITIVELY in byte-space (the
    // bytes already encode dB, so adding bytes = adding dB; multiplying
    // them was over-shooting and saturating all bars). +1 dB/octave
    // ≈ +3.5 bytes/octave above the bass band.
    const bandCenterOctaves = Math.log2((lo + hi) / 2 / F_MIN)
    avg = Math.min(255, avg + bandCenterOctaves * 3.5)
    // Vocal duck — bands 2 and 3 cover the 470 Hz – 3.6 kHz range
    // where sustained vocal content lives. Without this, singing
    // dominated the visualizer and it stopped feeling beat-aligned.
    // Bands 0, 1 (kick + bass) and 4 (hi-hats / snare snap) carry
    // the rhythm — those stay at full strength. Only applied at the
    // 5-band default; other counts pass through unweighted.
    if (numBins === 5) avg = avg * VOCAL_DUCK[i]
    out[i] = Math.round(avg)
  }
  return out
}

// Per-band visualizer weighting for the default 5-band layout.
// Indices 2/3 (vocal range) attenuated to bias toward rhythm.
const VOCAL_DUCK: readonly number[] = [1.0, 1.0, 0.6, 0.65, 1.0]

/** Read N time-domain samples (0–255, centered on 128) from the
 *  analyser for an oscilloscope-style waveform. Used by the LCD-pill
 *  mini visualizer. Returns null when no audio chain has been built
 *  yet. */
export function getVisualizerWaveform(numSamples: number): Uint8Array | null {
  if (!analyserNode) return null
  // getByteTimeDomainData fills a buffer with `frequencyBinCount` (=
  // fftSize/2) samples; we downsample to `numSamples` so the canvas
  // gets a clean point-per-pixel stride regardless of FFT size.
  const raw = new Uint8Array(analyserNode.frequencyBinCount)
  analyserNode.getByteTimeDomainData(raw)
  if (numSamples >= raw.length) return raw.slice()
  const out = new Uint8Array(numSamples)
  const stride = raw.length / numSamples
  for (let i = 0; i < numSamples; i++) {
    out[i] = raw[Math.floor(i * stride)]
  }
  return out
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
