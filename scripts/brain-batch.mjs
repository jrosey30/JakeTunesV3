/**
 * The brain trainer's nightly queue — its own module so tests can load it
 * without the trainer's import-time checks (the OpenAI key, the state dir).
 *
 * 2026-10-12 (Jake: "brain development needs improvement"): EVERY
 * not-yet-heard new add (last 14 days) is taken, newest first. At a fixed
 * 50/night the adds (~130/day in October) outran the trainer and 377 songs
 * sat unheard, the very songs he plays most. Only the historical backfill
 * (most-played first) is capped at `batch`. The trainer's run time budget
 * (BRAIN_MINUTES), not this count, bounds a giant import night.
 */
export function pickBatch(tracks, done, { now = Date.now(), batch = 300, recentMs = 14 * 24 * 60 * 60 * 1000 } = {}) {
  const addedMs = (t) => { const d = Date.parse(t.dateAdded || ''); return Number.isFinite(d) ? d : 0 }
  const isRecent = (t) => { const a = addedMs(t); return a > 0 && now - a < recentMs }
  const todo = tracks.filter(t => !done.has(String(t.id)) && (t.artist || t.title))
  const recent = todo.filter(isRecent).sort((a, b) => addedMs(b) - addedMs(a))
  const older = todo.filter(t => !isRecent(t)).sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0)).slice(0, batch)
  return [...recent, ...older]
}
