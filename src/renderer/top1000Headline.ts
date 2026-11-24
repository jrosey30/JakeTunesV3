// The Top 1000's headline — renderer store (2026-11-14, common/ipod-ad.ts): the
// line at the top of its page. homemini keeps it (main/ipod-headlines.ts) so
// every Mac and the phone match; with none it is "The thousand that made it."
//
// The first ask is for this Mac's own copy (disk, no network), so the page
// paints the right words at once; homemini's answer follows and only changes
// them when Jake changed the headline somewhere else.
// Same module-store idiom as top1000Name.ts.
import { useEffect, useSyncExternalStore } from 'react'
import { checkHeadline, cleanStory, homeminiCounts, type HomeminiCounts } from '../common/ipod-ad'

let headline: string | null = null
let asked = false
let inFlight: Promise<void> | null = null
/** Bumped by every local change, so an answer asked for before it can't put the old line back. */
let edits = 0
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): string | null => headline
/** homemini's song and artist counts for the Top 1000 (both or none; Mobile #798). */
let counts: HomeminiCounts | null = null
const getCounts = (): HomeminiCounts | null => counts
function putCounts(next: HomeminiCounts | null): void {
  if (next?.songCount === counts?.songCount && next?.artistCount === counts?.artistCount) return
  counts = next
  for (const l of listeners) l()
}
/** Jake's story under the Top 1000's ad (2026-11-24); homemini's, read only. null = none. */
let story: string | null = null
const getStory = (): string | null => story
function putStory(next: string | null): void {
  if (next === story) return
  story = next
  for (const l of listeners) l()
}
function put(next: string | null): void {
  if (next === headline) return
  headline = next
  for (const l of listeners) l()
}

async function ask(local: boolean): Promise<void> {
  const at = edits
  const r = await window.electronAPI.top1000HeadlineGet?.(local)
  if (!r?.ok) return
  putCounts(homeminiCounts(r.counts))
  putStory(cleanStory(r.story))
  if (at === edits) put(r.headline)
}

/** Ask main: this Mac's copy first (the first time), then homemini's. Overlapping asks share one read. */
export function refreshTop1000Headline(): Promise<void> {
  if (inFlight) return inFlight
  const first = !asked
  asked = true
  inFlight = (first ? ask(true) : Promise.resolve())
    .then(() => ask(false))
    .catch((err: unknown) => { console.warn('[top1000-headline] read failed:', err instanceof Error ? err.message : err) })
    .finally(() => { inFlight = null })
  return inFlight
}

/** Jake's headline for the Top 1000, or null (the page shows the default line). Mounting asks again. */
export function useTop1000Headline(): string | null {
  const s = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => { void refreshTop1000Headline() }, [])
  return s
}

/** homemini's counts for the Top 1000's copy line, or null (the page counts its own). Shares the headline's read. */
export function useTop1000Counts(): HomeminiCounts | null {
  const c = useSyncExternalStore(subscribe, getCounts)
  useEffect(() => { void refreshTop1000Headline() }, [])
  return c
}

/** Jake's story for the Top 1000, or null (nothing is shown under the ad). Shares the headline's read. */
export function useTop1000Story(): string | null {
  const s = useSyncExternalStore(subscribe, getStory)
  useEffect(() => { void refreshTop1000Headline() }, [])
  return s
}

/** Headline… on the Top 1000: shown at once; the old line comes back on a refusal. Empty = the default. */
export async function setTop1000Headline(raw: string): Promise<{ ok: true; headline: string | null; homemini: 'saved' | 'later' } | { ok: false; error: string }> {
  const check = checkHeadline(raw)
  if (!check.ok) return check
  const before = headline
  edits++
  put(check.headline)
  const r = await (window.electronAPI.ipodHeadlineSet?.({ key: 'top1000', headline: check.headline }) ?? Promise.resolve({ ok: false as const, error: 'Headlines need a newer JakeTunes.' }))
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : 'couldn’t save the headline' }))
  if (!r.ok) {
    edits++
    put(before)
    return r
  }
  return r
}
