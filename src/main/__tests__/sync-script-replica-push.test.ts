/**
 * jaketunes-homemini-sync.sh run end to end against recording stubs for
 * ssh / rsync / osascript / scutil (2026-10-09).
 *
 * A replica (--skip-library-json) must push SAFELY:
 *   - its state goes to replicas/<name>/ on homemini, never over the hub's
 *     copies (the backend reads play-events.jsonl / listening-log.jsonl from
 *     the hub folder, "one-way synced from the MacBook");
 *   - artwork is additive (--ignore-existing), no JakeTunes restart on
 *     homemini, no NAS legs, and no osascript notification (on macOS 26 those
 *     open Script Editor — once per song change on workmini).
 * The hub run (no flag) must keep doing exactly what it did.
 * Remote paths are escaped only for macOS's openrsync.
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
if [ "$1" = "--version" ]; then echo "\${STUB_RSYNC_VERSION:-rsync  version 3.4.2  protocol version 32}"; exit 0; fi
( IFS=$'\\x1f'; printf 'RSYNC\\037%s\\n' "$*" ) >> "$STUB_CALLS"
exit "\${STUB_RSYNC_EXIT:-0}"
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
echo "\${STUB_HOST:-Workmini}"
`

interface Call { tool: string; args: string[] }
interface Run { calls: Call[]; log: string; status: number | null }

function runScript(args: string[], env: Record<string, string> = {}): Run {
  const root = mkdtempSync(join(tmpdir(), 'jt-sync-test-'))
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
    for (const f of STATE_FILES) writeFileSync(join(data, f), f === 'library.json' ? '{"tracks":[{"id":1}]}' : `${f}\n`)
    // The phone legs run on a full hub pass (after the NAS legs) and only
    // when the desktop side has something to push.
    mkdirSync(join(root, 'nas', 'JakeTunesLibrary'), { recursive: true })
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(data, 'mobile-stars.json'), '{}')
    writeFileSync(join(data, 'mobile-plays.json'), '{}')
    writeFileSync(join(data, 'artwork', 'abc.jpg'), 'jpg')
    writeFileSync(join(data, 'artwork', 'abc.meta.json'), '{}')
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
        ...env,
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
const statePush = (r: Run) => rsyncs(r).find((c) => c.args.includes('--checksum'))
const artworkPush = (r: Run) => rsyncs(r).find((c) => dest(c).endsWith('/artwork/'))

describe('sync script: a replica pushes only into its own folder on homemini', () => {
  it('replica state goes to replicas/<name>/, never the hub folder, never library.json', () => {
    const r = runScript(['--quick', '--skip-library-json'])
    assert.equal(r.status, 0, r.log)
    const push = statePush(r)
    assert.ok(push, `no state push in: ${JSON.stringify(rsyncs(r))}`)
    assert.equal(dest(push), `test@stub:${HUB_DIR}/replicas/workmini/`)
    assert.equal(push.args.some((a) => a.endsWith('/library.json')), false, 'replica must not push library.json')
    assert.ok(push.args.some((a) => a.endsWith('/play-events.jsonl')), 'the replica still pushes its own play log')
    for (const c of rsyncs(r)) {
      assert.notEqual(dest(c), `test@stub:${HUB_DIR}/`, 'nothing may land in the hub folder')
      assert.equal(dest(c).includes('JakeTunesState'), false, 'no library publish from a replica')
    }
    assert.ok(r.calls.some((c) => c.tool === 'SSH' && c.args.join(' ').includes(`mkdir -p "${HUB_DIR}/replicas/workmini"`)))
  })

  it('replica: no JakeTunes restart on homemini, no NAS legs, artwork only adds', () => {
    const r = runScript(['--skip-library-json'])
    assert.equal(r.status, 0, r.log)
    assert.equal(r.calls.some((c) => c.tool === 'SSH' && c.args.join(' ').includes('pkill')), false, 'replica must not restart homemini JakeTunes')
    assert.match(r.log, /homemini-only pass done/)
    assert.equal(/rsync music/.test(r.log), false)
    const art = artworkPush(r)
    assert.ok(art)
    assert.ok(art.args.includes('--ignore-existing'))
    assert.equal(art.args.includes('--update'), false)
  })

  it('replica: a failed push logs its notice and never runs osascript', () => {
    const r = runScript(['--skip-library-json'], { STUB_RSYNC_EXIT: '23' })
    assert.equal(r.calls.some((c) => c.tool === 'OSASCRIPT'), false, 'osascript notifications open Script Editor on macOS 26')
    assert.match(r.log, /notice \(replica, not shown\): Library state sync to homemini failed/)
  })

  it('openrsync gets the spaces escaped; GNU rsync gets the path unchanged', () => {
    const open = runScript(['--skip-library-json'], { STUB_RSYNC_VERSION: 'openrsync: protocol version 29' })
    assert.equal(dest(statePush(open)!), 'test@stub:Library/Application\\ Support/JakeTunes/replicas/workmini/')
    assert.equal(dest(artworkPush(open)!), 'test@stub:Library/Application\\ Support/JakeTunes/artwork/')
    const gnu = runScript(['--skip-library-json'])
    assert.equal(dest(statePush(gnu)!), `test@stub:${HUB_DIR}/replicas/workmini/`)
  })

  it('the replica folder name is the host name, lowercased and safe', () => {
    const r = runScript(['--skip-library-json'], { STUB_HOST: 'Jake’s Mac mini!!' })
    assert.equal(dest(statePush(r)!), `test@stub:${HUB_DIR}/replicas/jake-s-mac-mini/`)
  })
})

describe('sync script: the hub run is unchanged', () => {
  // 2026-10-10: the hub no longer kills + relaunches JakeTunes on homemini
  // after a push (257 times in one day — every play count, star and playlist
  // add). The running app reloads library.json itself; the sync only starts
  // it when it isn't running.
  it('hub publishes library.json, pushes state into the hub folder, never restarts homemini JakeTunes', () => {
    const r = runScript(['--quick', '--homemini-only'])
    assert.equal(r.status, 0, r.log)
    assert.ok(rsyncs(r).some((c) => dest(c) === 'test@stub:JakeTunesState/.library.json.incoming'), 'library publish')
    const push = statePush(r)
    assert.ok(push)
    assert.equal(dest(push), `test@stub:${HUB_DIR}/`)
    assert.ok(push.args.some((a) => a.endsWith('/library.json')))
    const sshCmds = r.calls.filter((c) => c.tool === 'SSH').map((c) => c.args.join(' '))
    assert.equal(sshCmds.some((s) => /pkill|killall/.test(s)), false, 'no kill of homemini JakeTunes')
    assert.ok(sshCmds.some((s) => s.includes('pgrep -f "JakeTunes.app/Contents/MacOS/JakeTunes$" >/dev/null || open -g /Applications/JakeTunes.app')),
      'starts it only when it is not running')
    const art = artworkPush(r)
    assert.ok(art && art.args.includes('--update') && !art.args.includes('--ignore-existing'))
    assert.equal(r.calls.some((c) => c.tool === 'SSH' && c.args.join(' ').includes('replicas/')), false)
  })

  it('hub: a failed push still shows its notification', () => {
    const r = runScript(['--homemini-only'], { STUB_RSYNC_EXIT: '23' })
    assert.ok(r.calls.some((c) => c.tool === 'OSASCRIPT'), 'the hub keeps its notifications')
  })

  // 2026-10-10: six phone legs (stars both ways, playlist sidecars, listening
  // log, plays) built "$HOMEMINI:$JT_DATA_REMOTE/…" by hand. Once JakeTunes
  // launched with /usr/bin ahead of Homebrew, openrsync split them at the
  // space: a "Couldn't push desktop stars" banner (Script Editor) on every
  // playlist add, and the phone pulls failing silently as "not there yet".
  it('every remote path is escaped for openrsync, pulls and pushes alike', () => {
    const open = runScript(['--quick'], { STUB_RSYNC_VERSION: 'openrsync: protocol version 29' })
    assert.equal(open.status, 0, open.log)
    const remote = rsyncs(open).flatMap((c) => c.args).filter((a) => a.startsWith('test@stub:'))
    for (const want of ['mobile-stars.json', 'mobile-playlists.json', 'playlist-additions.json', 'mobile-plays.json']) {
      assert.ok(remote.some((a) => a.endsWith(`/${want}`)), `${want} leg ran`)
    }
    const raw = remote.filter((a) => a.includes('Application Support'))
    assert.deepEqual(raw, [], 'no remote path reaches openrsync with a bare space')
    const gnu = runScript(['--quick'])
    const gnuRemote = rsyncs(gnu).flatMap((c) => c.args).filter((a) => a.startsWith('test@stub:'))
    assert.ok(gnuRemote.some((a) => a === `test@stub:${HUB_DIR}/mobile-stars.json`))
    assert.deepEqual(gnuRemote.filter((a) => a.includes('\\')), [], 'GNU rsync never gets a backslash')
  })
})
