/**
 * homeCache — Home's fetched data, kept across mounts.
 *
 * Jake, 2026-08-09: "tackle loading pages (they are unacceptable right now)
 * they appear too often too."
 *
 * The "too often" was structural, not cosmetic. Home fires six independent
 * fetches (listening memory, rediscover, news+releases, tour dates, venue
 * shows, weather) and holds the WHOLE page behind a skeleton until they all
 * settle or a 2.5 s cap expires. Every one of those lived in a useEffect with
 * no storage outside the component, so leaving Home and coming back threw all
 * six results away and did it again — the skeleton on every single visit,
 * for up to two and a half seconds each time, showing data that hadn't
 * changed since a minute ago.
 *
 * So: results live here instead. A return visit paints from cache on the
 * FIRST render — no gate at all — and the fetches still run underneath to
 * refresh. The gate is now only what it was always meant to be: what you see
 * the first time, on a cold library, and never again after that.
 *
 * Module store (same as mixtapes.ts / liveSets.ts) because LibraryContext is
 * do-not-touch. Deliberately NOT persisted to disk: this is "don't refetch
 * what you just fetched", not a durable cache. A fresh launch should ask,
 * because tour dates and weather age badly and a stale Home is worse than a
 * one-time skeleton.
 */

const store = new Map<string, { at: number; value: unknown }>()

/** How long a cached lane is served before a visit is treated as cold. */
const MAX_AGE_MS = 30 * 60 * 1000

export function getCached<T>(key: string): T | undefined {
  const hit = store.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > MAX_AGE_MS) { store.delete(key); return undefined }
  return hit.value as T
}

export function setCached(key: string, value: unknown): void {
  store.set(key, { at: Date.now(), value })
}

/**
 * True when every lane already has a fresh value — i.e. this is a return
 * visit and Home can paint immediately with no loading state whatsoever.
 * A lane that legitimately has no data caches `null`, which still counts as
 * settled; absence of an ENTRY is what marks a lane as never-fetched.
 */
export function isWarm(keys: readonly string[]): boolean {
  return keys.every((k) => {
    const hit = store.get(k)
    return !!hit && Date.now() - hit.at <= MAX_AGE_MS
  })
}

/** Drop everything — for a hard refresh action. */
export function clearHomeCache(): void {
  store.clear()
}
