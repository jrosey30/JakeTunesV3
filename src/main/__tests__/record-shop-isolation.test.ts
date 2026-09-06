// Rails: the fixture set and the live command bus never meet.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shopFixtureSession } from '../../common/record-shop-fixtures.ts'
import { isFixtureId } from '../../common/record-shop-live.ts'

const SRC = join(import.meta.dirname, '../..')
const src = (p: string): string => readFileSync(join(SRC, p), 'utf-8')

describe('Record Shop: fixtures stay isolated from live commands', () => {
  it('every fixture id is recognisable as a fixture', () => {
    const s = shopFixtureSession()
    for (const i of s.items) assert.ok(isFixtureId(i.itemId), i.itemId)
    for (const j of Object.values(s.jobs)) assert.ok(isFixtureId(j.jobId), j.jobId)
  })
  it('the live modules never import the fixtures; the fixtures never import the live modules', () => {
    for (const p of ['renderer/record-shop/liveShopCommands.ts', 'renderer/record-shop/useShopSession.ts', 'common/record-shop-live.ts', 'main/record-shop-resolve.ts', 'main/ipc/record-shop-ipc.ts']) {
      assert.doesNotMatch(src(p), /record-shop-fixtures/, `${p} must not import the fixtures`)
    }
    assert.doesNotMatch(src('common/record-shop-fixtures.ts'), /record-shop-live|liveShopCommands|downloadQueue|electronAPI/)
  })
  it('the live bus refuses fixture ids on every verb', () => {
    const s = src('renderer/record-shop/liveShopCommands.ts')
    const verbs = ['saveItem', 'inspectSelection', 'previewItem', 'playOwned', 'getSelection', 'cancelJob', 'retryJob', 'chooseEdition']
    for (const v of verbs) assert.match(s, new RegExp(`${v}\\([^)]*\\) \\{\\s*\\n\\s*if \\(!guard\\('${v}'`), `${v} must guard first`)
  })
  it('the room runs live by default; the recording bus and the fixture set appear only behind the review flag', () => {
    const s = src('renderer/views/RecordStore/RecordStoreView.tsx')
    assert.match(s, /fixtureMode\s*\?\s*shopFixtureSession\(\)\s*:\s*null/)
    assert.match(s, /fixtureMode\s*\n?\s*\?\s*recordingShopCommands\(/)
    assert.match(s, /shopFixtures/)
    assert.doesNotMatch(s, /useMemo\(\(\) => shopFixtureSession\(\), \[\]\)/)
  })
})
