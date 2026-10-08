/**
 * Eject failure messaging (2026-08-25). Jake saw "Notice — Eject failed: Eject
 * failed" and asked "what the fuck????". Two defects stacked: the handler
 * returned the literal string "Eject failed" which the UI then prefixed with
 * "Eject failed:", and — worse — diskutil's actual words (the only useful part:
 * WHICH process is holding the disk) were discarded by a bare catch.
 *
 * These pin the phrasing rules so the pair cannot drift back together.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', '..')

describe('eject failure never says its own name twice', () => {
  test('the ipc handler does not return the constant the UI prefixes', () => {
    const src = readFileSync(join(SRC, 'main/ipc/ipod-ipc.ts'), 'utf-8')
    assert.ok(!/error:\s*'Eject failed'/.test(src),
      "ipod-ipc must pass diskutil's cause through, not a constant the UI re-prefixes")
  })

  test('the UI does not prefix with the same words the handler may send', () => {
    const src = readFileSync(join(SRC, 'renderer/components/sidebar/Sidebar.tsx'), 'utf-8')
    assert.ok(!/`Eject failed: \$\{r\.error/.test(src),
      'Sidebar must not build "Eject failed: <error>" — that produced the doubled notice')
  })

  test('platform surfaces WHY, and stays path-free for safeIpcError', () => {
    const src = readFileSync(join(SRC, 'main/platform.ts'), 'utf-8')
    assert.ok(/in use by process/.test(src), 'must recognise the in-use case')
    assert.ok(/dissent/i.test(src), 'must recognise a dissenting app')
    // A message carrying a /Volumes/... path would be scrubbed to a generic code.
    assert.ok(!/throw new Error\(`[^`]*\$\{mountPoint\}/.test(src),
      'the thrown message must not embed the mount path')
  })
})
