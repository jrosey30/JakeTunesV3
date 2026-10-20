/**
 * Discovery feedback — the Record Shop's memory of Jake's verdicts
 * (discovery-feedback.json; moved out of main/index.ts 2026-10-20).
 * notForMe keys are normalized artist names ("not for me" = that artist never
 * surfaces in Discovery again); served tracks per-card view counts so stale
 * cards rotate out instead of squatting for weeks (the Vince Staples bug).
 *
 * Both Macs (2026-10-20): this Mac WRITES only its own file, through
 * discoveryFeedbackCache. Everything that DECIDES what to show reads
 * sharedDiscoveryFeedback(): the local file plus the other Mac's verdicts
 * (the copy the sync script pulls into taste-elsewhere/), merged by
 * src/common/taste-shared.ts. A "Not for me" on either Mac hides the artist
 * on both; an "Allow again" newer than it undoes it on both.
 */
import { join } from 'path'
import { JsonFileCache } from './state-cache'
import { STATE_DIR } from './state-dir'
import { triggerSync } from './sync-orchestrator'
import { elsewhereJson } from './taste-elsewhere.ts'
import { sharedFeedbackView, applyNotForMe, applyAllowAgain, type DiscoveryFeedback } from '../common/taste-shared.ts'

export type { DiscoveryFeedback }

export const DISCOVERY_FEEDBACK_FILE = 'discovery-feedback.json'

export const discoveryFeedbackCache = new JsonFileCache<DiscoveryFeedback>(
  () => join(STATE_DIR, DISCOVERY_FEEDBACK_FILE),
  () => ({ notForMe: {}, served: {} }),
  'discovery-feedback',
)

/** What the Record Shop honours: both Macs' verdicts. Read-only — never pass
 *  it to discoveryFeedbackCache.update. */
export async function sharedDiscoveryFeedback(): Promise<DiscoveryFeedback> {
  const local = await discoveryFeedbackCache.get()
  let elsewhere: Array<Partial<DiscoveryFeedback>> = []
  try {
    elsewhere = (await elsewhereJson(STATE_DIR, DISCOVERY_FEEDBACK_FILE)).map((x) => x.doc as Partial<DiscoveryFeedback>)
  } catch { /* no copies from the other Mac: this Mac's verdicts alone, as before */ }
  return sharedFeedbackView(local, elsewhere)
}

/** discovery-not-for-me's write. `restKeys` = an artist Jake owns: rest just
 *  those cards. null = the artist-level no. */
export async function recordNotForMe(key: string, artist: string, restKeys: string[] | null): Promise<void> {
  await discoveryFeedbackCache.update((cur) => applyNotForMe(cur, { key, artist, restKeys }, Date.now()))
  triggerSync('taste')
}

/** discovery-allow-again's write — stamped, so the undo travels too. */
export async function recordAllowAgain(key: string, artist: string): Promise<void> {
  await discoveryFeedbackCache.update((cur) => applyAllowAgain(cur, key, artist, Date.now()))
  triggerSync('taste')
}
