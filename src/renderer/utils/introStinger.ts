/**
 * 4.5: the launch stinger — a ~2.6s synthesized rock'n'roll intro that plays
 * under the splash screen. Drum pickup (kick, kick, snare) into a distorted
 * E5 power chord with a cymbal crash; the chord lands at ~0.46s, timed to the
 * splash logo's ground impact.
 *
 * Fully synthesized with the Web Audio API — no bundled asset, works offline.
 *
 * ⚠️ CRITICAL: builds its OWN AudioContext and closes it when done. NEVER
 * create/assign Howler.ctx here — pre-pinning an AudioContext onto Howler
 * silently killed all playback in 4.5.0-52 (Radio Mode regression).
 */

let played = false

export function playIntroStinger(): void {
  // Once per app launch; also guards React StrictMode's dev double-mount.
  if (played) return
  played = true
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    void ctx.resume().catch(() => { /* play silently fails — splash still works */ })

    // Master: modest level into a gentle compressor for glue.
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.ratio.value = 6
    comp.attack.value = 0.003
    comp.release.value = 0.25
    comp.connect(ctx.destination)
    const master = ctx.createGain()
    master.gain.value = 0.32
    master.connect(comp)

    const t0 = ctx.currentTime + 0.04

    const noiseBuffer = (seconds: number): AudioBuffer => {
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      return buf
    }

    const kick = (t: number): void => {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(165, t)
      osc.frequency.exponentialRampToValueAtTime(45, t + 0.11)
      g.gain.setValueAtTime(0.9, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14)
      osc.connect(g).connect(master)
      osc.start(t); osc.stop(t + 0.16)
    }

    const snare = (t: number): void => {
      const src = ctx.createBufferSource()
      src.buffer = noiseBuffer(0.2)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.9
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.7, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
      src.connect(bp).connect(g).connect(master)
      src.start(t); src.stop(t + 0.2)
    }

    const crash = (t: number): void => {
      const src = ctx.createBufferSource()
      src.buffer = noiseBuffer(1.8)
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'; hp.frequency.value = 5200
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.35, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8)
      src.connect(hp).connect(g).connect(master)
      src.start(t); src.stop(t + 1.85)
    }

    // Distorted E5 power chord — E2/B2/E3/B3, two detuned saws per voice
    // through a tanh waveshaper and a closing lowpass. Rings ~2.2s.
    const powerChord = (t: number): void => {
      const curve = new Float32Array(1024)
      const k = 14
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1
        curve[i] = Math.tanh(k * x) / Math.tanh(k)
      }
      const shaper = ctx.createWaveShaper()
      shaper.curve = curve
      shaper.oversample = '2x'
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'; lp.Q.value = 0.7
      lp.frequency.setValueAtTime(4200, t)
      lp.frequency.exponentialRampToValueAtTime(2200, t + 1.6)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(1.0, t + 0.012)
      env.gain.setValueAtTime(1.0, t + 0.25)
      env.gain.exponentialRampToValueAtTime(0.0001, t + 2.2)
      shaper.connect(lp).connect(env).connect(master)
      for (const f of [82.41, 123.47, 164.81, 246.94]) {
        for (const det of [-7, 7]) {
          const osc = ctx.createOscillator()
          osc.type = 'sawtooth'
          osc.frequency.value = f
          osc.detune.value = det
          const vg = ctx.createGain()
          vg.gain.value = 0.16
          osc.connect(vg).connect(shaper)
          osc.start(t); osc.stop(t + 2.4)
        }
      }
    }

    // The riff: kick, kick, snare… CHORD + crash (synced to the logo landing).
    kick(t0)
    kick(t0 + 0.15)
    snare(t0 + 0.30)
    powerChord(t0 + 0.46)
    crash(t0 + 0.46)

    window.setTimeout(() => { void ctx.close().catch(() => { /* already closed */ }) }, 3500)
  } catch { /* no audio is never an error worth surfacing on the splash */ }
}
