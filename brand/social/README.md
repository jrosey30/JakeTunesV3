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

### Copy — a story, not statistics

    MY SPOTIFY WRAPPED  WAS WRONG. NOT EVEN CLOSE.
    SO I BUILT MY OWN   A WHOLE MUSIC APP. BY MYSELF.
    IT MAKES MIXTAPES   YOU CANNOT SKIP. FROM THE TOP.
    AND MY IPOD         STILL SYNCS. IN 2026.

and it signs off:

    JAKETUNES
    MUSIC FOR ME, NOT FOR THEE

Card 1 is Jake's real reason, in his words: "it really is because, 'My 2025
spotify wrapped was wrong'". That is the hook — thousands of people have felt
exactly that and nobody has done anything about it.

The sign-off also retired "OUT NOW", which this film had no business claiming
and which "not for thee" directly contradicts.

Jake: "i would not mention 9205 songs or the amount of songs because it changes
so fast. it should basically be a high level overview of why i built it. i want
to make people go like....'wait what?'"

So: no numbers. A count is stale the day after it is posted and is not a reason
for anything. Four cards that are a story instead — the itch, the turn, and two
things that are strange to hear in 2026. The turn is the post; the iPod line is
what gets repeated. The payoff word is always in the BIG type, which the first
pass got wrong (headline "AND IT SYNCS", punchline "TO MY IPOD." buried in the
subhead — setup loud, joke quiet).

Every claim is true of the app as built. Change them in `CARDS` at the top of
`make-film.py` and re-run — one edit, two minutes.

### The cinematic pass — and where the notes came from

Jake: "use grok api or chat gpt api to make that video more cinematic."

The xAI key has been dead since 2026-05-25, and the OpenAI key on this machine
reaches no video model — so neither API can RENDER anything here. What one can
do is DIRECT. A contact sheet of twelve frames plus the structure went to
gpt-4.1 with a brief asking for the six highest-leverage changes, restricted to
things expressible as per-frame drawing (no footage, no 3D, no stock). All six
came back concrete and all six are implemented:

1. **Zoom blur on the slams** (`mark_streak`) — several scaled copies stacked
   with falling weight, 16-18% spread decaying over ~0.14s. A slam that is only
   a scale keyframe reads as a UI transition, not as force.
2. **Two-layer burst** — a wide soft bloom plus a tight hot core. One layer
   alone reads as a grey circle rather than light.
3. **Directional wipes between cards**, 0.13s, alternating direction, with a
   bright bar riding the wipe edge. The bar is not decoration: card 1 wipes INK
   over INK, so without it that transition is invisible and the first 0.1s reads
   as a dropped frame.
4. **Gate weave** — a 1px lateral wander across the whole film. Small enough to
   be felt rather than seen; more than that makes type look unstable.
5. **Bloom and micro-shake on the void pixel**, synced to the sub-bass, so the
   opening has scale and tension instead of sitting perfectly still.
6. **Counter-parallax on the final type** — the wordmark drifts up, the sign-off
   drifts down, ~10px over five seconds. A perfectly still five-second hold
   stops reading as a held shot and starts reading as a frozen render.

Plus a drifting light leak under the statement cards, which keeps the flat
colour fields from reading as dead pixels.

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
adds a floor (sub) and a HOOK (E5 G#5 B5 C#6 B5) stated three times so it is
singable.

**The passage (4.2-10.6s) is harmony, not percussion.** Jake: "music after the
intro jingle should be a little more elegant." It was a kick on every beat, a
2.6 kHz rim tick, and six seconds of ONE chord. The kick and tick are gone —
nothing in this section needs hitting — and the static harmony was the real
problem: elegance is movement, and a pad that never changes reads as a held
note however pretty the arpeggio over it is. It now walks **I - vi - IV - V**
in E (E → C#m7 → A maj9 → B sus) and arrives home on E at 12.2, which is what
makes the ARRIVAL a resolution rather than just a louder chord. The hook lands
the second time over C#m7, where its five notes become the 3rd, 5th, 7th and
root — the cheapest way to make a repeat sound like development. Verified by
FFT per bar in the finished render.

**The click.** Jake: "i hear like a weird annoying click." Found by measuring,
not guessing: isolated high-frequency transients at 8.218s and 10.362s, ~7x the
local HF floor, both landing exactly on arpeggio onsets. Cause was the
Karplus-Strong excitation — raw FULL-BANDWIDTH white noise, so every buffer is
a dice roll and occasionally one lands with enough energy near Nyquist that the
attack reads as a click rather than a pluck. A real string is not excited by
white noise. 4 kHz lowpass on the burst plus a 4 ms attack: 2 transients → 0,
same detector, measured on the decoded mp4.

A first attempt blamed the reversed risers at IMPACT-0.02 and ARRIVE-0.03. They
did produce the two largest waveform steps in the file — but measuring the
energy 3 ms either side showed only a 1.2x rise, i.e. no onset from silence, so
they were not audible as clicks. Broadband noise has large sample-to-sample
steps by nature; a click is a jump in the ENVELOPE. They are placed forwards
now anyway, so the swell peaks ON the hit instead of decaying from before it,
which is what was wanted in the first place.

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
