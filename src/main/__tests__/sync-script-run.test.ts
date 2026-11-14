/**
 * A test's run of the sync script stays off this Mac (sync-script-run.ts). Rails, so the
 * next harness or the next probe can't bring the real NAS back, and runs that only pass
 * if the fakes are the ones that answered.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runSyncScript } from './sync-script-run.ts'

const here = import.meta.dirname
const script = readFileSync(join(here, '..', '..', '..', 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh'), 'utf-8')
const HUB_DIR = 'Library/Application Support/JakeTunes'

describe('sync script rails: nothing gets past the fakes', () => {
  it('the script reaches the mount tools only through their variables', () => {
    const direct = script.split('\n')
      .filter((l) => !/^\s*#/.test(l) && !/^\s*(MOUNT_BIN|LSOF_BIN)=\//.test(l))
      .filter((l) => /\/s?bin\/(mount|ping|smbutil|lsof|diskutil|osascript|route)\b/.test(l))
    assert.deepEqual(direct, [], 'a tool called by its full path skips the fakes and reaches the real network')
  })

  it('every test that runs the script fakes the mount tools', () => {
    const offenders = readdirSync(here).filter((f) => {
      // replica-sync-legs only runs `bash -n` on it. sync-script-publish-deletions runs
      // only the publish guard's Python, cut out of it, in a temp folder: no bash, no mount.
      if (!f.endsWith('.test.ts') || f === 'replica-sync-legs.test.ts' || f === 'sync-script-publish-deletions.test.ts') return false
      const src = readFileSync(join(here, f), 'utf-8')
      return src.includes('jaketunes-homemini-sync.sh')
        && /\b(spawnSync|spawn|execFileSync|execFile|execSync|exec)\(/.test(src)
        && !src.includes("JT_MOUNT_TOOLS_FROM_PATH: '1'")
    })
    assert.deepEqual(offenders, [], 'run it through runSyncScript (sync-script-run.ts)')
  })
})

/** A hub pass over a sandbox holding only library.json; `share` picks its JT_MOUNT. */
function hubPass(share: (root: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'jt-sync-run-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const stubs = {
      rsync: '#!/bin/bash\n[ "$1" = "--version" ] && exit 0\nprintf \'%s\\n\' "$@" >> "$STUB_ARGS"\nexit 0\n',
      ssh: '#!/bin/bash\ncase "$*" in *python3*) echo "published 1" ;; esac\nexit 0\n',
    }
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), body)
      chmodSync(join(bin, name), 0o755)
    }
    const data = join(root, 'home', HUB_DIR)
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'library.json'), '{"tracks":[{"id":1}]}')
    mkdirSync(join(root, 'lib'))
    const args = join(root, 'args.txt')
    writeFileSync(args, '')
    const mount = share(root)
    const r = runSyncScript(['--quick'], bin, {
      HOME: join(root, 'home'),
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      STUB_ARGS: args,
      JT_SYNC_LOG: join(root, 'sync.log'),
      JT_SYNC_LOCK: join(root, 'sync.lock'),
      JT_HOMEMINI: 'test@stub',
      JT_LIBRARY_ROOT: join(root, 'lib'),
      JT_MOUNT: mount,
      JT_PLEX_SKIP: '1',
    })
    return {
      status: r.status,
      toolsAsked: r.toolsAsked,
      // On disk, not what the run called: the script holds route to 5 s, and at load 500 the fake
      // didn't get to say it was asked.
      fakedTools: readdirSync(bin),
      mount,
      log: readFileSync(join(root, 'sync.log'), 'utf8'),
      rsyncArgs: readFileSync(args, 'utf8').split('\n').filter(Boolean),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('a run on the fakes', () => {
  it('stays in its sandbox, whatever this Mac has mounted', () => {
    const r = hubPass((root) => {
      const nas = join(root, 'nas')
      mkdirSync(join(nas, 'JakeTunesLibrary'), { recursive: true })
      return nas
    })
    assert.equal(r.status, 0, r.log)
    assert.ok(r.fakedTools.includes('route'), `the real route would answer, and away from home it says away: ${r.fakedTools}`)
    assert.ok(r.log.includes(`→ ${r.mount}/JakeTunesLibrary/`), `the music leg left JT_MOUNT:\n${r.log}`)
    assert.doesNotMatch(r.log, /overrides publish/, 'the sandbox has no metadata-overrides.json, so none was found on a real share')
    assert.deepEqual(r.rsyncArgs.filter((a) => a.startsWith('/Volumes/')), [])
  })

  it('with no share at all, the mount ladder asks only the fakes and gives up', () => {
    const r = hubPass((root) => join(root, 'no-share'))
    assert.equal(r.status, 1, r.log)
    assert.match(r.log, /NAS unreachable on every path/)
    assert.ok(r.toolsAsked.includes('ping'), `the real ping answered: ${r.toolsAsked}`)
    assert.ok(r.toolsAsked.includes('smbutil'), `the real smbutil answered: ${r.toolsAsked}`)
  })
})
