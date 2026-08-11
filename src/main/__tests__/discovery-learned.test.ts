import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summariseLearning, type LedgerRow } from '../discovery-learned.ts'

const row = (o: Partial<LedgerRow>): LedgerRow => ({ ts: '2026-08-01T00:00:00Z', ...o })

describe('summariseLearning — the brain admits how much it knows', () => {
  it("says it doesn't know you when it barely has signals (Jake's real numbers)", () => {
    // His actual ledger: 20 discover rows, 1 reject, the rest from the strip.
    const rows = [
      ...Array.from({ length: 19 }, () => row({ surface: 'discover', verdict: 'accept' })),
      row({ surface: 'discover', verdict: 'reject', key: { artist: 'DJ Plead' } }),
      ...Array.from({ length: 1922 }, () => row({ surface: 'strip', verdict: 'pass' })),
    ]
    const s = summariseLearning(rows, {})
    assert.equal(s.discoverSignals, 20)
    assert.equal(s.rejects, 1)
    assert.equal(s.stripSignals, 1922)
    assert.equal(s.confidence, 'thin')
    assert.match(s.headline, /not for me/i)     // it asks for the signal it lacks
  })

  it('refuses to claim knowledge from almost nothing', () => {
    const s = summariseLearning([row({ surface: 'discover', verdict: 'accept' })], {})
    assert.equal(s.confidence, 'none')
    assert.match(s.headline, /don't know your taste yet/i)
  })

  it('will not call itself confident on volume alone — rejections are required', () => {
    const rows = Array.from({ length: 150 }, () => row({ surface: 'discover', verdict: 'accept' }))
    assert.equal(summariseLearning(rows, {}).confidence, 'thin')   // 150 signals, 0 rejects
    const withNos = [...rows, ...Array.from({ length: 5 }, () => row({ surface: 'discover', verdict: 'reject' }))]
    assert.equal(summariseLearning(withNos, {}).confidence, 'growing')
  })

  it('ranks lanes by how much evidence each has, not by how good it looks', () => {
    const rows = [
      row({ surface: 'discover', verdict: 'accept', ctx: { lane: 'deep-cut' } }),
      row({ surface: 'discover', verdict: 'accept', ctx: { lane: 'deep-cut' } }),
      row({ surface: 'discover', verdict: 'reject', ctx: { lane: 'venue' } }),
    ]
    const s = summariseLearning(rows, {})
    assert.equal(s.lanes[0].lane, 'deep-cut')
    assert.equal(s.lanes[0].accepts, 2)
    assert.equal(s.lanes[1].lane, 'venue')
    assert.equal(s.lanes[1].rejects, 1)
  })

  it('lists what it stopped showing, newest first', () => {
    const s = summariseLearning([], { a: { artist: 'DJ Plead', at: 100 }, b: { artist: 'Burial', at: 300 } })
    assert.deepEqual(s.stoppedShowing.map((x) => x.artist), ['Burial', 'DJ Plead'])
  })

  it('never invents a lane "shown" count the ledger cannot support', () => {
    const s = summariseLearning([row({ surface: 'discover', verdict: 'accept', ctx: { lane: 'x' } })], {})
    assert.deepEqual(Object.keys(s.lanes[0]).sort(), ['accepts', 'lane', 'rejects'])
  })
})
