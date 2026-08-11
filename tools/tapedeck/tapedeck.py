#!/usr/bin/env python3
"""
tapedeck — the RFID mixtape deck for the Raspberry Pi.

Scan a mixtape card → the Pi plays that tape's side from homemini,
in order, through whatever audio device the Pi has. The flip is a
ritual: side A ends with a soft stop; turn the card over and scan
side B. Scanning the side that's already playing stops it (eject).

Design (2026-08-07, Jake: "one of a kind, amazing, and memorable"):
  - One physical card per tape, one RFID tag per SIDE (two tags).
  - Tag → (mixId, side) mapping lives on the Pi (tapedeck-map.json).
  - Unknown tag → pairing mode: the deck remembers the tag and the
    pairing page (http://<pi>:8123) lets you bind it to a tape side
    with one click. Print the card, stick the tag, scan, bind, done.
  - Tapes + audio stream from homemini:3000 (the proven /audio/:id
    endpoint) — nothing is stored on the Pi but the tag map.

Input: a USB HID (keyboard-wedge) RFID reader via evdev — the same
family fraglib uses. The reader is grabbed exclusively so scans don't
type into a shell. Fallback: line input on stdin for bench testing.

Run:  python3 tapedeck.py [--reader /dev/input/eventN] [--stdin]
Deps: python3-evdev (apt), mpv (apt).
"""
import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HOMEMINI = os.environ.get('TAPEDECK_BACKEND', 'http://homemini:3000')
MAP_PATH = os.path.expanduser('~/.tapedeck-map.json')
PAIR_PORT = int(os.environ.get('TAPEDECK_PAIR_PORT', '8123'))

state = {
    'playing': None,        # (tagId, mixId, side) or None
    'pending_tag': None,    # unknown tag awaiting pairing
    'mpv': None,            # subprocess handle
}
lock = threading.Lock()


def load_map():
    try:
        with open(MAP_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_map(m):
    tmp = MAP_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(m, f, indent=2)
    os.replace(tmp, MAP_PATH)


def fetch_json(path):
    with urllib.request.urlopen(f'{HOMEMINI}{path}', timeout=8) as r:
        return json.load(r)


def get_tapes():
    d = fetch_json('/api/mixtapes')
    return d.get('items', d if isinstance(d, list) else [])


def stop_playback():
    p = state['mpv']
    state['mpv'] = None
    state['playing'] = None
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()


def play_side(tag, mix_id, side):
    tapes = {t['id']: t for t in get_tapes()}
    tape = tapes.get(mix_id)
    if not tape:
        print(f'[deck] tape {mix_id} not on homemini — skipping', flush=True)
        return
    ids = tape.get('sideA' if side == 'A' else 'sideB') or []
    if not ids:
        print(f'[deck] {tape.get("title")} side {side} is empty', flush=True)
        return
    urls = [f'{HOMEMINI}/audio/{i}' for i in ids]
    stop_playback()
    print(f'[deck] ▶ {tape.get("title")} — side {side} ({len(ids)} songs)', flush=True)
    state['mpv'] = subprocess.Popen(
        ['mpv', '--no-video', '--really-quiet', '--audio-display=no',
         '--keep-open=no', *urls],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    state['playing'] = (tag, mix_id, side)


def on_scan(tag):
    tag = tag.strip()
    if not tag:
        return
    with lock:
        m = load_map()
        entry = m.get(tag)
        cur = state['playing']
        if entry is None:
            state['pending_tag'] = tag
            print(f'[deck] unknown tag {tag} — open http://<pi>:{PAIR_PORT} to bind it', flush=True)
            return
        if cur and cur[0] == tag and state['mpv'] and state['mpv'].poll() is None:
            print('[deck] ⏏ eject', flush=True)
            stop_playback()
            return
        play_side(tag, entry['mixId'], entry.get('side', 'A'))


# ── Pairing page ──────────────────────────────────────────────────────
class PairHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith('/bind'):
            q = dict(re.findall(r'([^?&=]+)=([^&]*)', self.path))
            tag = state['pending_tag']
            if tag and q.get('mix') and q.get('side') in ('A', 'B'):
                m = load_map()
                m[tag] = {'mixId': q['mix'], 'side': q['side']}
                save_map(m)
                state['pending_tag'] = None
                body = f'<h2>Bound tag to {q["mix"]} side {q["side"]} ✓</h2><p>Scan it.</p>'
            else:
                body = '<h2>No pending tag — scan the new card first.</h2>'
        else:
            try:
                tapes = get_tapes()
            except Exception as e:
                tapes = []
                body = f'<p>homemini unreachable: {e}</p>'
            pend = state['pending_tag']
            rows = ''.join(
                f"<li><b>{t.get('title')}</b> (C{t.get('tapeLength')}) — "
                f"<a href=\"/bind?mix={t['id']}&side=A\">bind side A</a> · "
                f"<a href=\"/bind?mix={t['id']}&side=B\">bind side B</a></li>"
                for t in tapes)
            body = (f'<h2>tapedeck pairing</h2>'
                    f'<p>Pending tag: <b>{pend or "none — scan a new card"}</b></p>'
                    f'<ul>{rows}</ul>')
        page = f'<html><body style="font-family:Georgia;max-width:640px;margin:40px auto">{body}</body></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(page.encode())


def pairing_server():
    HTTPServer(('0.0.0.0', PAIR_PORT), PairHandler).serve_forever()


# ── Reader input ──────────────────────────────────────────────────────
def stdin_loop():
    print('[deck] stdin mode — type/scan tag ids', flush=True)
    for line in sys.stdin:
        on_scan(line)


def evdev_loop(dev_path):
    from evdev import InputDevice, categorize, ecodes  # python3-evdev
    KEYMAP = {f'KEY_{c}': c for c in '0123456789ABCDEFabcdef'}
    KEYMAP.update({f'KEY_KP{d}': str(d) for d in range(10)})
    dev = InputDevice(dev_path)
    dev.grab()   # exclusive: scans never leak into a shell
    print(f'[deck] reading {dev.name} ({dev_path})', flush=True)
    buf = ''
    for event in dev.read_loop():
        if event.type != ecodes.EV_KEY:
            continue
        key = categorize(event)
        if key.keystate != key.key_down:
            continue
        code = key.keycode if isinstance(key.keycode, str) else key.keycode[0]
        if code in ('KEY_ENTER', 'KEY_KPENTER'):
            on_scan(buf)
            buf = ''
        else:
            buf += KEYMAP.get(code, '')


def find_reader():
    from evdev import InputDevice, list_devices
    for p in list_devices():
        d = InputDevice(p)
        if re.search(r'rfid|reader|hid.*keyboard|barcode', d.name, re.I):
            return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--reader')
    ap.add_argument('--stdin', action='store_true')
    args = ap.parse_args()
    if not shutil.which('mpv'):
        sys.exit('mpv not installed: sudo apt install mpv')
    signal.signal(signal.SIGTERM, lambda *_: (stop_playback(), sys.exit(0)))
    threading.Thread(target=pairing_server, daemon=True).start()
    print(f'[deck] pairing page on :{PAIR_PORT} · backend {HOMEMINI}', flush=True)
    if args.stdin:
        stdin_loop()
        return
    dev = args.reader or find_reader()
    if not dev:
        print('[deck] no RFID reader found — falling back to stdin', flush=True)
        stdin_loop()
        return
    evdev_loop(dev)


if __name__ == '__main__':
    main()
