/**
 * brain-purity.mjs — Brief 179: sampled neighbour purity for an embeddings
 * index, productizing the 2026-10-10 neighbour-purity experiment as a
 * pre-publish quality gate for the nightly trainer.
 *
 * FINDING (verified 2026-10-14 against JakeTunesV3 main): the experiment's
 * code does not survive in the repo — `brain-eval/` measures recall@k of
 * natural-language queries against metadata predicates, and no "purity"
 * implementation exists anywhere in the tree. This module therefore
 * implements the metric in the shape the brief specifies, on the same
 * objective metadata brain-eval's retrieval bucket resolves from
 * library.json (artist / genre):
 *
 *   For a FIXED, deterministic sample of tracks (seeded PRNG over the ids
 *   present in BOTH indexes, so candidate and previous are scored on the
 *   identical sample), take each sampled track's k nearest neighbours by
 *   cosine within the same index and compute:
 *
 *     purity = share of those neighbours that are by the SAME ARTIST or
 *              carry the SAME GENRE as the sampled track
 *
 *   …averaged over the sample. A degraded index (bad model swap, scrambled
 *   vectors) pulls neighbours from unrelated artists/genres and purity
 *   falls; a healthy index clusters a track with its own artist/genre.
 *
 * The gate compares candidate vs previous: regression beyond
 * PURITY_MAX_REGRESSION blocks the publish. The gate only ever blocks —
 * nothing in this module writes an index.
 */
import { readFileSync } from 'node:fs'

/** Max allowed purity drop (candidate vs previous) before the gate blocks.
 *  Conservative default: the 2026-10-10 experiment recorded no threshold in
 *  the repo, so this is deliberately marked as a starting value — purity of
 *  a healthy same-model index is stable night to night; 0.02 is well inside
 *  the drop a scrambled/degraded index produces (see the module tests:
 *  a shuffled index loses ~0.5). Override per-run with BRAIN_PURITY_MAX_REGRESSION. */
export const PURITY_MAX_REGRESSION = 0.02
export const PURITY_SAMPLE_SIZE = 200
export const PURITY_K = 10

const MAGIC = 'EMBD'

/**
 * Read an EMBD embeddings file into Map<id, Float32Array> — same container
 * the trainer writes. Throws on bad magic / truncated reads (mirrors the
 * trainer's readEmb discipline: a partial brain must never be scored as if
 * it were whole).
 */
export function readEmbFile(path) {
  const buf = readFileSync(path)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== MAGIC) throw new Error(`${path}: bad magic`)
  const dim = buf.readUInt16LE(6), count = buf.readUInt32LE(8), rec = 4 + dim * 4
  if (buf.length < 12 + count * rec) throw new Error(`${path}: truncated read — header says ${count} vectors but bytes cover only ${Math.floor((buf.length - 12) / rec)}`)
  const map = new Map(); let off = 12
  for (let i = 0; i < count; i++) {
    const id = buf.readUInt32LE(off); off += 4
    const v = new Float32Array(dim)
    for (let j = 0; j < dim; j++) { v[j] = buf.readFloatLE(off); off += 4 }
    map.set(id, v)
  }
  return { map, dim }
}

/** Deterministic PRNG (mulberry32) — the sample must be identical for the
 *  candidate and previous indexes, and stable across runs. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d > 0 ? dot / d : 0
}

const normKey = (s) => String(s || '').trim().toLowerCase()

/**
 * Neighbour purity of ONE index.
 *   index: Map<id, Float32Array>
 *   meta:  Map<id, { artist, genre }> (from library.json)
 *   ids:   the sampled ids (already the fixed sample)
 *   k:     neighbours per sampled track
 * Returns { purity, sampled, neighbours } — purity in [0,1], or null when
 * the sample has no scorable track (no neighbours / no metadata).
 */
export function neighbourPurity(index, meta, ids, k = PURITY_K) {
  const all = [...index.keys()]
  let scored = 0, hits = 0, neighbours = 0
  for (const id of ids) {
    const v = index.get(id)
    const m = meta.get(id)
    if (!v || !m) continue
    const artist = normKey(m.artist), genre = normKey(m.genre)
    if (!artist && !genre) continue
    const sims = []
    for (const other of all) {
      if (other === id) continue
      sims.push([cosine(v, index.get(other)), other])
    }
    sims.sort((x, y) => y[0] - x[0])
    const top = sims.slice(0, k)
    if (!top.length) continue
    scored++
    for (const [, nid] of top) {
      const nm = meta.get(nid)
      if (!nm) continue
      neighbours++
      if ((artist && normKey(nm.artist) === artist) || (genre && normKey(nm.genre) === genre)) hits++
    }
  }
  if (!scored || !neighbours) return { purity: null, sampled: scored, neighbours }
  return { purity: hits / neighbours, sampled: scored, neighbours }
}

/**
 * The fixed sample: ids present in BOTH indexes (and in meta), chosen by a
 * seeded shuffle so candidate and previous are always scored identically.
 */
export function pickSample(candidate, previous, meta, sampleSize = PURITY_SAMPLE_SIZE, seed = 0xBEE5) {
  const common = [...candidate.keys()].filter((id) => previous.has(id) && meta.has(id))
  const rnd = mulberry32(seed)
  for (let i = common.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[common[i], common[j]] = [common[j], common[i]]
  }
  return common.slice(0, Math.max(0, sampleSize))
}

/**
 * Compare a candidate index against the previous one.
 * Returns { candidate, previous, regression, sampleSize, k } where the
 * purity fields are neighbourPurity() results. regression = previous -
 * candidate (positive = the candidate got WORSE), or null when either side
 * is unscorable.
 */
export function comparePurity(candidate, previous, meta, { sampleSize = PURITY_SAMPLE_SIZE, k = PURITY_K, seed } = {}) {
  const ids = pickSample(candidate, previous, meta, sampleSize, seed)
  const cand = neighbourPurity(candidate, meta, ids, k)
  const prev = neighbourPurity(previous, meta, ids, k)
  const regression = (cand.purity === null || prev.purity === null) ? null : prev.purity - cand.purity
  return { candidate: cand, previous: prev, regression, sampleSize: ids.length, k }
}

/** The gate decision. Blocks only on a MEASURED regression beyond the
 *  threshold; an unscorable comparison does not block (integrity checks
 *  elsewhere own that failure) but is reported so the caller can log it. */
export function gateDecision(comparison, maxRegression = PURITY_MAX_REGRESSION) {
  if (comparison.regression === null) return { block: false, reason: 'unscorable (empty sample or metadata) — gate abstains' }
  if (comparison.regression > maxRegression) {
    return {
      block: true,
      reason: `neighbour purity regressed ${comparison.regression.toFixed(4)} `
        + `(candidate ${comparison.candidate.purity.toFixed(4)} vs previous ${comparison.previous.purity.toFixed(4)}, `
        + `sample ${comparison.sampleSize} × k=${comparison.k}) — beyond the ${maxRegression} threshold`,
    }
  }
  return {
    block: false,
    reason: `neighbour purity ok (candidate ${comparison.candidate.purity.toFixed(4)} vs previous ${comparison.previous.purity.toFixed(4)}, regression ${comparison.regression.toFixed(4)} ≤ ${maxRegression})`,
  }
}
