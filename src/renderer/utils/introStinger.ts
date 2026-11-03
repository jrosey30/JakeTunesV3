/**
 * The launch song — v5's "warm welcome", scored to the logo lineage (2026-11-03).
 *
 * History, so the next change keeps what Jake chose:
 *   • June 2026: rock stingers (drum fill, THX swell, a distorted power-chord
 *     strut). Jake: "sounds terrible — make it warm, inviting, musical."
 *   • v5: no distortion, no drums. Soft detuned-triangle tones with slow
 *     attacks arpeggiate UP an E-major triad, then BLOOM into a lush E
 *     major(add9) chord — warm bass, octave, bell sparkle — on a long hall.
 *   • 2026-08-09, "same sound, only more dramatic and theatrical": a hall not a
 *     room, independent L/R tails, the build entering UNDER the bloom, the
 *     chord floor to ceiling (E1 … E6), a riser opening into the arrival.
 *   • 2026-11-03, Jake: "the launching page song needs to flow better with the
 *     logo evolution." The boot had become five marks and the song had been
 *     started 1.18 s late so its chord still met the light — three marks in
 *     silence, notes on a 280 ms grid against marks on a 460 ms one. Now the
 *     cue sheet (common/splash-score.ts) gives every mark its note on the beat
 *     it dissolves in, each in its era's colour (warm → music box → brush →
 *     8-bit → 8-bit), the pedal and the riser span the whole lineage, and the
 *     splash starts this on ITS clock (playIntroStinger(bootStart)), so the
 *     song and the picture are one timeline. Same key, same voices, same
 *     melody carried two notes further, same bloom, same hall.
 *
 * Warm by construction: triangles (not saws) under a ~2.6 kHz lowpass, soft
 * attacks (no clicks), a generous hall, a gentle master curtain. The 8-bit
 * colours are a quiet 25% pulse under a lowpass — the pixel marks' grain, not
 * a chiptune. Identical every launch (but for the noise in the hall and the
 * brush). Fully synthesized; no asset.
 *
 * ⚠️ CRITICAL: builds its OWN AudioContext and closes it when done. NEVER
 * create/assign Howler.ctx here — pre-pinning an AudioContext onto Howler
 * silently killed all playback in 4.5.0-52 (Radio Mode regression).
 */
import { launchScore, songOrigin, type LaunchScore } from '../../common/splash-score'

let played = false
let primed: AudioContext | null = null

function audioContextCtor(): typeof AudioContext | undefined {
  return window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

/**
 * Open the audio device NOW, ahead of the boot (the splash calls this as it
 * mounts, while the marks load). `new AudioContext()` blocks the page for
 * ~100–200 ms while the device opens; measured 2026-11-03, paid at the boot's
 * 0 it swallowed the power-on scanline and the first mark's focus. Paid here,
 * it hides inside the image load.
 */
export function primeIntroStinger(): void {
  if (primed || played) return
  try {
    const Ctor = audioContextCtor()
    if (!Ctor) return
    primed = new Ctor()
    void primed.resume().catch(() => { /* resumed again when the song is scheduled */ })
  } catch { primed = null }
}

/**
 * Play the launch song, once per app launch (also guards React StrictMode's
 * dev double-mount). `bootStartPerfMs` is the splash's own start time
 * (performance.now() at the moment its boot clock reads 0): the song is
 * scheduled against that instant, through the audio clock's own mapping to
 * performance time, so every note sounds with its mark.
 */
export function playIntroStinger(bootStartPerfMs: number = performance.now(), score: LaunchScore = launchScore()): void {
  if (played) return
  played = true
  try {
    const Ctor = audioContextCtor()
    if (!primed && !Ctor) return
    const ctx = primed ?? new Ctor!()
    primed = null
    let scheduled = false
    const firstCueMs = score.cues[0]?.atMs ?? score.bloomAtMs
    const schedule = (): void => {
      if (scheduled) return
      const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null
      const clock = {
        contextTime: ts?.contextTime ?? 0,
        performanceTime: ts?.performanceTime ?? 0,
        currentTime: ctx.currentTime,
        nowPerfMs: performance.now(),
      }
      // A young context has no output timestamp yet and a clock still at 0;
      // the first note is ~190 ms away, so wait a few ms for a real reading
      // rather than guess — but never past the first note.
      const clockRunning = clock.performanceTime > 0 || clock.currentTime > 0
      if (!clockRunning && clock.nowPerfMs - bootStartPerfMs < firstCueMs - 40) {
        window.setTimeout(schedule, 10)
        return
      }
      scheduled = true
      try {
        scoreLaunchSong(ctx, ctx.destination, songOrigin(clock, bootStartPerfMs, firstCueMs), score)
      } catch { /* no audio is never an error worth surfacing on the splash */ }
      window.setTimeout(() => { void ctx.close().catch(() => { /* already closed */ }) }, Math.max(0, score.endMs - (performance.now() - bootStartPerfMs)) + 500)
    }
    // Schedule once the clock runs (resume settles at once in Electron), and
    // regardless after 300 ms — a context that never resumes stays silent,
    // exactly as before.
    void ctx.resume().then(schedule, schedule)
    window.setTimeout(schedule, 300)
  } catch { /* silent failure — the splash works without audio */ }
}

/**
 * Build the whole song on any audio context, starting at context time `t0`
 * (the boot's 0): the live one at launch, or an OfflineAudioContext when the
 * song is rendered to a file. `random` feeds the hall and the brush.
 */
export function scoreLaunchSong(
  ctx: BaseAudioContext,
  out: AudioNode,
  t0: number,
  score: LaunchScore,
  random: () => number = Math.random,
): void {
  const at = (ms: number): number => t0 + ms / 1000
  const START = at(score.cues[0]?.atMs ?? score.bloomAtMs)
  const LAND = at(score.bloomAtMs)
  const RING = score.ringMs / 1000

  // ── Master → gentle compressor (glue, not pump) ──
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -22
  comp.ratio.value = 3
  comp.attack.value = 0.01
  comp.release.value = 0.3
  comp.connect(out)
  const master = ctx.createGain()
  // Theatre dynamics: the build enters UNDER the bloom so the bloom has
  // somewhere to arrive from — now over the whole lineage, first mark to light.
  master.gain.setValueAtTime(0.5, Math.min(t0, START))
  master.gain.setValueAtTime(0.5, START)
  master.gain.linearRampToValueAtTime(0.64, LAND - 0.12)
  master.gain.linearRampToValueAtTime(0.92, LAND + 0.05)    // the arrival
  master.gain.setValueAtTime(0.92, LAND + 2.6)
  master.gain.linearRampToValueAtTime(0.0001, LAND + 4.4)   // long curtain-fall
  master.connect(comp)

  // ── Reverb: a HALL, not a room (2026-08-09) ──
  // 4.2 s with a slow decay so the tail blooms outward, and INDEPENDENT noise
  // per channel so the tail is genuinely wide.
  const ir = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * 4.2), ctx.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch)
    for (let i = 0; i < d.length; i++) d[i] = (random() * 2 - 1) * Math.pow(1 - i / d.length, 1.7)
  }
  const verb = ctx.createConvolver(); verb.buffer = ir
  const wet = ctx.createGain(); wet.gain.value = 0.55
  verb.connect(wet).connect(master)
  const sendToVerb = (node: AudioNode): void => { node.connect(verb) }

  const noiseBuffer = (seconds: number): AudioBuffer => {
    const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * seconds)), ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1
    return buf
  }

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
    // Width: the line spreads across the stage instead of stacking in the centre.
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

  // A soft bell/sparkle (pure sine, brighter).
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

  // ── The era colours (2026-11-03) ──

  // The cream note: a music-box tine over the warm note — the octave, plucked,
  // and a quick slightly-inharmonic ping on top, the way a comb tooth rings.
  const musicBox = (freq: number, start: number, peak: number, pan: number): void => {
    const pn = ctx.createStereoPanner(); pn.pan.value = pan
    pn.connect(master)
    for (const [mult, dur, level] of [[2, 1.1, 1], [4.02, 0.32, 0.45]] as const) {
      const o = ctx.createOscillator()
      o.type = 'sine'
      o.frequency.value = freq * mult
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, start)
      env.gain.exponentialRampToValueAtTime(peak * level, start + 0.006)
      env.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      o.connect(env).connect(pn)
      sendToVerb(env)
      o.start(start); o.stop(start + dur + 0.05)
    }
  }

  // The brush J: a soft stroke across the stage — band-passed air that
  // darkens as it travels, panned left → right like the brush moving.
  const brush = (start: number, pan: number): void => {
    const src = ctx.createBufferSource()
    src.buffer = noiseBuffer(0.45)
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9
    bp.frequency.setValueAtTime(3200, start)
    bp.frequency.exponentialRampToValueAtTime(850, start + 0.36)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(0.05, start + 0.07)
    env.gain.exponentialRampToValueAtTime(0.0001, start + 0.4)
    const pn = ctx.createStereoPanner()
    pn.pan.setValueAtTime(Math.max(-1, pan - 0.35), start)
    pn.pan.linearRampToValueAtTime(Math.min(1, pan + 0.45), start + 0.38)
    src.connect(bp).connect(env).connect(pn).connect(master)
    sendToVerb(env)
    src.start(start); src.stop(start + 0.45)
  }

  // The pixel iPod: the click wheel's tick — a few ms of bright air.
  const clickWheel = (start: number): void => {
    const src = ctx.createBufferSource()
    src.buffer = noiseBuffer(0.02)
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(0.05, start + 0.0015)
    env.gain.exponentialRampToValueAtTime(0.0001, start + 0.016)
    src.connect(hp).connect(env).connect(master)
    src.start(start); src.stop(start + 0.02)
  }

  // The pixel marks: a 25% pulse (the 8-bit voice) under a lowpass, plucked.
  const pulse = (() => {
    const N = 24, duty = 0.25
    const real = new Float32Array(N + 1), imag = new Float32Array(N + 1)
    for (let n = 1; n <= N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty)
    return ctx.createPeriodicWave(real, imag)
  })()
  const chip = (freq: number, start: number, dur: number, peak: number, pan: number): void => {
    const o = ctx.createOscillator()
    o.setPeriodicWave(pulse)
    o.frequency.value = freq
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.5
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(peak, start + 0.005)
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur)
    const pn = ctx.createStereoPanner(); pn.pan.value = pan
    o.connect(lp).connect(env).connect(pn).connect(master)
    sendToVerb(env)
    o.start(start); o.stop(start + dur + 0.05)
  }

  // ── The melody: one note per mark, each ringing on under the next ──
  for (const cue of score.cues) {
    const s = at(cue.atMs)
    voice(cue.freq, s, RING, cue.peak, cue.pan)
    switch (cue.color) {
      case 'music-box': musicBox(cue.freq, s, cue.peak * 0.5, cue.pan); break
      case 'brush': brush(s - 0.03, cue.pan); break
      case 'chip': clickWheel(s - 0.01); chip(cue.freq, s, 0.55, cue.peak * 0.3, cue.pan); break
      // Today's mark comes in over four notes still ringing, so its pluck is
      // a touch stronger (measured: at 0.34 it rose only ~4 dB above the bed).
      case 'pixel': chip(cue.freq, s, 0.7, cue.peak * 0.5, cue.pan); chip(cue.freq * 2, s + 0.03, 0.4, cue.peak * 0.16, -cue.pan); break
      case 'warm': break
    }
  }

  // ── The pedal: a soft low E under the whole lineage, handing over to the
  // bloom's own E2 — what makes five notes one gesture ──
  {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 82.41
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.5
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, START)
    env.gain.exponentialRampToValueAtTime(0.07, LAND - 0.05)
    env.gain.exponentialRampToValueAtTime(0.0001, LAND + 0.6)
    o.connect(lp).connect(env).connect(master)
    sendToVerb(env)
    o.start(START); o.stop(LAND + 0.7)
  }

  // ── BLOOM at LAND — the full chord, floor to ceiling (unchanged) ──
  // E major(add9): a sub-octave E1 for weight you feel, the fifth to fill the
  // middle, the add9 shimmer, and bells up to E6 so the chord reaches.
  voice(41.2,   LAND, 3.2, 0.2,   0.0)   // E1 — the floor
  voice(82.41,  LAND, 3.0, 0.26,  0.0)   // E2 — warm bass, swells (not a thump)
  voice(123.47, LAND, 2.8, 0.13, -0.2)   // B2 — the fifth, fills the middle
  voice(329.63, LAND, 2.7, 0.14,  0.22)  // E4 — the octave
  voice(369.99, LAND, 2.7, 0.08, -0.34)  // F#4 — the add9 shimmer
  voice(493.88, LAND, 2.5, 0.07,  0.36)  // B4 — upper fifth, air
  bell(659.26,  LAND + 0.02, 2.6, 0.065) // E5 sparkle
  bell(987.77,  LAND + 0.06, 2.4, 0.05)  // B5 sparkle
  bell(1318.51, LAND + 0.1, 2.2, 0.03)   // E6 — the ceiling
  // …and the shipping mark's grain in the sparkle: an 8-bit glint, quiet.
  chip(659.26, LAND + 0.04, 0.6, 0.02, 0.3)
  chip(987.77, LAND + 0.09, 0.45, 0.012, -0.3)

  // ── The riser: a very soft, dark, airy swell under the WHOLE lineage ──
  // The lowpass opens 220 Hz → 3.2 kHz from the first mark to the light, so
  // the bed brightens as the marks evolve and gets out of the way the instant
  // the chord lands. No percussion — the lift is motion. It stays an
  // undercurrent (~-40 dB) until today's mark has sounded, then makes its
  // push: a straight swell over the whole lineage was as loud as the notes
  // by the fifth mark and buried its note (measured 2026-11-03: a 3.6 dB
  // onset, against 11–39 dB for the others).
  {
    const LAST = at(score.cues[score.cues.length - 1]?.atMs ?? score.bloomAtMs)
    const src = ctx.createBufferSource()
    src.buffer = noiseBuffer(LAND - START + 0.3)
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'
    lp.frequency.setValueAtTime(220, START)
    lp.frequency.exponentialRampToValueAtTime(3200, LAND)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, START)
    g.gain.exponentialRampToValueAtTime(0.01, Math.max(START + 0.05, LAST + 0.08))
    g.gain.exponentialRampToValueAtTime(0.085, LAND - 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, LAND + 0.22)
    src.connect(lp).connect(g).connect(master)
    sendToVerb(g)
    src.start(START); src.stop(LAND + 0.25)
  }
}
