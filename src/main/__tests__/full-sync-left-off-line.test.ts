/**
 * Brief 266, suspect 2 (b): the full-library sync counted skipped songs in copyErrors and
 * listed them in notConverted / notReplaced, and the Device page said "Synced" over all of it.
 * fullSyncLeftOffLine is the line it now says after; DeviceView puts it beside the result.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fullSyncLeftOffLine } from '../../common/ipod-one-sync-plan.ts'

const song = (id: number, title: string) => ({ id, title, artist: 'Band' })

describe('fullSyncLeftOffLine', () => {
  it('a clean full sync says nothing more', () => {
    assert.equal(fullSyncLeftOffLine({ copyErrors: 0 }), null)
    assert.equal(fullSyncLeftOffLine({}), null)
    assert.equal(fullSyncLeftOffLine({ copyErrors: 0, notConverted: [], notReplaced: [] }), null)
  })
  it('names the songs that couldn\'t be converted', () => {
    assert.equal(
      fullSyncLeftOffLine({ copyErrors: 2, notConverted: [song(1, 'Breeze'), song(2, 'Human')] }),
      '2 songs couldn’t be converted and were left off: Breeze, Human.',
    )
    assert.equal(fullSyncLeftOffLine({ copyErrors: 1, notConverted: [song(1, 'Breeze')] }),
      '1 song couldn’t be converted and was left off: Breeze.')
  })
  it('copy failures beyond the not-converted ones are counted (the engine has no names for them)', () => {
    assert.equal(fullSyncLeftOffLine({ copyErrors: 4, notConverted: [song(1, 'Breeze')] }),
      '1 song couldn’t be converted and was left off: Breeze. 3 songs couldn’t be copied.')
    assert.equal(fullSyncLeftOffLine({ copyErrors: 1 }), '1 song couldn’t be copied.')
  })
  it('names the songs kept as they were on the iPod', () => {
    assert.equal(fullSyncLeftOffLine({ copyErrors: 0, notReplaced: [song(9, 'Human')] }),
      '1 song was already on the iPod in another form and stayed as it was: Human.')
  })
  it('many songs: the count only, the left-off line\'s rule (never "and N more")', () => {
    const many = Array.from({ length: 12 }, (_, i) => song(i, `S${i}`))
    assert.equal(fullSyncLeftOffLine({ copyErrors: 12, notConverted: many }), '12 songs couldn’t be converted and were left off.')
  })
})

describe('the Device page says it after a full-library sync', () => {
  it('runFullLibrarySync puts the line beside "Synced" (the same note the result strip shows)', async () => {
    const src = await readFile(new URL('../../renderer/views/DeviceView.tsx', import.meta.url), 'utf-8')
    const body = src.slice(src.indexOf('const runFullLibrarySync = async'), src.indexOf('const saveRename = async'))
    assert.ok(body.length > 0)
    assert.match(body, /const note = fullSyncLeftOffLine\(result\)\s*\n\s*setLeftOffNote\(note\)/)
    assert.match(body, /setLeftOffNote\(null\)\s*\n\s*setSyncing\(true\)/, 'a stale note is cleared when it starts')
    assert.match(src, /\{resultLine\(timeline\)\}\{leftOffNote \? ` \$\{leftOffNote\}` : ''\}/, 'the strip shows the note')
  })
})
