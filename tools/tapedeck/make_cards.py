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


def front(tape):
    ink = tape.get('inkColor') or '#8f1d1d'
    title = esc(tape.get('title'))
    n_a = len(tape.get('sideA') or [])
    n_b = len(tape.get('sideB') or [])
    s = svg_head()
    s += f'<rect x="3" y="3" width="{MM_W-6}" height="10" rx="1.5" fill="{ink}"/>'
    s += (f'<text x="{MM_W/2}" y="10" text-anchor="middle" fill="#f5f2ea" '
          f'font-size="4.6" font-weight="bold">{title}</text>')
    s += (f'<text x="{MM_W/2}" y="19" text-anchor="middle" fill="#2a2620" font-size="3">'
          f'C{tape.get("tapeLength")} · {n_a + n_b} songs · JakeTunes</text>')
    for side, cx in (('A', MM_W * 0.28), ('B', MM_W * 0.72)):
        s += (f'<circle cx="{cx}" cy="35" r="11" fill="none" stroke="{ink}" '
              f'stroke-width="0.7" stroke-dasharray="1.6 1.2"/>')
        s += (f'<text x="{cx}" y="37.6" text-anchor="middle" fill="{ink}" '
              f'font-size="8" font-weight="bold">{side}</text>')
        s += (f'<text x="{cx}" y="49" text-anchor="middle" fill="#6b665e" font-size="2.4">'
              f'RFID tag here — scan side {side}</text>')
    return s + '</svg>'


def back(tape, tracks):
    ink = tape.get('inkColor') or '#8f1d1d'
    s = svg_head()
    y = 7.0
    for side in ('A', 'B'):
        ids = tape.get(f'side{side}') or []
        s += (f'<text x="4" y="{y}" fill="{ink}" font-size="3.4" '
              f'font-weight="bold">SIDE {side}</text>')
        y += 3.6
        for i, tid in enumerate(ids):
            t = tracks.get(tid, {})
            line = f'{i+1}. {t.get("title", "?")} — {t.get("artist", "?")}'
            if len(line) > 58:
                line = line[:57] + '…'
            s += f'<text x="6" y="{y}" fill="#2a2620" font-size="2.5">{esc(line)}</text>'
            y += 3.0
            if y > MM_H - 4:
                break
        y += 2.0
        if y > MM_H - 8 and side == 'A':
            break
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
