"""Build the jewel-case assets from the rectified photo master.

Source: "CD Jewel Case (Front).jpg" by DiscoA340, CC0, Wikimedia Commons,
perspective-corrected by rectify.py into master/rect.png (case = 2840 x 2500
at (220, 220); 20 px per mm).

Layers (all measured in master case pixels, the booklet window = 2400 px):
  frame   RGBA  the plastic that is NOT the lid's optics: the ribbed strip's
                dark floor, the clear rims, the hinge zone; the booklet window
                cut to alpha 0 (inset 2 px so the plastic overlaps the art).
  lid     RGBA  what the clear lid does to whatever is under it, composited
                normally (white-with-alpha == screen, black-with-alpha ==
                multiply for neutral layers): the ribs' lit crests and dark
                valleys over the strip (so spine text reads as printed UNDER
                the ribs), the lid's broad sheen and scratches over the
                window, the walls' shadow on the booklet's edges, the
                plastic's absorption.
  shadow  RGBA  a contact shadow (the photo's paper carries none to extract).
  tray    RGB   the black tray for the Home case's open state, re-centred on
                the hub (the photo's lid sits 8 mm in front of the tray and
                the camera's parallax put the hub 52 px low).
Usage: build-assets.py MASTER.png OUTDIR [asset_width]
(MASTER = rectify.py's output; the app ships OUTDIR's four files in
src/renderer/assets/jewel-case/ and the numbers below in
src/common/jewel-case-photo.ts.) Needs Pillow, numpy, scipy.
"""
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

MASTER = sys.argv[1]
M = 220
CW, CH = 2840, 2500
WIN = (300, 28, 2700, 2428)          # the booklet: x0 y0 x1 y1 (2400 square)
STRIP = (10, 32, 250, 2440)          # the ribbed hinge strip
FACE = (320, 132, 2698, 2406)        # the tray's face (what the lid effects are read from)
HUB = (1507, 1280)
CORNER_R = 24
OUT = sys.argv[2]
ASSET_W = int(sys.argv[3]) if len(sys.argv) > 3 else 804
SHADOW_MARGIN = 140

os.makedirs(OUT, exist_ok=True)
img = np.asarray(Image.open(MASTER).convert('RGB')).astype(np.float32)[M:M + CH, M:M + CW]
lum = img.mean(axis=2)
yy, xx = np.mgrid[0:CH, 0:CW].astype(np.float32)


def rrect_sdf(x0, y0, x1, y1, r):
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    qx = np.abs(xx + 0.5 - cx) - hx
    qy = np.abs(yy + 0.5 - cy) - hy
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r


def inside(x0, y0, x1, y1, r=0.0, feather=1.0):
    return np.clip(0.5 - rrect_sdf(x0, y0, x1, y1, r) / feather, 0, 1)


def masked_blur(a, m, sigma):
    num = ndi.gaussian_filter(a * m, sigma)
    den = ndi.gaussian_filter(m.astype(np.float32), sigma)
    return num / np.maximum(den, 1e-4)


def save_rgba(name, rgb, alpha, scale_w, premultiply=True):
    """rgb 0..255 float (H W 3), alpha 0..1; resize premultiplied to width scale_w."""
    a = np.clip(alpha, 0, 1)[..., None]
    pm = np.concatenate([rgb * a, a * 255], axis=2)
    im = Image.fromarray(np.clip(pm, 0, 255).astype(np.uint8), 'RGBA')
    h = round(im.height * scale_w / im.width)
    im = im.resize((scale_w, h), Image.LANCZOS)
    arr = np.asarray(im).astype(np.float32)
    al = arr[..., 3:4] / 255
    rgb2 = np.where(al > 1e-3, arr[..., :3] / np.maximum(al, 1e-3), 0)
    out = np.concatenate([np.clip(rgb2, 0, 255), arr[..., 3:4]], axis=2).astype(np.uint8)
    Image.fromarray(out, 'RGBA').save(os.path.join(OUT, name), optimize=True)
    return im.size


# ── masks ──────────────────────────────────────────────────────────────────
case_a = inside(0, 0, CW, CH, CORNER_R, 1.5)
hole_a = inside(WIN[0] + 2, WIN[1] + 2, WIN[2] - 2, WIN[3] - 2, 1.5, 1.0)
strip_m = inside(*STRIP, 14, 1.0)
win_m = inside(*WIN, 0, 1.0)
face_m = inside(*FACE, 0, 1.0)
# tray structures the booklet hides (never lid optics): hub, recess ring, logos, clips
hub_d = np.hypot(xx - HUB[0], yy - HUB[1])
structure = (hub_d < 290) | ((hub_d > 1150) & (hub_d < 1235))
for (x0, y0, x1, y1) in [(2455, 205, 2715, 375), (290, 2130, 570, 2320),      # embossed logos
                         (560, 0, 830, 160), (2210, 0, 2460, 160),            # top clips
                         (560, 2320, 830, 2500), (2210, 2320, 2460, 2500)]:   # bottom clips
    structure[y0:y1, x0:x1] = True
read_m = face_m * (~structure)

# ── frame ──────────────────────────────────────────────────────────────────
floor = np.stack([masked_blur(img[..., c], strip_m, 10) for c in range(3)], axis=2)
frame_rgb = img * (1 - strip_m[..., None]) + floor * strip_m[..., None]
frame_a = case_a * (1 - hole_a)

# ── lid ────────────────────────────────────────────────────────────────────
# the ribs: residual against the floor
res = (lum - floor.mean(axis=2)) * strip_m
crest = np.clip(res, 0, None) / np.maximum(255 - floor.mean(axis=2), 1)
valley = np.clip(-res, 0, None) / np.maximum(floor.mean(axis=2), 1)
# the window: broad sheen (the lid's reflection of the room) …
# read only from the recess floor (one uniform surface: any low-frequency
# variation there is the lid, or the light's falloff — both look right)
recess_m = read_m * (hub_d < 1120)
# a quadratic surface through the recess floor's brightness: the light's
# falloff across the lid without the floor's own blotches
sel = recess_m > 0.5
X = (xx[sel] - CW / 2) / CW
Y = (yy[sel] - CH / 2) / CH
A = np.stack([np.ones_like(X), X, Y, X * X, X * Y, Y * Y], axis=1)
coef, *_ = np.linalg.lstsq(A, lum[sel], rcond=None)
Xa = (xx - CW / 2) / CW
Ya = (yy - CH / 2) / CH
sheen_src = (coef[0] + coef[1] * Xa + coef[2] * Ya + coef[3] * Xa * Xa + coef[4] * Xa * Ya + coef[5] * Ya * Ya).astype(np.float32)
sheen_floor = sheen_src[win_m > 0.5].min()
sheen_top = sheen_src[win_m > 0.5].max()
# a smooth ramp, 0 at the window's darkest corner to 0.07 at its brightest
broad = np.clip(sheen_src - sheen_floor, 0, None) / max(sheen_top - sheen_floor, 1) * 0.07
print('sheen poly coef', np.round(coef, 2))
# … and the scratches / scuffs: a top-hat above the tray's speckle, kept where
# it forms lines rather than dots
opened = ndi.grey_opening(lum, size=(13, 13))
tophat = (lum - opened) * read_m
print('tophat percentiles in face (50/90/99/99.9):', [round(float(np.percentile(tophat[read_m > 0.5], q)), 1) for q in (50, 90, 99, 99.9)])
SCR_T = 24
scratch = np.clip(tophat - SCR_T, 0, None)
# keep marks that are LONG (>= 1.5 mm): the tray's sparkle is 2-5 px dots
lab, n = ndi.label(scratch > 0)
keep = np.zeros(n + 1, bool)
for i, sl in enumerate(ndi.find_objects(lab), start=1):
    if sl is None:
        continue
    h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
    if max(h, w) >= 30:
        keep[i] = True
print('scratch components', n, 'kept', int(keep.sum()))
scratch = scratch * keep[lab]
scratch = ndi.gaussian_filter(scratch, 0.8)
fine = np.clip(scratch / 100, 0, 1)
# iridescence: the scuffs' own colour, where the residual has one
col = img - ndi.gaussian_filter(img, 6)
tint = np.clip(col / np.maximum(np.abs(col).max(axis=2, keepdims=True), 1), -1, 1)
# the walls' shadow on the booklet's edges + the plastic's absorption
dx0 = np.clip(xx - WIN[0], 0, None)
dx1 = np.clip(WIN[2] - xx, 0, None)
dy0 = np.clip(yy - WIN[1], 0, None)
dy1 = np.clip(WIN[3] - yy, 0, None)
edge = 1 - (1 - 0.34 * np.exp(-dx0 / 34)) * (1 - 0.16 * np.exp(-dx1 / 18)) * \
    (1 - 0.14 * np.exp(-dy0 / 14)) * (1 - 0.16 * np.exp(-dy1 / 16))
absorb = 0.045
w_alpha = (1 - (1 - fine) * (1 - broad)) * win_m
b_alpha = (1 - (1 - edge) * (1 - absorb)) * win_m
# one normal-blend layer == screen by w then multiply by (1-b)
lid_a = 1 - (1 - w_alpha) * (1 - b_alpha)
lid_grey = np.where(lid_a > 1e-4, w_alpha * (1 - b_alpha) / np.maximum(lid_a, 1e-4), 0)
lid_rgb = np.repeat((lid_grey * 255)[..., None], 3, axis=2)
# a little of the scuffs' colour
lid_rgb = np.clip(lid_rgb + tint * 40 * fine[..., None], 0, 255)
# the strip's crests / valleys replace the window math there
strip_a = np.clip(crest + valley, 0, 1)
strip_rgb = np.where((crest >= valley)[..., None], 255.0, 0.0) * np.ones((1, 1, 3))
lid_a = np.where(strip_m > 0.5, strip_a, lid_a)
lid_rgb = np.where((strip_m > 0.5)[..., None], strip_rgb, lid_rgb)
lid_a = lid_a * case_a

# ── shadow (synthesised: the photo's paper carries none) ───────────────────
SW, SH = CW + 2 * SHADOW_MARGIN, CH + 2 * SHADOW_MARGIN
syy, sxx = np.mgrid[0:SH, 0:SW].astype(np.float32)
base = np.zeros((SH, SW), np.float32)
base[SHADOW_MARGIN:SHADOW_MARGIN + CH, SHADOW_MARGIN:SHADOW_MARGIN + CW] = case_a
soft = ndi.gaussian_filter(np.roll(base, 26, axis=0), 55) * 0.30
tight = ndi.gaussian_filter(np.roll(base, 12, axis=0), 16) * 0.34
shadow_a = 1 - (1 - soft) * (1 - tight)
shadow_rgb = np.zeros((SH, SW, 3), np.float32) + np.array([20, 16, 12], np.float32)

# ── tray (Home, open case) ─────────────────────────────────────────────────
descr = img.copy()
sm = ndi.gaussian_filter((fine > 0.03).astype(np.float32), 2) > 0.1
med = np.stack([ndi.median_filter(img[..., c], size=9) for c in range(3)], axis=2)
descr = np.where(sm[..., None], med, descr)
tx0, ty0 = HUB[0] - 1200, HUB[1] - 1200
tray = descr[max(ty0, 0):ty0 + 2400, tx0:tx0 + 2400].copy()
# rows below the tray's face (the walls) and the clips: continue the face
face_bottom = FACE[3] - ty0
tray[face_bottom:] = tray[face_bottom - (2400 - face_bottom):face_bottom][::-1]
face_top = FACE[1] - ty0
tray[:face_top] = tray[face_top:2 * face_top][::-1]
for (x0, y0, x1, y1) in [(560, 0, 830, 160), (2210, 0, 2460, 160), (560, 2320, 830, 2500), (2210, 2320, 2460, 2500)]:
    y0t, y1t = max(y0 - ty0, 0), min(y1 - ty0, 2400)
    x0t, x1t = x0 - tx0, x1 - tx0
    if y1t > y0t:
        h = y1t - y0t
        src_y = y1t + 20 if y0 < 1000 else y0t - 20 - h
        tray[y0t:y1t, x0t:x1t] = tray[src_y:src_y + h, x0t:x1t][::-1]

# ── write ──────────────────────────────────────────────────────────────────
s = ASSET_W / CW
print('frame', save_rgba('case-frame.png', frame_rgb, frame_a, ASSET_W))
print('lid', save_rgba('case-lid.png', lid_rgb, lid_a, ASSET_W))
print('shadow', save_rgba('case-shadow.png', shadow_rgb, shadow_a, round(SW * s)))
tray_im = Image.fromarray(np.clip(tray, 0, 255).astype(np.uint8), 'RGB').resize((480, 480), Image.LANCZOS)
tray_im.save(os.path.join(OUT, 'case-tray.webp'), quality=82, method=6)
print('tray', tray_im.size)
# debug layers at the asset scale
dbg = os.path.join(OUT, 'debug')
os.makedirs(dbg, exist_ok=True)
Image.fromarray(np.clip(fine * 255, 0, 255).astype(np.uint8)).resize((ASSET_W, round(CH * s))).save(os.path.join(dbg, 'fine.png'))
Image.fromarray(np.clip(broad * 255 * 4, 0, 255).astype(np.uint8)).resize((ASSET_W, round(CH * s))).save(os.path.join(dbg, 'broad-x4.png'))
Image.fromarray(np.clip(lid_a * 255, 0, 255).astype(np.uint8)).resize((ASSET_W, round(CH * s))).save(os.path.join(dbg, 'lid-alpha.png'))
print('sheen floor', sheen_floor, 'broad max', broad.max(), 'fine>0 px', int((fine > 0.05).sum()))
# geometry for the app (fractions of the booklet window)
WINW = WIN[2] - WIN[0]
geo = {
    'caseW': CW / WINW, 'caseH': CH / WINW, 'winLeft': WIN[0] / WINW, 'winTop': WIN[1] / WINW,
    'stripLeft': STRIP[0] / WINW, 'stripRight': STRIP[2] / WINW, 'stripTop': STRIP[1] / WINW, 'stripBottom': STRIP[3] / WINW,
    'shadowMargin': SHADOW_MARGIN / WINW, 'cornerR': CORNER_R / WINW,
}
for k, v in geo.items():
    print(f'  {k}: {v:.5f}')
