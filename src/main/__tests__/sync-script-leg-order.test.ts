/**
 * What can hang on a NAS goes last (2026-11-06, the second look).
 *
 * The phone legs moved ahead of the music leg so stars and plays leave on every hub pass. Two of
 * their steps touch a NAS: the listening log, which homemini reads from its own mount, and the
 * sidecar copy onto this Mac's share. Neither has a limit that holds (--timeout: openrsync sat
 * 40 s on a 3 s limit, and a wedge in a local write outlives it), and real passes stalled 194 to
 * 300 s on them. Ahead of the music leg, a hang there meant no music, no Plex, no artwork.
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runSyncScript } from './sync-script-run.ts'

const HUB_DIR = 'Library/Application Support/JakeTunes'

// Every rsync and ssh is one line in the order it ran. STUB_FAIL_ON: the first call whose
// arguments match this pattern exits STUB_FAIL_RC, and so does every later one that does.
const STUB_RSYNC = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "rsync  version 3.4.2  protocol version 32"; exit 0; fi
echo "rsync $*" >> "$STUB_CALLS"
case "$*" in *\${STUB_FAIL_ON:-no such thing}*) exit "\${STUB_FAIL_RC:-255}" ;; esac
exit 0
`
const STUB_SSH = `#!/bin/bash
printf '%s\\n' "ssh $*" | head -1 >> "$STUB_CALLS"
case "$*" in *\${STUB_SSH_FAIL_ON:-no such thing}*) exit 255 ;; esac
case "$*" in *mobile-stars*) echo "merged 1 stars, 0 tombstones" ;; *python3*) echo "published 1" ;; esac
exit 0
`
const bin = mkdtempSync(join(tmpdir(), 'jt-sync-order-bin-'))
for (const [name, body] of [['rsync', STUB_RSYNC], ['ssh', STUB_SSH], ['osascript', '#!/bin/bash\necho "notify $*" >> "$STUB_CALLS"\nexit 0\n'], ['scutil', '#!/bin/bash\necho StubMac\n']]) {
  writeFileSync(join(bin, name), body)
  chmodSync(join(bin, name), 0o755)
}
after(() => rmSync(bin, { recursive: true, force: true }))

function pass(args: string[], env: Record<string, string> = {}): { calls: string[]; log: string; status: number | null } {
  const root = mkdtempSync(join(tmpdir(), 'jt-sync-order-'))
  try {
    const home = join(root, 'home')
    const data = join(home, HUB_DIR)
    mkdirSync(join(data, 'artwork'), { recursive: true })
    mkdirSync(join(root, 'lib'))
    mkdirSync(join(root, 'nas', 'JakeTunesLibrary'), { recursive: true })
    mkdirSync(join(root, 'nas', 'JakeTunesState'), { recursive: true })
    writeFileSync(join(data, 'library.json'), '{"tracks":[{"id":1}]}')
    writeFileSync(join(data, 'mobile-stars.json'), '{"v":2,"trackIds":[]}')
    writeFileSync(join(data, 'mobile-plays.json'), '{}')
    writeFileSync(join(data, 'artwork', 'a.jpg'), 'x')
    const calls = join(root, 'calls')
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
      JT_PLEX_SKIP: '1',
      ...env,
    })
    const log = existsSync(join(root, 'sync.log')) ? readFileSync(join(root, 'sync.log'), 'utf8') : ''
    return { calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean), log, status: r.status }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const at = (calls: string[], needle: string): number => calls.findIndex((c) => c.includes(needle))
const LISTENING = 'mobile-listening-log.jsonl'
const STAR_PULL = 'mobile-stars.incoming.json'
const ARTWORK = '/artwork/'
const STAR_MERGE = 'Library/Application Support/JakeTunes" && python3'

describe('the order of the legs', () => {
  it('a full pass: stars and plays first, then music, then artwork, then what can hang on a NAS', () => {
    const { calls, status, log } = pass(['--full'])
    assert.equal(status, 0, log)
    const stars = at(calls, STAR_PULL)
    const merge = at(calls, STAR_MERGE)
    const plays = at(calls, 'mobile-plays.json')
    const music = at(calls, 'rsync -')
    const artwork = at(calls, ARTWORK)
    const listening = at(calls, LISTENING)
    const shareCopy = calls.findIndex((c) => c.startsWith('rsync') && c.includes('/nas/JakeTunesState/mobile-'))
    for (const [what, i] of Object.entries({ stars, plays, artwork, listening, shareCopy, music })) assert.ok(i >= 0, `${what} never ran:\n${calls.join('\n')}`)
    assert.ok(stars < artwork && merge < artwork && plays < artwork, calls.join('\n'))
    assert.ok(artwork < listening, `the listening log came before artwork:\n${calls.join('\n')}`)
    assert.ok(artwork < shareCopy, `the share copy came before artwork:\n${calls.join('\n')}`)
    const musicLeg = calls.findIndex((c) => c.includes('/nas/JakeTunesLibrary/'))
    assert.ok(musicLeg > plays && musicLeg < artwork, `music leg at ${musicLeg}:\n${calls.join('\n')}`)
  })

  it('a homemini-only pass: the same, and no copy onto a share it was told to stay off', () => {
    const { calls, log } = pass(['--quick', '--homemini-only'])
    assert.match(log, /homemini-only pass done/)
    assert.ok(at(calls, STAR_PULL) < at(calls, ARTWORK), calls.join('\n'))
    assert.ok(at(calls, ARTWORK) < at(calls, LISTENING), calls.join('\n'))
    assert.equal(calls.filter((c) => c.includes('/nas/JakeTunesState/mobile-')).length, 0)
  })

  it('the listening log still reaches this Mac by the same three paths, in order', () => {
    const { calls } = pass(['--quick', '--homemini-only'], { STUB_FAIL_ON: LISTENING, STUB_FAIL_RC: '1' })
    const tries = calls.filter((c) => c.includes(LISTENING))
    assert.equal(tries.length, 3, tries.join('\n'))
    assert.match(tries[0], /test@stub:\/Volumes\/JakeShared\/JakeTunesState\//)
  })
})

describe('a dead homemini stops the phone legs at the first answer that says so', () => {
  for (const rc of ['255', '12']) {
    it(`exit ${rc} on the first pull: no more calls to homemini from the phone legs, last step included`, () => {
      const { calls, log } = pass(['--quick', '--homemini-only'], { STUB_FAIL_ON: STAR_PULL, STUB_FAIL_RC: rc })
      assert.match(log, new RegExp(`phone stars pull exit ${rc}`))
      assert.equal(at(calls, 'mobile-playlists.json'), -1, calls.join('\n'))
      assert.equal(at(calls, LISTENING), -1, calls.join('\n'))
      assert.equal(at(calls, STAR_MERGE), -1, calls.join('\n'))
    })

    it(`exit ${rc} on a sidecar: the rest of them, the star push and the last step don't run`, () => {
      const { calls, log } = pass(['--quick', '--homemini-only'], { STUB_FAIL_ON: 'mobile-playlists.json', STUB_FAIL_RC: rc })
      assert.equal(calls.filter((c) => c.includes('mobile-playlists.json')).length, 1, calls.join('\n'))
      assert.equal(at(calls, '.mobile-stars.json.incoming'), -1, calls.join('\n'))
      assert.equal(at(calls, LISTENING), -1, calls.join('\n'))
      assert.match(log, /phone sidecar pull/)
    })

    it(`exit ${rc} on the star push: no merge, no plays, no last step, no notification`, () => {
      const { calls, log } = pass(['--quick', '--homemini-only'], { STUB_FAIL_ON: '.mobile-stars.json.incoming', STUB_FAIL_RC: rc })
      assert.match(log, new RegExp(`star push exit ${rc}`))
      assert.equal(at(calls, STAR_MERGE), -1, calls.join('\n'))
      assert.equal(at(calls, 'mobile-plays.json'), -1, calls.join('\n'))
      assert.equal(at(calls, LISTENING), -1, calls.join('\n'))
      assert.equal(calls.filter((c) => c.startsWith('notify')).length, 0, calls.join('\n'))
    })

    it(`exit ${rc} in the last step: the other paths and the share copies stop too, and the pass still ends well`, () => {
      const { calls, log, status } = pass(['--full'], { STUB_FAIL_ON: LISTENING, STUB_FAIL_RC: rc })
      assert.equal(status, 0, log)
      assert.equal(calls.filter((c) => c.includes(LISTENING)).length, 1, calls.join('\n'))
      assert.equal(calls.filter((c) => c.includes('/nas/JakeTunesState/mobile-')).length, 0, calls.join('\n'))
      assert.doesNotMatch(log, /phone listening log not found/)
    })
  }

  it('an ordinary missing file is not that: the next sidecar is still asked for', () => {
    const { calls } = pass(['--quick', '--homemini-only'], { STUB_FAIL_ON: 'mobile-playlists.json', STUB_FAIL_RC: '23' })
    assert.ok(at(calls, '.mobile-stars.json.incoming') >= 0, calls.join('\n'))
    assert.ok(at(calls, LISTENING) >= 0, calls.join('\n'))
  })

  it('the star merge ssh has the same limits as the rest: a session that goes quiet ends', () => {
    const { calls } = pass(['--quick', '--homemini-only'])
    const merge = calls.find((c) => c.includes(STAR_MERGE))
    assert.ok(merge, calls.join('\n'))
    assert.match(merge, /ServerAliveInterval=15/)
    assert.match(merge, /ServerAliveCountMax=4/)
  })

  it('the star merge dying with 255 is the same: no plays, no last step', () => {
    const { calls, log } = pass(['--quick', '--homemini-only'], { STUB_SSH_FAIL_ON: 'mobile-stars' })
    assert.match(log, /star merge exit 255/)
    assert.equal(at(calls, LISTENING), -1, calls.join('\n'))
  })
})
