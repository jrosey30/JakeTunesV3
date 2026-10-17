/**
 * Activity sheet memory (2026-10-17). The sheet used to open on the built-in
 * default every plug-in: the last brief only lived in DeviceView's memory,
 * and unplugging bounces the Device page to Songs, so it was gone. Saved
 * profiles (main: activity-context.ts, userData/activity-profiles.json)
 * already carry everything — the sheet now starts from the newest one.
 *
 * Pure — node --test loads it; the sheet and its tests share these rules.
 */

export interface ProfileLike {
  id?: string
  profileName?: string
  updatedAt?: string
}

function stamp(p: ProfileLike): number {
  const t = Date.parse(String(p.updatedAt ?? ''))
  return Number.isFinite(t) ? t : -Infinity
}

/** Newest first by updatedAt; the file's own order breaks ties. */
function byNewest<T extends ProfileLike>(list: readonly T[]): T[] {
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (stamp(b.p) - stamp(a.p)) || (a.i - b.i))
    .map((x) => x.p)
}

/** The profile the sheet starts from when nothing else was passed in. */
export function newestProfile<T extends ProfileLike>(list: readonly T[]): T | null {
  const valid = (list || []).filter((p) => p && typeof p.id === 'string' && p.id)
  return byNewest(valid)[0] ?? null
}

/** The "Saved" chips: newest first, one chip per name (every sync used to
 *  save a fresh copy, so the file holds several "Run · Brooklyn"s). */
export function profileChips<T extends ProfileLike>(list: readonly T[], limit = 6): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const p of byNewest((list || []).filter((x) => x && typeof x.id === 'string' && x.id))) {
    const key = String(p.profileName ?? '').trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}

export interface BriefIdentity {
  id?: string
  profileName?: string
  activity: string
  place: string
}

/**
 * A brief that started from a saved profile carries that profile's id and
 * name, and main saves the sync back onto that id (saveActivityProfile).
 * The name describes "activity · place" — so if either changed, this is a
 * DIFFERENT profile: drop the id and name, and main files it as a new one
 * under its own name instead of overwriting the old one under the wrong
 * name. Changing back before confirming keeps the link.
 */
export function detachChangedProfile<B extends BriefIdentity>(
  brief: B,
  source: { id: string; activity: string; place: string } | null,
): B {
  if (!brief.id && !brief.profileName) return brief
  const norm = (s: string) => String(s ?? '').trim().toLowerCase()
  const same = !!source && brief.id === source.id &&
    brief.activity === source.activity && norm(brief.place) === norm(source.place)
  if (same) return brief
  const { id: _id, profileName: _name, ...rest } = brief
  return rest as B
}
