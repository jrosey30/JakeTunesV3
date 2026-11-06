/**
 * 4.3.3: Announcer broadcast-FX chain. Heavy compression + presence EQ +
 * small-room convolution reverb, so station-ID drops sound like a real radio
 * station ID instead of a TTS line.
 *
 *   raw announcer TTS → MediaElementSource
 *                       → input
 *                       → compressor → low-shelf → presence peak
 *                         → high-shelf → split: dry / convolver-wet
 *                       → output (sums dry + wet)
 *                       → `into` (the preamp, joining the normal chain)
 *
 * The convolver uses a synthesized impulse response — exponentially
 * decaying noise. ~1.5s tail, sounds like a small room / vocal booth.
 * Cheap to generate, no IR file to bundle.
 *
 * Takes any BaseAudioContext so an OfflineAudioContext can render the real graph.
 */

/** Was 1.4 ("small overall boost so announcer sits on top"), which drove him
 *  over full scale: +1 to +2.3 dBTP, about 4.5 LU hotter than the hosts. */
export const ANNOUNCER_OUTPUT_GAIN = 0.7

function makeImpulseResponse(ctx: BaseAudioContext, duration: number, decay: number): AudioBuffer {
  const sampleRate = ctx.sampleRate
  const length = Math.floor(sampleRate * duration)
  const ir = ctx.createBuffer(2, length, sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay)
    }
  }
  return ir
}

export function buildAnnouncerFx(ctx: BaseAudioContext, into: AudioNode): { input: GainNode; output: GainNode } {
  const input = ctx.createGain()
  input.gain.value = 1.0

  // Heavy broadcast compression — keeps the announcer voice glued and
  // present, and tames the per-syllable peaks the model sometimes produces.
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -22
  comp.knee.value = 10
  comp.ratio.value = 8
  comp.attack.value = 0.002
  comp.release.value = 0.18

  // Low shelf — adds chest / body weight (the "deep voice" feel).
  const lowShelf = ctx.createBiquadFilter()
  lowShelf.type = 'lowshelf'
  lowShelf.frequency.value = 180
  lowShelf.gain.value = 4

  // Presence peak — voice intelligibility, makes call letters cut.
  const presence = ctx.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 2800
  presence.Q.value = 0.7
  presence.gain.value = 5

  // High shelf — air / sparkle.
  const sparkle = ctx.createBiquadFilter()
  sparkle.type = 'highshelf'
  sparkle.frequency.value = 8000
  sparkle.gain.value = 2

  // Convolver reverb (small chamber / booth).
  const conv = ctx.createConvolver()
  conv.buffer = makeImpulseResponse(ctx, 1.5, 2.5)

  const dryGain = ctx.createGain()
  dryGain.gain.value = 0.85
  const wetGain = ctx.createGain()
  wetGain.gain.value = 0.18  // subtle — too wet sounds like a bathroom

  const output = ctx.createGain()
  output.gain.value = ANNOUNCER_OUTPUT_GAIN

  // Wire it: input → comp → low → presence → sparkle → split (dry+wet) → output → into
  input.connect(comp)
  comp.connect(lowShelf)
  lowShelf.connect(presence)
  presence.connect(sparkle)
  sparkle.connect(dryGain)
  sparkle.connect(conv)
  conv.connect(wetGain)
  dryGain.connect(output)
  wetGain.connect(output)
  output.connect(into)

  return { input, output }
}
