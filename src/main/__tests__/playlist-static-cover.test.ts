/**
 * Built-in playlist covers render square (2026-10-20).
 *
 * The header's "text block takes the remaining width" rule
 * (.playlist-view-header > div { flex: 1 }) also caught the static cover —
 * a <div>, unlike the choose-a-cover <button> — and stretched it to ~450x220,
 * cropping "BEST OF" and "Listen" off Best of 2026 / Listen More Weekly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'styles', 'musicman.css'), 'utf-8')

test('the header stretch rule never applies to a playlist cover', () => {
  const rules = [...css.matchAll(/^\.playlist-view-header > div([^{]*)\{([^}]*)\}/gm)]
  assert.ok(rules.length > 0)
  for (const [, sel, body] of rules) {
    if (/flex:\s*1/.test(body)) assert.match(sel, /:not\(\.playlist-view-cover\)/, `stretch rule must exclude the cover: ${sel}`)
  }
})

test('the cover is a fixed square', () => {
  const block = css.match(/^\.playlist-view-cover \{([^}]*)\}/m)?.[1] ?? ''
  assert.match(block, /width: 220px;/)
  assert.match(block, /height: 220px;/)
})
