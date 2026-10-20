/**
 * Jake's taste choices travel between the Macs through the sync script
 * (Dr. Claude/scripts/jaketunes-homemini-sync.sh, 2026-10-20) — rails in the
 * style of workmini-deploy.test.ts, plus the script run end to end against
 * stubs (a fake homemini folder the stub rsync copies from).
 *
 *   push: each Mac's own discovery-feedback.json / taste-ledger.jsonl /
 *         rock-dna.json go to homemini (hub folder, or replicas/<name>/);
 *         the hub alone publishes taste-weights.json + taste-profile.json.
 *   pull: the OTHER Mac's copies land in userData/taste-elsewhere/<source>/
 *         — never over this Mac's own files. A replica mirrors the hub's
 *         weights + profile into userData (valid JSON only, newer only).
 *   deploy: SIDECARS carries the hub-only pair, never a two-writer file.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scriptPath = join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh')
const src = readFileSync(scriptPath, 'utf-8')
const deploy = readFileSync(join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-workmini-deploy.sh'), 'utf-8')
const HUB_DIR = 'Library/Application Support/JakeTunes'
const SEP = '\u001f'
const SHARED = ['discovery-feedback.json', 'taste-ledger.jsonl', 'rock-dna.json']
const HUB_ONLY = ['taste-weights.json', 'taste-profile.json']

const bashArray = (text: string, name: string): string[] => {
  const m = text.match(new RegExp(`\\n${name}=\\(([^)]*)\\)`))
  assert.ok(m, `${name}=(...) missing`)
  return m![1].trim().split(/\s+/)
}

describe('sync script rails: what travels, and where', () => {
  it('SYNC_FILES carries every taste file; the arrays name exactly the two kinds', () => {
    const sync = bashArray(src, 'SYNC_FILES')
    for (const f of [...SHARED, ...HUB_ONLY]) assert.ok(sync.includes(f), `${f} in SYNC_FILES`)
    assert.deepEqual(bashArray(src, 'TASTE_SHARED'), SHARED)
    assert.deepEqual(bashArray(src, 'TASTE_HUB_ONLY'), HUB_ONLY)
  })

  it('the pull runs every pass, right after the push and before the homemini-only exit, and can never fail the sync', () => {
    const call = src.indexOf('\npull_taste_elsewhere || true\n')
    const push = src.indexOf('\npush_homemini_state || homemini_rc=$?\n')
    const exit = src.indexOf('if [ $HOMEMINI_ONLY -eq 1 ]; then\n  sync_artwork_to_homemini')
    assert.ok(push > 0 && call > push && exit > call, 'push → pull → homemini-only exit')
  })

  it('the pull is additive and lands only in taste-elsewhere/', () => {
    const fn = src.slice(src.indexOf('pull_taste_elsewhere() {'), src.indexOf('\nhomemini_rc=0\n'))
    assert.doesNotMatch(fn, /--delete/)
    assert.match(fn, /to="\$TASTE_ELSEWHERE\/hub\/"/)
    assert.match(fn, /to="\$TASTE_ELSEWHERE\/"/)
    assert.match(fn, /"\$\(rremote "\$from"\)" "\$to"/, 'remote source, local destination — through rremote for openrsync')
    assert.match(src, /\nTASTE_ELSEWHERE="\$JT_DATA_LOCAL\/taste-elsewhere"\n/)
  })

  it('the deploy pushes the hub-only pair and never a file workmini writes too', () => {
    const sidecars = bashArray(deploy, 'SIDECARS')
    for (const f of HUB_ONLY) assert.ok(sidecars.includes(f), `${f} in SIDECARS`)
    for (const f of SHARED) assert.equal(sidecars.includes(f), false, `${f} would overwrite workmini's own choices`)
  })
})

// ── end to end ───────────────────────────────────────────────────────────

const STUB_RSYNC = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "\${STUB_RSYNC_VERSION:-rsync  version 3.4.2  protocol version 32}"; exit 0; fi
( IFS=$'\\x1f'; printf 'RSYNC\\037%s\\n' "$*" ) >> "$STUB_CALLS"
n=$#; from="\${@:n-1:1}"; to="\${@:n:1}"
case "$from" in
  test@stub:*)
    if [ -n "\${STUB_PULL_EXIT:-}" ]; then echo "rsync: connection unexpectedly closed" >&2; exit "$STUB_PULL_EXIT"; fi
    rel="\${from#test@stub:}"; rel="\${rel//\\\\ / }"; root="$STUB_REMOTE/$rel"
    if [ ! -e "$root" ]; then echo "rsync: link_stat \\"$rel\\" failed: No such file or directory (2)" >&2; exit 23; fi
    for a in "$@"; do
      case "$a" in
        --include=/\\*/) ;;
        --include=/\\*/*) f="\${a#--include=/\\*/}"; for d in "$root"*/; do [ -f "$d$f" ] && { b=$(basename "$d"); mkdir -p "$to$b"; cp -p "$d$f" "$to$b/$f"; }; done ;;
        --include=/*) f="\${a#--include=/}"; [ -f "$root$f" ] && cp -p "$root$f" "$to$f" ;;
      esac
    done
    exit 0 ;;
esac
exit "\${STUB_RSYNC_EXIT:-0}"
`
const STUB_SSH = `#!/bin/bash
( IFS=$'\\x1f'; printf 'SSH\\037%s\\n' "$*" ) >> "$STUB_CALLS"
case "$*" in *python3*) echo "published 1" ;; esac
exit 0
`
const STUB_SCUTIL = '#!/bin/bash\necho "${STUB_HOST:-Workmini}"\n'
const STUB_OSASCRIPT = '#!/bin/bash\nexit 0\n'

const roots: string[] = []
process.on('exit', () => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

interface Run { calls: string[][]; log: string; status: number | null; local: string; read(rel: string): string | null; ls(rel: string): string[] }

function runScript(args: string[], opts: { local?: Record<string, string>; remote?: Record<string, string>; env?: Record<string, string>; before?: (dirs: { local: string; remote: string }) => void }): Run {
  const root = mkdtempSync(join(tmpdir(), 'jt-taste-sync-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const [name, body] of [['rsync', STUB_RSYNC], ['ssh', STUB_SSH], ['scutil', STUB_SCUTIL], ['osascript', STUB_OSASCRIPT]]) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const home = join(root, 'home')
  const local = join(home, HUB_DIR)
  mkdirSync(join(local, 'artwork'), { recursive: true })
  writeFileSync(join(local, 'library.json'), '{"tracks":[{"id":1}]}')
  writeFileSync(join(local, 'play-events.jsonl'), 'p\n')
  for (const [f, body] of Object.entries(opts.local ?? {})) writeFileSync(join(local, f), body)
  const remote = join(root, 'remote')
  for (const [f, body] of Object.entries(opts.remote ?? {})) {
    mkdirSync(join(remote, HUB_DIR, f, '..'), { recursive: true })
    writeFileSync(join(remote, HUB_DIR, f), body)
  }
  mkdirSync(join(remote, HUB_DIR), { recursive: true })
  opts.before?.({ local, remote: join(remote, HUB_DIR) })
  mkdirSync(join(root, 'nas', 'JakeTunesLibrary'), { recursive: true })
  mkdirSync(join(root, 'lib'), { recursive: true })
  const calls = join(root, 'calls.txt')
  writeFileSync(calls, '')
  const r = spawnSync('/bin/bash', [scriptPath, ...args], {
    env: {
      HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_CALLS: calls, STUB_REMOTE: remote,
      JT_SYNC_LOG: join(root, 'sync.log'), JT_SYNC_LOCK: join(root, 'sync.lock'), JT_HOMEMINI: 'test@stub',
      JT_LIBRARY_ROOT: join(root, 'lib'), JT_MOUNT: join(root, 'nas'), ...opts.env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const log = existsSync(join(root, 'sync.log')) ? readFileSync(join(root, 'sync.log'), 'utf8') : ''
  const out: Run = {
    calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => l.split(SEP)),
    log, status: r.status, local,
    read: (rel) => (existsSync(join(local, rel)) ? readFileSync(join(local, rel), 'utf8') : null),
    ls: (rel) => (existsSync(join(local, rel)) ? readdirSync(join(local, rel)).sort() : []),
  }
  roots.push(root)
  return out
}
const statePush = (r: Run) => r.calls.find((c) => c[0] === 'RSYNC' && c.includes('--checksum'))

const HUB_FILES = {
  'discovery-feedback.json': '{"notForMe":{"kneecap":{"artist":"Kneecap","at":1}},"served":{}}',
  'taste-ledger.jsonl': '{"ts":"2026-10-20T10:00:00.000Z","surface":"strip","verdict":"reject","key":{"trackId":1,"playlistId":"p"}}\n',
  'rock-dna.json': '{"version":1,"person":"jake","answers":{},"ratings":{"Interpol":"dislike"},"traitEdits":{}}',
  'taste-weights.json': '{"version":2,"global":{"vibe":1},"updatedAt":"2026-10-20T12:46:26"}',
  'taste-profile.json': '{"focusPlaylists":["Rocksurgence"]}',
  'play-events.jsonl': 'the hub\'s plays — not a taste file\n',
}
const WORKMINI_OWN = {
  'discovery-feedback.json': '{"notForMe":{},"served":{"a|b":{"first":1,"last":1,"views":2}}}',
  'taste-ledger.jsonl': '{"ts":"2026-10-20T14:34:30.153Z","surface":"strip","verdict":"refresh","key":{"trackId":2,"playlistId":"p"}}\n',
}

describe('a replica (workmini) pulls the hub\'s choices', () => {
  it('the hub\'s copies land in taste-elsewhere/hub/; workmini\'s own files are untouched; the hub-only pair is mirrored', () => {
    const r = runScript(['--skip-library-json'], { local: WORKMINI_OWN, remote: HUB_FILES })
    assert.equal(r.status, 0, r.log)
    assert.deepEqual(r.ls('taste-elsewhere'), ['hub'])
    assert.deepEqual(r.ls('taste-elsewhere/hub'), [...SHARED, ...HUB_ONLY].sort(), 'exactly the taste files — never play-events.jsonl')
    assert.equal(r.read('taste-elsewhere/hub/discovery-feedback.json'), HUB_FILES['discovery-feedback.json'])
    for (const [f, body] of Object.entries(WORKMINI_OWN)) assert.equal(r.read(f), body, `workmini's own ${f} is never replaced`)
    assert.equal(r.read('rock-dna.json'), null, 'the hub\'s quiz is merged by the app, never copied over workmini\'s')
    assert.equal(r.read('taste-weights.json'), HUB_FILES['taste-weights.json'], 'learned weights arrive on the normal sync')
    assert.equal(r.read('taste-profile.json'), HUB_FILES['taste-profile.json'])
    assert.match(r.log, /taste pull: adopted the hub's taste-weights\.json/)
    const pull = r.calls.find((c) => c[0] === 'RSYNC' && c[c.length - 1].endsWith('/taste-elsewhere/hub/'))
    assert.ok(pull && pull[pull.length - 2] === `test@stub:${HUB_DIR}/`)
  })

  it('workmini pushes its own choices into replicas/workmini/, but never the hub-only pair', () => {
    const r = runScript(['--skip-library-json'], { local: { ...WORKMINI_OWN, 'rock-dna.json': '{"version":1}', 'taste-weights.json': '{"v":1}', 'taste-profile.json': '{"a":1}' }, remote: {} })
    const push = statePush(r)!
    assert.equal(push[push.length - 1], `test@stub:${HUB_DIR}/replicas/workmini/`)
    for (const f of [...SHARED]) assert.ok(push.some((a) => a.endsWith(`/${f}`)), `${f} pushed`)
    for (const f of HUB_ONLY) assert.equal(push.some((a) => a.endsWith(`/${f}`)), false, `${f} is the hub's — never published back`)
  })

  it('a hub copy that is not a JSON object, or older than the one here, is never adopted', () => {
    const yesterday = new Date(Date.now() - 86_400_000)
    const bad = runScript(['--skip-library-json'], {
      local: { 'taste-weights.json': '{"version":2,"good":true}' },
      remote: { 'taste-weights.json': '{"version": 2, "torn' },
      before: ({ local }) => utimesSync(join(local, 'taste-weights.json'), yesterday, yesterday),   // the hub copy is NEWER — only the JSON gate stops it
    })
    assert.equal(bad.status, 0, bad.log)
    assert.equal(bad.read('taste-weights.json'), '{"version":2,"good":true}')
    const older = runScript(['--skip-library-json'], {
      local: { 'taste-weights.json': '{"deployed":"today"}' },
      remote: { 'taste-weights.json': '{"from":"homemini"}' },
      before: ({ remote }) => { const t = new Date(Date.now() - 86_400_000); utimesSync(join(remote, 'taste-weights.json'), t, t) },
    })
    assert.equal(older.read('taste-weights.json'), '{"deployed":"today"}', 'a deploy\'s newer copy is kept')
  })

  it('homemini away: the pull fails quietly, the sync still succeeds, nothing local changes', () => {
    const r = runScript(['--skip-library-json'], { local: WORKMINI_OWN, remote: HUB_FILES, env: { STUB_PULL_EXIT: '255' } })
    assert.equal(r.status, 0, r.log)
    assert.match(r.log, /homemini-only pass done/)
    assert.deepEqual(r.ls('taste-elsewhere/hub'), [])
    assert.equal(r.read('taste-weights.json'), null)
  })

  it('openrsync gets the pull\'s remote path escaped', () => {
    const r = runScript(['--skip-library-json'], { remote: HUB_FILES, env: { STUB_RSYNC_VERSION: 'openrsync: protocol version 29' } })
    const pull = r.calls.find((c) => c[0] === 'RSYNC' && c[c.length - 1].endsWith('/taste-elsewhere/hub/'))!
    assert.equal(pull[pull.length - 2], 'test@stub:Library/Application\\ Support/JakeTunes/')
    assert.equal(r.read('taste-elsewhere/hub/rock-dna.json'), HUB_FILES['rock-dna.json'])
  })
})

describe('the hub (MacBook) pulls every replica\'s choices', () => {
  it('replicas/<name>/ copies land in taste-elsewhere/<name>/ — only the shared taste files', () => {
    const remote = Object.fromEntries([...Object.entries(WORKMINI_OWN), ['rock-dna.json', '{"version":1}'], ['play-events.jsonl', 'x\n'], ['taste-weights.json', '{"stale":1}']].map(([f, b]) => [`replicas/workmini/${f}`, b]))
    const r = runScript(['--quick', '--homemini-only'], { local: HUB_FILES, remote })
    assert.equal(r.status, 0, r.log)
    assert.deepEqual(r.ls('taste-elsewhere'), ['workmini'])
    assert.deepEqual(r.ls('taste-elsewhere/workmini'), SHARED.slice().sort())
    assert.equal(r.read('taste-elsewhere/workmini/taste-ledger.jsonl'), WORKMINI_OWN['taste-ledger.jsonl'])
    for (const [f, body] of Object.entries(HUB_FILES)) assert.equal(r.read(f), body, `the hub's own ${f} is untouched`)
  })

  it('the hub publishes all its taste files to the hub folder', () => {
    const r = runScript(['--quick', '--homemini-only'], { local: HUB_FILES, remote: {} })
    const push = statePush(r)!
    assert.equal(push[push.length - 1], `test@stub:${HUB_DIR}/`)
    for (const f of [...SHARED, ...HUB_ONLY]) assert.ok(push.some((a) => a.endsWith(`/${f}`)), `${f} pushed`)
  })

  it('no replica has synced yet: nothing to pull, nothing logged, sync fine', () => {
    const r = runScript(['--quick', '--homemini-only'], { local: HUB_FILES, remote: {} })
    assert.equal(r.status, 0, r.log)
    assert.deepEqual(r.ls('taste-elsewhere'), [])
    assert.doesNotMatch(r.log, /taste pull/)
  })
})
