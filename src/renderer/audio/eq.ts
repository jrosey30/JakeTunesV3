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
import { Howl } from 'howler'

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
let currentSettings: EqSettings = { ...DEFAULT_EQ }

// Tracks which HTMLAudio elements have already been routed through the
// EQ chain. createMediaElementSource throws if called twice on the
// same element, so we guard with this WeakMap. Keyed by the element
// itself; held weakly so it's cleaned up when the Howl is GC'd.
const boundSources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>()

function buildChain(): void {
  if (audioContext) return
  // Use the namespaced AudioContext if available; fall back to the
  // webkit-prefixed one for older Electron versions (unlikely needed
  // but cheap to guard).
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  audioContext = new Ctor()
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

/** Attempt to route a Howl's HTMLAudio element through the EQ chain.
 *  Safe to call repeatedly — if EQ is off, or this audio element is
 *  already bound, this is a no-op. */
export function attachHowlToEq(howl: Howl | null | undefined): void {
  if (!howl || !currentSettings.enabled) return
  // Reach into Howler internals to get the underlying HTMLAudio element.
  // Howler doesn't expose a public accessor for the html5 mode element.
  const sounds = (howl as unknown as { _sounds?: Array<{ _node?: HTMLAudioElement }> })._sounds
  const audioEl = sounds && sounds[0] && sounds[0]._node
  if (!audioEl || !(audioEl instanceof HTMLAudioElement)) return
  if (boundSources.has(audioEl)) return  // already bound
  buildChain()
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
    // sources. Either way: silently skip this track for EQ.
    console.warn('[eq] could not bind audio element:', err)
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
