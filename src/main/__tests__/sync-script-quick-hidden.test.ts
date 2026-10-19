/**
 * The NAS quick leg lists only finished, visible music files.
 *
 * 2026-10-18: the quick leg's `find -not -path './.*'` skipped hidden
 * entries only at the library ROOT, so a hidden file deeper down
 * (iPod_Control/Music/F04/.x.tagwrite-ab12.m4a) was listed and copied to
 * the NAS: writeVerified's tag-write clones and the import's .importing-
 * work files, while they were being written. The import's 0-byte Brief-170
 * reservation was listed too. Same stub harness shape as
 * sync-script-verified-push.test.ts, plus an rsync stub that keeps the
 * --files-from list.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const scriptPath = join(repoRoot, 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh')
const HUB_DIR = 'Library/Application Support/JakeTunes'
const STATE_FILES = [
  'library.json', 'metadata-overrides.json', 'playlists.json', 'play-events.jsonl', 'listening-log.jsonl',
  'live-sets.json', 'listener-profile.json', 'musicman-memory.json', 'musicman-interactions.jsonl',
  'picks-cache.json', 'audio-index.bin', 'activity-pool.json',
]

const STUB_RSYNC = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "rsync  version 3.4.2  protocol version 32"; exit 0; fi
for a in "$@"; do
  case "$a" in --files-from=*) cat "\${a#--files-from=}" >> "$STUB_LIST" ;; esac
done
exit 0
`
const STUB_OK = `#!/bin/bash
exit 0
`
const STUB_SSH = `#!/bin/bash
case "$*" in
  *python3*) echo "published 1" ;;
esac
exit 0
`
const STUB_SCUTIL = `#!/bin/bash
echo "StubMac"
`

/** Runs --quick against a library holding `files` (relative path → bytes)
 *  and returns the file list the music leg handed rsync. */
function quickList(files: Record<string, string>): { list: string[]; status: number | null; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'jt-sync-quick-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    for (const [name, body] of [['rsync', STUB_RSYNC], ['ssh', STUB_SSH], ['osascript', STUB_OK], ['scutil', STUB_SCUTIL]]) {
      writeFileSync(join(bin, name), body)
      chmodSync(join(bin, name), 0o755)
    }
    const home = join(root, 'home')
    const data = join(home, HUB_DIR)
    mkdirSync(join(data, 'artwork'), { recursive: true })
    for (const f of STATE_FILES) {
      const body = f === 'library.json' ? '{"tracks":[{"id":1}]}'
        : f === 'metadata-overrides.json' ? '{"37":{"title":"X"}}'
        : `${f}\n`
      writeFileSync(join(data, f), body)
    }
    writeFileSync(join(data, 'mobile-stars.json'), '{"trackIds":["1"]}')
    writeFileSync(join(data, 'mobile-plays.json'), '{}')
    mkdirSync(join(root, 'nas', 'JakeTunesLibrary'), { recursive: true })
    const lib = join(root, 'lib')
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(lib, rel)), { recursive: true })
      writeFileSync(join(lib, rel), body)
    }
    const listFile = join(root, 'list.txt')
    writeFileSync(listFile, '')
    const r = spawnSync('/bin/bash', [scriptPath, '--quick'], {
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        STUB_LIST: listFile,
        JT_SYNC_LOG: join(root, 'sync.log'),
        JT_SYNC_LOCK: join(root, 'sync.lock'),
        JT_HOMEMINI: 'test@stub',
        JT_LIBRARY_ROOT: lib,
        JT_MOUNT: join(root, 'nas'),
        JT_PLEX_SKIP: '1',
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
    const log = existsSync(join(root, 'sync.log')) ? readFileSync(join(root, 'sync.log'), 'utf8') : ''
    return { list: readFileSync(listFile, 'utf8').split('\n').filter(Boolean).sort(), status: r.status, log }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('sync script --quick: the NAS music leg', () => {
  it('skips hidden files at any depth and 0-byte reservations; finished files still go', () => {
    const F = 'iPod_Control/Music/F04'
    const r = quickList({
      [`${F}/imported_1.m4a`]: 'finished audio',
      [`${F}/imported_2.m4a`]: '',
      [`${F}/.imported_2.m4a.importing-ab12cd34.m4a`]: 'being encoded',
      [`${F}/.imported_2.m4a.importing-ab12cd34.m4a.faststart.m4a`]: 'being remuxed',
      [`${F}/.imported_1.m4a.tagwrite-ab12.m4a`]: 'tag-write clone',
      [`${F}/._imported_1.m4a`]: 'AppleDouble',
      [`${F}/.DS_Store`]: 'finder',
      ['.moov-repair-backup/old.m4a']: 'root hidden dir',
      ['_pending-imports/x.flac']: 'staging',
      ['Playlists/mix.m3u']: 'playlist',
    })
    assert.equal(r.status, 0, r.log)
    assert.deepEqual(r.list, ['./Playlists/mix.m3u', `./${F}/imported_1.m4a`])
  })
})
