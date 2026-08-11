#!/usr/bin/env python3
"""
Build every app icon from the one master mark.

Jake, 2026-08-09: "the logo has this cheap white border around it. needs to
look like an official app."

He was right, and the cause was structural rather than cosmetic. The master
art is a PHOTOGRAPH OF A LOGO: a fully opaque 1024x1024 canvas with the orange
tile sitting on white paper — white down the left and right edges, and white in
all four rounded corners. Shipping that straight to .icns means macOS composites
opaque white where every other app has nothing, so the mark reads as a sticker
on a white card instead of an app icon.

An app icon is not a picture of a logo. It is a SHAPE with transparency around
it, and on macOS a specific shape at a specific size:

  · macOS (Big Sur and later): a 1024 canvas with the body occupying 824x824,
    centred, everything outside it transparent, with a soft shadow. That 100px
    margin is not padding-for-taste — it is the grid every system icon is drawn
    on, which is why a full-bleed icon looks oversized in the Dock next to real
    ones. The corner is a continuous-curvature squircle, not a rounded
    rectangle; a plain radius reads subtly wrong at large sizes.
  · iOS: the exact opposite — FULL BLEED, no alpha, no corners of its own. The
    system masks it. Rounded corners baked into an iOS asset get cropped by the
    system mask and leave slivers of whatever was behind them (here: white).

So both platforms were wrong in the same way for the same reason, and both are
generated here from one square source of truth.

Run from the repo root:  python3 brand/make-icons.py
"""
import subprocess
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

REPO = Path(__file__).resolve().parent.parent
# Version-less on purpose: the mark has been revised twice now, and a
# filename with a version in it means editing this script every time.
MASTER = REPO / 'brand' / 'jaketunes-logo-master.png'
MOBILE_ICONSET = Path.home() / 'JakeTunesMobile' / 'ios' / 'JakeTunesMobile' / 'Assets.xcassets' / 'AppIcon.appiconset'

# The brand orange, median-sampled from the master. Kept in sync with
# --brand-orange in src/renderer/styles/variables.css.
TILE = (252, 85, 1)

# Apple's macOS icon grid: body 824 of 1024, continuous-curvature corner.
MAC_BODY = 824
MAC_CANVAS = 1024
SUPERELLIPSE_N = 5.0     # very close to Apple's squircle
SS = 4                   # supersample factor for a clean edge

# In-app art (splash, About): the tile fills the canvas and only the corners
# are transparent, so the mark stays large on screen. Radius as a fraction of
# the side, matching the macOS body's proportion (185.4/824).
APP_RADIUS_FRAC = 0.225


def die(msg: str) -> None:
    print(f'ERROR: {msg}', file=sys.stderr)
    sys.exit(1)


def square_tile() -> Image.Image:
    """
    The master, rebuilt as a full-bleed square: white paper replaced by tile.

    The note is lifted rather than redrawn. Three masks do it:
      orange  — the tile field
      paper   — bright pixels reachable from the CANVAS BORDER, i.e. the sheet
                the logo was sitting on. Topological, not positional, so it
                catches the corners and the side margins in one pass.
      note    — everything that is neither, which is the white glyph, its black
                outline, and the antialiased pixels between them.

    Paper is dilated before the subtraction. Without that, the antialiased ring
    where the tile's own rounded corner meets the paper is neither pure orange
    nor pure white, so it survives as "note" and leaves four pale crescents in
    the corners of the finished icon — the exact cheap edge being removed.
    """
    im = Image.open(MASTER).convert('RGB')
    a = np.asarray(im).astype(int)
    h, w, _ = a.shape
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]

    orange = (r > 180) & (g < 160) & (b < 110)
    bright = a.min(axis=2) > 170

    paper = np.zeros((h, w), bool)
    q: deque = deque()
    for x in range(w):
        for y in (0, h - 1):
            if bright[y, x] and not paper[y, x]:
                paper[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if bright[y, x] and not paper[y, x]:
                paper[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and bright[ny, nx] and not paper[ny, nx]:
                paper[ny, nx] = True
                q.append((ny, nx))

    grown = np.asarray(
        Image.fromarray((paper * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))
    ) > 127

    note = (~orange) & (~grown)
    out = np.zeros_like(a)
    out[:, :] = TILE
    out[note] = a[note]
    print(f'  tile rebuilt: note {note.sum():,}px, paper removed {grown.sum():,}px')
    return Image.fromarray(out.astype(np.uint8), 'RGB')


def superellipse_mask(size: int, body: int) -> Image.Image:
    """Apple-style continuous-curvature corner, supersampled then reduced."""
    big, bodyb = size * SS, body * SS
    yy, xx = np.mgrid[0:big, 0:big]
    cx = cy = (big - 1) / 2.0
    a = bodyb / 2.0
    d = (np.abs(xx - cx) / a) ** SUPERELLIPSE_N + (np.abs(yy - cy) / a) ** SUPERELLIPSE_N
    m = (d <= 1.0).astype(np.uint8) * 255
    return Image.fromarray(m, 'L').resize((size, size), Image.LANCZOS)


def mac_icon(tile: Image.Image) -> Image.Image:
    """1024 canvas, 824 squircle body, transparent surround, soft shadow."""
    body = tile.resize((MAC_BODY, MAC_BODY), Image.LANCZOS)
    mask = superellipse_mask(MAC_BODY, MAC_BODY)
    body.putalpha(mask)

    canvas = Image.new('RGBA', (MAC_CANVAS, MAC_CANVAS), (0, 0, 0, 0))
    off = (MAC_CANVAS - MAC_BODY) // 2

    # Shadow first: the body silhouette, blurred, nudged down. Every system
    # icon sits on one; without it the mark looks pasted onto the Dock.
    shadow = Image.new('RGBA', (MAC_CANVAS, MAC_CANVAS), (0, 0, 0, 0))
    sil = Image.new('RGBA', (MAC_BODY, MAC_BODY), (0, 0, 0, 90))
    sil.putalpha(mask.point(lambda v: int(v * 0.35)))
    shadow.paste(sil, (off, off + 10), sil)
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas = Image.alpha_composite(canvas, shadow)

    canvas.paste(body, (off, off), body)
    return canvas


def app_art(tile: Image.Image) -> Image.Image:
    """In-app art: full-canvas tile, transparent corners only."""
    size = tile.size[0]
    mask = superellipse_mask(size, size)
    out = tile.convert('RGBA')
    out.putalpha(mask)
    return out


def main() -> None:
    if not MASTER.exists():
        die(f'master missing: {MASTER}')
    print(f'master: {MASTER}')

    tile = square_tile()
    tile.save(REPO / 'brand' / 'jaketunes-tile-fullbleed.png')
    print('  wrote brand/jaketunes-tile-fullbleed.png (square source of truth)')

    # ── macOS ────────────────────────────────────────────────────────────
    mac = mac_icon(tile)
    mac.save(REPO / 'build' / 'icon-source.png')
    iconset = REPO / 'build' / 'icon.iconset'
    subprocess.run(['rm', '-rf', str(iconset)], check=True)
    iconset.mkdir(parents=True)
    for px in (16, 32, 64, 128, 256, 512, 1024):
        mac.resize((px, px), Image.LANCZOS).save(iconset / f'icon_{px}x{px}.png')
        if px > 16:
            mac.resize((px, px), Image.LANCZOS).save(iconset / f'icon_{px // 2}x{px // 2}@2x.png')
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(REPO / 'build' / 'icon.icns')], check=True)
    subprocess.run(['rm', '-rf', str(iconset)], check=True)
    print('  wrote build/icon.icns + build/icon-source.png (824/1024 squircle, transparent)')

    # ── in-app ───────────────────────────────────────────────────────────
    app_art(tile).save(REPO / 'src' / 'renderer' / 'assets' / 'jaketunes-logo.png')
    print('  wrote src/renderer/assets/jaketunes-logo.png (transparent corners)')

    # ── iOS: FULL BLEED, no alpha ────────────────────────────────────────
    if MOBILE_ICONSET.exists():
        sizes = {
            'AppIcon-1024.png': 1024,
            'AppIcon-20x20@2x.png': 40, 'AppIcon-20x20@3x.png': 60,
            'AppIcon-29x29@2x.png': 58, 'AppIcon-29x29@3x.png': 87,
            'AppIcon-40x40@2x.png': 80, 'AppIcon-40x40@3x.png': 120,
            'AppIcon-60x60@2x.png': 120, 'AppIcon-60x60@3x.png': 180,
            'AppIcon-ipad-20x20@1x.png': 20, 'AppIcon-ipad-20x20@2x.png': 40,
            'AppIcon-ipad-29x29@1x.png': 29, 'AppIcon-ipad-29x29@2x.png': 58,
            'AppIcon-ipad-40x40@1x.png': 40, 'AppIcon-ipad-40x40@2x.png': 80,
            'AppIcon-ipad-76x76@1x.png': 76, 'AppIcon-ipad-76x76@2x.png': 152,
            'AppIcon-ipad-83_5x83_5@2x.png': 167,
        }
        for name, px in sizes.items():
            tile.resize((px, px), Image.LANCZOS).save(MOBILE_ICONSET / name)
        print(f'  wrote {len(sizes)} iOS icons (full bleed, opaque) -> {MOBILE_ICONSET}')
    else:
        print(f'  SKIPPED iOS: {MOBILE_ICONSET} not found')

    print('done.')


if __name__ == '__main__':
    main()
