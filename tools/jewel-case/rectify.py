"""Perspective-correct the jewel case photo to a canonical rectangle.

Source photo: "CD Jewel Case (Front).jpg" by DiscoA340, CC0, Wikimedia Commons
(docs/credits.md) — the 4641 x 3692 original:
https://upload.wikimedia.org/wikipedia/commons/6/6f/CD_Jewel_Case_%28Front%29.jpg
Needs Pillow + numpy (python3 -m venv …; pip install pillow numpy scipy).

Usage: rectify.py in.jpg out.png
Outer edges are fitted as lines through the lum<thr boundary; the four
corners are their intersections. The output canvas is the case (CW x CH,
142:125) plus a margin on every side for the ground shadow."""
import sys, numpy as np
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
a = np.asarray(im).astype(np.float32)
H, W, _ = a.shape
lum = a.mean(axis=2)
thr = 176
mask = lum < thr
def fit(pts):
    pts = np.array(pts, dtype=np.float64)
    return np.polyfit(pts[:,0], pts[:,1], 1)  # y = m x + b
# left/right edges: sample rows, record x as fn of y -> fit x = m y + b
L, R = [], []
for y in range(400, 3300, 25):
    xs = np.where(mask[y])[0]
    L.append((y, xs.min())); R.append((y, xs.max()))
T, B = [], []
for x in range(700, 4100, 25):
    ys = np.where(mask[:, x])[0]
    T.append((x, ys.min())); B.append((x, ys.max()))
mL, bL = fit(L); mR, bR = fit(R)   # x = m*y + b
mT, bT = fit(T); mB, bB = fit(B)   # y = m*x + b
def isect(mv, bv, mh, bh):
    # x = mv*y + bv ; y = mh*x + bh  -> x = mv*(mh*x + bh) + bv
    x = (mv*bh + bv) / (1 - mv*mh)
    y = mh*x + bh
    return (x, y)
TL = isect(mL, bL, mT, bT); TR = isect(mR, bR, mT, bT)
BL = isect(mL, bL, mB, bB); BR = isect(mR, bR, mB, bB)
print('corners TL TR BR BL', [tuple(round(v,1) for v in p) for p in (TL, TR, BR, BL)])
print('edge widths: top', TR[0]-TL[0], 'bottom', BR[0]-BL[0], 'left h', BL[1]-TL[1], 'right h', BR[1]-TR[1])
CW = 2840
CH = round(CW * 125 / 142)
M = 220  # margin for the shadow
OW, OH = CW + 2*M, CH + 2*M
# output corners
o = [(M, M), (M+CW, M), (M+CW, M+CH), (M, M+CH)]
i = [TL, TR, BR, BL]
# solve for coefficients mapping output (x,y) -> input (u,v): PIL PERSPECTIVE data
A = []; bvec = []
for (x, y), (u, v) in zip(o, i):
    A.append([x, y, 1, 0, 0, 0, -u*x, -u*y]); bvec.append(u)
    A.append([0, 0, 0, x, y, 1, -v*x, -v*y]); bvec.append(v)
coef = np.linalg.solve(np.array(A, dtype=np.float64), np.array(bvec, dtype=np.float64))
out = im.transform((OW, OH), Image.PERSPECTIVE, tuple(coef), Image.BICUBIC)
out.save(dst)
print('wrote', dst, out.size, 'case at', M, M, CW, CH)
