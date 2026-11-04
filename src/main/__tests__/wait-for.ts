/**
 * Wait for something real to happen (a file landing, a detached write) without
 * guessing how fast the Mac is. `npm run check` runs during install builds and phone
 * builds, and short limits failed clean code there: 8 s and 15 s around the install
 * gate, 30 ms around a spool landing (load 50+, 2026-11-03 and 2026-11-04).
 *
 * A fixed sleep is fine only before checking that something did NOT happen: being
 * slow cannot fail that. Never assert how long real work took.
 */
import assert from 'node:assert/strict'

/**
 * When a wait means stuck, not slow. It stops a stuck test holding up the suite and
 * times nothing, so it sits far past how slow a busy Mac gets. Under the runner's
 * 300 s (`--test-timeout` in `npm test`, which caps each test and each whole file), so
 * the failure names what never came.
 */
export const HUNG_MS = 100_000

/** Polls `cond` until it gives something truthy, and returns that. */
export async function waitFor<T>(cond: () => T | Promise<T>, what: string, hungMs = HUNG_MS): Promise<NonNullable<T>> {
  const until = Date.now() + hungMs
  for (;;) {
    const got = await cond()
    if (got) return got
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
