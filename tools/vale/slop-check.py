#!/usr/bin/env python3
"""slop-check: the app's own words, read by Vale for AI tells.

Jake (2026-11-19, on a sync message): "its these confusing messages. its AI
slop. it needs to be simple". His rule for anything the app says: one short
plain line, no ids, no internals. This check pulls the words a person reads
out of the code (Swift Text/Button/Label/toasts/alerts, the backend's error and
notice strings that reach the phone, the desktop's JSX text and message
tables), writes them one per paragraph into a temp plain-text file, runs Vale
with the vendored ai-tells rules that tools/vale/.vale.ini enables, and maps
every hit back to file:line.

ONE FILE, TWO REPOS: this script is byte-identical in JakeTunesMobile and
JakeTunesV3 (tools/vale/slop-check.py). The profile is picked by --repo.

Vale itself is NOT in the repo: JT_VALE, else ~/.jaketunes-vale/bin/vale.
Missing, the check prints one line and passes, unless JT_VALE_REQUIRED=1 (CI
sets it after fetching a checksum-pinned v3.26.0).

A line that must say something a rule dislikes can carry `slop-ok` in a
comment on the same source line.

Usage:
  python3 tools/vale/slop-check.py --repo mobile|v3          # the check
  python3 tools/vale/slop-check.py --repo mobile --calibrate # every rule, counts
  python3 tools/vale/slop-check.py --repo mobile --dump      # the extracted words
"""
import bisect
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
VALE_DIR = os.path.join(ROOT, 'tools', 'vale')
CONFIG = os.path.join(VALE_DIR, '.vale.ini')


def vale_binary():
    path = os.environ.get('JT_VALE') or os.path.expanduser('~/.jaketunes-vale/bin/vale')
    return path if os.path.isfile(path) and os.access(path, os.X_OK) else None


# ── A small lexer: string literals with their line, comments skipped ──────────
# Interpolations (Swift \( ), TS ${ }) become "X", so the words around them are
# read and the code inside is not.

def _swift_strings(src):
    out = []
    i, n, line = 0, len(src), 1

    def read_string(i, line, multi, raw_hashes):
        # i points just past the opening quote(s). Returns (text, i, line).
        buf = []
        close = ('"""' if multi else '"') + '#' * raw_hashes
        while i < n:
            if src.startswith(close, i):
                return ''.join(buf), i + len(close), line
            c = src[i]
            if c == '\n':
                if not multi:
                    return ''.join(buf), i, line
                line += 1
                buf.append(' ')
                i += 1
                continue
            esc = '\\' + '#' * raw_hashes
            if src.startswith(esc, i):
                j = i + len(esc)
                if j < n and src[j] == '(':
                    i, line = skip_code(j + 1, line, ')')
                    buf.append('X')
                    continue
                if j < n:
                    buf.append({'n': ' ', 't': ' '}.get(src[j], src[j]))
                    i = j + 1
                    continue
            buf.append(c)
            i += 1
        return ''.join(buf), i, line

    def skip_code(i, line, closer):
        depth = 1
        while i < n:
            c = src[i]
            if c == '\n':
                line += 1
            if c == '"':
                multi = src.startswith('"""', i)
                _, i, line = read_string(i + (3 if multi else 1), line, multi, 0)
                continue
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    return i + 1, line
            i += 1
        return i, line

    while i < n:
        c = src[i]
        if c == '\n':
            line += 1
            i += 1
        elif src.startswith('//', i):
            j = src.find('\n', i)
            i = n if j < 0 else j
        elif src.startswith('/*', i):
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            line += src.count('\n', i, j)
            i = j
        elif c == '#' and re.match(r'#+"', src[i:i + 8]):
            hashes = len(re.match(r'#+', src[i:]).group(0))
            start, sl = i, line
            multi = src.startswith('"""', i + hashes)
            text, i, line = read_string(i + hashes + (3 if multi else 1), line, multi, hashes)
            out.append((start, sl, text, i))
        elif c == '"':
            start, sl = i, line
            multi = src.startswith('"""', i)
            text, i, line = read_string(i + (3 if multi else 1), line, multi, 0)
            out.append((start, sl, text, i))
        else:
            i += 1
    return out


_REGEX_PREV = set('(,=:[!&|?{};+-*%<>~^')


def _ts_strings(src):
    out = []
    i, n, line = 0, len(src), 1

    def read_quoted(i, line, q):
        buf = []
        while i < n:
            c = src[i]
            if c == q:
                return ''.join(buf), i + 1, line
            if c == '\n':
                return ''.join(buf), i, line   # unterminated (JSX text "don't")
            if c == '\\' and i + 1 < n:
                nxt = src[i + 1]
                buf.append({'n': ' ', 't': ' '}.get(nxt, nxt))
                if nxt == '\n':
                    line += 1
                i += 2
                continue
            buf.append(c)
            i += 1
        return ''.join(buf), i, line

    def read_template(i, line):
        buf = []
        while i < n:
            c = src[i]
            if c == '`':
                return ''.join(buf), i + 1, line
            if c == '\n':
                line += 1
                buf.append(' ')
                i += 1
                continue
            if c == '\\' and i + 1 < n:
                buf.append(src[i + 1])
                i += 2
                continue
            if src.startswith('${', i):
                i, line = skip_expr(i + 2, line)
                buf.append('X')
                continue
            buf.append(c)
            i += 1
        return ''.join(buf), i, line

    def skip_expr(i, line):
        depth = 1
        while i < n:
            c = src[i]
            if c == '\n':
                line += 1
            if c in '\'"':
                _, i, line = read_quoted(i + 1, line, c)
                continue
            if c == '`':
                _, i, line = read_template(i + 1, line)
                continue
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return i + 1, line
            i += 1
        return i, line

    prev = ''
    while i < n:
        c = src[i]
        if c == '\n':
            line += 1
            i += 1
            continue
        if c in ' \t\r':
            i += 1
            continue
        if src.startswith('//', i):
            j = src.find('\n', i)
            i = n if j < 0 else j
            continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            line += src.count('\n', i, j)
            i = j
            continue
        if c == '/' and (prev == '' or prev in _REGEX_PREV):
            # A regex literal: skip to its closing slash on this line.
            j, cls = i + 1, False
            while j < n and src[j] != '\n':
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '[':
                    cls = True
                elif src[j] == ']':
                    cls = False
                elif src[j] == '/' and not cls:
                    break
                j += 1
            i = j + 1
            prev = 'r'
            continue
        if c in '\'"':
            start, sl = i, line
            text, i, line = read_quoted(i + 1, line, c)
            out.append((start, sl, text, i))
            prev = 's'
            continue
        if c == '`':
            start, sl = i, line
            text, i, line = read_template(i + 1, line)
            out.append((start, sl, text, i))
            prev = 's'
            continue
        prev = c
        i += 1
    return out


# ── What counts as words a person reads ───────────────────────────────────────

def is_prose(text):
    t = text.strip()
    if len(t) < 4 or ' ' not in t or not re.search(r'[A-Za-z]{2}', t):
        return False
    if re.search(r'https?://|var\(--|rgba?\(|\bpx\b|=>|\$\{|^\s*[.#]?[a-z-]+\s*\{', t):
        return False
    if re.fullmatch(r'[\w.:/@%+-]+(\s+[\w.:/@%+-]+)?', t) and not re.search(r'[A-Z][a-z]|[a-z]\s[a-z]', t):
        return False
    # CSS class lists, SF Symbol names, key paths: no capital, no punctuation,
    # every word hyphenated or dotted.
    words = t.split()
    if all(re.fullmatch(r'[a-z0-9]+([.-][a-z0-9]+)+', w) for w in words):
        return False
    return True


def preceding(src, start, width=60):
    return src[max(0, start - width):start]


SWIFT_TRIGGER_BODY = (
    r'(?:\b(?:Text|Button|Label|Toggle|Section|Link|TextField|SecureField|Menu|Picker|'
    r'LocalizedStringKey|ContentUnavailableView|showToast)\(\s*'
    r'|\.(?:alert|confirmationDialog|navigationTitle|accessibilityLabel|accessibilityHint|help|badge)\(\s*'
    r'|\b(?:title|subtitle|message|prompt|placeholder|caption|headline|hint|line|banner)\s*:\s*'
    r'|\b(?:title|subtitle|message|headline|caption|hint)\s*=\s*)')

BACKEND_TRIGGER_BODY = r'\b(?:error|message|notice|hint)\s*:\s*'

TS_TRIGGER_BODY = (
    r'(?:\b(?:notify|notifyToast|showToast|toast|pushToast|confirm|alert)\(\s*'
    r'|\b(?:title|subtitle|message|label|hint|body|detail|placeholder|happened|next|line|headline|caption|empty|tooltip)\s*:\s*'
    r'|\b(?:title|placeholder|alt|label|aria-label)=\{?\s*)')


class Trigger:
    """Where a literal is words a person reads: right after a trigger (`Text(`, `title:`), or
    the first branch of a ternary after one (`Text(c ? "a" : "b")`)."""

    def __init__(self, body):
        self.direct = re.compile(body + r'$')
        # The condition: no quote, no newline, no statement end, at most 100 characters.
        self.ternary = re.compile(body + r'[^\n"\';{}]{1,100}?\s\?\s*$')

    def search(self, before):
        return self.direct.search(before) or self.ternary.search(before)


SWIFT_TRIGGER = Trigger(SWIFT_TRIGGER_BODY)
BACKEND_TRIGGER = Trigger(BACKEND_TRIGGER_BODY)
TS_TRIGGER = Trigger(TS_TRIGGER_BODY)

# A function or computed property whose job is to say something: its `return "…"` is read.
MESSAGE_NAME = re.compile(r'(?i)(message|title|text|line|label|copy|caption|headline|banner|toast|words|hint|reason|summary|sentence|phrase)')
SWIFT_DECL = re.compile(r'\bfunc\s+(\w+)|\b(?:static\s+)?var\s+(\w+)\s*:\s*String\b[^\n{=]*\{')
TS_DECL = re.compile(r'\bfunction\s+(\w+)|\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=\n]*)?=>')
RETURN = re.compile(r'\breturn\s+(?:[^\n"\';{}]{1,100}?\s\?\s*)?$')
# The other half of a literal already read: the ternary's second branch, or a concatenation
# (`"a" + "b"`, `"a" + name + "b"`).
ELSE_BRANCH = re.compile(r'^\s*:\s*$')
CONCAT = re.compile(r'^\s*\+\s*(?:[\w.?!()\[\]]+\s*\+\s*)?$')

JSX_ATTR = re.compile(r'''\b(?:title|placeholder|alt|aria-label|label)="([^"{}]+)"''')
JSX_INLINE = re.compile(r'(?<![=\-])>([^<>{}]*[A-Za-z][^<>{}]*)(?=<|\{)')
JSX_AFTER_EXPR = re.compile(r'\}([^<>{}]*[A-Za-z][^<>{}]*)<')
JSX_TEXT_LINE = re.compile(r'''^[A-Za-z0-9"'“‘(—–.…!?&$][^<>{}=;]*$''')


def jsx_text(path, src):
    out = []
    lines = src.split('\n')
    prev = ''
    in_block = False
    for no, raw in enumerate(lines, 1):
        s = raw.strip()
        if '/*' in s and '*/' not in s:
            in_block = True
        if in_block:
            if '*/' in s:
                in_block = False
            prev = s or prev
            continue
        if s.startswith('//') or s.startswith('*') or s.startswith('import '):
            prev = s or prev
            continue
        for m in JSX_ATTR.finditer(raw):
            out.append((no, m.group(1)))
        for rx in (JSX_INLINE, JSX_AFTER_EXPR):
            for m in rx.finditer(raw):
                seg = m.group(1)
                if re.search(r'&&|\|\||=>|;|`|\[\'|\s\?\s|\breturn\b|\bconst\b|\?\.|\)\s*$', seg):
                    continue
                out.append((no, seg))
        if s and JSX_TEXT_LINE.match(s) and prev.endswith('>') and not prev.endswith('=>') \
                and not re.search(r'\b(return|const|let|if|else|case)\b|&&|\|\||\?\s|:\s*$|\)$|,$', s):
            out.append((no, s))
        prev = s or prev
    return out


def walk(base, exts, skip=()):
    for dirpath, dirnames, files in os.walk(os.path.join(ROOT, base)):
        dirnames[:] = sorted(d for d in dirnames if d not in ('node_modules', '__tests__', 'dist', 'build'))
        for f in sorted(files):
            if f.endswith(exts) and not f.endswith(('.test.ts', '.test.tsx', '.d.ts')) and f not in skip:
                yield os.path.join(dirpath, f)


def literal_hits(path, src, strings, trigger, everything=False, decl=None, spans=None):
    """(line, text) for every literal a person reads. `decl` finds the function a literal is
    in (its `return "…"` is read when the name says it makes a message); `spans` limits
    `everything` to those (start, end) ranges of the file."""
    out = []
    decls = [(m.start(), m.group(1) or m.group(2)) for m in decl.finditer(src)] if decl else []
    starts = [d[0] for d in decls]
    prev_end, prev_in = -1, False
    for start, line, text, end in strings:
        before = preceding(src, start, 160)
        between = src[prev_end:start] if prev_end >= 0 else None
        whole = everything and (spans is None or any(a <= start < b for a, b in spans))
        take = whole or trigger.search(before)
        if not take and decls and RETURN.search(before):
            k = bisect.bisect_right(starts, start) - 1
            take = k >= 0 and MESSAGE_NAME.search(decls[k][1] or '') is not None
        joined = False
        if not take and prev_in and between is not None:
            if CONCAT.match(between):
                # One sentence in two halves: read as one.
                gap = ' X ' if between.strip() != '+' else ''
                pl, pt = out[-1]
                out[-1] = (pl, pt + gap + text)
                joined = True
            elif ELSE_BRANCH.match(between):
                take = True
        if take:
            out.append((line, text))
        prev_end, prev_in = end, bool(take) or joined
    return out


def function_spans(src, names):
    """(start, end) of each named top-level TS function: its header to the `}` closing it."""
    spans = []
    for name in names:
        m = re.search(r'^(?:export\s+)?function\s+' + re.escape(name) + r'\b', src, re.M)
        if not m:
            continue
        end = src.find('\n}\n', m.start())
        spans.append((m.start(), len(src) if end < 0 else end + 2))
    return spans


# Backend words that reach a person from outside routes/: (file, the functions that write them).
BACKEND_UTIL_WORDS = {
    'mobile': [('backend/src/util/musicManPacket.ts', ('factsOnlyAnswer', 'tempoLine', 'pace'))],
    'v3': [('src/common/music-man-packet.ts', ('factsOnlyAnswer', 'tempoLine', 'pace'))],
}


def extract(repo):
    items = []   # (relpath, line, text)

    def add(path, pairs, src):
        rel = os.path.relpath(path, ROOT)
        src_lines = src.split('\n')
        for line, text in pairs:
            text = re.sub(r'\s+', ' ', text).strip()
            if not is_prose(text):
                continue
            if 0 < line <= len(src_lines) and 'slop-ok' in src_lines[line - 1]:
                continue
            items.append((rel, line, text))

    if repo == 'mobile':
        for path in list(walk('ios/JakeTunesMobile', ('.swift',))) + list(walk('ios/JakeTunesWidget', ('.swift',))):
            src = open(path, encoding='utf-8', errors='replace').read()
            name = os.path.basename(path)
            whole = re.search(r'(Words|Copy)\.swift$', name) is not None
            add(path, literal_hits(path, src, _swift_strings(src), SWIFT_TRIGGER, whole, SWIFT_DECL), src)
        for path in walk('backend/src/routes', ('.ts',)):
            src = open(path, encoding='utf-8', errors='replace').read()
            add(path, literal_hits(path, src, _ts_strings(src), BACKEND_TRIGGER, decl=TS_DECL), src)
    elif repo == 'v3':
        copy_files = re.compile(r'^(sync-failure-copy|downloads-panel-model|record-shop(-[a-z-]+)?|shop-[a-z-]+)\.ts$')
        for path in walk('src/renderer', ('.tsx', '.ts')):
            src = open(path, encoding='utf-8', errors='replace').read()
            add(path, literal_hits(path, src, _ts_strings(src), TS_TRIGGER), src)
            if path.endswith('.tsx'):
                add(path, jsx_text(path, src), src)
        for path in walk('src/common', ('.ts',)):
            if not copy_files.match(os.path.basename(path)):
                continue
            src = open(path, encoding='utf-8', errors='replace').read()
            add(path, literal_hits(path, src, _ts_strings(src), TS_TRIGGER, True), src)
    else:
        raise SystemExit(f'slop check: unknown --repo {repo}')
    for rel, names in BACKEND_UTIL_WORDS[repo]:
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            continue
        src = open(path, encoding='utf-8', errors='replace').read()
        add(path, literal_hits(path, src, _ts_strings(src), BACKEND_TRIGGER, True, spans=function_spans(src, names)), src)
    return items


# ── Running Vale ──────────────────────────────────────────────────────────────

class ValeBroken(Exception):
    pass


def run_vale(vale, config, items):
    # One file per string: a rule that reads across sentences never joins two
    # strings that sit apart in the code.
    with tempfile.TemporaryDirectory() as tmp:
        words = os.path.join(tmp, 'words')
        os.mkdir(words)
        for k, (_, _, text) in enumerate(items):
            with open(os.path.join(words, f'{k:06d}.txt'), 'w', encoding='utf-8') as f:
                f.write(text + '\n')
        try:
            proc = subprocess.run([vale, '--config', config, '--output=JSON', '--no-exit', words],
                                  capture_output=True, text=True, timeout=180)
        except (subprocess.TimeoutExpired, OSError) as err:
            raise ValeBroken(f'Vale did not answer ({type(err).__name__})')
        try:
            data = json.loads(proc.stdout) if proc.stdout.strip().startswith('{') else None
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise ValeBroken(f'Vale failed: {(proc.stderr.strip() or "exit " + str(proc.returncode))[:200]}')
    hits = []
    for name, alerts in sorted(data.items()):
        k = int(os.path.basename(name).split('.')[0])
        rel, line, text = items[k]
        for a in alerts:
            hits.append((rel, line, a['Check'], a['Message'], a.get('Match', ''), text))
    return hits


def calibrate_config(tmp):
    path = os.path.join(tmp, 'all.ini')
    with open(path, 'w') as f:
        f.write(f'StylesPath = {os.path.join(VALE_DIR, "styles")}\nMinAlertLevel = suggestion\n'
                '[*.txt]\nBasedOnStyles = ai-tells\n')
    return path


def main(argv):
    repo = None
    mode = 'check'
    for a in argv:
        if a.startswith('--repo='):
            repo = a.split('=', 1)[1]
        elif a in ('--calibrate', '--dump'):
            mode = a[2:]
        elif a in ('mobile', 'v3'):
            repo = a
    if '--repo' in argv:
        repo = argv[argv.index('--repo') + 1]
    if repo is None:
        repo = 'mobile' if os.path.isdir(os.path.join(ROOT, 'ios')) else 'v3'

    items = extract(repo)
    if mode == 'dump':
        for rel, line, text in items:
            print(f'{rel}:{line}: {text}')
        return 0

    vale = vale_binary()
    if vale is None:
        if os.environ.get('JT_VALE_REQUIRED') == '1':
            print('slop check: FAIL: Vale is required here (JT_VALE_REQUIRED=1) and was not found')
            return 1
        print('slop check: skipped (no Vale at JT_VALE or ~/.jaketunes-vale/bin/vale)')
        return 0

    try:
        return report(mode, vale, items)
    except ValeBroken as err:
        # Vale installed but crashing or hanging here: one line, and the commit is not held,
        # except where Vale is required (CI).
        if os.environ.get('JT_VALE_REQUIRED') == '1':
            print(f'slop check: FAIL: {err}')
            return 1
        print(f'slop check: skipped ({err})')
        return 0


def report(mode, vale, items):
    if mode == 'calibrate':
        with tempfile.TemporaryDirectory() as tmp:
            hits = run_vale(vale, calibrate_config(tmp), items)
        counts = {}
        for h in hits:
            counts.setdefault(h[2], []).append(h)
        for rule, hs in sorted(counts.items(), key=lambda kv: -len(kv[1])):
            print(f'{len(hs):5d}  {rule}')
            for rel, line, _, _, match, text in hs[:4]:
                print(f'         {rel}:{line}  [{match}]  {text[:110]}')
        print(f'{len(items)} strings read, {len(hits)} hits, {len(counts)} rules fired')
        return 0

    hits = run_vale(vale, CONFIG, items)
    if not hits:
        print(f'slop check: ok ({len(items)} strings read)')
        return 0
    print(f'slop check: FAIL: {len(hits)} AI tell(s) in words a person reads')
    for rel, line, check, msg, match, text in hits:
        print(f'  {rel}:{line}: {check}: {msg}')
        print(f'      "{text[:140]}"')
    print('  Say it in one short plain line (Jake: "no AI slop"). A line that must keep it: `slop-ok` in a comment.')
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
