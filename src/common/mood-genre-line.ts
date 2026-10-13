/**
 * The genre line of the mood index's text (2026-10-13, Jake: "build the
 * Synthpop (Pop) fix"). ONE function for both writers — the nightly trainer
 * (scripts/brain-trainer.mjs moodText) and the app (src/main/ai/mood-index.ts
 * buildMoodText) both import it, so the line can't drift between them.
 *
 * Why: the 10/11 taxonomy turned coarse tags ("Pop", "Rap") into fine leaves
 * ("Synthpop", "Midwest Rap"). The 10/13 nightly rebuilt the mood index with
 * the leaves alone and broad searches lost their words: "pop music" 0.80 ->
 * 0.44 (brain-eval PROPOSAL-mood-umbrella-genre-line). The leaf now carries
 * its family and umbrella from the genre vocab, minus any word already
 * present, so the specific name and the broad one are both in the text.
 * Measured on the 3,531 re-tagged tracks: the old tag's words survive in 45%
 * of lines with the leaf alone, 66% with family + umbrella; nearly all the
 * rest is "Alternative", which stays strict on purpose.
 *
 *   Synthwave    -> Synthwave (New Wave & Synth, Pop)
 *   Synth-Pop    -> Synth-Pop (New Wave & Synth)   ("pop" is already there)
 *   Midwest Rap  -> Midwest Rap (Hip-Hop)
 *   Heavy Metal  -> Heavy Metal (Rock)
 *   Indie Rock   -> Indie Rock          ("rock" is already there)
 *   Soundtrack   -> Soundtrack          (not on the berg: no parents)
 */
import { GENRES } from './genre-vocab.ts'
import { UMBRELLAS } from './genre-iceberg.ts'

const FAMILY = new Map(GENRES.map((g) => [g.name, g.area]))
const words = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/hip-hop/g, 'hiphop').replace(/r&b/g, 'rnb').split(/[^a-z0-9]+/).filter((w) => w && w !== 'and'))

/** "Synthwave" -> "Synthwave (New Wave & Synth, Pop)"; unknown genres pass through. */
export function genreWithParents(genre: string): string {
  const leaf = genre.trim()
  if (!leaf) return ''
  const family = FAMILY.get(leaf)
  if (!family || family === 'Other') return leaf
  const umbrella = UMBRELLAS.find((u) => u.families.includes(family))?.name
  const seen = words(leaf)
  const parents: string[] = []
  for (const p of [family, umbrella]) {
    if (!p) continue
    const w = words(p)
    if ([...w].every((x) => seen.has(x))) continue
    parents.push(p)
    for (const x of w) seen.add(x)
  }
  return parents.length ? `${leaf} (${parents.join(', ')})` : leaf
}
