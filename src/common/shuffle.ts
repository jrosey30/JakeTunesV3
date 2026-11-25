/**
 * One shuffle for the whole app (V7, 2026-11-24).
 *
 * Eleven places shuffled with `[...list].sort(() => Math.random() - 0.5)`.
 * That is not a shuffle: a comparison sort asked random questions gives a
 * lopsided order (V8's sort leaves the first songs near the front far more
 * often than chance), so "Shuffle" kept opening on the same few songs.
 * Fisher–Yates gives every order the same chance. `rng` is for tests.
 */
export function shuffle<T>(list: readonly T[], rng: () => number = Math.random): T[] {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}
