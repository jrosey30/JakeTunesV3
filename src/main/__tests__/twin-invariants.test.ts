// Cross-platform twin invariants. These are the runtime asserts of
// the rule encoded in CLAUDE.md: "Schema version must equal on both
// sides; bump in lockstep." If someone changes ONE side without the
// other, this test fails before any build hits a real device.
//
// Citation: docs/postmortems/2026-04-26-ipod-songcount-counter.md —
// the 0x64 mediaKind incident demonstrated what happens when a
// producer and consumer get out of sync on a wire field. These
// invariants make that class of bug a CI-time failure rather than a
// runtime data-loss.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { LIBRARY_SNAPSHOT_VERSION as DESKTOP_SNAPSHOT_VERSION } from '../library-snapshot.ts'
import { OVERRIDES_QUEUE_VERSION as DESKTOP_OVERRIDES_VERSION } from '../library-overrides.ts'
import {
  LIBRARY_SNAPSHOT_VERSION as MOBILE_SNAPSHOT_VERSION,
  OVERRIDES_QUEUE_VERSION as MOBILE_OVERRIDES_VERSION,
} from '../../../mobile/src/types.ts'

describe('twin invariants — schema versions', () => {
  test('LIBRARY_SNAPSHOT_VERSION matches across desktop and mobile', () => {
    assert.equal(
      DESKTOP_SNAPSHOT_VERSION,
      MOBILE_SNAPSHOT_VERSION,
      `desktop=${DESKTOP_SNAPSHOT_VERSION} mobile=${MOBILE_SNAPSHOT_VERSION} — bump together`,
    )
  })

  test('OVERRIDES_QUEUE_VERSION matches across desktop and mobile', () => {
    assert.equal(
      DESKTOP_OVERRIDES_VERSION,
      MOBILE_OVERRIDES_VERSION,
      `desktop=${DESKTOP_OVERRIDES_VERSION} mobile=${MOBILE_OVERRIDES_VERSION} — bump together`,
    )
  })
})
