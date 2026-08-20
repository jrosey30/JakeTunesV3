import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIX_BRAIN_TWIN,
  ORBIT_ABS_FLOOR,
  ORBIT_REL_MARGIN,
} from '../common/mix-brain-twin.ts'
import {
  ORBIT_ABS_FLOOR as orbitFloorFromModule,
  ORBIT_REL_MARGIN as orbitMarginFromModule,
} from '../ai/orbit-quality.ts'

describe('mix-brain-twin contract', () => {
  it('names desktop as SoT and lists the Mobile paths that must twin', () => {
    assert.equal(MIX_BRAIN_TWIN.sourceOfTruth, 'JakeTunesV3')
    assert.ok(MIX_BRAIN_TWIN.mobileMustTwin.some((p) => p.includes('mixes.ts')))
    assert.ok(MIX_BRAIN_TWIN.mobileMustTwin.some((p) => p.includes('rag.ts')))
    assert.ok(MIX_BRAIN_TWIN.rules.length >= 4)
  })

  it('keeps orbit thresholds single-sourced', () => {
    assert.equal(ORBIT_ABS_FLOOR, 0.58)
    assert.equal(ORBIT_REL_MARGIN, 0.12)
    assert.equal(orbitFloorFromModule, ORBIT_ABS_FLOOR)
    assert.equal(orbitMarginFromModule, ORBIT_REL_MARGIN)
  })
})
