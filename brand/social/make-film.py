#!/usr/bin/env python3
"""
The 2.1 launch film.

Jake: "need a new launch video....for instagram....using the new logo....and
more enhanced launch jingle. new colors and animations and fonts must be used.
it must be incredible and talk of town worthy."

WHY THIS IS DRAWN AND NOT CAPTURED. The previous film was built from real app
footage over CDP, and hit a hard wall documented in this folder's README: the
renderer caps Page.captureScreenshot at CSS resolution (1390x831), with no
deviceScaleFactor override. There are no retina pixels to crop into, so a 9:16
frame would have been a 2.3x upscale of a 1390px window — mush. That film
therefore had to show the window whole and compose around it.

This one is drawn at native 1080x1920 instead, which removes the ceiling
entirely and is also what "new animations and fonts" asks for. Every pixel is
generated, so it is sharp at any size Instagram re-encodes it to.

TYPE. Two faces, neither of them the app's:
  · display  — Futura Condensed ExtraBold rendered SMALL and upscaled with
               NEAREST resampling, so the letterforms are literally pixels.
               That is the tie to the mark: the logo is pixel art, so the
               headlines are too. Geometric forms survive pixelation; a
               humanist face would fall apart.
  · support  — Avenir Next Condensed (Heavy/Medium) at full resolution, for
               the lines that have to be read rather than felt.

COLOUR is the 2.1 ramp, unaltered: #FC5501 and its HLS-derived shades.

CUT. Timed to brand/social/launch-score-2026.wav, whose own structure is
printed by make-score.py. The four statement cards land on the score's 112 BPM
— one card every three beats (1.607s) — so the picture changes ON the music
rather than near it.

    0.00-0.60  the void: one pixel
    0.60-2.60  assembly: the mark writes itself on, cell by cell
    2.60       IMPACT: tile slam, white flash, shake, RGB split
    2.60-4.20  the wordmark
    4.20-10.60 four statements, cut to the beat
   10.60-12.20 the hush: paper, near-silence
   12.20       ARRIVAL: the mark, full size, bloom
   12.20-18.00 hold and tail

Run:  python3 brand/social/make-film.py
"""
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ART = REPO / 'src' / 'renderer' / 'assets' / 'jaketunes-logo.png'
SCORE = HERE / 'launch-score-2026.wav'
WORK = HERE / '.frames'
FPS = 30
DUR = 18.0
NFRAMES = int(FPS * DUR)

# ── the 2.1 ramp ───────────────────────────────────────────────────────────
ORANGE = (252, 85, 1)
ORANGE_LIGHT = (254, 118, 50)
ORANGE_DARK = (201, 68, 1)
GLOW = (249, 134, 76)
PAPER = (254, 253, 252)
INK = (11, 11, 10)

FUTURA = '/System/Library/Fonts/Supplemental/Futura.ttc'
FUTURA_XBOLD = 4          # Condensed ExtraBold
AVENIR = '/System/Library/Fonts/Avenir Next Condensed.ttc'
AVENIR_HEAVY, AVENIR_MED = 8, 5

IMPACT_T = 2.60
ARRIVE_T = 12.20
HUSH_T = 10.60
BEAT = 60.0 / 112.0
CARD_T = [4.20 + k * BEAT * 3 for k in range(4)]
CARD_LEN = BEAT * 3

# Real numbers, off the app's own status bar. Nothing here is invented.
CARDS = [
    ('9,205 SONGS.', 'EVERY ONE PUT THERE ON PURPOSE.'),
    ('LOSSLESS.', 'GAPLESS. THE WAY IT WAS MASTERED.'),
    ('MIXTAPES.', '25 SONGS. NO SKIPPING. FROM THE TOP.'),
    ('A BRAIN.', 'NOT A FEED. IT LEARNS WHAT YOU LOVE.'),
]

rng = np.random.default_rng(20260809)


# ── easing ─────────────────────────────────────────────────────────────────
def clamp01(x):
    return max(0.0, min(1.0, x))


def ease_out(x, p=3.0):
    return 1 - (1 - clamp01(x)) ** p


def ease_in(x, p=2.5):
    return clamp01(x) ** p


def overshoot(x, amount=1.7):
    """Back-out: goes past 1 and settles. What makes a slam feel physical."""
    x = clamp01(x)
    c = amount
    return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2


def hash01(i, salt=0):
    n = np.sin(i * 127.1 + salt * 311.7) * 43758.5453
    return float(n - np.floor(n))


# ── type ───────────────────────────────────────────────────────────────────
def pixel_text(text, cap_px, scale=8, color=(255, 255, 255), tracking=0):
    """
    Render at cap_px/scale then upscale with NEAREST, so the letters are made
    of visible square pixels the same size as the mark's. Drawing big and
    downsampling would give smooth edges — the opposite of the point.
    """
    small_size = max(6, int(round(cap_px / scale)))
    f = ImageFont.truetype(FUTURA, small_size, index=FUTURA_XBOLD)
    pad = 4
    if tracking:
        widths = [f.getbbox(ch)[2] - f.getbbox(ch)[0] if ch != ' ' else small_size // 3 for ch in text]
        total = sum(widths) + tracking * (len(text) - 1)
        img = Image.new('RGBA', (total + pad * 2, small_size * 2 + pad * 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        x = pad
        for ch, w in zip(text, widths):
            d.text((x, pad), ch, font=f, fill=color + (255,))
            x += w + tracking
    else:
        bb = f.getbbox(text)
        img = Image.new('RGBA', (bb[2] - bb[0] + pad * 2, bb[3] - bb[1] + pad * 2), (0, 0, 0, 0))
        ImageDraw.Draw(img).text((pad - bb[0], pad - bb[1]), text, font=f, fill=color + (255,))
    img = img.crop(img.getbbox() or (0, 0, 1, 1))
    return img.resize((img.width * scale, img.height * scale), Image.NEAREST)


def smooth_text(text, px, color, weight=AVENIR_MED, tracking=0.0):
    f = ImageFont.truetype(AVENIR, px, index=weight)
    if tracking <= 0:
        bb = f.getbbox(text)
        img = Image.new('RGBA', (bb[2] - bb[0] + 8, bb[3] - bb[1] + 8), (0, 0, 0, 0))
        ImageDraw.Draw(img).text((4 - bb[0], 4 - bb[1]), text, font=f, fill=color + (255,))
        return img.crop(img.getbbox() or (0, 0, 1, 1))
    widths = [(f.getbbox(c)[2] - f.getbbox(c)[0]) if c != ' ' else px // 3 for c in text]
    total = int(sum(widths) + tracking * (len(text) - 1)) + 8
    img = Image.new('RGBA', (total, px * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = 4.0
    for c, w in zip(text, widths):
        d.text((x, 4), c, font=f, fill=color + (255,))
        x += w + tracking
    return img.crop(img.getbbox() or (0, 0, 1, 1))


_DISC = {}


def soft_disc(radius, color, alpha, falloff=2.2):
    """
    A radial gradient, not a filled ellipse.

    First pass drew every glow with ImageDraw.ellipse, which has a hard edge —
    the void "pixel", the floor under the assembly and the bloom behind the
    arrival all read as flat orange discs pasted onto the frame. Built at 256px
    and scaled up, because a soft edge survives upscaling and costs nothing.
    """
    radius = max(2, int(radius))
    key = (color, round(alpha, 3), falloff)
    if key not in _DISC:
        n = 256
        yy, xx = np.mgrid[0:n, 0:n]
        dist = np.sqrt(((xx - n / 2) / (n / 2)) ** 2 + ((yy - n / 2) / (n / 2)) ** 2)
        a = (np.clip(1 - dist, 0, 1) ** falloff * alpha * 255).astype(np.uint8)
        rgba = np.dstack([np.full((n, n), color[0], np.uint8),
                          np.full((n, n), color[1], np.uint8),
                          np.full((n, n), color[2], np.uint8), a])
        _DISC[key] = Image.fromarray(rgba, 'RGBA')
    return _DISC[key].resize((radius * 2, radius * 2), Image.BILINEAR)


def fit_width(img, max_w):
    """Headlines must never run off the frame. "9,205 SONGS." did, at both
    edges, on the first pass."""
    if img.width <= max_w:
        return img
    k = max_w / img.width
    return img.resize((int(img.width * k), max(1, int(img.height * k))), Image.NEAREST)


def paste_c(base, img, cx, cy, alpha=1.0):
    """Paste centred, with optional global alpha."""
    if img is None or alpha <= 0.001:
        return
    if alpha < 0.999:
        a = img.getchannel('A').point(lambda v: int(v * alpha))
        img = img.copy()
        img.putalpha(a)
    base.alpha_composite(img, (int(cx - img.width / 2), int(cy - img.height / 2)))


# ── the mark ───────────────────────────────────────────────────────────────
MARK = Image.open(ART).convert('RGBA')


def mark_at(size):
    return MARK.resize((size, size), Image.LANCZOS if size < MARK.width else Image.NEAREST)


def assembled_mark(size, progress, cell=22):
    """
    The mark writing itself on: cells arrive along a diagonal sweep, each
    flashing as it lands. Deliberately the same idea as the app's own boot, so
    someone who has launched JakeTunes recognises the film's opening.
    """
    src = mark_at(size)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    cols = rows = (size + cell - 1) // cell
    eased = ease_out(progress, 1.8)
    flash = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    fd = ImageDraw.Draw(flash)
    for gy in range(rows):
        for gx in range(cols):
            diag = (gx / cols) * 0.55 + (gy / rows) * 0.45
            arrive = min(0.999, diag * 0.84 + hash01(gx, gy) * 0.16)
            if eased < arrive:
                continue
            box = (gx * cell, gy * cell, min(size, gx * cell + cell), min(size, gy * cell + cell))
            out.paste(src.crop(box), box[:2])
            since = (eased - arrive) * 2.6
            if since < 1.0:
                k = (1 - since) ** 2
                fd.rectangle(box, fill=(255, 248, 232, int(215 * k)))
    out.alpha_composite(flash)
    return out


# ── frame effects ──────────────────────────────────────────────────────────
def rgb_split(arr, px):
    if px < 1:
        return arr
    out = arr.copy()
    out[:, :, 0] = np.roll(arr[:, :, 0], px, axis=1)
    out[:, :, 2] = np.roll(arr[:, :, 2], -px, axis=1)
    return out


GRAIN = None


def add_grain(arr, amount):
    """One fixed noise field, rolled per frame — cheaper than fresh noise and
    it reads as film rather than as static."""
    global GRAIN
    if amount <= 0:
        return arr
    if GRAIN is None or GRAIN.shape[:2] != arr.shape[:2]:
        GRAIN = rng.normal(0, 1, arr.shape[:2] + (1,))
    return arr + GRAIN * amount


def vignette_mask(w, h, strength=0.30):
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2)
    return (1 - strength * np.clip((d - 0.55) / 0.85, 0, 1) ** 1.6)[:, :, None]


# ── the frame ──────────────────────────────────────────────────────────────
def render(t, W, H):
    """One frame at time t. Layout is expressed against W/H so the same
    composition renders 9:16 and 4:5 without a separate design."""
    S = min(W, H)
    cx, cy = W / 2, H * 0.44
    on_paper = t >= HUSH_T
    bg = PAPER if on_paper else INK
    img = Image.new('RGBA', (W, H), bg + (255,))
    d = ImageDraw.Draw(img)

    shake = (0, 0)
    flash = 0.0
    split = 0

    # ── A. the void ────────────────────────────────────────────────────────
    if t < 0.60:
        k = t / 0.60
        pulse = 0.5 + 0.5 * np.sin(t * 20)
        r = S * 0.008 * (1 + 0.35 * pulse)
        paste_c(img, soft_disc(S * (0.06 + 0.30 * k), ORANGE, 0.30 + 0.22 * pulse, 2.6), cx, cy)
        d.rectangle([cx - r, cy - r, cx + r, cy + r], fill=(255, 240, 220, 255))

    # ── B. assembly ────────────────────────────────────────────────────────
    elif t < IMPACT_T:
        k = (t - 0.60) / (IMPACT_T - 0.60)
        size = int(S * (0.46 + 0.06 * ease_out(k, 2.0)))
        m = assembled_mark(size, k)
        drift = (1 - ease_out(k, 2.0)) * S * 0.02
        paste_c(img, m, cx, cy - drift)
        # a floor of light growing under it
        glow = soft_disc(S * (0.20 + 0.42 * k), ORANGE, 0.10 + 0.16 * k, 2.4)
        glow = glow.resize((glow.width, max(2, int(glow.height * 0.34))), Image.BILINEAR)
        paste_c(img, glow, cx, cy + size * 0.60)

    # ── C/D. impact + wordmark ─────────────────────────────────────────────
    elif t < CARD_T[0]:
        e = t - IMPACT_T
        sc = overshoot(clamp01(e / 0.42), 1.9) if e < 0.42 else 1.0
        size = int(S * 0.60 * (1.35 - 0.35 * sc) if e < 0.42 else S * 0.60)
        size = max(8, size)
        if e < 0.30:
            amp = (1 - e / 0.30) ** 2 * S * 0.022
            shake = (int(np.sin(e * 92) * amp), int(np.cos(e * 71) * amp))
        # Short and WHITE. A 0.16s ramp read as a grey wash over the black
        # field instead of a hit.
        # Light comes OFF the mark. Blending the WHOLE frame toward white put
        # the mark itself under the wash, so the impact read as a grey dip
        # rather than a hit — worse than no flash. A burst behind it, plus a
        # small global lift, keeps the orange at full strength.
        burst = max(0.0, 1 - e / 0.16) ** 1.3
        flash = burst * 0.30
        split = int(max(0, (1 - e / 0.20)) * 12)
        if burst > 0.01:
            paste_c(img, soft_disc(size * (0.7 + 1.5 * (1 - burst)), (255, 246, 226), burst * 0.85, 1.7),
                    cx + shake[0], cy + shake[1])
        paste_c(img, mark_at(size), cx + shake[0], cy + shake[1])
        if e > 0.28:
            wk = clamp01((e - 0.28) / 0.5)
            wm = pixel_text('JAKETUNES', int(S * 0.115), scale=9, color=PAPER, tracking=1)
            paste_c(img, wm, cx, cy + size * 0.72 + (1 - ease_out(wk)) * 40, ease_out(wk))
        if e > 0.72:
            sk = clamp01((e - 0.72) / 0.5)
            tag = smooth_text('THE GREATEST MUSIC PLATFORM EVER BUILT',
                              int(S * 0.030), (176, 168, 158), AVENIR_MED, tracking=S * 0.0042)
            paste_c(img, tag, cx, cy + size * 0.72 + S * 0.10, sk)

    # ── E. statements ──────────────────────────────────────────────────────
    elif t < HUSH_T:
        i = min(3, int((t - CARD_T[0]) // CARD_LEN))
        e = t - CARD_T[i]
        head, sub = CARDS[i]
        warm = i % 2 == 1
        if warm:
            img = Image.new('RGBA', (W, H), ORANGE + (255,))
            d = ImageDraw.Draw(img)
        fg = INK if warm else PAPER
        accent = PAPER if warm else ORANGE
        # a rule wipes across before the words land
        rw = ease_out(clamp01(e / 0.30), 2.4)
        d.rectangle([cx - S * 0.40, cy - S * 0.20, cx - S * 0.40 + S * 0.80 * rw, cy - S * 0.20 + 6],
                    fill=accent + (255,))
        hk = clamp01((e - 0.10) / 0.34)
        if hk > 0:
            ht = fit_width(pixel_text(head, int(S * 0.165), scale=10, color=fg, tracking=1), int(W * 0.86))
            dy = (1 - overshoot(hk, 2.2)) * S * 0.06
            paste_c(img, ht, cx, cy + dy, min(1.0, hk * 2.2))
        sk = clamp01((e - 0.34) / 0.40)
        if sk > 0:
            # On the orange cards the subhead was ink-on-orange at 3.3% — legible
            # in theory, invisible on a phone. Paper on orange, ink on black.
            sub_col = PAPER if warm else (232, 226, 216)
            st = fit_width(smooth_text(sub, int(S * 0.038), sub_col, AVENIR_HEAVY, tracking=S * 0.0026), int(W * 0.86))
            paste_c(img, st, cx, cy + S * 0.140, ease_out(sk))
        # ticking counter of the card index, small, bottom
        cnt = smooth_text(f'{i + 1} / 4', int(S * 0.026), accent, AVENIR_HEAVY, tracking=S * 0.004)
        paste_c(img, cnt, cx, H * 0.86, 0.85)
        flash = max(0.0, 1 - e / 0.07) ** 2 * (0.5 if e < 0.07 else 0)

    # ── F. the hush ────────────────────────────────────────────────────────
    elif t < ARRIVE_T:
        k = (t - HUSH_T) / (ARRIVE_T - HUSH_T)
        ghost = mark_at(int(S * 0.52))
        paste_c(img, ghost, cx, cy, 0.055 + 0.03 * np.sin(t * 5))
        paste_c(img, soft_disc(S * 0.10 * (1 + 0.25 * np.sin(t * 6)), ORANGE, 0.20, 2.6), cx, cy)
        r = S * 0.007 + S * 0.003 * np.sin(t * 7)
        d.rectangle([cx - r, cy - r, cx + r, cy + r], fill=ORANGE + (255,))
        # (A contracting hairline lived here. On a white field it read as a
        #  stray rule across the frame, not as a held note. Cut.)

    # ── G/H. arrival + hold ────────────────────────────────────────────────
    else:
        e = t - ARRIVE_T
        sc = overshoot(clamp01(e / 0.5), 1.6) if e < 0.5 else 1.0
        base = S * 0.60
        size = int(base * (1.28 - 0.28 * sc) if e < 0.5 else base * (1.0 + 0.006 * np.sin(e * 1.6)))
        if e < 0.26:
            amp = (1 - e / 0.26) ** 2 * S * 0.018
            shake = (int(np.sin(e * 88) * amp), int(np.cos(e * 64) * amp))
        # On PAPER a white flash has nowhere to go — it just erases the frame,
        # and the arrival read as a two-frame white-out. The burst here is WARM
        # and sits behind the mark; the global lift is small.
        burst = max(0.0, 1 - e / 0.22) ** 1.3
        flash = burst * 0.20
        split = int(max(0, (1 - e / 0.22)) * 8)
        paste_c(img, soft_disc(size * (0.95 + 0.06 * np.sin(e * 1.9)), GLOW,
                               0.30 * min(1, e / 0.45), 2.0), cx, cy)
        if burst > 0.01:
            paste_c(img, soft_disc(size * (0.8 + 1.3 * (1 - burst)), ORANGE_LIGHT, burst * 0.75, 1.8),
                    cx + shake[0], cy + shake[1])
        paste_c(img, mark_at(size), cx + shake[0], cy + shake[1])
        wk = clamp01((e - 0.30) / 0.55)
        if wk > 0:
            wm = pixel_text('JAKETUNES', int(S * 0.128), scale=10, color=INK, tracking=1)
            paste_c(img, wm, cx, cy + size * 0.70 + (1 - ease_out(wk)) * 46, ease_out(wk))
        tk = clamp01((e - 0.75) / 0.6)
        if tk > 0:
            tag = smooth_text('THE GREATEST MUSIC PLATFORM EVER BUILT',
                              int(S * 0.031), (120, 112, 102), AVENIR_HEAVY, tracking=S * 0.0046)
            paste_c(img, tag, cx, cy + size * 0.70 + S * 0.105, ease_out(tk))
        hk = clamp01((e - 1.5) / 0.7)
        if hk > 0:
            hd = smooth_text('OUT NOW', int(S * 0.044), ORANGE, AVENIR_HEAVY, tracking=S * 0.012)
            paste_c(img, hd, cx, H * 0.845, ease_out(hk) * (0.75 + 0.25 * np.sin(e * 3)))
        if e > 5.0:                                    # tail to paper
            pass

    # ── grade ──────────────────────────────────────────────────────────────
    arr = np.asarray(img.convert('RGB')).astype(np.float64)
    if split:
        arr = rgb_split(arr, split)
    if flash > 0:
        tgt = np.array(PAPER if on_paper else (255, 250, 240), dtype=np.float64)
        arr = arr * (1 - flash) + tgt * flash
    arr *= vignette_mask(W, H, 0.34 if not on_paper else 0.12)
    arr = add_grain(arr, 3.2 if not on_paper else 2.0)
    # last 1.0s: fade out, matching the score's tail
    if t > DUR - 1.0:
        k = (t - (DUR - 1.0)) / 1.0
        arr = arr * (1 - k) + np.array(PAPER, dtype=np.float64) * k
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def build(w, h, name):
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    for i in range(NFRAMES):
        render(i / FPS, w, h).save(WORK / f'f{i:05d}.png')
        if i % 90 == 0:
            print(f'   {name} {i}/{NFRAMES}')
    out = HERE / name
    subprocess.run([
        'ffmpeg', '-y', '-loglevel', 'error',
        '-framerate', str(FPS), '-i', str(WORK / 'f%05d.png'),
        '-i', str(SCORE),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
        '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2',
        '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
        '-movflags', '+faststart',          # or it buffers before playing
        '-shortest', str(out),
    ], check=True)
    shutil.rmtree(WORK)
    print(f'   -> {out.name}')
    return out


if __name__ == '__main__':
    if not SCORE.exists():
        raise SystemExit('run make-score.py first')
    print(f'{NFRAMES} frames @ {FPS}fps')
    build(1080, 1920, 'jaketunes-2026-launch-reel.mp4')
    build(1080, 1350, 'jaketunes-2026-launch-feed.mp4')
    print('done.')
