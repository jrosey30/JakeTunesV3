import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shopFixtureSession } from '../../common/record-shop-fixtures.ts'
import { draftShopJob, retryShopJob } from '../../common/record-shop.ts'
import { shopActions, recordingShopCommands, ownershipLabel, editionLabel, jobLabel } from '../../common/record-shop-commands.ts'

// The fixture set every presentation renders; the verbs every presentation
// offers. Same inputs → same answers, whatever the room looks like.
describe('the Record Shop fixtures and command vocabulary', () => {
  const s = shopFixtureSession()
  const item = (id: string) => s.items.find((i) => i.itemId === id)!
  const actions = (id: string) => shopActions(item(id), s.ownership[id], s.jobs[id], s.entries.some((e) => e.item.itemId === id))

  it('covers the regression set and is frozen', () => {
    assert.equal(s.items.length, 13)
    assert.deepEqual(s.items.map((i) => i.kind).sort(), ['artist', 'concert', 'recording', 'recording', 'recording', 'release', 'release', 'release', 'release', 'release', 'release', 'release', 'release'])
    assert.throws(() => { (s.items[0] as { itemId: string }).itemId = 'x' })
    assert.throws(() => { (s.jobs['fx:lc-deluxe'] as { status: string }).status = 'x' })
  })

  it('edition details, ownership and results read the same in every presentation', () => {
    assert.equal(editionLabel(item('fx:xtc-bonus')), 'bonus · 15 tracks · 1979')
    assert.equal(editionLabel(item('fx:lc-standard')), 'standard · 9 tracks · 1985')
    assert.equal(editionLabel(item('fx:xtc-plain')), 'No edition selected yet')
    assert.equal(editionLabel(item('fx:5-years-time')), 'Peaceful, the World Lays Me Down · 3:37 · 2008')
    assert.equal(editionLabel(item('fx:artist-th')), null)
    assert.equal(ownershipLabel(s.ownership['fx:xtc-bonus']), 'All 15 in your library')
    // one coherent state per card: the completed import is complete; the pre-import one is partial with no job
    assert.equal(ownershipLabel(s.ownership['fx:lc-deluxe']), 'All 12 in your library')
    assert.equal(ownershipLabel(s.ownership['fx:ril-deluxe']), '8 of 12 in your library')
    assert.equal(s.jobs['fx:ril-deluxe'], undefined)
    assert.equal(ownershipLabel(s.ownership['fx:lc-live']), 'None of 9 in your library')
    assert.equal(ownershipLabel(s.ownership['fx:xtc-plain']), 'Ownership unknown')
    assert.equal(jobLabel(s.jobs['fx:lc-deluxe']), '12 tracks · 10 imported, 2 already in your library')
    assert.equal(jobLabel(s.jobs['fx:xtc-bonus']), '15 tracks · 0 imported, 15 already in your library')
    assert.equal(jobLabel(s.jobs['fx:lc-live']), 'Exact edition not found')
    assert.equal(jobLabel(s.jobs['fx:joy-again-piano']), 'Album import incomplete')
    assert.equal(jobLabel(s.jobs['fx:king']), 'Getting…')
    assert.equal(s.jobs['fx:lc-live'].result?.alternatives?.length, 2)
    assert.equal(s.jobs['fx:joy-again-piano'].result?.missing, 2)
    assert.equal(s.jobs['fx:joy-again-piano'].attempt, 2)
  })

  it('offers the same verbs from the same facts: owned albums cannot be Got, unselected ones select first, browse-only never downloads', () => {
    assert.deepEqual(actions('fx:xtc-bonus'), { verbs: ['inspectSelection', 'playOwned'], getBlocked: 'owned' })
    assert.deepEqual(actions('fx:xtc-plain'), { verbs: ['inspectSelection', 'chooseEdition'], getBlocked: 'select-edition' })
    assert.deepEqual(actions('fx:lc-deluxe'), { verbs: ['previewItem', 'inspectSelection', 'playOwned'], getBlocked: 'owned' })
    assert.deepEqual(actions('fx:ril-deluxe'), { verbs: ['inspectSelection', 'playOwned', 'getSelection'] })
    // refused by the sources: Details + a new choice, never Retry/Get of the refused one
    assert.deepEqual(actions('fx:lc-live'), { verbs: ['saveItem', 'inspectSelection', 'chooseEdition'], getBlocked: 'refused' })
    assert.deepEqual(actions('fx:5-years-time'), { verbs: ['saveItem', 'previewItem', 'inspectSelection', 'chooseEdition'], getBlocked: 'refused' })
    assert.deepEqual(actions('fx:simple-plan-anniv'), { verbs: ['saveItem', 'inspectSelection', 'chooseEdition'], getBlocked: 'refused' })
    // an incomplete import: Retry is the acquisition action, Get is not offered beside it
    assert.deepEqual(actions('fx:joy-again-piano'), { verbs: ['saveItem', 'inspectSelection', 'playOwned', 'retryJob'], getBlocked: 'retry' })
    assert.deepEqual(actions('fx:king'), { verbs: ['previewItem', 'inspectSelection', 'cancelJob'], getBlocked: 'in-flight' })
    assert.deepEqual(actions('fx:artist-th'), { verbs: [], getBlocked: 'browse-only' })
    assert.deepEqual(actions('fx:concert-th-1983'), { verbs: [], getBlocked: 'browse-only' })
    assert.deepEqual(actions('fx:mayor'), { verbs: ['saveItem', 'inspectSelection', 'playOwned'], getBlocked: 'owned' })
  })

  it('two recommenders stay two recommendations on one item; the job carries both ids', () => {
    const recs = s.recommendations.filter((r) => r.itemId === 'fx:king')
    assert.deepEqual(recs.map((r) => r.source.name), ['Alex', 'Sam'])
    assert.deepEqual([...s.jobs['fx:king'].recommendationIds], ['fx:rec:king-alex', 'fx:rec:king-sam'])
  })

  it('a job drafts only from a selected item; retry keeps the selection and counts the attempt', () => {
    const plain = s.entries.find((e) => e.item.itemId === 'fx:xtc-plain')!
    assert.deepEqual(draftShopJob(plain, 'j', '2026-09-05T00:00:00Z'), { ok: false, reason: 'select-edition' })
    const artist = s.entries.find((e) => e.item.itemId === 'fx:artist-th')!
    assert.deepEqual(draftShopJob(artist, 'j', '2026-09-05T00:00:00Z'), { ok: false, reason: 'browse-only' })
    const retried = retryShopJob(s.jobs['fx:lc-live'], '2026-09-05T00:00:00Z')
    assert.equal(retried.attempt, 2); assert.equal(retried.status, 'queued'); assert.equal(retried.selection.revision, 'itunes:collection:9990001')
  })

  it('the prototype command bus records calls and has no other effect', () => {
    const seen: string[] = []
    const cmd = recordingShopCommands((c) => seen.push(`${c.verb}:${c.id}`))
    cmd.getSelection('fx:ril-deluxe'); cmd.cancelJob('fx:job:king'); cmd.retryJob('fx:job:joy-again-piano'); cmd.chooseEdition('fx:lc-live')
    assert.deepEqual(seen, ['getSelection:fx:ril-deluxe', 'cancelJob:fx:job:king', 'retryJob:fx:job:joy-again-piano', 'chooseEdition:fx:lc-live'])
    assert.equal(cmd.calls.length, 4)
  })
})
