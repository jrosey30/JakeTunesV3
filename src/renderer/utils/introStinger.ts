/**
 * 4.5: the launch stinger, v2 — "the JakeTunes chord."
 *
 * v1 was a drum-fill-into-power-chord: punchy but generic. Jake: "could be
 * better… goosebumps / insanely memorable / not annoying." Goosebumps live in
 * a different gesture — ANTICIPATION → BLOOM (THX Deep Note, Mac startup):
 *
 *   0.00–0.88s  THE GATHERING — eight voices start scattered across the
 *               register and glide until they CONVERGE on an E-major add9;
 *               a lowpass opens as they travel, a reversed-cymbal "inhale"
 *               swells, a sub-bass rises underneath. A 30ms breath-hold dip
 *               right before the downbeat.
 *   0.90s       THE BLOOM — the chord locks, with a deep thump transient,
 *               a sub drop to E1 (felt, not heard), octave shimmer with a
 *               slow tremolo, a dark soft crash, and a ~2.2s generated-
 *               impulse reverb tail. Synced to the splash logo's landing.
 *
 * Not annoying: no hard distortion (only k=2.5 tanh glue), modest master
 * level, dark noise layers, long decays — warm, not buzzy.
 * Memorable: all pitches/glides are FIXED constants — it is the identical
 * chord every single launch. Fully synthesized; no asset.
 *
 * ⚠️ CRITICAL: builds its OWN AudioContext and closes it when done. NEVER
 * create/assign Howler.ctx here — pre-pinning an AudioContext onto Howler
 * silently killed all playback in 4.5.0-52 (Radio Mode regression).
 */

let played = false

/** Seconds from play start to the bloom — the splash logo's impact frame. */
export const STINGER_BLOOM_AT = 0.9

export function playIntroStinger(): void {
  // Once per app launch; also guards React StrictMode's dev double-mount.
  if (played) return
  played = true
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    void ctx.resume().catch(() => { /* silent failure — splash works without audio */ })

    const t0 = ctx.currentTime + 0.05
    const BLOOM = t0 + STINGER_BLOOM_AT

    // ── Master: modest level into a gentle compressor for glue ──
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -20
    comp.ratio.value = 5
    comp.attack.value = 0.004
    comp.release.value = 0.3
    comp.connect(ctx.destination)
    const master = ctx.createGain()
    master.gain.setValueAtTime(0.3, t0)
    // Fade the whole thing to silence at the end — no abrupt stop.
    master.gain.setValueAtTime(0.3, BLOOM + 2.0)
    master.gain.linearRampToValueAtTime(0.0001, BLOOM + 2.5)
    master.connect(comp)

    // ── Generated reverb: 2.4s stereo decaying-noise impulse response.
    //    The tail is what makes it sound expensive. Low end stays dry. ──
    const irSeconds = 2.4
    const ir = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * irSeconds), ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch)
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3)
      }
    }
    const verb = ctx.createConvolver()
    verb.buffer = ir
    const wet = ctx.createGain()
    wet.gain.value = 0.38
    verb.connect(wet).connect(master)
    /** Tap a node into the reverb send as well as the dry master. */
    const sendToVerb = (node: AudioNode): void => { node.connect(verb) }

    const noiseBuffer = (seconds: number): AudioBuffer => {
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      return buf
    }

    // ── THE GATHERING: eight voices converge onto E-major add9 ──
    // Fixed start pitches (identical every launch), wandering the register.
    const VOICES: Array<{ from: number; to: number }> = [
      { from: 196.0,  to: 82.41 },   // → E2
      { from: 146.83, to: 123.47 },  // → B2
      { from: 220.0,  to: 164.81 },  // → E3
      { from: 311.13, to: 207.65 },  // → G#3
      { from: 277.18, to: 246.94 },  // → B3
      { from: 415.3,  to: 329.63 },  // → E4
      { from: 587.33, to: 369.99 },  // → F#4 (the add9 sparkle)
      { from: 440.0,  to: 493.88 },  // → B4
    ]
    // Soft tanh "glue" — warmth, NOT distortion.
    const curve = new Float32Array(1024)
    const k = 2.5
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.tanh(k * x) / Math.tanh(k)
    }
    const glue = ctx.createWaveShaper()
    glue.curve = curve
    glue.oversample = '2x'
    const chordFilter = ctx.createBiquadFilter()
    chordFilter.type = 'lowpass'
    chordFilter.Q.value = 0.7
    chordFilter.frequency.setValueAtTime(700, t0)            // closed, distant
    chordFilter.frequency.exponentialRampToValueAtTime(5500, BLOOM)  // opens as they travel
    chordFilter.frequency.exponentialRampToValueAtTime(3600, BLOOM + 1.3)
    const chordGain = ctx.createGain()
    chordGain.gain.setValueAtTime(0.0001, t0)
    chordGain.gain.exponentialRampToValueAtTime(0.9, BLOOM - 0.06)  // the swell
    chordGain.gain.exponentialRampToValueAtTime(0.25, BLOOM - 0.005) // 30ms breath-hold
    chordGain.gain.exponentialRampToValueAtTime(1.15, BLOOM + 0.018) // BLOOM
    chordGain.gain.setValueAtTime(1.15, BLOOM + 0.3)
    chordGain.gain.exponentialRampToValueAtTime(0.0001, BLOOM + 2.2)
    glue.connect(chordFilter).connect(chordGain).connect(master)
    sendToVerb(chordGain)
    VOICES.forEach((v, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      const start = t0 + i * 0.02   // tiny stagger — they wake up one by one
      osc.frequency.setValueAtTime(v.from, start)
      osc.frequency.exponentialRampToValueAtTime(v.to, BLOOM - 0.02)  // the convergence
      osc.detune.value = i % 2 === 0 ? -4 : 4
      const vg = ctx.createGain()
      vg.gain.value = 0.085
      osc.connect(vg).connect(glue)
      osc.start(start)
      osc.stop(BLOOM + 2.3)
    })

    // ── The inhale: reversed-cymbal noise swell into the downbeat ──
    {
      const src = ctx.createBufferSource()
      src.buffer = noiseBuffer(STINGER_BLOOM_AT)
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.setValueAtTime(900, t0)
      hp.frequency.exponentialRampToValueAtTime(4200, BLOOM)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 7000   // dark ceiling — sparkle without sizzle
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.16, BLOOM - 0.03)
      g.gain.exponentialRampToValueAtTime(0.0001, BLOOM + 0.02)
      src.connect(hp).connect(lp).connect(g).connect(master)
      sendToVerb(g)
      src.start(t0); src.stop(BLOOM + 0.05)
    }

    // ── The rising sub: felt more than heard, drops to E1 at the bloom ──
    {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(55, t0)
      osc.frequency.exponentialRampToValueAtTime(61.74, BLOOM - 0.02)  // B1 — dominant, wants to resolve
      osc.frequency.setValueAtTime(41.2, BLOOM)                        // E1 — home
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.42, BLOOM - 0.03)
      g.gain.setValueAtTime(0.6, BLOOM)
      g.gain.exponentialRampToValueAtTime(0.0001, BLOOM + 1.9)
      osc.connect(g).connect(master)   // dry only — keep the low end tight
      osc.start(t0); osc.stop(BLOOM + 2.0)
    }

    // ── The bloom transient: deep thump + tiny snap (the "ta-DUM" attack) ──
    {
      const thump = ctx.createOscillator()
      thump.type = 'sine'
      thump.frequency.setValueAtTime(130, BLOOM)
      thump.frequency.exponentialRampToValueAtTime(38, BLOOM + 0.09)
      const tg = ctx.createGain()
      tg.gain.setValueAtTime(0.95, BLOOM)
      tg.gain.exponentialRampToValueAtTime(0.0001, BLOOM + 0.18)
      thump.connect(tg).connect(master)
      thump.start(BLOOM); thump.stop(BLOOM + 0.2)

      const snap = ctx.createBufferSource()
      snap.buffer = noiseBuffer(0.05)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'; bp.frequency.value = 2800; bp.Q.value = 1.2
      const sg = ctx.createGain()
      sg.gain.setValueAtTime(0.35, BLOOM)
      sg.gain.exponentialRampToValueAtTime(0.0001, BLOOM + 0.05)
      snap.connect(bp).connect(sg).connect(master)
      sendToVerb(sg)
      snap.start(BLOOM); snap.stop(BLOOM + 0.06)
    }

    // ── Dark, soft crash — release, not sizzle ──
    {
      const src = ctx.createBufferSource()
      src.buffer = noiseBuffer(1.6)
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'; hp.frequency.value = 4500
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'; lp.frequency.value = 9000
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.2, BLOOM)
      g.gain.exponentialRampToValueAtTime(0.0001, BLOOM + 1.5)
      src.connect(hp).connect(lp).connect(g).connect(master)
      sendToVerb(g)
      src.start(BLOOM); src.stop(BLOOM + 1.6)
    }

    // ── Octave shimmer: quiet detuned sines an octave up, slow tremolo ──
    {
      const lfo = ctx.createOscillator()
      lfo.frequency.value = 4.5
      const lfoDepth = ctx.createGain()
      lfoDepth.gain.value = 0.02
      lfo.connect(lfoDepth)
      for (const f of [659.26, 987.77]) {   // E5, B5
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = f
        osc.detune.value = f > 700 ? 4 : -4
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, BLOOM)
        g.gain.exponentialRampToValueAtTime(0.05, BLOOM + 0.06)
        g.gain.exponentialRampToValueAtTime(0.0001, BLOOM + 2.0)
        lfoDepth.connect(g.gain)
        osc.connect(g).connect(master)
        sendToVerb(g)
        osc.start(BLOOM); osc.stop(BLOOM + 2.1)
      }
      lfo.start(BLOOM); lfo.stop(BLOOM + 2.1)
    }

    window.setTimeout(() => { void ctx.close().catch(() => { /* already closed */ }) }, 4200)
  } catch { /* no audio is never an error worth surfacing on the splash */ }
}
