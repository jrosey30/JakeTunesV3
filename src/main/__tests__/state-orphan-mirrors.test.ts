import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HUB_ROUTED_MIRRORS, assertNoMirrorNasPush } from '../phone-mirrors.ts'

// 2026-10-28: the mirror rewrote mobile-stars.json / mobile-plays.json a
// couple of minutes after homemini wrote the NAS copy, so the orphan check
// (detectStateConflicts, mtime-wins) warned "ORPHANED LOCAL EDITS" every 10
// minutes over byte-identical files, and auto-backup pushed the mirror back.
const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8')

function listBlock(decl: string): string {
  const start = src.indexOf(decl)
  const end = src.indexOf(']', start)
  assert.ok(start > 0 && end > start, `${decl} block not found`)
  return src.slice(start, end).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

describe('hub-routed mirrors never ride the NAS push / orphan check', () => {
  it('assertNoMirrorNasPush throws on either mirror and passes desktop-owned files', () => {
    for (const f of HUB_ROUTED_MIRRORS) assert.throws(() => assertNoMirrorNasPush(['library.json', f], 'X'), /must not push/)
    assert.doesNotThrow(() => assertNoMirrorNasPush(['library.json', 'lyrics.json', 'playlists.json'], 'X'))
  })
  it('STATE_FILE_NAMES lists neither mirror and is fenced at boot', () => {
    const block = listBlock('const STATE_FILE_NAMES = [')
    for (const f of HUB_ROUTED_MIRRORS) assert.equal(block.includes(`'${f}'`), false, `${f} is back in STATE_FILE_NAMES`)
    assert.ok(src.includes("assertNoMirrorNasPush(STATE_FILE_NAMES, 'STATE_FILE_NAMES')"), 'boot fence missing')
  })
  it('the phone mirror still pulls both files (only the push side is gone)', () => {
    const block = listBlock('const PHONE_AUTHORED_FILES = [')
    for (const f of HUB_ROUTED_MIRRORS) assert.ok(block.includes(`'${f}'`), `${f} dropped from PHONE_AUTHORED_FILES`)
  })
})
