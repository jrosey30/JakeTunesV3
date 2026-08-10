/**
 * The listener profile — plays, skips, ratings, and the taste summary built
 * from them.
 *
 * Extracted from index.ts on 2026-08-09 with no tests, which mattered more
 * here than usual for two reasons. buildTasteProfile is 130 lines of branching
 * prompt assembly that every character call depends on, and it fails silently:
 * it returns '' both when it is broken and when there is honestly nothing to
 * say. And the caps are load-bearing — this data goes into a PROMPT, so an
 * uncapped history doesn't just grow, it starts crowding out the conversation.
 *
 * The module deliberately imports no electron, which is what lets these run.
 * activity-context.ts does import it, so the activity block arrives injected.
 * If someone later imports it directly, this whole file stops working — that
 * is the intended alarm.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initListenerProfile, loadListenerProfile, buildTasteProfile,
  recordPlay, recordSkip, recordRating, addObservation, getListenerProfile,
} from '../listener-profile.ts'

const play = (n: number, artist = 'Nirvana') => ({
  title: `Track ${n}`, artist, album: 'Nevermind', genre: 'Grunge',
})

describe('listener profile', () => {
  let saved: Record<string, unknown> | null
  let reflected: number
  let discogs: string
  let activity: string

  beforeEach(async () => {
    saved = null
    reflected = 0
    discogs = ''
    activity = ''
    const dir = await mkdtemp(join(tmpdir(), 'lp-'))
    initListenerProfile({
      stateDir: dir,
      profileCache: { get: async () => saved, set: (v) => { saved = v } },
      discogsSummary: () => discogs,
      activityBlock: () => activity,
      onReflect: () => { reflected++ },
    })
    await loadListenerProfile()   // fresh profile from an empty cache
  })

  test('a brand-new listener produces NO taste profile', () => {
    // Not a header with empty sections. Nothing. Anything else would tell the
    // personas things about a listener the app has never observed.
    assert.equal(buildTasteProfile(), '')
  })

  test('counts plays and names what was played', async () => {
    for (let i = 0; i < 3; i++) await recordPlay(play(i))
    const p = getListenerProfile()
    assert.equal(p.totalPlays, 3)
    assert.equal(p.artistPlays['Nirvana'], 3)

    const t = buildTasteProfile()
    assert.ok(t.includes('3 plays'))
    assert.ok(t.includes('Nirvana'))
    assert.ok(t.includes('Grunge'))
  })

  test('skips are recorded as their own signal', async () => {
    await recordSkip({ title: 'Something', artist: 'Coldplay' })
    await recordPlay(play(1))
    const p = getListenerProfile()
    assert.equal(p.totalSkips, 1)
    assert.equal(p.artistSkips['Coldplay'], 1)
    assert.ok(buildTasteProfile().includes('Coldplay'))
  })

  test('Music Man reflects on every 20th play and no other', async () => {
    for (let i = 0; i < 19; i++) await recordPlay(play(i))
    assert.equal(reflected, 0, 'nothing at 19')
    await recordPlay(play(19))
    assert.equal(reflected, 1, 'fires at 20')
    for (let i = 0; i < 19; i++) await recordPlay(play(i))
    assert.equal(reflected, 1, 'and not again until 40')
    await recordPlay(play(99))
    assert.equal(reflected, 2)
  })

  test('4 stars and up is a favourite; anything less takes it back off', async () => {
    await recordRating({ title: 'Lithium', artist: 'Nirvana', album: 'Nevermind', rating: 5 })
    assert.equal(getListenerProfile().topRated.length, 1)

    // Re-rating the same track updates rather than duplicating.
    await recordRating({ title: 'Lithium', artist: 'Nirvana', album: 'Nevermind', rating: 4 })
    assert.equal(getListenerProfile().topRated.length, 1)
    assert.equal(getListenerProfile().topRated[0].rating, 4)

    await recordRating({ title: 'Lithium', artist: 'Nirvana', album: 'Nevermind', rating: 2 })
    assert.equal(getListenerProfile().topRated.length, 0, 'demoted, not kept')
  })

  test('every history is capped, because all of it goes into a prompt', async () => {
    for (let i = 0; i < 210; i++) await recordPlay(play(i, `Artist ${i}`))
    assert.equal(getListenerProfile().recentPlays.length, 200)

    for (let i = 0; i < 110; i++) await recordSkip({ title: `S${i}`, artist: `A${i}` })
    assert.equal(getListenerProfile().recentSkips.length, 100)

    for (let i = 0; i < 60; i++) {
      await recordRating({ title: `R${i}`, artist: `A${i}`, album: 'X', rating: 5 })
    }
    assert.equal(getListenerProfile().topRated.length, 50)

    for (let i = 0; i < 20; i++) addObservation(`observation ${i}`)
    assert.equal(getListenerProfile().observations.length, 15)
    assert.ok(getListenerProfile().observations.at(-1)?.includes('19'), 'keeps the newest')
  })

  test('newest play is first, so the prompt leads with what just happened', async () => {
    await recordPlay(play(1, 'First'))
    await recordPlay(play(2, 'Second'))
    assert.equal(getListenerProfile().recentPlays[0].artist, 'Second')
  })

  test('reads the injected suppliers at call time, not at init', async () => {
    // The frozen-state failure this whole extraction is shaped around: the
    // Discogs blurb is fetched well AFTER init, so a captured value would be
    // permanently empty and the record collection would never reach a prompt.
    await recordPlay(play(1))
    assert.ok(!buildTasteProfile().includes('412 releases'))
    discogs = '412 releases (mostly LP)'
    assert.ok(buildTasteProfile().includes('412 releases'), 'picked up the later fetch')
  })

  test('an idle listener with only a record collection still says something', () => {
    // totalPlays is 0, but Discogs alone is enough to describe someone.
    discogs = '412 releases'
    assert.notEqual(buildTasteProfile(), '')
  })

  test('every play is persisted, not just held in memory', async () => {
    await recordPlay(play(1))
    assert.ok(saved, 'wrote through the cache')
    assert.equal((saved as { totalPlays: number }).totalPlays, 1)
  })
})
