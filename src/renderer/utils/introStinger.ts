/**
 * 4.5: the launch stinger, v3 — "the strut."
 *
 * v2 was a THX-style swell; Jake wants the first 3 seconds of the Beastie Boys'
 * "(You Gotta) Fight for Your Right" — not a copy, but THAT energy: a cocky,
 * dumb-in-the-best-way DESCENDING power-chord stomp with drums. Memorable,
 * swaggering, a little goosebump from the big landing + tail.
 *
 *   0.00s  pick-scrape + stick-count tick — "here we go"
 *   0.26s  B5  ┐ three descending power chords, each a kick+snare STOMP. The
 *   0.48s  A5  │ splash logo is falling through these — it drops in time with
 *   0.70s  G5  ┘ the riff…
 *   0.90s  E5  …and SLAMS home: big sustained chord + crash + sub-E, the exact
 *               frame the logo lands. Rings out ~1.9s on a reverb tail.
 *
 * Not annoying: the crunch is a CONTROLLED tanh (k≈7, not a fizzy k=14) into a
 * ~4 kHz lowpass — warm amp grit, not buzz. Modest master level.
 * Memorable: every pitch + hit time is a FIXED constant — identical riff every
 * launch. Fully synthesized; no asset.
 *
 * ⚠️ CRITICAL: builds its OWN AudioContext and closes it when done. NEVER
 * create/assign Howler.ctx here — pre-pinning an AudioContext onto Howler
 * silently killed all playback in 4.5.0-52 (Radio Mode regression).
 */

let played = false

/** Seconds from play start to the landing chord — the splash logo's impact. */
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
    const LAND = t0 + STINGER_BLOOM_AT

    // ── Master → gentle compressor for glue ──
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.ratio.value = 5
    comp.attack.value = 0.003
    comp.release.value = 0.25
    comp.connect(ctx.destination)
    const master = ctx.createGain()
    master.gain.setValueAtTime(0.3, t0)
    master.gain.setValueAtTime(0.3, LAND + 1.7)
    master.gain.linearRampToValueAtTime(0.0001, LAND + 2.2)   // fade out, no hard stop
    master.connect(comp)

    // ── Reverb: 2.2s decaying-noise impulse — the goosebump tail on the landing ──
    const ir = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * 2.2), ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch)
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.6)
    }
    const verb = ctx.createConvolver(); verb.buffer = ir
    const wet = ctx.createGain(); wet.gain.value = 0.3
    verb.connect(wet).connect(master)
    const sendToVerb = (node: AudioNode): void => { node.connect(verb) }

    const noiseBuffer = (seconds: number): AudioBuffer => {
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      return buf
    }

    // Controlled crunch — warm grit, not fizz.
    const makeCrunch = (k: number): WaveShaperNode => {
      const curve = new Float32Array(1024)
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1
        curve[i] = Math.tanh(k * x) / Math.tanh(k)
      }
      const ws = ctx.createWaveShaper()
      ws.curve = curve
      ws.oversample = '2x'
      return ws
    }

    // One distorted power chord (root + fifth + octave), through crunch → lowpass.
    const chord = (t: number, root: number, dur: number, big = false): void => {
      const shaper = makeCrunch(big ? 6 : 8)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'; lp.Q.value = 0.8
      lp.frequency.setValueAtTime(big ? 4600 : 3800, t)
      if (big) lp.frequency.exponentialRampToValueAtTime(2600, t + dur)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(1.0, t + 0.01)        // hard pick attack
      if (big) {
        env.gain.setValueAtTime(1.0, t + 0.25)
        env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      } else {
        env.gain.exponentialRampToValueAtTime(0.16, t + dur * 0.6) // palm-mute chug
        env.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      }
      shaper.connect(lp).connect(env).connect(master)
      if (big) sendToVerb(env)
      const freqs = [root, root * 1.4983, root * 2]   // root, fifth, octave
      for (const f of freqs) {
        for (const det of [-7, 7]) {
          const osc = ctx.createOscillator()
          osc.type = 'sawtooth'
          osc.frequency.value = f
          osc.detune.value = det
          const vg = ctx.createGain(); vg.gain.value = 0.12
          osc.connect(vg).connect(shaper)
          osc.start(t); osc.stop(t + dur + 0.05)
        }
      }
    }

    const kick = (t: number): void => {
      const osc = ctx.createOscillator(); const g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(160, t)
      osc.frequency.exponentialRampToValueAtTime(46, t + 0.1)
      g.gain.setValueAtTime(0.9, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13)
      osc.connect(g).connect(master); osc.start(t); osc.stop(t + 0.15)
    }
    const snare = (t: number, gain = 0.55): void => {
      const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.2)
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1850; bp.Q.value = 0.8
      const g = ctx.createGain()
      g.gain.setValueAtTime(gain, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15)
      src.connect(bp).connect(g).connect(master); sendToVerb(g); src.start(t); src.stop(t + 0.2)
    }
    const crash = (t: number): void => {
      const src = ctx.createBufferSource(); src.buffer = noiseBuffer(1.8)
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4800
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9500   // dark — no sizzle
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.26, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7)
      src.connect(hp).connect(lp).connect(g).connect(master); sendToVerb(g); src.start(t); src.stop(t + 1.8)
    }
    const tick = (t: number): void => {   // closed hat / stick count
      const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.04)
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.22, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
      src.connect(hp).connect(g).connect(master); src.start(t); src.stop(t + 0.05)
    }
    const pickScrape = (t: number): void => {   // the cocky "here we go" sweep
      const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.26)
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6
      bp.frequency.setValueAtTime(1100, t)
      bp.frequency.exponentialRampToValueAtTime(3200, t + 0.24)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.05)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26)
      src.connect(bp).connect(g).connect(master); src.start(t); src.stop(t + 0.27)
    }

    // ── The strut: pickup → descending B5·A5·G5 stomp → E5 landing ──
    pickScrape(t0 + 0.02)
    tick(t0 + 0.04)
    tick(t0 + 0.20)
    // B2=123.47, A2=110.0, G2=98.0, E2=82.41 (power-chord roots, descending)
    chord(t0 + 0.26, 123.47, 0.2); kick(t0 + 0.26); snare(t0 + 0.26)
    chord(t0 + 0.48, 110.00, 0.2); kick(t0 + 0.48); snare(t0 + 0.48)
    chord(t0 + 0.70, 98.00, 0.2);  kick(t0 + 0.70); snare(t0 + 0.70)
    // LANDING — the big one (logo slams home)
    chord(LAND, 82.41, 1.9, true); kick(LAND); snare(LAND, 0.7); crash(LAND)
    {
      const sub = ctx.createOscillator(); const g = ctx.createGain()
      sub.type = 'sine'
      sub.frequency.setValueAtTime(82.41, LAND)
      sub.frequency.exponentialRampToValueAtTime(41.2, LAND + 0.08)   // drop to E1 — felt
      g.gain.setValueAtTime(0.6, LAND)
      g.gain.exponentialRampToValueAtTime(0.0001, LAND + 1.6)
      sub.connect(g).connect(master); sub.start(LAND); sub.stop(LAND + 1.7)
    }

    window.setTimeout(() => { void ctx.close().catch(() => { /* already closed */ }) }, 3600)
  } catch { /* no audio is never an error worth surfacing on the splash */ }
}
