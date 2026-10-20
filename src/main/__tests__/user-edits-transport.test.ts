/**
 * How stars and Get Info edits travel between Macs (2026-10-20), locked:
 *   - the sync carries user-edits.json — a replica's into replicas/<name>/,
 *     the hub's into its own folder (jaketunes-homemini-sync.sh run end to
 *     end against recording stubs, as in sync-script-replica-push.test.ts);
 *   - the daily workmini deploy never copies metadata-overrides.json,
 *     mobile-stars.json or a journal onto workmini (the copy erased Jake's
 *     workmini edits);
 *   - in the app, the save-metadata-override handler is the journal's only
 *     writer, the star mirror merges instead of copying, and a replica's
 *     overrides go through the overlay at load.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scripts = join(repoRoot, 'Dr. Claude', 'scripts')
const syncScript = join(scripts, 'jaketunes-homemini-sync.sh')
const HUB_DIR = 'Library/Application Support/JakeTunes'
const SEP = '\u001f'

const STUB_RSYNC = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "rsync  version 3.4.2  protocol version 32"; exit 0; fi
( IFS=$'\\x1f'; printf 'RSYNC\\037%s\\n' "$*" ) >> "$STUB_CALLS"
exit 0
`
const STUB_SSH = `#!/bin/bash
( IFS=$'\\x1f'; printf 'SSH\\037%s\\n' "$*" ) >> "$STUB_CALLS"
case "$*" in *python3*) echo "published 1" ;; esac
exit 0
`
const STUB_SCUTIL = '#!/bin/bash\necho Workmini\n'

function statePush(args: string[]): string[] {
  const root = mkdtempSync(join(tmpdir(), 'jt-ue-sync-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    for (const [name, body] of [['rsync', STUB_RSYNC], ['ssh', STUB_SSH], ['osascript', '#!/bin/bash\nexit 0\n'], ['scutil', STUB_SCUTIL]]) {
      writeFileSync(join(bin, name), body)
      chmodSync(join(bin, name), 0o755)
    }
    const data = join(root, 'home', HUB_DIR)
    mkdirSync(join(data, 'artwork'), { recursive: true })
    writeFileSync(join(data, 'library.json'), '{"tracks":[{"id":1}]}')
    writeFileSync(join(data, 'metadata-overrides.json'), '{"1":{"fp":"","fields":{"genre":"Rock"}}}')
    writeFileSync(join(data, 'play-events.jsonl'), '{"id":1,"ts":1}\n')
    writeFileSync(join(data, 'user-edits.json'), '{"version":1,"since":1,"edits":{}}')
    mkdirSync(join(root, 'nas', 'JakeTunesLibrary'), { recursive: true })
    mkdirSync(join(root, 'lib'), { recursive: true })
    const calls = join(root, 'calls.txt')
    writeFileSync(calls, '')
    const r = spawnSync('/bin/bash', [syncScript, ...args], {
      env: {
        HOME: join(root, 'home'), PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, STUB_CALLS: calls,
        JT_SYNC_LOG: join(root, 'sync.log'), JT_SYNC_LOCK: join(root, 'sync.lock'), JT_HOMEMINI: 'test@stub',
        JT_LIBRARY_ROOT: join(root, 'lib'), JT_MOUNT: join(root, 'nas'),
      },
      encoding: 'utf8', timeout: 60_000,
    })
    assert.equal(r.status, 0, r.stderr)
    const push = readFileSync(calls, 'utf8').split('\n').filter(Boolean)
      .map((l) => l.split(SEP)).find((c) => c[0] === 'RSYNC' && c.includes('--checksum'))
    assert.ok(push, 'a state push ran')
    return push!.slice(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('the sync carries the journal', () => {
  it('a replica pushes user-edits.json into replicas/<name>/ — never the hub folder', () => {
    const args = statePush(['--quick', '--skip-library-json'])
    assert.ok(args.some((a) => a.endsWith('/user-edits.json')))
    assert.equal(args[args.length - 1], `test@stub:${HUB_DIR}/replicas/workmini/`)
  })

  it('the hub pushes its journal into its own folder (a replica reads the verdicts there)', () => {
    const args = statePush(['--quick', '--homemini-only'])
    assert.ok(args.some((a) => a.endsWith('/user-edits.json')))
    assert.equal(args[args.length - 1], `test@stub:${HUB_DIR}/`)
  })
})

function bashArray(src: string, name: string): string[] {
  const m = src.match(new RegExp(`\\n${name}=\\(([^)]*)\\)`))
  assert.ok(m, `${name}=(...) must exist`)
  return m![1].trim().split(/\s+/).filter(Boolean)
}

describe('the workmini deploy never overwrites workmini\'s edits', () => {
  const deploy = readFileSync(join(scripts, 'jaketunes-workmini-deploy.sh'), 'utf-8')
  const code = deploy.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')

  it('SIDECARS has no overrides, stars or journal', () => {
    const sidecars = bashArray(deploy, 'SIDECARS')
    for (const f of ['metadata-overrides.json', 'mobile-stars.json', 'user-edits.json']) {
      assert.equal(sidecars.includes(f), false, `${f} must not be copied onto workmini`)
    }
    assert.ok(sidecars.includes('playlists.json'), 'the rest of the bootstrap stays')
  })

  it('no other line of the deploy copies them either', () => {
    for (const f of ['metadata-overrides.json', 'mobile-stars.json', 'user-edits.json']) {
      assert.equal(code.includes(f), false, `${f} appears in deploy code`)
    }
  })
})

describe('in the app', () => {
  const idx = readFileSync(join(repoRoot, 'src', 'main', 'index.ts'), 'utf-8')

  it('the save-metadata-override handler is the only journal writer for this Mac\'s edits', () => {
    const records = idx.match(/userEdits\.record\(/g) ?? []
    assert.equal(records.length, 1)
    const start = idx.indexOf("ipc.handle('save-metadata-override'")
    const end = idx.indexOf('ipc.handle(', start + 10)
    const body = idx.slice(start, end)
    assert.match(body, /const editAt = Date\.now\(\)/)
    assert.match(body, /userEdits\.record\(trackId, field, value, editAt\)/)
    assert.match(body, /writeMobileStarSidecar\(trackId, Number\(value\) > 0, editAt\)/, 'journal and sidecar share the edit time')
    // and nothing else in src writes the journal file
    const writers: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p) }
        else if (/\.(ts|tsx)$/.test(e.name) && /USER_EDITS_FILE|'user-edits\.json'/.test(readFileSync(p, 'utf-8'))) writers.push(p.slice(repoRoot.length + 1))
      }
    }
    walk(join(repoRoot, 'src'))
    assert.deepEqual(writers.sort(), ['src/common/user-edits.ts', 'src/main/user-edits-sync.ts'])
  })

  it('the star mirror merges, and never drops the star cache under a pending write', () => {
    const start = idx.indexOf('async function refreshPhoneAuthoredMirrors')
    const body = idx.slice(start, idx.indexOf('\n}\n', start))
    assert.match(body, /merge: \{ 'mobile-stars\.json': \(body\) => mobileReadsApi\.mergeRemoteStars\(body\) \}/)
    assert.equal(body.includes('mobileStarsCache.invalidate()'), false)
  })

  it('a replica\'s overrides pass the overlay at load; one override writer', () => {
    const start = idx.indexOf("ipc.handle('load-metadata-overrides'")
    const body = idx.slice(start, idx.indexOf('}, { public: true })', start))
    assert.match(body, /overrides: await userEdits\.overlay\(merged\)/)
    assert.match(idx, /writeOverridesSerialized\(\(overrides\) => mergeOverrideField\(overrides, trackId, field, value, fingerprint\)\)/)
  })
})
