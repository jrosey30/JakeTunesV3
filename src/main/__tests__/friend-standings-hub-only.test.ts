/**
 * Friends / LTL standings read the same on both Macs (2026-10-20).
 *
 * Both Macs ran the friend-import sweep every 5 minutes, so workmini (a
 * replica whose library arrives from the hub) minted its OWN credit records
 * and its board drifted from the MacBook's. Lock: only the hub sweeps, and
 * the deploy ships the hub's friend-credits.json beside friends.json.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '..')
const index = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf-8')
const deploy = readFileSync(join(root, 'Dr. Claude', 'scripts', 'jaketunes-workmini-deploy.sh'), 'utf-8')

test('only the hub credits friend imports', () => {
  assert.match(index, /const sweepFriendImports = async \(\): Promise<number> => \(\(await isHomeminiPlaybackClientCached\(\)\) \? 0 : moduleSweepFriendImports\(sweepDeps\)\)/)
  assert.equal((index.match(/moduleSweepFriendImports\(/g) ?? []).length, 1, 'no ungated call')
})

test("workmini gets the hub's credits with the friends ledger", () => {
  const sidecars = deploy.match(/^SIDECARS=\(([^)]*)\)/m)?.[1].split(/\s+/) ?? []
  assert.ok(sidecars.includes('friends.json') && sidecars.includes('friend-credits.json'))
})
