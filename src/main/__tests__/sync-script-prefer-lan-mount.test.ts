/**
 * A tailnet JakeShared mount moves back to the LAN path once home (2026-10-27).
 *
 * ensure_jakeshared adopted ANY live mount, so a mount made over Tailscale
 * while Jake was away (//…@100.117.19.93/JakeShared) stayed in use at home
 * forever. That path drops on every wake from sleep — 28 of 33 NAS-breaker
 * trips on 10/26-27 were within a minute of a wake. Now: tailnet mount + the
 * DS225 proving itself on the LAN + nothing open on the mount + this run
 * holding the lock → `diskutil unmount` (never force) and mount the LAN path.
 * Busy, unmount failure, away, or already-LAN → the mount is left alone.
 *
 * Runs the real script (--quick) with mount/ping/smbutil/lsof/diskutil/
 * osascript shimmed via PATH (JT_MOUNT_TOOLS_FROM_PATH=1): no network, no
 * real mounts. The mount table is a file the shims read and rewrite.
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
const TAILNET = '100.117.19.93'

const STUBS: Record<string, string> = {
  mount: `#!/bin/bash
cat "$STUB_MOUNTS"
`,
  ping: `#!/bin/bash
host="\${@: -1}"
echo "ping $host" >> "$STUB_CALLS"
case "$host" in
  192.168.1.223) [ "$STUB_LAN" = "1" ] && [ "$STUB_LAN_MOVED" != "1" ] && exit 0; exit 2 ;;
  ds225.local) [ "$STUB_LAN" = "1" ] && exit 0; exit 2 ;;
esac
exit 2
`,
  smbutil: `#!/bin/bash
host="\${@: -1}"; host="\${host#//jakerosenbaum@}"
case "$host" in
  ds225.local|192.168.1.223) [ "$STUB_LAN" = "1" ] && echo "JakeShared  Disk" ;;
  ${TAILNET}) echo "JakeShared  Disk" ;;
esac
exit 0
`,
  lsof: `#!/bin/bash
echo "lsof $*" >> "$STUB_CALLS"
if [ "$STUB_BUSY" = "1" ]; then
  echo "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME"
  echo "lsof    999 jake  cwd    DIR   1,20     4096    2 $STUB_VOL"
  echo "JakeTunes 123 jake   42r   REG   1,20  1048576   17 $STUB_VOL/JakeTunesLibrary/a.m4a"
  exit 0
fi
echo "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME"
echo "lsof    999 jake  cwd    DIR   1,20     4096    2 $STUB_VOL"
exit 0
`,
  diskutil: `#!/bin/bash
echo "diskutil $*" >> "$STUB_CALLS"
[ "$1" = "unmount" ] || exit 1
case " $* " in *" force "*) echo "FORCE USED" >> "$STUB_CALLS" ;; esac
if [ "$STUB_UNMOUNT_FAIL" = "1" ]; then echo "Unmount of $2 failed: at least one volume could not be unmounted" >&2; exit 1; fi
: > "$STUB_MOUNTS"
exit 0
`,
  osascript: `#!/bin/bash
case "$*" in
  *"mount volume"*)
    host=$(printf '%s' "$*" | sed -n 's|.*smb://jakerosenbaum@\\([^/]*\\)/JakeShared.*|\\1|p')
    echo "osascript mount $host" >> "$STUB_CALLS"
    echo "//jakerosenbaum@$host/JakeShared on $STUB_VOL (smbfs, nodev, nosuid, mounted by jake)" > "$STUB_MOUNTS"
    ;;
esac
exit 0
`,
  rsync: `#!/bin/bash
if [ "$1" = "--version" ]; then echo "rsync  version 3.4.2  protocol version 32"; exit 0; fi
exit 0
`,
  ssh: `#!/bin/bash
case "$*" in *python3*) echo "published 1" ;; esac
exit 0
`,
  scutil: `#!/bin/bash
echo "StubMac"
`,
  // route -n get: on-link at home, a gateway line when away; STUB_ROUTE=none is no route at all.
  route: `#!/bin/bash
echo "route $*" >> "$STUB_CALLS"
[ "$STUB_ROUTE" = "none" ] && { echo "route: writing to routing socket: not in table" >&2; exit 0; }
echo "   route to: 192.168.1.223"
[ "$STUB_ROUTE" = "gateway" ] && echo "    gateway: 172.17.1.1"
echo "  interface: en0"
exit 0
`,
}

interface Run { status: number | null; log: string; calls: string[]; mounts: string; shareStats: string[]; shareState: string }

function run(opts: { server: string; lan: boolean; lanMoved?: boolean; busy?: boolean; unmountFails?: boolean; route?: 'home' | 'gateway' | 'none'; args?: string[]; shareState?: string }): Run {
  const root = mkdtempSync(join(tmpdir(), 'jt-sync-preferlan-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(join(bin, name), body)
      chmodSync(join(bin, name), 0o755)
    }
    const home = join(root, 'home')
    mkdirSync(join(home, HUB_DIR, 'artwork'), { recursive: true })
    writeFileSync(join(home, HUB_DIR, 'library.json'), '{"tracks":[{"id":1}]}')
    const vol = join(root, 'Volumes', 'JakeShared')
    mkdirSync(join(vol, 'JakeTunesLibrary'), { recursive: true })
    const lib = join(root, 'lib')
    mkdirSync(lib)
    const mounts = join(root, 'mounts.txt')
    writeFileSync(mounts, `//jakerosenbaum@${opts.server}/JakeShared on ${vol} (smbfs, nodev, nosuid, mounted by jake)\n`)
    const calls = join(root, 'calls.txt')
    writeFileSync(calls, '')
    if (opts.shareState) writeFileSync(join(root, 'sync.lock.share-state'), `${opts.shareState}\n`)
    // -x: the trace is the only witness that a stat of the share did not happen.
    const r = spawnSync('/bin/bash', ['-x', scriptPath, ...(opts.args ?? ['--quick'])], {
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        JT_MOUNT_TOOLS_FROM_PATH: '1',
        STUB_MOUNTS: mounts,
        STUB_CALLS: calls,
        STUB_VOL: vol,
        STUB_LAN: opts.lan ? '1' : '0',
        STUB_LAN_MOVED: opts.lanMoved ? '1' : '0',
        STUB_ROUTE: opts.route ?? 'home',
        STUB_BUSY: opts.busy ? '1' : '0',
        STUB_UNMOUNT_FAIL: opts.unmountFails ? '1' : '0',
        JT_SYNC_LOG: join(root, 'sync.log'),
        JT_SYNC_LOCK: join(root, 'sync.lock'),
        JT_HOMEMINI: 'test@stub',
        JT_LIBRARY_ROOT: lib,
        JT_MOUNT: vol,
        JT_PLEX_SKIP: '1',
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
    const log = existsSync(join(root, 'sync.log')) ? readFileSync(join(root, 'sync.log'), 'utf8') : ''
    return {
      status: r.status,
      log,
      calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
      mounts: readFileSync(mounts, 'utf8'),
      shareState: existsSync(join(root, 'sync.lock.share-state')) ? readFileSync(join(root, 'sync.lock.share-state'), 'utf8').trim() : '',
      // bash traces `[` as '[' and `[[` as [[
      shareStats: r.stderr.split('\n').filter((l) => /^\++ *('\['|\[\[) .*-[def] /.test(l) && l.includes(vol)),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const nasLines = (log: string) => log.split('\n').filter((l) => l.includes('NAS: '))
const has = (calls: string[], prefix: string) => calls.some((c) => c.startsWith(prefix))

describe('sync script: a tailnet JakeShared mount moves to the LAN path at home', () => {
  it('tailnet mount + DS225 on the LAN + nothing open → unmounts (no force) and mounts the LAN path', () => {
    const r = run({ server: TAILNET, lan: true })
    assert.equal(r.status, 0, r.log)
    assert.ok(has(r.calls, 'lsof -n '), r.calls.join('\n'))
    assert.ok(has(r.calls, 'diskutil unmount '), r.calls.join('\n'))
    assert.ok(!r.calls.includes('FORCE USED'))
    assert.ok(r.calls.includes('osascript mount ds225.local'), r.calls.join('\n'))
    assert.match(r.mounts, /^\/\/jakerosenbaum@ds225\.local\/JakeShared on /)
    const lines = nasLines(r.log)
    assert.equal(lines.filter((l) => l.includes('released the tailnet mount')).length, 1, r.log)
    assert.equal(lines.filter((l) => l.includes('now on the LAN mount')).length, 1, r.log)
  })

  it('tailnet mount + DS225 on the LAN + files open → keeps the tailnet mount', () => {
    const r = run({ server: TAILNET, lan: true, busy: true })
    assert.equal(r.status, 0, r.log)
    assert.ok(!has(r.calls, 'diskutil'), r.calls.join('\n'))
    assert.ok(!has(r.calls, 'osascript mount'), r.calls.join('\n'))
    assert.match(r.mounts, new RegExp(`^//jakerosenbaum@${TAILNET.replace(/\./g, '\\.')}/JakeShared on `))
    const lines = nasLines(r.log)
    assert.equal(lines.length, 1, r.log)
    assert.match(lines[0], /busy \(JakeTunes\(123\)\) — keeping it/)
  })

  it('a LAN mount is left untouched — no lsof, no unmount, no mount, no log', () => {
    const r = run({ server: 'ds225.local', lan: true })
    assert.equal(r.status, 0, r.log)
    assert.ok(!has(r.calls, 'lsof'), r.calls.join('\n'))
    assert.ok(!has(r.calls, 'diskutil'), r.calls.join('\n'))
    assert.ok(!has(r.calls, 'osascript mount'), r.calls.join('\n'))
    assert.match(r.mounts, /^\/\/jakerosenbaum@ds225\.local\/JakeShared on /)
    assert.deepEqual(nasLines(r.log), [])
  })

  it('on-link but the DS225 does not prove itself (a foreign 192.168.1.x, the NAS asleep) → the tailnet mount is kept as before', () => {
    const r = run({ server: TAILNET, lan: false, route: 'none' })
    assert.equal(r.status, 0, r.log)
    assert.ok(!has(r.calls, 'lsof'), r.calls.join('\n'))
    assert.ok(!has(r.calls, 'diskutil'), r.calls.join('\n'))
    assert.ok(!has(r.calls, 'osascript mount'), r.calls.join('\n'))
    const lines = nasLines(r.log)
    assert.equal(lines.length, 1, r.log)
    assert.match(lines[0], /not on the LAN — away, keeping it/)
  })

  it('unmount fails → keeps the tailnet mount and logs one line', () => {
    const r = run({ server: TAILNET, lan: true, unmountFails: true })
    assert.equal(r.status, 0, r.log)
    assert.ok(has(r.calls, 'diskutil unmount '), r.calls.join('\n'))
    assert.ok(!has(r.calls, 'osascript mount'), r.calls.join('\n'))
    assert.match(r.mounts, new RegExp(`^//jakerosenbaum@${TAILNET.replace(/\./g, '\\.')}/JakeShared on `))
    const lines = nasLines(r.log)
    assert.equal(lines.length, 1, r.log)
    assert.match(lines[0], /unmounting the tailnet mount .* failed — keeping it/)
  })
})

// 2026-11-06. An idle share passes every check, so a sync started within 5 s and a
// backup within 2 min, the stat then took over 2 s, and the breaker reopened. Away
// the script stays off the share altogether.
describe('sync script: no SMB when away', () => {
  it('a gateway on the route to the NAS → homemini legs only, no ladder, not one stat of the share, even with no flag from the app', () => {
    const r = run({ server: TAILNET, lan: false, route: 'gateway' })
    assert.equal(r.status, 0, r.log)
    assert.match(r.log, /away from home/)
    assert.match(r.log, /homemini-only pass done/)
    assert.doesNotMatch(r.log, /rsync music/)
    for (const tool of ['ping', 'lsof', 'diskutil', 'osascript mount']) assert.ok(!has(r.calls, tool), `${tool}: ${r.calls.join('\n')}`)
    assert.deepEqual(nasLines(r.log), [])
    assert.deepEqual(r.shareStats, [])
  })

  it('…and the same when the app passes --homemini-only', () => {
    const r = run({ server: TAILNET, lan: false, route: 'gateway', args: ['--quick', '--homemini-only'] })
    assert.equal(r.status, 0, r.log)
    assert.doesNotMatch(r.log, /away from home/, 'the app already said so')
    assert.deepEqual(r.shareStats, [])
  })

  it('--homemini-only at home (the breaker is open): not one stat of the share either', () => {
    const r = run({ server: 'ds225.local', lan: true, args: ['--quick', '--homemini-only'] })
    assert.equal(r.status, 0, r.log)
    assert.match(r.log, /homemini-only pass done/)
    assert.deepEqual(r.shareStats, [])
  })

  it('home again: no gateway, so a tailnet mount left over from the trip still moves to the LAN path', () => {
    const r = run({ server: TAILNET, lan: true, route: 'home' })
    assert.equal(r.status, 0, r.log)
    assert.ok(r.calls.includes('osascript mount ds225.local'), r.calls.join('\n'))
    assert.match(r.mounts, /^\/\/jakerosenbaum@ds225\.local\/JakeShared on /)
    assert.doesNotMatch(r.log, /away from home/)
  })

  it('no route at all, with no earlier answer, proves nothing: the old path, not away', () => {
    const r = run({ server: TAILNET, lan: false, route: 'none' })
    assert.equal(r.status, 0, r.log)
    assert.doesNotMatch(r.log, /away from home/)
    assert.match(r.log, /not on the LAN — away, keeping it/)
  })

  it('an empty route read just after being away is not home: not one stat of the share', () => {
    for (const shareState of ['away', 'on-link-no-answer']) {
      const r = run({ server: TAILNET, lan: false, route: 'none', shareState })
      assert.equal(r.status, 0, r.log)
      assert.match(r.log, /away from home/)
      assert.deepEqual(r.shareStats, [])
      assert.equal(r.shareState, shareState, 'an empty read changes no answer')
    }
  })

  it('…and after home it stays home', () => {
    const r = run({ server: 'ds225.local', lan: true, route: 'none', shareState: 'home' })
    assert.equal(r.status, 0, r.log)
    assert.doesNotMatch(r.log, /away from home/)
  })

  // A hotel or a friend's network numbered 192.168.1.x: same route, nobody at that address.
  it('on-link and no answer → homemini legs only, no ladder, not one stat of the share', () => {
    const r = run({ server: TAILNET, lan: false, route: 'home' })
    assert.equal(r.status, 0, r.log)
    assert.match(r.log, /on-link, no answer: 192\.168\.1\.223/)
    assert.match(r.log, /away from home/)
    assert.match(r.log, /homemini-only pass done/)
    assert.doesNotMatch(r.log, /rsync music/)
    assert.deepEqual(r.shareStats, [])
    assert.deepEqual(r.calls.filter((c) => c.startsWith('ping')), ['ping 192.168.1.223', 'ping ds225.local'], 'the address, then the name, and no ladder')
    assert.match(r.log, /doesn't answer on the LAN/, 'not "behind a gateway": there is no gateway here')
    assert.doesNotMatch(r.log, /behind a gateway/)
    assert.equal(r.shareState, 'on-link-no-answer', 'not the same word as a normal away')
  })

  // Second look, 2026-11-06: a new lease at home read as away for good.
  it('the NAS took a new address at home: ds225.local answers, so this is home, and the legs run', () => {
    const r = run({ server: 'ds225.local', lan: true, route: 'home', lanMoved: true })
    assert.equal(r.shareState, 'home')
    assert.doesNotMatch(r.log, /on-link, no answer/)
    assert.doesNotMatch(r.log, /away from home/)
  })

  it('…said once per change: the next pass in that state says nothing new', () => {
    const r = run({ server: TAILNET, lan: false, route: 'home', shareState: 'on-link-no-answer' })
    assert.doesNotMatch(r.log, /on-link, no answer/)
    assert.equal(r.shareState, 'on-link-no-answer')
  })

  it('…and when it answers again the log says so', () => {
    const r = run({ server: 'ds225.local', lan: true, route: 'home', shareState: 'on-link-no-answer' })
    assert.match(r.log, /on-link, no answer: over/)
    assert.equal(r.shareState, 'home')
  })

  it('a gateway needs no ping, and it is its own word', () => {
    const r = run({ server: TAILNET, lan: false, route: 'gateway' })
    assert.equal(r.shareState, 'away')
    assert.doesNotMatch(r.log, /on-link, no answer/)
  })

  it('at home a full pass does look at the share, so the guards above are not simply always off', () => {
    const r = run({ server: 'ds225.local', lan: true })
    assert.equal(r.status, 0, r.log)
    assert.ok(r.shareStats.length > 0, 'the home path stats the live mount')
  })
})
