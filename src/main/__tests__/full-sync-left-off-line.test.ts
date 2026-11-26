/**
 * Brief 266, suspect 2 (b): the full-library sync counted skipped songs in copyErrors and
 * listed them in notConverted / notReplaced, and the Device page said "Synced" over all of it.
 * fullSyncLeftOffLine is the line it now says after; DeviceView puts it beside the result.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fullSyncLeftOffLine } from '../../common/ipod-one-sync-plan.ts'
import { keptCardCopy } from '../ipod-card-kept-copy.ts'

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

describe('the full-library sync: a song already on the card whose new copy can\'t be made (Brief 266)', () => {
  it('fullSyncLeftOffLine names it as not updated, kept on the iPod', () => {
    assert.equal(fullSyncLeftOffLine({ copyErrors: 0, notUpdated: [song(3, 'Breeze')] }),
      '1 song couldn’t be updated and kept its old copy on the iPod: Breeze.')
  })

  it('keptCardCopy finds the card\'s copy at its path, or at the .m4a an earlier conversion wrote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b266-kept-'))
    try {
      const at = join(root, 'A.m4a')
      assert.equal(await keptCardCopy(at, '/lib/A.m4a'), null, 'nothing on the card: nothing kept')
      await writeFile(at, Buffer.alloc(10, 1))
      assert.deepEqual(await keptCardCopy(at, '/lib/A.m4a'), { abs: at, size: 10 })
      const flacDest = join(root, 'B.flac')
      await writeFile(join(root, 'B.m4a'), Buffer.alloc(7, 1))
      assert.deepEqual(await keptCardCopy(flacDest, '/lib/B.flac'), { abs: join(root, 'B.m4a'), size: 7 })
      await writeFile(join(root, 'C.m4a'), Buffer.alloc(0))
      assert.equal(await keptCardCopy(join(root, 'C.m4a'), '/lib/C.m4a'), null, 'an empty file is not a copy')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the copy step keeps it (its file, its row) instead of listing it as not converted', async () => {
    const src = await readFile(new URL('../sync-engine/index.ts', import.meta.url), 'utf-8')
    const at = src.indexOf('if (isAacEncoderMissing(err) || isAacConvertFailed(err)) {')
    assert.ok(at > 0)
    const branch = src.slice(at, src.indexOf('notConverted.push(', at))
    assert.match(branch, /const onCard = await keptCardCopy\(ipod, local\)\s*\n\s*if \(onCard\) \{/)
    assert.match(branch, /writtenById\.set\(trackId, \{ srcPath: onCard\.abs, dstPath: onCard\.abs, expectedSize: onCard\.size \}\)/)
    assert.match(branch, /notUpdated\.push\(/)
    assert.match(branch, /continue\s*\n\s*\}/)
    assert.match(src, /\.\.\.\(notUpdated\.length > 0 \? \{ notUpdated \} : \{\}\)/)
  })

  it('the verify checks the card\'s own copy when the new one can\'t be made, so the song list keeps it', async () => {
    const src = await readFile(new URL('../sync-engine/index.ts', import.meta.url), 'utf-8')
    const at = src.indexOf('let dstForVerify = join(IPOD_MOUNT, relPath)')
    assert.ok(at > 0)
    const body = src.slice(at, at + 1200)
    assert.match(body, /\} catch \(err\) \{[\s\S]{0,300}const onCard = await keptCardCopy\(dstForVerify, libraryFile\)\s*\n\s*if \(!onCard\) throw err\s*\n\s*srcForVerify = onCard\.abs\s*\n\s*dstForVerify = onCard\.abs/)
    assert.match(body, /dstPath: dstForVerify,/)
  })
})
