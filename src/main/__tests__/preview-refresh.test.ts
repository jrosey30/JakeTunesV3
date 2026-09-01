/** Deezer preview refresh — pins the strict matcher: wrong preview is
 *  worse than no preview (the searchDeezerArt doctrine, applied to audio). */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { pickDeezerPreview } from '../ipc/preview-refresh-ipc.ts'

const row = (artist: string, title: string, preview = 'https://cdnt-preview.dzcdn.net/x') =>
  ({ title, preview, artist: { name: artist } })

describe('pickDeezerPreview', () => {
  test('exact artist + title wins', () => {
    assert.ok(pickDeezerPreview([row('Pavement', 'Gold Soundz')], 'Pavement', 'Gold Soundz'))
  })
  test('edition parens fold away on both sides', () => {
    assert.ok(pickDeezerPreview([row('JAY-Z', '4:44 (Explicit)')], 'Jay-Z', '4:44'))
  })
  test('wrong artist with the right title NEVER matches', () => {
    assert.equal(pickDeezerPreview([row('Some Cover Band', 'Gold Soundz')], 'Pavement', 'Gold Soundz'), null)
  })
  test('clean title prefix is accepted (single-vs-album subtitle)', () => {
    assert.ok(pickDeezerPreview([row('Pavement', 'Gold Soundz - Remastered')], 'Pavement', 'Gold Soundz'))
  })
  test('rows without a preview are skipped, later exact match still found', () => {
    const rows = [{ title: 'Gold Soundz', artist: { name: 'Pavement' } }, row('Pavement', 'Gold Soundz')]
    assert.ok(pickDeezerPreview(rows, 'Pavement', 'Gold Soundz'))
  })
  test('empty inputs match nothing', () => {
    assert.equal(pickDeezerPreview([row('X', 'Y')], '', 'Y'), null)
  })
})
