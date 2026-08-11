/**
 * 4.5: the launch sound, v5 — "warm welcome."
 *
 * The earlier versions were rock stingers (drum-fill, THX swell, then a
 * distorted power-chord strut). Jake: "sounds terrible — make it warm, inviting,
 * musical." So this is no longer a stinger at all: it's a gentle major-chord
 * welcome. NO distortion, NO drums. Soft detuned-triangle tones with slow
 * attacks arpeggiate UP an E-major triad while the logo falls, then BLOOM into
 * a lush E-major(add9) chord — warm bass, octave, and bell-like sparkle — with
 * a long reverb tail, the moment the logo lands. Music box / Mac-startup warmth.
 *
 *   0.30s  E3  ┐ the triad assembles note by note as the logo descends —
 *   0.58s  G#3 │ rounded, unhurried, each note ringing into the next
 *   0.86s  B3  ┘
 *   1.15s  ✦   BLOOM: full E-major(add9) — E2 warm bass + E4 + F#4 shimmer +
 *               E5/B5 bell sparkle, all on a ~2.5s reverb tail. Logo lands here.
 *
 * Warm by construction: triangles (not saws), a ~2.6 kHz lowpass shaving any
 * harsh top, ~40 ms soft attacks (no clicks), generous reverb, gentle master
 * fade. Identical every launch. Fully synthesized; no asset.
 *
 * ⚠️ CRITICAL: builds its OWN AudioContext and closes it when done. NEVER
 * create/assign Howler.ctx here — pre-pinning an AudioContext onto Howler
 * silently killed all playback in 4.5.0-52 (Radio Mode regression).
 */

let played = false

/** Seconds from play start to the chord bloom — the splash logo's landing. */
export const STINGER_BLOOM_AT = 1.15

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

    // ── Master → gentle compressor (glue, not pump) ──
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -22
    comp.ratio.value = 3
    comp.attack.value = 0.01
    comp.release.value = 0.3
    comp.connect(ctx.destination)
    const master = ctx.createGain()
    // Theatre dynamics: the build enters UNDER the bloom so the bloom has
    // somewhere to arrive from. Flat 0.70 throughout meant the chord landed
    // at the same level it started — pleasant, but nothing happened.
    master.gain.setValueAtTime(0.52, t0)
    master.gain.linearRampToValueAtTime(0.62, LAND - 0.12)
    master.gain.linearRampToValueAtTime(0.92, LAND + 0.05)    // the arrival
    master.gain.setValueAtTime(0.92, LAND + 2.6)
    master.gain.linearRampToValueAtTime(0.0001, LAND + 4.4)   // long curtain-fall
    master.connect(comp)

    // ── Reverb: a HALL, not a room (2026-08-09) ──
    // Jake: same sound, "only more dramatic and theatrical". Most of that is
    // space. 4.2s instead of 2.8, with a slower decay curve so the tail
    // blooms outward rather than closing in, and the two channels get
    // INDEPENDENT noise so the tail is genuinely wide instead of a mono
    // reverb sitting in the middle of the head.
    const ir = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * 4.2), ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch)
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.7)
    }
    const verb = ctx.createConvolver(); verb.buffer = ir
    const wet = ctx.createGain(); wet.gain.value = 0.55
    verb.connect(wet).connect(master)
    const sendToVerb = (node: AudioNode): void => { node.connect(verb) }

    // A warm sustained tone: two slightly-detuned triangles (chorus warmth)
    // → lowpass (shave harsh highs) → soft-attack / gentle-release envelope.
    const voice = (freq: number, start: number, dur: number, peak: number, pan = 0): void => {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.6
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, start)
      env.gain.exponentialRampToValueAtTime(peak, start + 0.04)        // ~40ms soft attack — no click
      env.gain.setValueAtTime(peak, start + Math.min(0.25, dur * 0.3))
      env.gain.exponentialRampToValueAtTime(0.0001, start + dur)        // gentle release
      // Width: the chord spreads across the stage instead of stacking in the
      // centre — the cheapest theatrical trick there is, and the most honest.
      const pn = ctx.createStereoPanner(); pn.pan.value = pan
      lp.connect(env).connect(pn).connect(master)
      sendToVerb(env)
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator()
        o.type = 'triangle'
        o.frequency.value = freq
        o.detune.value = det
        const g = ctx.createGain(); g.gain.value = 0.5
        o.connect(g).connect(lp)
        o.start(start); o.stop(start + dur + 0.1)
      }
    }

    // A soft bell/sparkle (pure sine, brighter) — only on the bloom.
    const bell = (freq: number, start: number, dur: number, peak: number): void => {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = freq
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, start)
      env.gain.exponentialRampToValueAtTime(peak, start + 0.02)
      env.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      o.connect(env).connect(master)
      sendToVerb(env)
      o.start(start); o.stop(start + dur + 0.1)
    }

    // ── The triad assembles as the logo falls (E major: E·G#·B) ──
    // Same three notes at the same three moments — the melody Jake knows is
    // untouched. They just ring longer and spread across the stage.
    voice(164.81, t0 + 0.30, 3.4, 0.17, -0.28)  // E3 — rings all the way into the bloom
    voice(207.65, t0 + 0.58, 3.1, 0.15,  0.30)  // G#3
    voice(246.94, t0 + 0.86, 2.9, 0.15, -0.12)  // B3

    // ── BLOOM at LAND — the full chord, floor to ceiling ──
    // Was E2 + E4 + F#4 + two bells. Drama here is RANGE: a sub-octave E1
    // under everything for weight you feel, the fifth to fill the middle, and
    // a top E6 so the chord reaches. Same E major(add9) — just all of it.
    voice(41.20,  LAND, 3.2, 0.20,  0.00)  // E1 — the floor
    voice(82.41,  LAND, 3.0, 0.26,  0.00)  // E2 — warm bass, swells (not a thump)
    voice(123.47, LAND, 2.8, 0.13, -0.20)  // B2 — the fifth, fills the middle
    voice(329.63, LAND, 2.7, 0.14,  0.22)  // E4 — the octave
    voice(369.99, LAND, 2.7, 0.08, -0.34)  // F#4 — the add9 shimmer
    voice(493.88, LAND, 2.5, 0.07,  0.36)  // B4 — upper fifth, air
    bell(659.26,  LAND + 0.02, 2.6, 0.065)  // E5 sparkle
    bell(987.77,  LAND + 0.06, 2.4, 0.05)   // B5 sparkle
    bell(1318.51, LAND + 0.10, 2.2, 0.03)   // E6 — the ceiling

    // A very soft, dark, airy swell into the bloom — adds "lift" without any
    // percussion. Heavily low-passed noise, quiet; fades out as the chord lands.
    {
      const src = ctx.createBufferSource()
      const len = Math.ceil(ctx.sampleRate * (STINGER_BLOOM_AT + 0.1))
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      src.buffer = buf
      // A RISER, not just a hiss: the lowpass opens 220Hz → 3.2kHz across the
      // build, so the bed brightens as it swells and gets out of the way the
      // instant the chord lands. Still no percussion — the lift comes from
      // motion, which is what makes it feel theatrical rather than loud.
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'
      lp.frequency.setValueAtTime(220, t0)
      lp.frequency.exponentialRampToValueAtTime(3200, LAND)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.085, LAND - 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, LAND + 0.22)
      src.connect(lp).connect(g).connect(master)
      sendToVerb(g)
      src.start(t0); src.stop(LAND + 0.2)
    }

    window.setTimeout(() => { void ctx.close().catch(() => { /* already closed */ }) }, 6200)
  } catch { /* no audio is never an error worth surfacing on the splash */ }
}
