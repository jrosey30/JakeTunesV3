/**
 * Pure additive union of two star-id sets — dedupes + sorts. Shared by the
 * sync-incoming merge (index.ts) and node --test.
 *
 * ADDITIVE BY DESIGN: mobile-stars.json is a bare set of track ids with no
 * per-star timestamps, so a star present on EITHER device survives the merge.
 * The consequence (accepted, sync B-pass 2026-06-07): un-starring on one device
 * a track still starred on the other will reappear on the next sync — the star
 * wins. True both-way un-star propagation needs per-star timestamps on desktop
 * AND the iOS app; until then this matches the app's existing "never auto-lower
 * a rating" behavior (App.tsx mobile-stars apply).
 */
export function mergeStarIds(local: string[], incoming: string[]): string[] {
  const set = new Set<string>()
  for (const id of local) if (typeof id === 'string' && id) set.add(id)
  for (const id of incoming) if (typeof id === 'string' && id) set.add(id)
  return Array.from(set).sort()
}
