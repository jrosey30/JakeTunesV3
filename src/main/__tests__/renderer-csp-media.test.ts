/**
 * Regression: CSP media-src must allow https: so Apple/Deezer 30s
 * preview URLs can load in previewPlayer.ts (HTMLAudioElement).
 * Without it, every ▶ preview in the app fails silently.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const htmlPath = join(dirname(fileURLToPath(import.meta.url)), '../../renderer/index.html')

describe('renderer CSP media-src', () => {
  it('allows https for remote song previews', () => {
    const html = readFileSync(htmlPath, 'utf8')
    const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)
    assert.ok(m, 'CSP meta tag present')
    const csp = m![1]
    const media = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('media-src'))
    assert.ok(media, 'media-src directive present')
    assert.ok(/\shttps:(?:\s|$)/.test(` ${media} `), `media-src must include https: — got: ${media}`)
    assert.ok(/\sipod-audio:(?:\s|$)/.test(` ${media} `), 'media-src still allows ipod-audio:')
  })
})
