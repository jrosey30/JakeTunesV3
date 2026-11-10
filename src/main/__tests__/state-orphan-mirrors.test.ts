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

// 2026-11-09: auto-backup looked, warned "ORPHANED LOCAL EDITS ... Use Settings",
// and then pushed the file itself seconds later: 1,812 warnings in main.log for
// edits that were never stuck (metadata-overrides.json, 20:39:36 local, was on
// the NAS byte-identical within minutes). The look before the push is quiet;
// the look after it warns, so the line now means a file is STILL ahead.
describe('ORPHANED LOCAL EDITS means still ahead after auto-backup tried', () => {
  const fn = (() => {
    const start = src.indexOf('async function autoBackupStateToNas(')
    const end = src.indexOf('\n}\n', start)
    assert.ok(start > 0 && end > start, 'autoBackupStateToNas not found')
    return src.slice(start, end)
  })()
  it('the look before the push does not warn, the look after it does', () => {
    const looks = [...fn.matchAll(/await detectStateConflicts\(([^)]*)\)/g)].map((m) => m[1])
    assert.deepEqual(looks, ['false', ''], 'auto-backup looks twice: quietly before the push, aloud after it')
    assert.ok(fn.indexOf('detectStateConflicts(false)') < fn.indexOf('atomicPublishToNas('), 'the quiet look comes before the push')
    assert.ok(fn.lastIndexOf('detectStateConflicts()') > fn.indexOf('atomicPublishToNas('), 'the warning look comes after the push')
  })
  it('the warning is gated on the caller asking for it, and defaults to on', () => {
    assert.ok(src.includes('async function detectStateConflicts(announce = true)'), 'manual reconcile and the after-push look still warn')
    assert.ok(src.includes('if (announce && orphanKey !== lastOrphanWarnKey)'), 'a quiet look must not warn or use up the warn-once key')
  })
})
