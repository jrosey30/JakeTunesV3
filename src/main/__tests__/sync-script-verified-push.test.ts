/**
 * Brief 172 + Brief 174 — the sync script's verified/merge pushes.
 *
 * Same stub harness shape as sync-script-replica-push.test.ts (recording
 * stubs for ssh / rsync / osascript / scutil; the ssh stub answers
 * "published 1" to any python3 remote, like the real verifiers do).
 *
 * Brief 174: metadata-overrides.json must NOT ride the bulk --checksum
 * rsync any more — it uploads alone to .metadata-overrides.json.incoming
 * for the remote verify+replace, so a corrupt local sidecar can no longer
 * overwrite the good remote copy.
 *
 * Brief 172: desktop stars must NOT be rsync-copied over homemini's
 * mobile-stars.json — they upload to .mobile-stars.json.incoming and are
 * merged there under the tombstone rule, so phone tombstones survive.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scriptPath = join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh')
const HUB_DIR = 'Library/Application Support/JakeTunes'
const STATE_FILES = [
  'library.json', 'metadata-overrides.json', 'playlists.json', 'play-events.jsonl', 'listening-log.jsonl',
  'live-sets.json', 'listener-profile.json', 'musicman-memory.json', 'musicman-interactions.jsonl',
  'picks-cache.json', 'audio-index.bin', 'activity-pool.json',
]
const SEP = '\u001f'

const STUB_RSYNC = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "rsync  version 3.4.2  protocol version 32"; exit 0; fi
( IFS=$'\\x1f'; printf 'RSYNC\\037%s\\n' "$*" ) >> "$STUB_CALLS"
exit 0
`
const STUB_SSH = `#!/bin/bash
( IFS=$'\\x1f'; printf 'SSH\\037%s\\n' "$*" ) >> "$STUB_CALLS"
case "$*" in
  *python3*) echo "published 1" ;;
esac
exit 0
`
const STUB_OSASCRIPT = `#!/bin/bash
( IFS=$'\\x1f'; printf 'OSASCRIPT\\037%s\\n' "$*" ) >> "$STUB_CALLS"
exit 0
`
const STUB_SCUTIL = `#!/bin/bash
echo "StubMac"
`

interface Call { tool: string; args: string[] }
interface Run { calls: Call[]; log: string; status: number | null }

function runScript(args: string[]): Run {
  const root = mkdtempSync(join(tmpdir(), 'jt-sync-verified-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    for (const [name, body] of [['rsync', STUB_RSYNC], ['ssh', STUB_SSH], ['osascript', STUB_OSASCRIPT], ['scutil', STUB_SCUTIL]]) {
      writeFileSync(join(bin, name), body)
      chmodSync(join(bin, name), 0o755)
    }
    const home = join(root, 'home')
    const data = join(home, HUB_DIR)
    mkdirSync(join(data, 'artwork'), { recursive: true })
    for (const f of STATE_FILES) {
      // metadata-overrides.json must be VALID here — Brief 174's local
      // parse gate would (correctly) refuse the `${f}\n` placeholder the
      // replica-push harness uses, and the upload would never happen.
      const body = f === 'library.json' ? '{"tracks":[{"id":1}]}'
        : f === 'metadata-overrides.json' ? '{"37":{"title":"X"}}'
        : `${f}\n`
      writeFileSync(join(data, f), body)
    }
    mkdirSync(join(root, 'nas', 'JakeTunesLibrary'), { recursive: true })
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(data, 'mobile-stars.json'), '{"trackIds":["1"]}')
    writeFileSync(join(data, 'mobile-plays.json'), '{}')
    writeFileSync(join(data, 'artwork', 'abc.jpg'), 'jpg')
    const calls = join(root, 'calls.txt')
    writeFileSync(calls, '')
    const r = spawnSync('/bin/bash', [scriptPath, ...args], {
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        STUB_CALLS: calls,
        JT_SYNC_LOG: join(root, 'sync.log'),
        JT_SYNC_LOCK: join(root, 'sync.lock'),
        JT_HOMEMINI: 'test@stub',
        JT_LIBRARY_ROOT: join(root, 'lib'),
        JT_MOUNT: join(root, 'nas'),
        JT_PLEX_SKIP: '1',
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
    const parsed = readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => {
      const [tool, ...rest] = line.split(SEP)
      return { tool, args: rest }
    })
    const log = existsSync(join(root, 'sync.log')) ? readFileSync(join(root, 'sync.log'), 'utf8') : ''
    return { calls: parsed, log, status: r.status }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const rsyncs = (r: Run) => r.calls.filter((c) => c.tool === 'RSYNC')
const dest = (c: Call) => c.args[c.args.length - 1]

describe('sync script: Brief 174 verified overrides publish + Brief 172 star merge push', () => {
  it('overrides upload to .incoming alone, never in the bulk --checksum rsync', () => {
    const r = runScript(['--quick'])
    assert.equal(r.status, 0, r.log)
    const bulk = rsyncs(r).find((c) => c.args.includes('--checksum'))
    assert.ok(bulk, 'bulk state push still runs')
    assert.equal(bulk.args.some((a) => a.endsWith('/metadata-overrides.json')), false,
      'metadata-overrides.json must not ride the bulk rsync (Brief 174)')
    assert.ok(rsyncs(r).some((c) => dest(c) === `test@stub:${HUB_DIR}/.metadata-overrides.json.incoming`),
      'overrides upload to .metadata-overrides.json.incoming')
    // The verifier ssh carries a heredoc, which the line-based call log
    // fragments across records — search the whole record stream.
    const stream = r.calls.map((c) => [c.tool, ...c.args].join(' ')).join('\n')
    assert.ok(stream.includes('SSH') && stream.includes('inc = ".metadata-overrides.json.incoming"'),
      'remote verifier runs against the incoming copy')
  })

  it('stars upload to .incoming for the remote merge, never copied over mobile-stars.json', () => {
    const r = runScript(['--quick'])
    assert.equal(r.status, 0, r.log)
    assert.match(r.log, /tombstone merge/)
    assert.ok(rsyncs(r).some((c) => dest(c) === `test@stub:${HUB_DIR}/.mobile-stars.json.incoming`),
      'stars upload to .mobile-stars.json.incoming')
    assert.equal(rsyncs(r).some((c) => dest(c) === `test@stub:${HUB_DIR}/mobile-stars.json`), false,
      'no rsync may land directly on mobile-stars.json (Brief 172)')
  })
})
