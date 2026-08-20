import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tempoEnergyText, KEY_CONFIDENCE_FLOOR } from '../ai/tempo-energy.ts'

describe('tempoEnergyText — key confidence gate', () => {
  it('always includes measured BPM', () => {
    const s = tempoEnergyText({ bpm: 128, keyRoot: 'A', keyMode: 'minor', camelotKey: '8A', keyConfidence: 0.9 })
    assert.match(s, /128 BPM/)
    assert.match(s, /camelot 8A/)
    assert.match(s, /A minor/)
  })

  it('omits key + camelot when confidence is below the floor', () => {
    const s = tempoEnergyText({ bpm: 128, keyRoot: 'A', keyMode: 'minor', camelotKey: '8A', keyConfidence: 0.2 })
    assert.match(s, /128 BPM/)
    assert.equal(s.includes('camelot'), false)
    assert.equal(s.includes('minor'), false)
    assert.ok(KEY_CONFIDENCE_FLOOR > 0.2)
  })

  it('keeps key when confidence is unknown (legacy overrides)', () => {
    const s = tempoEnergyText({ bpm: 100, keyRoot: 'C', keyMode: 'major', camelotKey: '8B' })
    assert.match(s, /C major/)
    assert.match(s, /camelot 8B/)
  })

  it('says nothing with no bpm', () => {
    assert.equal(tempoEnergyText({ keyRoot: 'C', keyMode: 'major' }), '')
  })
})
