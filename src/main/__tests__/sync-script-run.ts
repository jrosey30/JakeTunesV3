/**
 * Runs jaketunes-homemini-sync.sh in a test, with this Mac's mount tools faked.
 *
 * JT_MOUNT alone does not keep a run in its sandbox: the script asks `mount` where
 * JakeShared is, and a live mount beats JT_MOUNT (2026-08-07, so a suffix-drifted mount
 * is still found). So on a Mac with the real share mounted, a test's run used the real
 * NAS. It took every state file its sandbox lacks from there, parsing the real
 * metadata-overrides.json (7 MB, 18 to 34 s over the tailnet), and on a tailnet mount it
 * looked for the NAS on the LAN (7 s when it isn't there). Away from home that passed
 * spawnSync's limit and failed the pre-commit gate (2026-11-05). At home on a tailnet
 * mount with nothing open, the same run would have unmounted the real share.
 *
 * JT_MOUNT_TOOLS_FROM_PATH=1 makes the script look for those tools on PATH, and here
 * they all say no: nothing is mounted, no host answers, the route can't be read, which the
 * script takes as not away. The real route says away on a trip, and the music leg never ran
 * (2026-11-06). A tool already in `bin` wins, so a harness keeps its own recording osascript.
 */
import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HUNG_MS } from './wait-for.ts'

const scriptPath = join(import.meta.dirname, '..', '..', '..', 'Dr. Claude', 'scripts', 'jaketunes-homemini-sync.sh')
const MOUNT_TOOLS = ['mount', 'ping', 'smbutil', 'lsof', 'diskutil', 'osascript', 'route']

const FAKE = `#!/bin/bash
echo "\${0##*/}" >> "$STUB_TOOLS_ASKED"
exit 1
`

// One file per test process, linked under each name: a new executable's first run costs
// about 50 times a later one (macOS checks it), and a link to one that has run does not.
let fakeDir: string | undefined
function fakeTool(): string {
  if (!fakeDir) {
    const dir = mkdtempSync(join(tmpdir(), 'jt-sync-fake-'))
    fakeDir = dir
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'tool'), FAKE, { mode: 0o755 })
  }
  return join(fakeDir, 'tool')
}

/**
 * `bin` must come first on `env.PATH`. `toolsAsked` names each fake the run called. It
 * must include `mount`, which every run asks at the top of the script: a run that never
 * asked the fake read the real mount table.
 */
export function runSyncScript(
  args: string[],
  bin: string,
  env: Record<string, string>,
): SpawnSyncReturns<string> & { toolsAsked: string[] } {
  for (const tool of MOUNT_TOOLS) {
    if (!existsSync(join(bin, tool))) symlinkSync(fakeTool(), join(bin, tool))
  }
  const asked = join(bin, '.tools-asked')
  const r = spawnSync('/bin/bash', [scriptPath, ...args], {
    env: { ...env, JT_MOUNT_TOOLS_FROM_PATH: '1', STUB_TOOLS_ASKED: asked },
    encoding: 'utf8',
    timeout: HUNG_MS,
  })
  const toolsAsked = existsSync(asked) ? readFileSync(asked, 'utf8').split('\n').filter(Boolean) : []
  assert.ok(toolsAsked.includes('mount'), 'the run never asked the fake mount, so it read this Mac\'s real mount table')
  return { ...r, toolsAsked }
}
