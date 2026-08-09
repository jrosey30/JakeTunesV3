# Launch films — social cuts

## Current (2026-08-09) — the 2.1 film

Jake: "need a new launch video....for instagram....using the new logo....and
more enhanced launch jingle. new colors and animations and fonts must be used.
it must be incredible and talk of town worthy."

| file | use |
|---|---|
| **`jaketunes-2026-launch-reel.mp4`** | **1080x1920, 18s — Reels / Stories** |
| **`jaketunes-2026-launch-feed.mp4`** | **1080x1350, 18s — the feed post (4:5)** |
| `launch-score-2026.wav` | the score on its own |
| `make-score.py` | regenerates the score |
| `make-film.py` | regenerates both films |

Both are rebuilt from scratch with two commands:

    python3 brand/social/make-score.py
    python3 brand/social/make-film.py

### The cut

    0.00-0.60  the void — one pixel, breathing
    0.60-2.60  assembly — the mark writes itself on, cell by cell
    2.60       IMPACT — tile slam, light bursting off it, shake, RGB split
    2.60-4.20  the wordmark
    4.20-10.60 four statements, cut to the beat
   10.60-12.20 the hush — paper, near silence
   12.20       ARRIVAL — the mark full size, warm bloom
   12.20-18.00 hold, tagline, OUT NOW, fade to paper

The four cards land on the score's 112 BPM — one every three beats (1.607s) —
so the picture changes ON the music, not near it. Verified by pulling frames
back OUT of the encoded mp4 rather than trusting the renderer.

### Copy — all of it true

    9,205 SONGS.   EVERY ONE PUT THERE ON PURPOSE.
    LOSSLESS.      GAPLESS. THE WAY IT WAS MASTERED.
    MIXTAPES.      25 SONGS. NO SKIPPING. FROM THE TOP.
    A BRAIN.       NOT A FEED. IT LEARNS WHAT YOU LOVE.

The song count is the real number off the app's own status bar. Change it in
`CARDS` at the top of `make-film.py` and re-run — it is one edit and two
minutes.

### Why this one is DRAWN, not captured

The previous film was assembled from real app footage over CDP and hit a hard
ceiling: the renderer caps `Page.captureScreenshot` at CSS resolution
(1390x831), with no `deviceScaleFactor` or `clip.scale` override, and
`fromSurface:true` needs an unoccluded window. There are no retina pixels to
crop into, so a 9:16 frame would have been a 2.3x upscale — mush. That film
had to show the window whole and compose around it.

This one is drawn at native 1080x1920, which removes the ceiling and is also
what "new animations and fonts" asks for. Every pixel is generated, so it
survives whatever Instagram re-encodes it to.

### Type — two faces, neither of them the app's

- **display** — Futura Condensed ExtraBold rendered SMALL and upscaled with
  NEAREST, so the letterforms are literally pixels, the same size as the
  mark's. That is the tie: the logo is pixel art, so the headlines are too.
  Geometric forms survive pixelation; a humanist face falls apart.
- **support** — Avenir Next Condensed (Heavy/Medium) at full resolution, for
  the lines that have to be read rather than felt.

### The score

Synthesised in numpy (`make-score.py`), not rendered through the app. The
app's chime is deliberately *gentle* — no percussion, everything lowpassed at
2.6 kHz — which is right for opening an app forty times a day and wrong for a
launch post. And rendering the old arrangement through an OfflineAudioContext
inside Electron hung reliably, so the film's audio shouldn't depend on it.

What is KEPT is the tune: E major(add9), and the three notes that assemble
under the logo are E3 / G#3 / B3 at the app's own offsets. Anyone who has
opened JakeTunes recognises the opening. Then it does what the app never does —
adds a floor (sub), a pulse (112 BPM arpeggio + kick), and a HOOK
(E5 G#5 B5 C#6 B5) stated three times so it is singable.

Measured RMS, decoded back out of the finished mp4:

    approach 0.04 → IMPACT 0.21 → pulse 0.10 → hush 0.02 → ARRIVAL 0.28 → tail 0.00

The arrival is the loudest moment in the piece and the hush immediately before
it the quietest — a 13x ratio. That gap is the whole trick.

### Things that had to be fixed, caught by looking at frames

Every one of these was invisible in the code and obvious in a contact sheet:

- **`9,205 SONGS.` ran off both edges.** Headlines now go through `fit_width`.
- **Every glow was a flat disc.** `ImageDraw.ellipse` has a hard edge, so the
  void pixel, the floor under the assembly and the bloom behind the arrival
  all read as orange circles pasted on. Replaced with real radial gradients.
- **The impact was a grey wash.** Blending the whole frame toward white put
  the mark itself under the wash. The burst now sits BEHIND the mark and the
  global lift is small, so the orange stays at full strength.
- **The arrival white-out.** Same flash on the PAPER field has nowhere to go —
  it just erased the frame. The arrival burst is warm, not white.
- **The approach was as loud as the impact** (0.111 vs 0.155 RMS — 1.4x is not
  an event). A ramp across the first 2.55s buys the impact its headroom.

---

## Previous (2026-08-08) — the 1.0 films

Kept for reference. These use the OLD mark and the OLD orange, so don't post
them.

| file | use |
|---|---|
| `jaketunes-launch-reel.mp4` | 1080x1920, 21s — real app footage |
| `jaketunes-launch-post.mp4` | 1080x1080, 21s |
| `jaketunes-launch-score.wav` | the 21s score |
| `jaketunes-launch-square.mp4` / `-vertical.mp4` | 7s logo-only cuts |
| `jaketunes-launch-new.wav` | the app's launch chime alone |

Their structure: the boot, then the PRODUCT (album wall, song list, Home,
artists, a mixtape — each a real scroll captured from the running app), then a
hush, then the logo assembling a second time onto the score's arrival. The
picture was the actual app, captured with `Page.startScreencast` and assembled
from real frame timestamps rather than a guessed frame rate, because the
chord had to land on the logo landing.
