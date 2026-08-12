/**
 * remountVolume must not force-unmount during sync verify by default.
 * Jake: remount-every-song went 489 → 33 because force discarded dirty writes.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const platformSrc = readFileSync(join(here, '../platform.ts'), 'utf-8')

describe('remountVolume — no force-unmount by default', () => {
  test('allowForce is opt-in', () => {
    assert.match(platformSrc, /allowForce\?: boolean/)
    assert.match(platformSrc, /const allowForce = opts\.allowForce === true/)
  })

  test('force unmount is gated behind allowForce', () => {
    assert.match(
      platformSrc,
      /if \(allowForce\) unmountAttempts\.push\(\['unmount', 'force', node\]\)/,
    )
  })

  test('documents the 500→33 thrash', () => {
    assert.match(platformSrc, /500 → 33/)
  })
})
