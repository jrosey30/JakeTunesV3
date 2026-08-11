#!/usr/bin/env python3
"""
make_cards — printable mixtape card faces for the RFID tape deck.

One card per tape, credit-card size (85.6 × 54 mm), two faces:
  FRONT: tape title in its own ink color, C-length, big A/B tag zones
         (where the two RFID stickers go — one per side).
  BACK:  the liner — side A and side B tracklists, record-collector style.

Reads the LOCAL mixtapes.json + library.json (titles). Outputs SVGs to
~/Desktop/MixtapeCards/ — print at 100% scale, laminate or 3D-print a
thin frame around them, sticker the tags on the marked circles.
"""
import html
import json
import os
import re

MM_W, MM_H = 85.6, 54.0
OUT = os.path.expanduser('~/Desktop/MixtapeCards')
DATA = os.path.expanduser('~/Library/Application Support/JakeTunes')


def esc(s):
    return html.escape(str(s or ''), quote=True)


def load():
    tapes = json.load(open(os.path.join(DATA, 'mixtapes.json')))
    tapes = tapes if isinstance(tapes, list) else tapes.get('mixtapes', [])
    lib = json.load(open(os.path.join(DATA, 'library.json')))
    tracks = {t['id']: t for t in lib.get('tracks', [])}
    return tapes, tracks


def svg_head():
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{MM_W}mm" height="{MM_H}mm" '
            f'viewBox="0 0 {MM_W} {MM_H}" font-family="Georgia, serif">'
            f'<rect width="{MM_W}" height="{MM_H}" rx="3" fill="#f5f2ea" stroke="#2a2620" stroke-width="0.4"/>')


def fit_font(text, max_w, max_font, min_font=2.6):
    """Largest font (mm) whose estimated width fits max_w. Georgia avg
    glyph ~0.52 em wide — conservative so we never clip again."""
    if not text:
        return max_font
    f = max_w / (0.52 * len(text))
    return max(min_font, min(max_font, f))


def split_title(t):
    """Long titles wrap to two lines at the friendliest break."""
    if len(t) <= 30:
        return [t]
    mid = len(t) // 2
    best = None
    for m in re.finditer(r'[ :\u2014-]', t):
        if best is None or abs(m.start() - mid) < abs(best - mid):
            best = m.start()
    if best is None:
        return [t]
    return [t[:best + 1].strip(), t[best + 1:].strip()]


def front(tape):
    ink = tape.get('inkColor') or '#8f1d1d'
    lines = split_title(str(tape.get('title') or ''))
    n_a = len(tape.get('sideA') or [])
    n_b = len(tape.get('sideB') or [])
    s = svg_head()
    band_h = 13 if len(lines) > 1 else 10
    s += f'<rect x="3" y="3" width="{MM_W-6}" height="{band_h}" rx="1.5" fill="{ink}"/>'
    font = min(fit_font(l, MM_W - 12, 4.6) for l in lines)
    ty = 3 + band_h / 2 - (len(lines) - 1) * (font * 0.62) + font * 0.36
    for l in lines:
        s += (f'<text x="{MM_W/2}" y="{ty:.1f}" text-anchor="middle" fill="#f5f2ea" '
              f'font-size="{font:.2f}" font-weight="bold">{esc(l)}</text>')
        ty += font * 1.24
    s += (f'<text x="{MM_W/2}" y="{band_h + 8}" text-anchor="middle" fill="#2a2620" font-size="3">'
          f'C{tape.get("tapeLength")} · {n_a + n_b} songs · JakeTunes</text>')
    for side, cx in (('A', MM_W * 0.28), ('B', MM_W * 0.72)):
        s += (f'<circle cx="{cx}" cy="36" r="10" fill="none" stroke="{ink}" '
              f'stroke-width="0.7" stroke-dasharray="1.6 1.2"/>')
        s += (f'<text x="{cx}" y="38.4" text-anchor="middle" fill="{ink}" '
              f'font-size="7.5" font-weight="bold">{side}</text>')
        s += (f'<text x="{cx}" y="50" text-anchor="middle" fill="#6b665e" font-size="2.3">'
              f'tag here · scan = side {side}</text>')
    return s + '</svg>'


def back(tape, tracks):
    """Liner: side A left column, side B right — row height and font
    auto-shrink so EVERY track fits, C60 through C120. Never clip."""
    ink = tape.get('inkColor') or '#8f1d1d'
    s = svg_head()
    col_w = (MM_W - 12) / 2
    for side, x0 in (('A', 4.0), ('B', 8.0 + col_w)):
        ids = tape.get(f'side{side}') or []
        s += (f'<text x="{x0}" y="7" fill="{ink}" font-size="3.2" '
              f'font-weight="bold">SIDE {side}</text>')
        avail = MM_H - 11 - 3
        rh = min(3.0, avail / max(len(ids), 1))
        font = min(2.4, rh * 0.82)
        y = 11.0
        for i, tid in enumerate(ids):
            t = tracks.get(tid, {})
            line = f'{i+1}. {t.get("title", "?")} - {t.get("artist", "?")}'
            # Names never clip (Jake's rule): the LINE shrinks to fit its
            # column instead of ellipsizing. Only a pathological 90+ char
            # title would ever be cut, and then visibly mid-word.
            lf = min(font, fit_font(line, col_w, font, min_font=1.7))
            # Estimation can still lie about long lines — textLength makes
            # the renderer fit the line to the column EXACTLY, no overflow
            # possible, ever. Applied only when the estimate says danger.
            tl = f' textLength="{col_w:.1f}" lengthAdjust="spacingAndGlyphs"' if 0.52 * lf * len(line) > col_w * 0.98 else ''
            s += f'<text x="{x0}" y="{y:.1f}" fill="#2a2620" font-size="{lf:.2f}"{tl}>{esc(line)}</text>'
            y += rh
    s += f'<line x1="{MM_W/2}" y1="4" x2="{MM_W/2}" y2="{MM_H-4}" stroke="{ink}" stroke-width="0.25" stroke-dasharray="1 1.4"/>'
    return s + '</svg>'


def main():
    os.makedirs(OUT, exist_ok=True)
    tapes, tracks = load()
    made = 0
    for tape in tapes:
        slug = ''.join(c if c.isalnum() else '-' for c in str(tape.get('title', tape['id']))).strip('-')[:40]
        with open(os.path.join(OUT, f'{slug}-front.svg'), 'w') as f:
            f.write(front(tape))
        with open(os.path.join(OUT, f'{slug}-back.svg'), 'w') as f:
            f.write(back(tape, tracks))
        made += 1
    print(f'{made} tapes → {OUT} (front + back each, 85.6×54mm at 100% scale)')


if __name__ == '__main__':
    main()
