/**
 * The one listening history (2026-10-10, Year in Review step 1). See
 * src/common/listening-history.ts for the measurements behind each rule.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyDevice, fromIpodLedger, mergeHistories, attachTrackIds, summarize, songKey,
  BURST_MIN, type RawListen,
} from '../../common/listening-history.ts'

const at = (sec: number): string => new Date(Date.UTC(2026, 8, 13, 16, 0, 0) + sec * 1000).toISOString()
const play = (sec: number, ti = 'Taxes', ar = 'Geese'): RawListen => ({ t: 'p', ts: at(sec), ar, ti, pct: 100 })
const skip = (sec: number, pct = 0, ti = `s${sec}`): RawListen => ({ t: 's', ts: at(sec), ar: 'X', ti, pct })

describe('classifying one device', () => {
  it('a run of 8+ near-zero skips under 20 s apart is mechanical, not 8 verdicts', () => {
    const rows = [play(0), ...Array.from({ length: BURST_MIN }, (_, i) => skip(300 + i * 5)), play(400)]
    const kinds = classifyDevice(rows, 'phone').map((l) => l.kind)
    assert.deepEqual(kinds, ['play', ...Array(BURST_MIN).fill('mechanical'), 'play'])
  })

  it('seven quick skips are not a burst: each is a skip or a glance on its own', () => {
    const rows = Array.from({ length: BURST_MIN - 1 }, (_, i) => skip(i * 5, i % 2 ? 40 : 1))
    const kinds = classifyDevice(rows, 'laptop').map((l) => l.kind)
    assert.ok(!kinds.includes('mechanical'))
    assert.deepEqual(kinds, kinds.map((_, i) => (i % 2 ? 'skip' : 'glance')))
  })

  it('a gap over 20 s splits a run', () => {
    const rows = [...Array.from({ length: 5 }, (_, i) => skip(i * 5)), ...Array.from({ length: 5 }, (_, i) => skip(100 + i * 5))]
    assert.ok(!classifyDevice(rows, 'laptop').some((l) => l.kind === 'mechanical'))
  })

  it('leaving before 5% is a glance; leaving later is a skip', () => {
    const [g, s] = classifyDevice([skip(0, 4), skip(60, 35)], 'workmini')
    assert.equal(g.kind, 'glance')
    assert.equal(s.kind, 'skip')
  })

  it('rows out of order are sorted; unreadable timestamps dropped', () => {
    const out = classifyDevice([play(60, 'B'), { t: 'p', ts: 'garbage', ti: 'C' }, play(0, 'A')], 'laptop')
    assert.deepEqual(out.map((l) => l.title), ['A', 'B'])
  })
})

describe('iPod round-trip ledger', () => {
  it('each offline play lands at the time the iPod recorded, ×delta', () => {
    const lib = new Map([[9836, { artist: 'Geese', title: 'Cobra' }]])
    const out = fromIpodLedger([{ kind: 'roundtrip', when: '2026-09-01T20:32:01Z', plays: [{ id: 9836, delta: 2, lastPlayedMs: Date.UTC(2026, 8, 1, 15, 0) }] }], (id) => lib.get(id))
    assert.equal(out.length, 2)
    assert.ok(out.every((l) => l.device === 'ipod' && l.kind === 'play' && l.trackId === 9836 && l.title === 'Cobra'))
    assert.equal(out[0].ts, '2026-09-01T15:00:00.000Z')
  })
})

describe('merging devices', () => {
  it('union in time order; an exact duplicate row counts once', () => {
    const lap = classifyDevice([play(10, 'A'), play(10, 'A')], 'laptop')
    const wm = classifyDevice([play(5, 'B')], 'workmini')
    const merged = mergeHistories([lap, wm])
    assert.deepEqual(merged.map((l) => `${l.device}:${l.title}`), ['workmini:B', 'laptop:A'])
  })

  it('the same song at the same time on two devices is two listens', () => {
    const merged = mergeHistories([classifyDevice([play(0)], 'laptop'), classifyDevice([play(0)], 'phone')])
    assert.equal(merged.length, 2)
  })
})

describe('identity', () => {
  it('songKey folds accents and punctuation', () => {
    assert.equal(songKey('Beyoncé', 'Halo!'), songKey('beyonce', 'halo'))
  })

  it('a unique artist+title gets its id; a shared one is not guessed', () => {
    const lib = [
      { id: 1, artist: 'Geese', title: 'Taxes', playCount: 3 },
      { id: 2, artist: 'Geese', title: 'Cobra', playCount: 1 },
      { id: 3, artist: 'Geese', title: 'Cobra', playCount: 1 },
    ]
    const out = attachTrackIds(classifyDevice([play(0, 'Taxes'), play(10, 'Cobra')], 'laptop'), lib)
    assert.equal(out[0].trackId, 1)
    assert.equal(out[1].trackId, undefined, 'two played copies of Cobra — no guess')
  })
})

describe('the year summary', () => {
  it('counts every kind, minutes from plays only, tops by plays', () => {
    const rows = [play(0, 'Taxes'), play(300, 'Taxes'), play(600, 'Cobra'), skip(900, 40), skip(1000, 1)]
    const listens = classifyDevice(rows, 'laptop')
    const s = summarize(listens, 2026, (l) => (l.title === 'Taxes' ? 197000 : undefined))
    assert.deepEqual(s.totals, { play: 3, skip: 1, glance: 1, mechanical: 0 })
    assert.equal(s.minutesKnownFor, 2)
    assert.equal(s.minutesListened, Math.round((197000 * 2) / 60000))
    assert.deepEqual(s.topSongs[0], { artist: 'Geese', title: 'Taxes', plays: 2 })
    assert.equal(s.topArtists[0].plays, 3)
    assert.equal(s.byDeviceMonth.laptop['09'].play, 3)
  })

  it('other years are left out', () => {
    const s = summarize([{ ts: '2025-12-31T23:00:00.000Z', device: 'laptop', kind: 'play', pct: 100, artist: 'A', title: 'B', album: '', genre: '' }], 2026, () => 1000)
    assert.equal(s.totals.play, 0)
  })
})
