/**
 * jaketunes-homemini-sync.sh run end to end against recording stubs for
 * ssh / rsync / osascript / scutil (2026-10-09), with the mount tools faked by
 * sync-script-run.ts.
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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runSyncScript } from './sync-script-run.ts'

const HUB_DIR = 'Library/Application Support/JakeTunes'
const STATE_FILES = [
  'library.json', 'metadata-overrides.json', 'playlists.json', 'play-events.jsonl', 'listening-log.jsonl',
  'live-sets.json', 'listener-profile.json', 'musicman-memory.json', 'musicman-interactions.jsonl',
  'picks-cache.json', 'audio-index.bin', 'activity-pool.json',
]
const SEP = '\u001f'

// STUB_DEAD_MESH: homemini does not answer. Every ssh, and every rsync that needs one, exits
// 255 (measured for both rsyncs against a dead address, 2026-11-06); the music leg, which
// only needs the mount, still works. STUB_DEAD_ON: only a call naming this does.
const STUB_RSYNC = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "\${STUB_RSYNC_VERSION:-rsync  version 3.4.2  protocol version 32}"; exit 0; fi
( IFS=$'\\x1f'; printf 'RSYNC\\037%s\\n' "$*" ) >> "$STUB_CALLS"
printf '%s\\n' "\${RSYNC_RSH:-none}" >> "$STUB_CALLS.rsh"
if [ -n "\${STUB_DEAD_MESH:-}" ]; then
  case "$*" in *test@stub:*) exit 255 ;; esac
fi
if [ -n "\${STUB_DEAD_ON:-}" ]; then
  case "$*" in *"$STUB_DEAD_ON"*) exit 255 ;; esac
fi
exit "\${STUB_RSYNC_EXIT:-0}"
`
const STUB_SSH = `#!/bin/bash
( IFS=$'\\x1f'; printf 'SSH\\037%s\\n' "$*" ) >> "$STUB_CALLS"
[ -n "\${STUB_DEAD_MESH:-}" ] && exit 255
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
interface Run { calls: Call[]; log: string; status: number | null; rsyncRsh: string[] }

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
    // The phone legs run on every hub pass (before the NAS legs and the
    // homemini-only exit) and only when the desktop side has something to push.
    mkdirSync(join(root, 'nas', 'JakeTunesLibrary'), { recursive: true })
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(data, 'mobile-stars.json'), '{}')
    writeFileSync(join(data, 'mobile-plays.json'), '{}')
    writeFileSync(join(data, 'artwork', 'abc.jpg'), 'jpg')
    writeFileSync(join(data, 'artwork', 'abc.meta.json'), '{}')
    const calls = join(root, 'calls.txt')
    writeFileSync(calls, '')
    const r = runSyncScript(args, bin, {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      STUB_CALLS: calls,
      JT_SYNC_LOG: join(root, 'sync.log'),
      JT_SYNC_LOCK: join(root, 'sync.lock'),
      JT_HOMEMINI: 'test@stub',
      JT_LIBRARY_ROOT: join(root, 'lib'),
      JT_MOUNT: join(root, 'nas'),
      ...env,
    })
    const parsed = readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => {
      const [tool, ...rest] = line.split(SEP)
      return { tool, args: rest }
    })
    const log = existsSync(join(root, 'sync.log')) ? readFileSync(join(root, 'sync.log'), 'utf8') : ''
    const rshFile = `${calls}.rsh`
    const rsyncRsh = existsSync(rshFile) ? readFileSync(rshFile, 'utf8').split('\n').filter(Boolean) : []
    return { calls: parsed, log, status: r.status, rsyncRsh }
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

  // 2026-11-06. A hub's stars leave through these legs and no other. They sat after the
  // homemini-only exit, so on 11/5 no star push ran from 20:48 to 23:42 and stars
  // made at 21:42 waited about 2 hours.
  it('a homemini-only hub pass still runs the phone legs: stars both ways, plays, sidecars, the listening log', () => {
    const r = runScript(['--quick', '--homemini-only'])
    assert.equal(r.status, 0, r.log)
    const args = rsyncs(r).map((c) => c.args)
    const dests = args.map((a) => a[a.length - 1])
    const sources = args.map((a) => a[a.length - 2])
    assert.ok(sources.includes(`test@stub:${HUB_DIR}/mobile-stars.json`), 'phone stars pulled')
    assert.ok(dests.includes(`test@stub:${HUB_DIR}/.mobile-stars.json.incoming`), 'desktop stars pushed')
    assert.ok(dests.includes(`test@stub:${HUB_DIR}/mobile-plays.json`), 'plays pushed')
    assert.ok(sources.includes(`test@stub:${HUB_DIR}/mobile-playlists.json`), 'playlist sidecar pulled')
    assert.ok(sources.some((s) => s.endsWith('/mobile-listening-log.jsonl')), 'phone listening log pulled')
    assert.ok(r.calls.some((c) => c.tool === 'SSH' && c.args.join(' ').includes('cd ~/"Library/Application Support/JakeTunes" && python3')), 'the tombstone merge ran on homemini')
    assert.match(r.log, /pushing desktop stars/)
    assert.match(r.log, /homemini-only pass done/)
  })

  it('the phone pull runs before the push, and both before the homemini-only exit', () => {
    const r = runScript(['--quick', '--homemini-only'])
    const pull = r.log.indexOf('pulling phone stars')
    const push = r.log.indexOf('pushing desktop stars')
    const done = r.log.indexOf('homemini-only pass done')
    assert.ok(pull >= 0 && push > pull && done > push, r.log)
  })

  it('a replica runs none of them: its stars go through the app, not this script', () => {
    const r = runScript(['--quick', '--skip-library-json'])
    assert.equal(r.status, 0, r.log)
    assert.doesNotMatch(r.log, /pulling phone stars|pushing desktop stars|pulling phone playlist sidecars/)
    const remote = rsyncs(r).flatMap((c) => c.args).filter((a) => a.startsWith('test@stub:'))
    for (const f of ['mobile-stars.json', 'mobile-plays.json', 'mobile-playlists.json', 'mobile-listening-log.jsonl']) {
      assert.equal(remote.some((a) => a.endsWith(f)), false, `${f} on a replica pass`)
    }
  })

  it('a full hub pass runs them exactly once', () => {
    const r = runScript(['--quick'])
    assert.equal(r.status, 0, r.log)
    assert.equal(r.log.split('pushing desktop stars').length - 1, 1, r.log)
    assert.equal(r.log.split('pulling phone stars').length - 1, 1, r.log)
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

// Reviewer's finding, 2026-11-06. The phone legs moved in front of the music leg, and an rsync
// to a homemini whose tailnet node is dead waits out the kernel's connect timeout: 75 s
// (net.inet.tcp.keepinit, measured). That was 14 rsyncs before the music leg, about 1,055 s,
// against a 600 s limit on the whole script: the music leg and the Plex scan never started.
// Away, a pass past that limit reported "Sync timed out", with 4 notifications where there
// used to be 2, and on macOS 26 a notification opens Script Editor.
describe('sync script: homemini not answering ssh does not eat the pass', () => {
  const isMusic = (c: Call): boolean => c.tool === 'RSYNC' && dest(c).endsWith('/JakeTunesLibrary/')
  const beforeMusic = (r: Run): Call[] => {
    const at = r.calls.findIndex(isMusic)
    assert.ok(at >= 0, `the music leg ran:\n${r.log}`)
    return r.calls.slice(0, at)
  }
  const remote = (c: Call): boolean => c.args.some((a) => a.startsWith('test@stub:'))
  const named = (r: Run, f: string): boolean => r.calls.some((c) => c.tool === 'RSYNC' && c.args.some((a) => a.endsWith(f)))

  it('at home: the phone legs stop at their first look, and the music leg still runs', () => {
    const r = runScript([], { STUB_DEAD_MESH: '1', JT_PLEX_SKIP: '1' })
    assert.equal(r.status, 0, r.log)
    assert.ok(named(r, 'mobile-stars.json'), 'the first look')
    for (const f of ['.mobile-stars.json.incoming', 'mobile-plays.json', 'mobile-playlists.json', 'playlist-additions.json', 'mobile-listening-log.jsonl']) {
      assert.equal(named(r, f), false, `${f}: homemini already did not answer`)
    }
    assert.ok(beforeMusic(r).filter((c) => c.tool === 'RSYNC' && remote(c)).length <= 5, JSON.stringify(beforeMusic(r).map((c) => dest(c))))
    assert.match(r.log, /homemini did not answer ssh/)
    assert.match(r.log, /music rsync exit=0/)
  })

  it('away: no leg left to starve, and it says so no more often than it used to', () => {
    const r = runScript(['--quick', '--homemini-only'], { STUB_DEAD_MESH: '1' })
    assert.equal(r.status, 0, r.log)
    assert.equal(named(r, '.mobile-stars.json.incoming'), false)
    assert.match(r.log, /homemini-only pass done/)
    assert.equal(r.calls.filter((c) => c.tool === 'OSASCRIPT').length, 2, 'state, then artwork: the two it always was')
  })

  it('every rsync to homemini is held to the limits the ssh calls have', () => {
    const r = runScript(['--quick', '--homemini-only'])
    assert.ok(r.rsyncRsh.length >= 5, r.rsyncRsh.join('\n'))
    for (const rsh of r.rsyncRsh) {
      assert.match(rsh, /^ssh /, 'it is a real remote shell line')
      assert.match(rsh, /-o ConnectTimeout=10\b/)
      assert.match(rsh, /-o BatchMode=yes\b/)
      assert.match(rsh, /-o ServerAliveInterval=15\b/)
    }
  })

  it('homemini goes between the state push and the phone legs: the phone legs say so once', () => {
    const r = runScript(['--quick', '--homemini-only'], { STUB_DEAD_ON: 'mobile-stars.json' })
    assert.equal(r.status, 0, r.log)
    assert.equal(named(r, 'mobile-plays.json'), false)
    const shown = r.calls.filter((c) => c.tool === 'OSASCRIPT').map((c) => c.args.join(' '))
    assert.equal(shown.length, 1, shown.join('\n'))
    assert.match(shown[0], /Couldn't reach homemini/)
  })

  it('only ssh itself stops them: a file that is not there yet still leaves the other legs running', () => {
    const r = runScript(['--quick', '--homemini-only'], { STUB_RSYNC_EXIT: '23' })
    assert.match(r.log, /pushing desktop stars/)
    assert.doesNotMatch(r.log, /homemini did not answer ssh/)
    assert.ok(named(r, 'mobile-plays.json'))
  })
})
