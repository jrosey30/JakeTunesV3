# Brief 037 Phase 2 — Record Store Art Prompt Pack (Midjourney)

The art inventory + ready-to-paste Midjourney prompts for the
Backyard-Baseball storefront. Built from the brief's locked specs
(§1 aesthetic, §4.2 Phase 2 palette). Tool: **Midjourney v8.1**.

## Locked look (do not drift)

- **Style:** late-1990s *Backyard Baseball* video-game art crossed with
  retro point-and-click PC-adventure graphics — thick bold black
  outlines, flat saturated primary colors, chunky simple shapes, a
  **subtle pixel/retro-game texture that stays crisp and readable** (NOT
  heavily pixelated — these render small in the UI). "Illustrated, not
  designed."
- **Palette:** sky `#a8d8ff` · wood `#b87333` · counter `#5a3a22` ·
  posters/accents in primary red / yellow / blue.
- **Place:** WJLR Records, a cozy independent vinyl shop on a homey,
  tree-lined block of **Meserole Avenue in Greenpoint, Brooklyn**, among
  brownstone rowhouses. Proprietor: **The Music Man** — arrogant,
  confident, middle-aged record-store savant.
  > NOTE: the brief / blurb wrapper currently say "Atlantic Ave." Moving
  > the shop to Greenpoint means the spoken blurbs should match — update
  > `blurb-generator.ts` (`buildBlurbUserMessage`, "WJLR Records on
  > Atlantic Ave") so the art and the voice agree.

## Greenpoint easter eggs (keep them SUBTLE — background only)

Greenpoint is Brooklyn's "Little Poland," a low-rise waterfront
neighborhood facing the Manhattan skyline. Drop **at most ~2 per image**
so the shop stays a shop, not a tourism poster. Best ones:

1. **Manhattan skyline across the East River** through the window — the
   signature Greenpoint view. (Strongest, most readable.)
2. **St. Anthony of Padua church steeple** (Manhattan Ave) — the tall,
   recognizable Greenpoint landmark on the skyline. The hero easter egg.
3. **The G train** — a small green "G" subway roundel on the corner (the
   only train to Greenpoint; a local inside joke). KEEP THIS.
4. **Rooftop wooden water towers** — ambient Greenpoint texture on the
   skyline (no single "famous" one; they read as the neighborhood).
5. **WNYC Transmitter Park nod** — a faded "Transmitter Park" sign /
   distant radio tower. Rhymes with **WJLR** being a radio call-sign.
6. **Little Poland** — a faded Polish bakery sign ("Piekarnia"), a
   red-and-white awning · **Eberhard Faber pencil-factory smokestack** ·
   **Newtown Creek "digester eggs"** (deep cuts for true locals).

Reusable window clause (paste into any scene with a window):
`through the front window a homey Greenpoint block of brownstone rowhouses, rooftop wooden water towers, the tall steeple of St. Anthony of Padua church on the skyline, and a small green G train sign on the corner`

## Workflow (this order matters for consistency)

1. **Make the STYLE ANCHOR first** (Prompt 0). Upscale the best result,
   open it, copy its image URL. That URL becomes `[STYLE_URL]` — paste it
   as `--sref [STYLE_URL]` on every other prompt so the whole shop looks
   like one illustrated world.
2. **Make the MUSIC MAN character sheet** (Prompt 1). Pick the best face,
   copy its URL → `[MM_URL]`. Use `--cref [MM_URL]` on every image where
   he appears so he's the *same guy* each time. Add `--cw 100` for max
   likeness, lower (`--cw 30`) if you want pose freedom.
3. Generate the scenes/assets (Prompts 2–7) with those references.
4. **UI assets that need transparency** (Music Man sprite, speech bubble,
   album-card frame): generate on a flat solid background, then cut the
   background out (Midjourney Editor, or any background remover) → export
   PNG with alpha.

## Asset inventory → where each file lands

| Asset | Prompt | Lands in (per brief §4) |
|---|---|---|
| Style anchor (reference only) | 0 | not shipped — the `--sref` seed |
| Music Man character sheet | 1 | reference for `--cref` |
| Storefront wide shot | 2 | `art/` → `StoreScene.tsx` background |
| Vinyl bin | 3 | `art/` → `Bin.tsx` / `BinScene.tsx` |
| Counter scene (MM) | 4 | `art/` → `CounterScene.tsx` |
| MM sprite — idle + speaking | 5 | `art/` → `Proprietor.tsx` (transparent) |
| Speech bubble | 6 | `art/` → `SpeechBubble.tsx` (transparent) |
| Album-card frame | 7 | `art/` → `AlbumCard.tsx` |

---

## Prompts

**0 — Style anchor** (generate FIRST)
```
cozy independent record store on a homey tree-lined block of Meserole Avenue in Greenpoint Brooklyn, late-1990s Backyard Baseball video-game art crossed with retro point-and-click PC-adventure graphics, subtle pixel-art texture but crisp and clearly readable, thick bold black outlines, flat saturated primary colors, chunky simple shapes, warm wooden record crates, band posters in red yellow and blue, through the front window a homey block of brownstone rowhouses with the tall steeple of St. Anthony of Padua church on the skyline and a small green G train sign on the corner, light blue sky, warm and inviting --ar 16:9 --style raw --v 8.1
```

**1 — Music Man character sheet** (for `--cref`; uses the anchor's
`--sref` so he's born in the shop's exact pixel style)
```
character reference sheet of "The Music Man", a confident arrogant middle-aged record-store owner, slightly heavyset, thick mustache, vintage band t-shirt and jeans, expressive face, late-1990s Backyard Baseball pixel-art video-game style, thick black outlines, flat saturated colors, three full-body poses (arms crossed and smug, pointing while talking, leaning on the counter), plain white background --ar 16:9 --style raw --v 8.1 --sref [STYLE_URL]
```

**2 — Storefront wide shot** (StoreScene background, no people)
```
wide interior of WJLR Records, a charming vinyl shop on Meserole Avenue in Greenpoint Brooklyn, late-1990s Backyard Baseball video-game art with retro PC-adventure graphics, subtle pixel texture but crisp and readable, thick black outlines, flat saturated colors, chunky simple shapes, wooden record bins in warm tan wood, dark brown sales counter, walls of band posters in primary red yellow blue, hand-painted "WJLR Records" sign, through the storefront window a homey block of brownstone rowhouses, rooftop wooden water towers, the tall steeple of St. Anthony of Padua church on the skyline, and a small green G train sign on the corner, light blue sky, warm afternoon light, no people --ar 16:9 --style raw --v 8.1 --sref [STYLE_URL]
```

**3 — Vinyl bin** (Bin / BinScene)
```
a single wooden vinyl record bin packed with album records seen head-on, late-1990s Backyard Baseball cartoon style, thick black outlines, flat saturated warm tan wood, colorful record spines and dividers, clean simple background --ar 1:1 --style raw --v 8.1 --sref [STYLE_URL]
```

**4 — Counter scene** (CounterScene, MM present)
```
The Music Man standing behind a dark brown record-store counter, leaning forward mid-sentence with one hand gesturing, shelves of records behind him, late-1990s Backyard Baseball cartoon style, thick black outlines, flat saturated colors, warm lighting --ar 16:9 --style raw --v 8.1 --sref [STYLE_URL] --cref [MM_URL] --cw 100
```

**5 — MM sprite, idle + speaking** (Proprietor; do twice, then cut out bg)

HYBRID recipe: `--cref` locks his clean character design, `--sref` adds
the shop's pixel crunch, `--sw` dials the blend (70 = light crunch; raise
to 150-250 for more pixel, drop to 30 if his face muddies).

```
The Music Man — confident arrogant middle-aged record-store owner, thick mustache, glasses, "MUSIC" band t-shirt, slightly heavyset — full body, arms crossed, calm confident expression, mouth closed, clean cartoon line-art with thick black outlines and a subtle pixel-art texture, lightly pixelated flat shading, crisp and readable, centered on a plain solid bright-green background --ar 2:3 --style raw --v 8.1 --cref [MM_URL] --cw 100 --sref [STYLE_URL] --sw 70
```
```
The Music Man — confident arrogant middle-aged record-store owner, thick mustache, glasses, "MUSIC" band t-shirt, slightly heavyset — full body, pointing one hand and talking mid-sentence, clean cartoon line-art with thick black outlines and a subtle pixel-art texture, lightly pixelated flat shading, crisp and readable, centered on a plain solid bright-green background --ar 2:3 --style raw --v 8.1 --cref [MM_URL] --cw 100 --sref [STYLE_URL] --sw 70
```

**6 — Speech bubble** (cut out the green after)
```
a blank comic-style speech bubble, hand-drawn late-1990s cartoon style, thick black outline, clean white fill, pointed tail at lower left, plain solid bright-green background --ar 4:3 --style raw --v 8.1
```

**7 — Album-card frame** (AlbumCard; blank center for real cover art)
```
an empty square vinyl record sleeve frame with a blank center, late-1990s Backyard Baseball cartoon style, thick black outline, slight worn cardboard texture, plain background --ar 1:1 --style raw --v 8.1 --sref [STYLE_URL]
```

## Export notes for wiring

- **Backgrounds** (Prompts 2–4): full-bleed PNG/JPG, no transparency needed.
- **Sprites + UI** (Prompts 5, 6): PNG with **transparent** background
  (that's why they're generated on solid green — easy to key out).
- **Album-card frame** (Prompt 7): PNG; the center stays blank so the
  app overlays the real cover (`coverUrl`).
- Keep the **style anchor** and **Music Man** reference URLs saved — every
  future asset reuses them so nothing drifts.
