import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newestProfile, profileChips, detachChangedProfile } from '../../common/activity-profiles.ts'

const p = (id: string, profileName: string, updatedAt: string) => ({ id, profileName, updatedAt })

describe('Activity sheet starts from the newest saved profile', () => {
  it('picks the newest updatedAt, not the file order', () => {
    const list = [p('a', 'Run · Brooklyn', '2026-10-01T10:00:00Z'), p('b', 'Ski · Vail', '2026-10-15T10:00:00Z'), p('c', 'Walk · SF', '2026-09-01T10:00:00Z')]
    assert.equal(newestProfile(list)?.id, 'b')
  })
  it('no profiles (or only junk rows) → null, so the sheet keeps the default', () => {
    assert.equal(newestProfile([]), null)
    assert.equal(newestProfile([{ profileName: 'x' } as never]), null)
  })
  it('a row with no/garbled updatedAt never beats a dated one', () => {
    const list = [{ id: 'x', profileName: 'Old' }, p('y', 'New', '2026-10-01T00:00:00Z')]
    assert.equal(newestProfile(list)?.id, 'y')
  })
})

describe('Saved chips: one per name, newest first', () => {
  it('dedupes duplicate names (every sync used to save a fresh copy)', () => {
    const list = [
      p('1', 'Run · Brooklyn', '2026-10-01T00:00:00Z'),
      p('2', 'Run · Brooklyn', '2026-10-10T00:00:00Z'),
      p('3', 'run · brooklyn ', '2026-09-01T00:00:00Z'),
      p('4', 'Ski · Vail', '2026-10-05T00:00:00Z'),
    ]
    const chips = profileChips(list)
    assert.deepEqual(chips.map((c) => c.id), ['2', '4'])
  })
  it('caps at the limit after deduping', () => {
    const list = Array.from({ length: 10 }, (_, i) => p(String(i), `Name ${i}`, `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`))
    assert.equal(profileChips(list, 6).length, 6)
    assert.equal(profileChips(list, 6)[0].id, '9')
  })
})

describe('A profile-sourced brief keeps its id only while it still IS that profile', () => {
  const source = { id: 'ap-1', activity: 'run', place: 'Brooklyn' }
  const fromProfile = { id: 'ap-1', profileName: 'Run · Brooklyn', activity: 'run', place: 'Brooklyn', intensity: 'hard' }
  it('unchanged activity + place → id and name kept (main updates that profile in place)', () => {
    assert.deepEqual(detachChangedProfile(fromProfile, source), fromProfile)
  })
  it('intensity / size changes keep the link — the name does not describe them', () => {
    const r = detachChangedProfile({ ...fromProfile, intensity: 'easy' }, source)
    assert.equal(r.id, 'ap-1')
  })
  it('activity changed → id AND name dropped, so main files a new profile under the right name', () => {
    const r = detachChangedProfile({ ...fromProfile, activity: 'bike' }, source)
    assert.equal(r.id, undefined)
    assert.equal(r.profileName, undefined)
    assert.equal(r.activity, 'bike')
    assert.equal((r as { intensity?: string }).intensity, 'hard')
  })
  it('place changed → detached too (the name is "activity · place")', () => {
    const r = detachChangedProfile({ ...fromProfile, place: 'Manhattan' }, source)
    assert.equal(r.id, undefined)
  })
  it('place whitespace/case alone is not a change', () => {
    assert.equal(detachChangedProfile({ ...fromProfile, place: ' brooklyn ' }, source).id, 'ap-1')
  })
  it('changing back before confirming keeps the link', () => {
    assert.equal(detachChangedProfile({ ...fromProfile, activity: 'run' }, source).id, 'ap-1')
  })
  it('an id with no known source is detached — never overwrite a profile of unknown provenance', () => {
    assert.equal(detachChangedProfile(fromProfile, null).id, undefined)
  })
  it('a brief that never came from a profile passes through untouched', () => {
    const b = { activity: 'run', place: 'Brooklyn' }
    assert.equal(detachChangedProfile(b, null), b)
  })
})

describe('wired into the Activity sheet', () => {
  const sheet = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'components', 'ActivitySheet.tsx'), 'utf8')
  it('starts from the newest profile, chips are deduped, confirm detaches a changed profile', () => {
    assert.match(sheet, /newestProfile\(list\)/)
    assert.match(sheet, /profileChips\(profiles\)\.map/)
    assert.match(sheet, /onConfirm\(detachChangedProfile\(/)
  })
  it('Return builds, Escape cancels — and the review sheet gets no Return key', () => {
    assert.match(sheet, /e\.key === 'Escape'/)
    assert.match(sheet, /e\.key !== 'Enter'/)
    const review = readFileSync(join(import.meta.dirname, '..', '..', 'renderer', 'components', 'SyncReviewSheet.tsx'), 'utf8')
    assert.doesNotMatch(review, /'Enter'/)
  })
})
