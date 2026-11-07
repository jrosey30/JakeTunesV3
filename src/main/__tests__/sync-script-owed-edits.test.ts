/**
 * The quick leg carries the audio edits no leg has carried (reviewer's finding, 2026-11-06).
 *
 * A Get Info edit rewrites the audio file's tags, often at the same size. Only the quick leg
 * can carry that: the full leg is --size-only, and hop 1 only adds. It looked back 10 minutes.
 * So once SMB went off while away, an edit made out there reached the NAS never: the away pass
 * skips the music leg, and the first pass home looked back 10 minutes. Plex reads those tags.
 *
 * The app now leaves a line for each rewrite (src/main/audio-edits-owed.ts). The first idea was
 * a stamp and `find -newer`, but in the week to 11/6, 679 files (25.3 GB) got a new mtime and
 * only 43 of them were edits: the other 23.7 GB is the same bytes, and it would all be sent again.
 *
 * Same stub harness shape as sync-script-quick-hidden.test.ts, with a world that lasts across
 * passes.
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { runSyncScript } from './sync-script-run.ts'
import { HUNG_MS } from './wait-for.ts'

const HUB_DIR = 'Library/Application Support/JakeTunes'
const STATE_FILES = ['library.json', 'playlists.json', 'play-events.jsonl']
const F = 'iPod_Control/Music/F04'
const OWED = 'audio-edits-owed.txt'

// The music leg is the call with --files-from. Everything else is homemini: answered, 0.
// STUB_DURING_LEG: a line the app writes while the leg runs.
// STUB_REAL_RSYNC: a real rsync does the leg. /usr/bin/rsync (openrsync) runs its other half
// as `rsync --server`, by name through PATH, and that name is this stub: answered 0, the client
// says "unexpected end of file" and exits 1 (run 42216467962, and on this Mac, 2026-11-06).
const STUB_RSYNC = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "rsync  version 3.4.2  protocol version 32"; exit 0; fi
for a in "$@"; do
  case "$a" in --server)
    [ -n "\${STUB_REAL_RSYNC:-}" ] && exec "$STUB_REAL_RSYNC" "$@"
    ;;
  --files-from=*)
    cat "\${a#--files-from=}" >> "$STUB_LIST"
    [ -n "\${STUB_DURING_LEG:-}" ] && printf '%s\\n' "$STUB_DURING_LEG" >> "$STUB_OWED"
    [ -n "\${STUB_REAL_RSYNC:-}" ] && exec "$STUB_REAL_RSYNC" "$@"
    exit "\${STUB_MUSIC_EXIT:-0}"
    ;;
  esac
done
exit 0
`
const STUB_OK = '#!/bin/bash\nexit 0\n'
// Home needs the NAS's address to answer.
const STUB_SSH = `#!/bin/bash
case "$*" in
  *python3*) echo "published 1" ;;
esac
exit 0
`
const STUB_SCUTIL = '#!/bin/bash\necho StubMac\n'
const STUB_ROUTE = `#!/bin/bash
echo 'interface: en0'
[ -n "\${STUB_AWAY:-}" ] && echo 'gateway: 100.64.0.1'
exit 0
`

const bin = mkdtempSync(join(tmpdir(), 'jt-sync-owed-bin-'))
for (const [name, body] of [['rsync', STUB_RSYNC], ['ssh', STUB_SSH], ['osascript', STUB_OK], ['ping', STUB_OK], ['scutil', STUB_SCUTIL], ['route', STUB_ROUTE]]) {
  writeFileSync(join(bin, name), body)
  chmodSync(join(bin, name), 0o755)
}
after(() => rmSync(bin, { recursive: true, force: true }))

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000)

interface Pass { list: string[]; status: number | null; log: string }

function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'jt-sync-owed-'))
  const home = join(root, 'home')
  const data = join(home, HUB_DIR)
  const lib = join(root, 'lib')
  const nas = join(root, 'nas', 'JakeTunesLibrary')
  mkdirSync(join(data, 'artwork'), { recursive: true })
  mkdirSync(nas, { recursive: true })
  mkdirSync(lib)
  for (const f of STATE_FILES) writeFileSync(join(data, f), f === 'library.json' ? '{"tracks":[{"id":1}]}' : `${f}\n`)
  const listFile = join(root, 'list.txt')
  const owedPath = join(data, OWED)
  const pathOf = (name: string): string => join(lib, F, name)
  return {
    root, lib, nas, data, owedPath, pathOf,
    /** A song on disk, edited hours ago: past the leg's 10 minutes. */
    song(name: string, body = 'edited out there', when = hoursAgo(3)): string {
      const p = pathOf(name)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, body)
      utimesSync(p, when, when)
      return p
    },
    /** The app's line, as noteAudioEditOwed writes it. */
    owe: (p: string): void => appendFileSync(owedPath, `${p}\n`),
    leftovers: (): string[] => readdirSync(data).filter((n) => n.startsWith(OWED)).sort(),
    pass(args: string[], env: Record<string, string> = {}): Pass {
      writeFileSync(listFile, '')
      const r = runSyncScript(args, bin, {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        STUB_LIST: listFile,
        STUB_OWED: owedPath,
        JT_SYNC_LOG: join(root, 'sync.log'),
        JT_SYNC_LOCK: join(root, 'sync.lock'),
        JT_HOMEMINI: 'test@stub',
        JT_LIBRARY_ROOT: lib,
        JT_MOUNT: join(root, 'nas'),
        JT_PLEX_SKIP: '1',
        ...env,
      })
      const log = existsSync(join(root, 'sync.log')) ? readFileSync(join(root, 'sync.log'), 'utf8') : ''
      return { list: readFileSync(listFile, 'utf8').split('\n').filter(Boolean).sort(), status: r.status, log }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

const AWAY = { STUB_AWAY: '1' }

/** Null when this rsync can run the quick leg's own flags, tried in a temp folder with no stub on
 *  its PATH. Otherwise why it can't, which is what the test skips with. */
function cannotRunTheLeg(rsync: string): string | null {
  if (!existsSync(rsync)) return `${rsync} is not on this Mac`
  const root = mkdtempSync(join(tmpdir(), 'jt-rsync-probe-'))
  try {
    const from = join(root, 'from')
    const to = join(root, 'to')
    mkdirSync(join(from, 'F04'), { recursive: true })
    mkdirSync(join(to, 'F04'), { recursive: true })
    writeFileSync(join(from, 'F04', 'a.m4a'), 'TAGS-NEW')
    writeFileSync(join(to, 'F04', 'a.m4a'), 'TAGS-OLD')
    utimesSync(join(to, 'F04', 'a.m4a'), hoursAgo(48), hoursAgo(48))
    writeFileSync(join(root, 'list'), './F04/a.m4a\n')
    const r = spawnSync(rsync, ['-rtz', '--timeout=180', `--files-from=${join(root, 'list')}`, `${from}/`, `${to}/`], {
      encoding: 'utf8',
      env: { PATH: `${dirname(rsync)}:/usr/bin:/bin` },
      timeout: HUNG_MS,
    })
    if (r.status !== 0) return `${rsync} can't run the quick leg here: exit ${r.status}, ${(r.stderr || r.error?.message || '').trim()}`
    const landed = readFileSync(join(to, 'F04', 'a.m4a'), 'utf8')
    return landed === 'TAGS-NEW' ? null : `${rsync} finished the quick leg and left the old bytes`
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const rel = (name: string): string => `./${F}/${name}`

describe('sync script --quick: the audio edits no leg has carried', () => {
  it('an edit made away, hours before the first pass home, goes on that pass', () => {
    const w = makeWorld()
    try {
      w.owe(w.song('a.m4a'))
      const away = w.pass(['--quick'], AWAY)
      assert.equal(away.status, 0, away.log)
      assert.deepEqual(away.list, [], 'no music leg while away')
      assert.deepEqual(w.leftovers(), [OWED], 'the list waits')
      const home = w.pass(['--quick'])
      assert.equal(home.status, 0, home.log)
      assert.deepEqual(home.list, [rel('a.m4a')])
      assert.match(home.log, /includes 1 audio edit\(s\) no leg had carried/)
    } finally { w.cleanup() }
  })

  it('a song nobody edited does not go, whatever its mtime: 23.7 GB of those in the week to 11/6', () => {
    const w = makeWorld()
    try {
      w.song('touched.m4a', 'same bytes, pulled back down')
      assert.deepEqual(w.pass(['--quick']).list, [])
    } finally { w.cleanup() }
  })

  it('a leg that finished clears the list: the same edit does not go twice, and nothing is left behind', () => {
    const w = makeWorld()
    try {
      w.owe(w.song('a.m4a'))
      assert.deepEqual(w.pass(['--quick']).list, [rel('a.m4a')])
      assert.deepEqual(w.leftovers(), [])
      assert.deepEqual(w.pass(['--quick']).list, [])
    } finally { w.cleanup() }
  })

  for (const code of ['23', '24', '30', '142']) {
    it(`a leg that ended ${code} carried nothing for sure: the next one takes the list again`, () => {
      const w = makeWorld()
      try {
        w.owe(w.song('a.m4a'))
        assert.deepEqual(w.pass(['--quick'], { STUB_MUSIC_EXIT: code }).list, [rel('a.m4a')])
        assert.deepEqual(w.pass(['--quick']).list, [rel('a.m4a')])
        assert.deepEqual(w.leftovers(), [])
      } finally { w.cleanup() }
    })
  }

  it('a line the app writes during the leg survives that leg, and goes on the next', () => {
    const w = makeWorld()
    try {
      w.owe(w.song('a.m4a'))
      const b = w.song('b.m4a')
      assert.deepEqual(w.pass(['--quick'], { STUB_DURING_LEG: b }).list, [rel('a.m4a')])
      assert.deepEqual(w.pass(['--quick']).list, [rel('b.m4a')])
      assert.deepEqual(w.leftovers(), [])
    } finally { w.cleanup() }
  })

  it('a list a killed run left aside goes on the next run', () => {
    const w = makeWorld()
    try {
      writeFileSync(`${w.owedPath}.taken.999.1`, `${w.song('a.m4a')}\n`)
      w.owe(w.song('b.m4a'))
      assert.deepEqual(w.pass(['--quick']).list, [rel('a.m4a'), rel('b.m4a')])
      assert.deepEqual(w.leftovers(), [])
    } finally { w.cleanup() }
  })

  it('a bulk edit moves forward leg by leg instead of sending the same files every pass', () => {
    const w = makeWorld()
    try {
      const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `${n}.m4a`)
      for (const n of names) w.owe(w.song(n))
      const seen: string[] = []
      for (const size of [2, 2, 1]) {
        const { list } = w.pass(['--quick'], { JT_OWED_PER_LEG: '2' })
        assert.equal(list.length, size, list.join(' '))
        seen.push(...list)
      }
      assert.deepEqual(seen.sort(), names.map(rel), 'each exactly once')
      assert.deepEqual(w.leftovers(), [])
    } finally { w.cleanup() }
  })

  it('…and a cut leg keeps what it did not fit, too', () => {
    const w = makeWorld()
    try {
      const names = ['a', 'b', 'c'].map((n) => `${n}.m4a`)
      for (const n of names) w.owe(w.song(n))
      assert.equal(w.pass(['--quick'], { JT_OWED_PER_LEG: '2', STUB_MUSIC_EXIT: '142' }).list.length, 2)
      assert.deepEqual(w.pass(['--quick']).list, names.map(rel))
    } finally { w.cleanup() }
  })

  it('a file gone, a link, an empty file, a hidden name or a path outside the library: nothing to carry', () => {
    const w = makeWorld()
    try {
      const real = w.song('real.m4a')
      w.owe(w.pathOf('gone.m4a'))
      const link = w.pathOf('streamed.m4a')
      symlinkSync(real, link)
      w.owe(link)
      w.owe(w.song('empty.m4a', ''))
      w.owe(w.song('.real.m4a.tagwrite-ab12.m4a'))
      w.owe('/somewhere/else/x.m4a')
      w.owe(real)
      assert.deepEqual(w.pass(['--quick']).list, [rel('real.m4a')])
      assert.deepEqual(w.leftovers(), [])
    } finally { w.cleanup() }
  })

  it('the same file listed twice, and inside the 10 minutes as well, goes once', () => {
    const w = makeWorld()
    try {
      const a = w.song('a.m4a', 'edited just now', new Date())
      w.owe(a)
      w.owe(a)
      assert.deepEqual(w.pass(['--quick']).list, [rel('a.m4a')])
    } finally { w.cleanup() }
  })

  it('the full leg, and a pass with no music leg, leave the list alone', () => {
    const w = makeWorld()
    try {
      w.owe(w.song('a.m4a'))
      assert.equal(w.pass([]).status, 0)
      w.pass(['--quick', '--homemini-only'])
      assert.deepEqual(w.leftovers(), [OWED])
      assert.deepEqual(w.pass(['--quick']).list, [rel('a.m4a')])
    } finally { w.cleanup() }
  })

  it('no library to read proves nothing: the list stays', () => {
    const w = makeWorld()
    try {
      w.owe(w.song('a.m4a'))
      const r = w.pass(['--quick'], { JT_LIBRARY_ROOT: join(w.root, 'not-there') })
      assert.equal(r.status, 0, r.log)
      assert.deepEqual(w.leftovers(), [OWED])
    } finally { w.cleanup() }
  })

  it('a replica has no music leg: its list is cleared, not left to grow', () => {
    const w = makeWorld()
    try {
      w.owe(w.song('a.m4a'))
      assert.equal(w.pass(['--quick', '--skip-library-json']).status, 0)
      assert.deepEqual(w.leftovers(), [])
    } finally { w.cleanup() }
  })

  // Each refusal is a notification, and on macOS 26 a notification opens Script Editor.
  it('a file the NAS keeps refusing is given up on, with a line in the log, not notified about for ever', () => {
    const w = makeWorld()
    try {
      w.owe(w.song('a.m4a'))
      const env = { JT_OWED_MAX_REFUSALS: '3', STUB_MUSIC_EXIT: '23' }
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(w.pass(['--quick'], env).list, [rel('a.m4a')])
        assert.doesNotMatch(readFileSync(join(w.root, 'sync.log'), 'utf8'), /gave up on/)
      }
      assert.deepEqual(w.pass(['--quick'], env).list, [rel('a.m4a')])
      assert.match(readFileSync(join(w.root, 'sync.log'), 'utf8'), /gave up on 1 audio edit\(s\) the NAS refused 3 legs in a row/)
      assert.deepEqual(w.pass(['--quick'], env).list, [])
      assert.deepEqual(w.leftovers(), [])
    } finally { w.cleanup() }
  })

  it('…a leg that was cut proves nothing about the file, so it does not count', () => {
    const w = makeWorld()
    try {
      w.owe(w.song('a.m4a'))
      for (let i = 0; i < 4; i++) w.pass(['--quick'], { JT_OWED_MAX_REFUSALS: '3', STUB_MUSIC_EXIT: '142' })
      assert.deepEqual(w.pass(['--quick']).list, [rel('a.m4a')])
    } finally { w.cleanup() }
  })

  it('…and a leg that finished starts the count again', () => {
    const w = makeWorld()
    try {
      const env = { JT_OWED_MAX_REFUSALS: '2', STUB_MUSIC_EXIT: '23' }
      w.owe(w.song('a.m4a'))
      w.pass(['--quick'], env)
      assert.equal(w.pass(['--quick']).status, 0)
      w.owe(w.song('b.m4a'))
      w.pass(['--quick'], env)
      assert.doesNotMatch(readFileSync(join(w.root, 'sync.log'), 'utf8'), /gave up on/)
    } finally { w.cleanup() }
  })

  // Same size, other bytes, through a real rsync: what the --size-only full leg can't see. Each
  // rsync here, because the app's PATH picks one: this Mac's quick legs ran on /usr/bin/rsync from
  // 10/9 to 10/11 (177 with files finished, 2,892 files, real log) and on Homebrew's since, and a
  // CI runner has only /usr/bin/rsync.
  for (const real of ['/opt/homebrew/bin/rsync', '/usr/bin/rsync']) {
    it(`a same-size re-tag made away lands on the NAS copy, through a real rsync (${real})`, { skip: cannotRunTheLeg(real) ?? false }, () => {
      const w = makeWorld()
      try {
        w.owe(w.song('a.m4a', 'TAGS-NEW'))
        const onNas = join(w.nas, F, 'a.m4a')
        mkdirSync(dirname(onNas), { recursive: true })
        writeFileSync(onNas, 'TAGS-OLD')
        utimesSync(onNas, hoursAgo(48), hoursAgo(48))
        w.pass(['--quick'], AWAY)
        assert.equal(readFileSync(onNas, 'utf8'), 'TAGS-OLD', 'nothing touches the NAS while away')
        const home = w.pass(['--quick'], { STUB_REAL_RSYNC: real })
        assert.equal(home.status, 0, home.log)
        assert.equal(readFileSync(onNas, 'utf8'), 'TAGS-NEW')
        assert.deepEqual(w.leftovers(), [])
      } finally { w.cleanup() }
    })
  }
})
