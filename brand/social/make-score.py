#!/usr/bin/env python3
"""
The launch score for the 2.1 film.

Jake: "more enhanced launch jingle... it must be incredible and talk of town
worthy."

Written in numpy rather than through the app's OfflineAudioContext. Two reasons:
the app's graph is tuned to be *gentle* on purpose (Jake, earlier: "make it
warm, inviting, musical" — no percussion, everything lowpassed at 2.6 kHz),
which is right for opening an app forty times a day and wrong for a launch
post; and rendering the old arrangement offline inside Electron hung reliably,
so the film's audio should not depend on it.

What is KEPT is the tune. The app's chime is E major(add9) and the three notes
that assemble under the logo are E3 / G#3 / B3, in that order, at those
offsets. Anyone who has opened JakeTunes knows that shape, so the film opens on
it and then does what the app never does: adds a floor, a pulse, and a hook.

    0.0 - 2.6   the approach — sub swell, the three notes assembling, a riser
    2.6         IMPACT — the full chord, floor to ceiling, sub drop
    4.2 -10.6   the pulse — arpeggio + kick under the statement cards, with the
                HOOK (E5 G#5 B5 C#6 B5) stated twice so it is singable
   10.6 -12.2   the hush — everything gone but one held note
   12.2         ARRIVAL — the biggest chord of the piece
   12.2 -18.0   the tail

Output: brand/social/launch-score-2026.wav (48k stereo float -> 16-bit)
"""
import numpy as np
from pathlib import Path
import wave

SR = 48_000
DUR = 18.0
N = int(SR * DUR)
OUT = Path(__file__).resolve().parent / 'launch-score-2026.wav'

L = np.zeros(N, dtype=np.float64)
R = np.zeros(N, dtype=np.float64)
rng = np.random.default_rng(20260809)      # fixed: the score must be reproducible

# Equal temperament, E major — the app's key.
E2, B2, E3, GS3, B3, CS4 = 82.41, 123.47, 164.81, 207.65, 246.94, 277.18
E4, FS4, GS4, B4, CS5 = 329.63, 369.99, 415.30, 493.88, 554.37
E5, FS5, GS5, B5, CS6, E6 = 659.26, 739.99, 830.61, 987.77, 1108.73, 1318.51

IMPACT = 2.60
ARRIVE = 12.20


def idx(t: float) -> int:
    return max(0, min(N, int(round(t * SR))))


def add(buf_l, buf_r, sig, start, pan=0.0):
    """Mix a mono signal in at `start` seconds with equal-power pan."""
    i = idx(start)
    n = min(len(sig), N - i)
    if n <= 0:
        return
    a = (pan + 1) * np.pi / 4                    # -1..1 -> 0..pi/2
    buf_l[i:i + n] += sig[:n] * np.cos(a)
    buf_r[i:i + n] += sig[:n] * np.sin(a)


def env(n, a, d, s, r, sus=0.75):
    """ADSR in samples-from-seconds. Shapes are curved, not linear — a linear
    decay on a sine reads as a synthetic bleep."""
    a, d, r = max(1, int(a * SR)), max(1, int(d * SR)), max(1, int(r * SR))
    s = max(0, n - a - d - r)
    out = np.concatenate([
        np.linspace(0, 1, a) ** 1.6,
        1 - (1 - sus) * (np.linspace(0, 1, d) ** 0.6),
        np.full(s, sus),
        sus * (1 - np.linspace(0, 1, r)) ** 2.2,
    ])
    return out[:n] if len(out) >= n else np.pad(out, (0, n - len(out)))


def voice(freq, dur, peak, detune=0.0, bright=0.35):
    """A warm sustained tone: triangle-ish stack, gently detuned for width."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    # Odd harmonics with 1/k^2 rolloff = triangle. Truncated, so it stays warm.
    for k, amp in ((1, 1.0), (3, 1 / 9), (5, 1 / 25), (7, 1 / 49)):
        sig += amp * np.sin(2 * np.pi * freq * k * (1 + detune) * t)
    sig += bright * 0.12 * np.sin(2 * np.pi * freq * 2 * t)   # a touch of even
    sig *= env(n, 0.012, 0.35, 0, dur * 0.55, sus=0.62)
    return sig * peak


def onepole_sweep(x, f_start, f_end, curve=1.0):
    """Time-varying one-pole lowpass — the riser's whole character."""
    n = len(x)
    f = f_start + (f_end - f_start) * (np.linspace(0, 1, n) ** curve)
    a = 1 - np.exp(-2 * np.pi * f / SR)
    y = np.empty(n)
    z = 0.0
    for i in range(n):
        z += a[i] * (x[i] - z)
        y[i] = z
    return y


def pluck(freq, dur, peak):
    """
    Karplus-Strong. The arpeggio and the hook want a string, not a pad.

    ⚠️ The excitation is BAND-LIMITED, and that is not cosmetic. Exciting the
    delay line with raw full-bandwidth white noise means every buffer is a
    fresh dice roll, and every so often one lands with enough energy near
    Nyquist that its attack reads as a CLICK rather than a pluck. Measured in
    the first score: isolated high-frequency transients at 8.218s and 10.362s,
    ~7x the local HF floor, both landing exactly on arpeggio onsets. A real
    string is not excited by white noise. 4 kHz lowpass on the burst, and a
    4 ms attack instead of 1 ms.
    """
    n = int(dur * SR)
    ln = max(2, int(SR / freq))
    buf = rng.uniform(-1, 1, ln)
    buf -= buf.mean()
    buf = onepole_sweep(buf, 4000.0, 4000.0)
    peak_abs = np.abs(buf).max()
    if peak_abs > 1e-9:
        buf = buf / peak_abs
    out = np.empty(n)
    damp = 0.9965
    for i in range(n):
        out[i] = buf[i % ln]
        nxt = (i + 1) % ln
        buf[i % ln] = damp * 0.5 * (buf[i % ln] + buf[nxt])
    out *= env(n, 0.004, 0.10, 0, dur * 0.8, sus=0.5)
    return out * peak


def bell(freq, dur, peak):
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = (np.sin(2 * np.pi * freq * t)
           + 0.4 * np.sin(2 * np.pi * freq * 2.76 * t)     # inharmonic partials
           + 0.2 * np.sin(2 * np.pi * freq * 5.4 * t))
    sig *= np.exp(-t * 3.4)
    return sig * peak


def sub(f0, f1, dur, peak):
    """The floor. A pitch-dropping sine — what the app's chime has none of."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t * 4.5)
    ph = 2 * np.pi * np.cumsum(f) / SR
    sig = np.sin(ph) + 0.25 * np.sin(2 * ph)
    sig *= np.exp(-t * 1.5)
    return sig * peak


def kick(dur, peak):
    return sub(120, 44, dur, peak)


def riser(dur, peak, tail_ms=16.0):
    """
    Noise swelling upward into a hit.

    The tail matters. This envelope ramps UP to full, so a riser that simply
    stops leaves broadband noise at full amplitude cut to silence in one
    sample — an audible click. Measured in the first render: a 0.44
    instantaneous step at 2.581s and 12.171s, which is exactly where two of
    these were placed REVERSED (a reversed riser starts at full amplitude,
    which is the same defect at the other end). Both are now placed forwards,
    so the swell peaks ON the hit, and the last few ms fade out.
    """
    n = int(dur * SR)
    noise = rng.normal(0, 1, n)
    swept = onepole_sweep(noise, 180, 7000, curve=2.4)
    swept *= np.linspace(0, 1, n) ** 2.0
    k = max(1, int(SR * tail_ms / 1000))
    swept[-k:] *= np.linspace(1, 0, k) ** 0.7
    return swept * peak


def reverb(x, tail=2.6, mix=0.30, pre=0.02):
    """FFT convolution with a synthetic exponential-noise impulse. Cheap, and
    it is what makes the impacts sound like a room rather than a click."""
    ln = int(tail * SR)
    t = np.arange(ln) / SR
    ir = rng.normal(0, 1, ln) * np.exp(-t * (5.0 / tail))
    ir = onepole_sweep(ir, 6000, 1200)          # darker as it decays
    ir /= np.abs(ir).max()
    ir = np.concatenate([np.zeros(int(pre * SR)), ir])
    wet = np.fft.irfft(np.fft.rfft(x, len(x) + len(ir)) * np.fft.rfft(ir, len(x) + len(ir)))[:len(x)]
    wet /= max(1e-9, np.abs(wet).max())
    return (1 - mix) * x + mix * wet * np.abs(x).max()


# ── 0.0–2.6  the approach ──────────────────────────────────────────────────
# The app's own three notes, same order, same offsets. This is the quote.
add(L, R, voice(E3, 3.6, 0.20, -0.0012), 0.30, -0.28)
add(L, R, voice(GS3, 3.3, 0.17, 0.0011), 0.58, 0.30)
add(L, R, voice(B3, 3.1, 0.17, -0.0009), 0.86, -0.12)
add(L, R, sub(70, 41, 3.0, 0.15), 0.05, 0.0)             # the floor arrives first
add(L, R, riser(2.55, 0.13), 0.05, 0.0)
# Ticks as the pixels land — quiet, felt more than heard.
for k in range(12):
    add(L, R, bell(1400 + 140 * k, 0.09, 0.020), 0.75 + k * 0.145, (-1) ** k * 0.35)

# ── 2.60  IMPACT ───────────────────────────────────────────────────────────
for f, pk, pan in ((E2, 0.20, 0.0), (B2, 0.15, -0.20), (E3, 0.17, 0.10),
                   (GS3, 0.13, -0.26), (B3, 0.13, 0.26), (E4, 0.15, 0.18),
                   (FS4, 0.08, -0.34), (B4, 0.08, 0.36)):
    add(L, R, voice(f, 3.4, pk), IMPACT, pan)
for f, pk, d in ((E5, 0.075, 0.02), (B5, 0.055, 0.06), (E6, 0.035, 0.10)):
    add(L, R, bell(f, 2.8, pk), IMPACT + d, 0.0)
add(L, R, sub(150, 38, 2.4, 0.42), IMPACT, 0.0)
add(L, R, riser(0.34, 0.24), IMPACT - 0.34, 0.0)         # swells INTO the hit

# ── 4.2–10.6  the passage ──────────────────────────────────────────────────
# Jake: "music after the intro jingle should be a little more elegant."
#
# It was a kick on every beat, a 2.6 kHz rim tick, and six seconds of ONE
# chord. The kick and the tick are gone — nothing here needs hitting — and the
# static harmony is the real culprit: elegance is movement, and a pad that
# never changes reads as a held note however pretty the arpeggio over it is.
#
# So the passage now walks I - vi - IV - V in E and arrives home on E at 12.2,
# which is what makes the ARRIVAL feel like a resolution rather than just a
# louder chord. Pulse comes from a warm root under each change, felt rather
# than struck.
BPM = 112.0
beat = 60.0 / BPM
CS3, A2b, A3, F3S = 138.59, 110.00, 220.00, 185.00

#        start   end     bass   arpeggio (one bar of eighths)                     pad
PASSAGE = [
    (4.200,  6.343, E2,  [E4, B4, GS4, B4, E5, B4, GS4, B4],          [E3, B3, GS4]),
    (6.343,  8.486, CS3, [CS4, GS4, E4, GS4, B4, GS4, E4, GS4],       [CS4, E4, GS4]),
    (8.486,  9.557, A2b, [A3, E4, CS5, E4],                           [A3, CS4, E4]),
    (9.557, 10.600, B2,  [B3, FS4, E4, FS4],                          [B3, E4, FS4]),
]
for start, end, bass, arp, pad in PASSAGE:
    span = end - start
    add(L, R, voice(bass, span + 1.1, 0.155), start, 0.0)
    for f, pk in zip(pad, (0.055, 0.045, 0.040)):
        add(L, R, voice(f, span + 0.9, pk), start, 0.30 * np.sin(f))
    t = start
    i = 0
    step = beat / 2
    while t < end - 0.01:
        f = arp[i % len(arp)]
        # Long ring so the notes overlap into each other — a harp, not a
        # sequencer. Alternating pan keeps it moving without a drum to do it.
        add(L, R, pluck(f, 1.05, 0.070), t, 0.34 * np.sin(i * 0.9))
        t += step
        i += 1

# THE HOOK — over E, then over C#m7, where its notes become the 3rd, 5th, 7th
# and root. Same five notes, a different chord underneath: the cheapest way to
# make a repeat sound like development rather than repetition.
HOOK = [(E5, 0.0), (GS5, 0.30), (B5, 0.60), (CS6, 0.90), (B5, 1.35)]
for when, gain in ((5.00, 0.105), (7.70, 0.115)):
    for f, off in HOOK:
        add(L, R, pluck(f, 1.5, gain), when + off, 0.16)
        add(L, R, pluck(f, 1.1, gain * 0.30), when + off + 0.30, -0.40)   # delay

# ── 10.6–12.2  the hush ────────────────────────────────────────────────────
# Everything stops. One note holds. The oldest trick there is, and it works.
add(L, R, voice(E4, 1.7, 0.055), 10.60, 0.0)

# ── 12.20  ARRIVAL ─────────────────────────────────────────────────────────
for f, pk, pan in ((E2, 0.24, 0.0), (B2, 0.17, -0.18), (E3, 0.20, 0.12),
                   (GS3, 0.15, -0.28), (B3, 0.15, 0.28), (E4, 0.18, 0.16),
                   (FS4, 0.10, -0.36), (B4, 0.10, 0.38), (E5, 0.09, 0.0)):
    add(L, R, voice(f, 5.4, pk), ARRIVE, pan)
for f, pk, d in ((E5, 0.085, 0.02), (B5, 0.065, 0.06), (CS6, 0.05, 0.10), (E6, 0.045, 0.14)):
    add(L, R, bell(f, 4.4, pk), ARRIVE + d, 0.0)
add(L, R, sub(160, 36, 4.2, 0.48), ARRIVE, 0.0)
add(L, R, riser(0.40, 0.28), ARRIVE - 0.40, 0.0)
# The hook one last time, high and unhurried, over the arrival.
for f, off in HOOK:
    add(L, R, pluck(f, 1.6, 0.10), ARRIVE + 0.45 + off * 1.15, 0.12)

# ── master ─────────────────────────────────────────────────────────────────
# The approach has to be genuinely QUIET or the impact is just more of the
# same. Measured first pass: opening 0.111 RMS against an impact of 0.155 —
# 1.4x is not an event. This ramp buys the impact its headroom.
ramp = np.ones(N)
k = idx(IMPACT - 0.05)
ramp[:k] = 0.34 + 0.66 * (np.linspace(0, 1, k) ** 2.3)
L *= ramp
R *= ramp

L = reverb(L, tail=2.8, mix=0.26)
R = reverb(R, tail=3.0, mix=0.26)

# Fade the very top and tail so nothing clicks.
L[:int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))
R[:int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))
f = int(1.1 * SR)
L[-f:] *= np.linspace(1, 0, f) ** 1.5
R[-f:] *= np.linspace(1, 0, f) ** 1.5

# Soft-clip rather than hard-limit: the impacts should feel loud, not crushed.
peak = max(np.abs(L).max(), np.abs(R).max())
L, R = L / peak * 1.06, R / peak * 1.06
L, R = np.tanh(L), np.tanh(R)
L, R = L * 0.97, R * 0.97

stereo = np.empty(N * 2, dtype=np.float64)
stereo[0::2], stereo[1::2] = L, R
pcm = (np.clip(stereo, -1, 1) * 32767).astype('<i2')

with wave.open(str(OUT), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())

# Report the shape so the cut can be checked against it rather than guessed.
mono = (L + R) / 2
print(f'wrote {OUT}  {DUR}s  {SR}Hz stereo')
print('RMS by second:')
for s in range(int(DUR)):
    seg = mono[s * SR:(s + 1) * SR]
    bar = '#' * int(np.sqrt(np.mean(seg ** 2)) * 220)
    print(f'  {s:>2}s {np.sqrt(np.mean(seg ** 2)):.4f} {bar}')
