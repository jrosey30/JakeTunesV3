/**
 * Jake's taste choices on BOTH Macs (2026-10-20, "fix ALL of them"): each Mac
 * writes only its own files; the other Mac's copies (pulled by the sync
 * script into userData/taste-elsewhere/<source>/) are merged in memory —
 * a union, newest verdict wins, never an overwrite, never written back.
 *
 * The audit this fixes: the MacBook had 24 "Not for me" artists, workmini 0,
 * and workmini's Record Shop showed 5 cards from them; strip ✕ / refresh
 * hides (8,185 MacBook verdicts, 313 workmini) stayed on the Mac that made
 * them; Rock DNA (38 answers + Dislikes) existed only on the MacBook.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { readFileSync as readSrc } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  effectiveNotForMe, sharedFeedbackView, applyNotForMe, applyAllowAgain, unionLedgerRows, mergeDnaStates,
  NOT_FOR_ME_REST_VIEWS, TASTE_ELSEWHERE_DIR, type DiscoveryFeedback, type SharedLedgerRow,
} from '../../common/taste-shared.ts'
import { stripMemoryFor, negativeExamples, REFRESH_HIDE_DAYS } from '../../common/strip-memory.ts'
import { normalizeDnaState, retake, dislikedArtists, type DnaState } from '../../common/rock-dna.ts'
import { elsewhereSources, elsewhereJson, elsewhereLedgerRows } from '../taste-elsewhere.ts'
import { readSharedLedgerRows } from '../taste-ledger-io.ts'
import { loadRockDna } from '../discovery-focus.ts'
import { dropVetoed, cardKey, normKey, CARD_REST_VIEWS } from '../discover-feed.ts'
import { discoverVerdicts } from '../discovery-learned.ts'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-20T12:00:00Z')
const fb = (o: Partial<DiscoveryFeedback> = {}): DiscoveryFeedback => ({ notForMe: {}, served: {}, ...o })

describe('Record Shop "Not for me" — either Mac, both Macs', () => {
  it('an artist rejected on either Mac is out on both; the newest verdict per artist wins', () => {
    const macbook = fb({ notForMe: { 'tv on the radio': { artist: 'TV on the Radio', at: 100 } } })
    const workmini = fb({ notForMe: { 'kneecap': { artist: 'Kneecap', at: 200 } } })
    const both = effectiveNotForMe([macbook, workmini])
    assert.deepEqual(Object.keys(both).sort(), ['kneecap', 'tv on the radio'])
    assert.deepEqual(effectiveNotForMe([workmini, macbook]), both, 'order of the copies does not matter')
  })

  it('"Allow again" travels: newer than the reject it undoes it, older it does not, a tie keeps it hidden', () => {
    const rej = fb({ notForMe: { boc: { artist: 'Boards of Canada', at: 100 } } })
    assert.deepEqual(effectiveNotForMe([rej, fb({ allowed: { boc: { artist: 'Boards of Canada', at: 150 } } })]), {})
    assert.ok(effectiveNotForMe([rej, fb({ allowed: { boc: { artist: 'x', at: 50 } } })]).boc, 'an older allow does not undo a newer reject')
    assert.ok(effectiveNotForMe([rej, fb({ allowed: { boc: { artist: 'x', at: 100 } } })]).boc)
    // ...and a reject made after the allow brings it back.
    const again = fb({ notForMe: { boc: { artist: 'Boards of Canada', at: 300 } } })
    assert.ok(effectiveNotForMe([rej, fb({ allowed: { boc: { artist: 'x', at: 150 } } }), again]).boc)
  })

  it('the local writes: not-for-me stamps the artist (or rests the owned card), allow-again stamps the undo', () => {
    const cur = applyNotForMe(fb(), { key: 'sigur ros', artist: 'Sigur Rós', restKeys: null }, 10)
    assert.deepEqual(cur.notForMe['sigur ros'], { artist: 'Sigur Rós', at: 10 })
    const owned = applyNotForMe(fb(), { key: 'daft punk', artist: 'Daft Punk', restKeys: ['disc|daft punk|x', 'daft punk|x'] }, 10)
    assert.deepEqual(owned.notForMe, {}, 'an artist Jake owns is never banned')
    assert.equal(owned.served['daft punk|x'].views, NOT_FOR_ME_REST_VIEWS)
    const undone = applyAllowAgain(cur, 'sigur ros', 'Sigur Rós', 20)
    assert.deepEqual(undone.notForMe, {})
    assert.deepEqual(undone.allowed, { 'sigur ros': { artist: 'Sigur Rós', at: 20 } })
    assert.equal(NOT_FOR_ME_REST_VIEWS, CARD_REST_VIEWS, 'the common twin of discover-feed CARD_REST_VIEWS')
  })

  it('the shared view takes the other Mac\'s hard rests but not its rotation, and never touches the local doc', () => {
    const local = fb({ served: { 'a|b': { first: 1, last: 5, views: 3 } } })
    const before = JSON.stringify(local)
    const other = fb({ served: { 'a|b': { first: 2, last: 9, views: 99 }, 'c|d': { first: 1, last: 1, views: 7 } } })
    const view = sharedFeedbackView(local, [other])
    assert.equal(view.served['a|b'].views, 99, 'a Not-for-me rest on the other Mac rests it here')
    assert.equal(view.served['c|d'], undefined, 'ordinary view counts stay on their own Mac')
    assert.equal(JSON.stringify(local), before, 'the local doc is untouched (it is what gets written)')
    assert.notEqual(view.served, local.served)
  })

  it('the serve-time door drops a cached card from a rejected artist and a rested card, nothing else', () => {
    const lanes = [
      { id: 'fresh-albums', title: 'x', cards: [{ type: 'album', artist: 'TV on the Radio', title: 'Seeds' }, { type: 'album', artist: 'Geese', title: 'Getting Killed' }] },
      { id: 'songs', title: 'y', cards: [{ type: 'song', artist: 'Boards Of Canada', title: 'Roygbiv' }] },
    ]
    const view = fb({
      notForMe: { [normKey('TV on the Radio')]: { artist: 'TV on the Radio', at: 1 } },
      served: { [cardKey({ artist: 'Boards Of Canada', title: 'Roygbiv' })]: { first: NOW, last: NOW - DAY, views: 99 } },
    })
    const out = dropVetoed(lanes, view, NOW)
    assert.deepEqual(out.map((l) => l.id), ['fresh-albums'], 'a lane left empty goes')
    assert.deepEqual(out[0].cards.map((c) => (c as { artist: string }).artist), ['Geese'])
    // A rest expires after 14 days, as in filterFeed; rotation counts (< 99) never drop here.
    const old = fb({ served: { [cardKey({ artist: 'Boards Of Canada', title: 'Roygbiv' })]: { first: 0, last: NOW - 15 * DAY, views: 99 } } })
    assert.equal(dropVetoed(lanes, old, NOW).length, 2)
    const rotating = fb({ served: { [cardKey({ artist: 'Geese', title: 'Getting Killed' })]: { first: 0, last: NOW, views: 6 } } })
    assert.equal(dropVetoed(lanes, rotating, NOW)[0].cards.length, 2)
  })
})

const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()
const srow = (verdict: string, trackId: number, daysAgo: number, playlistId = 'pool'): SharedLedgerRow =>
  ({ ts: at(daysAgo), surface: 'strip', verdict, key: { trackId, playlistId } })
const from = (source: string, rows: SharedLedgerRow[]) => rows.map((r) => ({ ...r, elsewhere: source }))

describe('strip ✕ / refresh hides — counted across both Macs', () => {
  it('with nothing from elsewhere the local rows come back untouched', () => {
    const local = [srow('reject', 1, 3)]
    assert.equal(unionLedgerRows(local, []), local)
    assert.equal(unionLedgerRows(local, [[]]), local)
  })

  it('a ✕ on the other Mac hides the song here, for good, and is a negative example', () => {
    const rows = unionLedgerRows([], [from('workmini', [srow('reject', 42, 1)])])
    const m = stripMemoryFor(rows, 'pool', new Set(), NOW)
    assert.deepEqual(m.get(42), { reason: 'rejected', until: null })
    assert.deepEqual(negativeExamples(m), [42])
  })

  it('one refresh on each Mac is two refreshes: hidden 90 days (Jake\'s 2-refresh → 90-day rule)', () => {
    const rows = unionLedgerRows([srow('refresh', 7, 30)], [from('hub', [srow('pass', 7, 10)])])
    const m = stripMemoryFor(rows, 'pool', new Set(), NOW)
    assert.equal(m.get(7)?.reason, 'refreshed')
    assert.equal(m.get(7)?.until, NOW - 10 * DAY + REFRESH_HIDE_DAYS * DAY)
    assert.equal(stripMemoryFor(unionLedgerRows([srow('refresh', 7, 30)], []), 'pool', new Set(), NOW).size, 0, 'one Mac alone: one refresh, no hide')
  })

  it('the same verdict twice (a copy of a copy) counts once — one refresh never hides', () => {
    const r = srow('refresh', 9, 2)
    const rows = unionLedgerRows([r], [from('hub', [r])])
    assert.equal(rows.length, 1)
    assert.equal(stripMemoryFor(rows, 'pool', new Set(), NOW).size, 0)
  })

  it('an add on the other Mac reads as "taken back" only once it is a day old; it clears older refreshes at once', () => {
    const fresh = unionLedgerRows([srow('refresh', 5, 20), srow('refresh', 5, 15)], [from('workmini', [{ ...srow('accept', 5, 0), ts: new Date(NOW - 3600_000).toISOString() }])])
    assert.equal(stripMemoryFor(fresh, 'pool', new Set(), NOW).size, 0, 'an hour old: this Mac\'s playlist may not have it yet')
    const settled = unionLedgerRows([], [from('workmini', [srow('accept', 5, 2)])])
    assert.equal(stripMemoryFor(settled, 'pool', new Set(), NOW).get(5)?.reason, 'taken-back', 'two days on and still not on the playlist: taken back')
    assert.equal(stripMemoryFor(settled, 'pool', new Set([5]), NOW).size, 0, 'on the playlist: nothing to hide')
    // Added here long ago, re-added on the other Mac an hour ago: still on its way.
    const readded = unionLedgerRows([srow('accept', 8, 30)], [from('workmini', [{ ...srow('accept', 8, 0), ts: new Date(NOW - 3600_000).toISOString() }])])
    assert.equal(stripMemoryFor(readded, 'pool', new Set(), NOW).size, 0)
    // An add made HERE that is no longer on the playlist is taken back at once, as before.
    assert.equal(stripMemoryFor([srow('accept', 6, 0)], 'pool', new Set(), NOW).get(6)?.reason, 'taken-back')
  })

  it('the union is in time order, so Discovery\'s latest-verdict-wins hears both Macs in the order Jake gave them', () => {
    const d = (verdict: string, daysAgo: number) => ({ ts: at(daysAgo), surface: 'discover', verdict, key: { artist: 'Geese', title: 'Getting Killed' } })
    const rows = unionLedgerRows([d('accept', 5)], [from('workmini', [d('reject', 1)])])
    const v = discoverVerdicts(rows as Parameters<typeof discoverVerdicts>[0])
    assert.equal(v.rejects.length, 1)
    assert.equal(v.accepts.length, 0)
  })
})

const dna = (o: Partial<DnaState>): DnaState => normalizeDnaState({ version: 1, person: 'jake', answers: {}, ratings: {}, traitEdits: {}, ...o })

describe('Rock DNA — answer on either Mac', () => {
  it('a Mac with no quiz takes the other Mac\'s whole quiz, Dislikes included', () => {
    const macbook = dna({ startedAt: '2026-10-11T20:00:00.000Z', updatedAt: '2026-10-11T23:52:14.768Z', completedAt: '2026-10-11T23:52:14.768Z', answers: { a1: { picks: ['x'], at: '2026-10-11T20:01:00.000Z' } }, ratings: { 'Nickelback': 'dislike', 'Geese': 'love' } })
    const merged = mergeDnaStates([normalizeDnaState(null), macbook])
    assert.deepEqual(merged, macbook)
    assert.deepEqual(dislikedArtists(merged), ['Nickelback'])
  })

  it('answers given on both Macs before a sync are all kept; each screen keeps the answer given last', () => {
    const start = '2026-10-11T20:00:00.000Z'
    const a = dna({ startedAt: start, updatedAt: '2026-10-20T10:00:00.000Z', answers: { s1: { picks: ['old'], at: '2026-10-11T20:01:00.000Z' }, s2: { picks: ['mac'], at: '2026-10-20T10:00:00.000Z' } }, ratings: { Geese: 'love' } })
    const b = dna({ startedAt: start, updatedAt: '2026-10-20T10:04:00.000Z', answers: { s1: { picks: ['new'], at: '2026-10-20T10:04:00.000Z' } }, ratings: { Interpol: 'dislike', Geese: 'like' }, traitEdits: {} })
    const m = mergeDnaStates([a, b])
    assert.deepEqual(m.answers.s1.picks, ['new'])
    assert.deepEqual(m.answers.s2.picks, ['mac'], 'the other Mac\'s answer is not lost to a newer save')
    assert.deepEqual(m.ratings, { Geese: 'like', Interpol: 'dislike' }, 'ratings union; the newest copy wins a conflict')
    assert.equal(m.updatedAt, '2026-10-20T10:04:00.000Z')
    assert.equal(m.startedAt, start)
  })

  it('a fresh start on a Mac that never saw the quiz merges into the run — it never wipes the other Mac\'s answers', () => {
    const macbook = dna({ startedAt: '2026-10-11T20:00:00.000Z', updatedAt: '2026-10-11T23:00:00.000Z', answers: { s1: { picks: ['x'], at: '2026-10-11T20:01:00.000Z' } } })
    const fresh = dna({ startedAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z', answers: { s2: { picks: ['y'], at: '2026-10-20T09:00:00.000Z' } } })
    const m = mergeDnaStates([macbook, fresh])
    assert.deepEqual(Object.keys(m.answers).sort(), ['s1', 's2'])
    assert.equal(m.startedAt, '2026-10-11T20:00:00.000Z')
  })

  it('a retake supersedes the run it replaced, on both Macs', () => {
    const old = dna({ startedAt: '2026-10-11T20:00:00.000Z', updatedAt: '2026-10-20T11:00:00.000Z', completedAt: '2026-10-11T23:00:00.000Z', answers: { s1: { picks: ['x'], at: '2026-10-11T20:01:00.000Z' } }, ratings: { Geese: 'love' } })
    const fresh = retake(old, '2026-10-20T12:00:00.000Z')
    const m = mergeDnaStates([old, fresh])
    assert.deepEqual(m.answers, {})
    assert.deepEqual(m.ratings, {})
    assert.equal(m.completedAt, undefined)
    assert.deepEqual(m.previous?.answers, old.answers, 'the last run is kept as previous')
  })

  it('trait corrections come whole from the newest copy, so "auto" (a delete) travels', () => {
    const start = '2026-10-11T20:00:00.000Z'
    const a = dna({ startedAt: start, updatedAt: '2026-10-12T00:00:00.000Z', traitEdits: { riffs: 'low' } })
    const b = dna({ startedAt: start, updatedAt: '2026-10-13T00:00:00.000Z', traitEdits: {} })
    assert.deepEqual(mergeDnaStates([a, b]).traitEdits, {})
  })
})

describe('the copies on disk (userData/taste-elsewhere/<source>/)', () => {
  function tmpUserData(): string {
    const ud = mkdtempSync(join(tmpdir(), 'jt-taste-shared-'))
    return ud
  }
  const put = (ud: string, source: string, file: string, body: string) => {
    mkdirSync(join(ud, TASTE_ELSEWHERE_DIR, source), { recursive: true })
    writeFileSync(join(ud, TASTE_ELSEWHERE_DIR, source, file), body)
  }

  it('no folder = no sources, no rows, no docs — every reader behaves exactly as before', async () => {
    const ud = tmpUserData()
    try {
      assert.deepEqual(await elsewhereSources(ud), [])
      assert.deepEqual(await elsewhereJson(ud, 'discovery-feedback.json'), [])
      assert.deepEqual(await elsewhereLedgerRows(ud), [])
      writeFileSync(join(ud, 'taste-ledger.jsonl'), `${JSON.stringify(srow('reject', 1, 1))}\n`)
      assert.equal((await readSharedLedgerRows(join(ud, 'taste-ledger.jsonl'))).length, 1)
    } finally { rmSync(ud, { recursive: true, force: true }) }
  })

  it('reads each source, marks its rows, skips a torn line, and keeps the last good parse of a corrupt copy', async () => {
    const ud = tmpUserData()
    try {
      put(ud, 'workmini', 'taste-ledger.jsonl', `${JSON.stringify(srow('reject', 2, 1))}\n{"torn`)
      put(ud, 'workmini', 'discovery-feedback.json', JSON.stringify(fb({ notForMe: { kneecap: { artist: 'Kneecap', at: 5 } } })))
      const rows = await elsewhereLedgerRows(ud)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].length, 1)
      assert.equal(rows[0][0].elsewhere, 'workmini')
      const docs = await elsewhereJson(ud, 'discovery-feedback.json')
      assert.equal(docs[0].source, 'workmini')
      // A copy that stops parsing keeps the last good one (never drops that Mac's verdicts).
      const p = join(ud, TASTE_ELSEWHERE_DIR, 'workmini', 'discovery-feedback.json')
      writeFileSync(p, '{"notForMe": ')
      utimesSync(p, new Date(), new Date(Date.now() + 5000))
      assert.deepEqual(await elsewhereJson(ud, 'discovery-feedback.json'), docs)
      // The shared ledger reader unions local + elsewhere.
      writeFileSync(join(ud, 'taste-ledger.jsonl'), `${JSON.stringify(srow('refresh', 3, 2))}\n`)
      assert.equal((await readSharedLedgerRows(join(ud, 'taste-ledger.jsonl'))).length, 2)
    } finally { rmSync(ud, { recursive: true, force: true }) }
  })

  it('loadRockDna merges this Mac\'s quiz with the other Mac\'s copy, and never writes', async () => {
    const ud = tmpUserData()
    try {
      const macbook = dna({ startedAt: '2026-10-11T20:00:00.000Z', updatedAt: '2026-10-11T23:52:14.768Z', answers: { s1: { picks: ['x'], at: '2026-10-11T20:01:00.000Z' } }, ratings: { Interpol: 'dislike' } })
      put(ud, 'hub', 'rock-dna.json', JSON.stringify(macbook))
      const m = await loadRockDna(ud)
      assert.deepEqual(dislikedArtists(m), ['Interpol'])
      assert.deepEqual(await elsewhereSources(ud), ['hub'])
      assert.throws(() => readFileSync(join(ud, 'rock-dna.json')), 'loading never writes this Mac\'s file')
    } finally { rmSync(ud, { recursive: true, force: true }) }
  })
})

describe('wiring (checked at the source)', () => {
  const src = (p: string) => readSrc(join(import.meta.dirname, '..', '..', p), 'utf-8')
  const index = src('main/index.ts')

  it('everything that decides what the Record Shop shows reads BOTH Macs\' verdicts', () => {
    assert.equal(index.match(/await sharedDiscoveryFeedback\(\)/g)?.length, 4, 'learned panel, feed build, serve-time door, radar')
    assert.match(index, /feedback: sharedDiscoveryFeedback, isOnList:/, 'critic wall')
    assert.match(index, /lanes = dropVetoed\(lanes, await sharedDiscoveryFeedback\(\), Date\.now\(\)\)\n\s+return dropListed\(lanes,/, 'every feed that leaves main')
    assert.equal(index.match(/readSharedLedgerRows\(TASTE_LEDGER_PATH\(\)\)/g)?.length, 2, 'learned panel + Discovery verdicts')
    assert.doesNotMatch(index, /readLedgerRows\(/)
  })

  it('writes go to THIS Mac\'s file only — the shared view is never written back', () => {
    assert.match(index, /await recordNotForMe\(key, String\(artist\), owned \?/)
    assert.match(index, /await recordAllowAgain\(key, String\(artist\)\)/)
    assert.equal(index.match(/discoveryFeedbackCache\.update\(/g)?.length, 2, 'only the two rotation counters write, on the local cache')
    assert.equal(index.match(/discoveryFeedbackCache\.get\(/g), null, 'no decision reads only this Mac\'s verdicts any more')
  })

  it('the strip reads both Macs\' rows; a real verdict, a Not-for-me and a quiz answer each queue a batched sync', () => {
    const ipc = src('main/ipc/taste-ipc.ts')
    assert.match(ipc, /unionLedgerRows\(local, elsewhere\.map/)
    assert.match(ipc, /if \(lines\.some\(\(l\) => !l\.includes\('"verdict":"shown"'\)\)\) triggerSync\('taste'\)/)
    assert.match(src('main/ipc/rock-dna-ipc.ts'), /triggerSync\('taste'\)/)
    assert.equal(src('main/discovery-feedback.ts').match(/triggerSync\('taste'\)/g)?.length, 2)
  })
})
