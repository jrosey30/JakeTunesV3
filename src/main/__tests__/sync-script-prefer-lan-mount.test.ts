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
  ds225.local|192.168.1.223) [ "$STUB_LAN" = "1" ] && exit 0; exit 2 ;;
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
}

interface Run { status: number | null; log: string; calls: string[]; mounts: string }

function run(opts: { server: string; lan: boolean; busy?: boolean; unmountFails?: boolean }): Run {
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
    const r = spawnSync('/bin/bash', [scriptPath, '--quick'], {
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        JT_MOUNT_TOOLS_FROM_PATH: '1',
        STUB_MOUNTS: mounts,
        STUB_CALLS: calls,
        STUB_VOL: vol,
        STUB_LAN: opts.lan ? '1' : '0',
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

  it('away (the LAN does not prove the DS225) → the tailnet mount is kept as before', () => {
    const r = run({ server: TAILNET, lan: false })
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
