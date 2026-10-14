// Brief 179 — brain-purity.mjs on synthetic embedding fixtures.
// Clean clustered index vs the same index with vectors shuffled across
// clusters: purity must be high for the first and collapse for the second,
// and the gate must block the shuffled candidate.
// Run: node --test scripts/__tests__/brain-purity.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { neighbourPurity, comparePurity, gateDecision, mulberry32, PURITY_MAX_REGRESSION } from '../brain-purity.mjs'

const DIM = 16
function clusterIndex({ clusters = 6, perCluster = 12, scramble = false } = {}) {
  const rnd = mulberry32(1234)
  const index = new Map(), meta = new Map()
  const centers = []
  for (let c = 0; c < clusters; c++) {
    const v = new Float32Array(DIM)
    for (let j = 0; j < DIM; j++) v[j] = rnd() * 2 - 1
    centers.push(v)
  }
  let id = 1
  const entries = []
  for (let c = 0; c < clusters; c++) {
    for (let i = 0; i < perCluster; i++) {
      const v = new Float32Array(DIM)
      for (let j = 0; j < DIM; j++) v[j] = centers[c][j] + (rnd() - 0.5) * 0.05
      entries.push({ id, v, c })
      meta.set(id, { artist: `Artist ${c}`, genre: `Genre ${c}` })
      id++
    }
  }
  if (scramble) {
    // Keep the vectors, destroy the geometry: hand each id another cluster's vector.
    const vecs = entries.map((e) => e.v)
    const rnd2 = mulberry32(99)
    for (let i = vecs.length - 1; i > 0; i--) { const j = Math.floor(rnd2() * (i + 1)); [vecs[i], vecs[j]] = [vecs[j], vecs[i]] }
    entries.forEach((e, i) => index.set(e.id, vecs[i]))
  } else {
    entries.forEach((e) => index.set(e.id, e.v))
  }
  return { index, meta }
}

test('clean clustered index has high neighbour purity', () => {
  const { index, meta } = clusterIndex()
  const ids = [...index.keys()]
  const r = neighbourPurity(index, meta, ids, 10)
  assert.ok(r.purity > 0.9, `expected purity > 0.9, got ${r.purity}`)
})

test('scrambled index collapses purity and the gate blocks it', () => {
  const clean = clusterIndex()
  const scrambled = clusterIndex({ scramble: true })
  const cmp = comparePurity(scrambled.index, clean.index, clean.meta, { sampleSize: 72, k: 10 })
  assert.ok(cmp.candidate.purity < 0.45, `scrambled purity should collapse, got ${cmp.candidate.purity}`)
  assert.ok(cmp.regression > PURITY_MAX_REGRESSION)
  const d = gateDecision(cmp)
  assert.equal(d.block, true)
  assert.match(d.reason, /regressed/)
})

test('identical candidate does not block; tiny noise does not block', () => {
  const clean = clusterIndex()
  const same = comparePurity(clean.index, clean.index, clean.meta, { sampleSize: 72, k: 10 })
  assert.equal(same.regression, 0)
  assert.equal(gateDecision(same).block, false)
})

test('unscorable comparison abstains instead of blocking', () => {
  const d = gateDecision({ candidate: { purity: null }, previous: { purity: null }, regression: null, sampleSize: 0, k: 10 })
  assert.equal(d.block, false)
  assert.match(d.reason, /abstains/)
})

test('sample is deterministic and common to both indexes', () => {
  const a = clusterIndex(); const b = clusterIndex({ scramble: true })
  const c1 = comparePurity(b.index, a.index, a.meta, { sampleSize: 20, k: 5 })
  const c2 = comparePurity(b.index, a.index, a.meta, { sampleSize: 20, k: 5 })
  assert.equal(c1.candidate.purity, c2.candidate.purity)
  assert.equal(c1.sampleSize, 20)
})
