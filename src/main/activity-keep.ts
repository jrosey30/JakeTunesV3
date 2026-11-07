/**
 * Activity Sync — the targeted-wipe proof.
 *
 * 2026-09-19 this file also held a keep plan (sealedManifestRows / keepVerdict
 * / activityKeepPlan). It never kept a song in production: the engine wrote
 * its in-flight manifest before reading the last one, so every sync copied
 * the whole set. The swap-only sync (ipod-swap-sync.ts, 2026-11-07) replaces
 * it with a proven plan: seal + manifest + the card's own catalog bytes +
 * every file's size, then identity by fingerprint and size. What it solved
 * (keep a song only by identity, never text) is covered there, with the same
 * rules and more.
 *
 * Pure, so node --test loads it.
 */

/**
 * A targeted wipe is proven when the card lists EXACTLY the keep set —
 * nothing extra, nothing missing — on consecutive listings. With an empty
 * keep set this is the old "proven empty".
 */
export function wipeListingMatchesKeep(listed: string[], keepAbs: Set<string>): boolean {
  if (listed.length !== keepAbs.size) return false
  for (const p of listed) if (!keepAbs.has(p)) return false
  return true
}

export function keepStreak(matches: boolean, prevStreak: number): number {
  const prev = Math.max(0, Math.floor(Number(prevStreak) || 0))
  return matches ? prev + 1 : 0
}
