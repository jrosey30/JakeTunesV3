/**
 * Plain words for a stopped sync (Jake, 2026-09-06): what happened, whether
 * the iPod changed, what to do next — with the engine's original sentence
 * kept verbatim for Details. The engine's strings are NOT edited.
 *
 * Two layers, on purpose:
 *  - `syncFailureCopy(raw)` reads the MESSAGE for "what happened" and "what
 *    to do". It never claims what the iPod holds.
 *  - `syncOutcome(timeline)` derives the mutation and catalog claims from the
 *    PHASE EVIDENCE (which steps were reached, where it stopped, how it
 *    ended), matching what the engine actually does at each stage:
 *      stopped before Wipe            → nothing changed
 *      stopped during Wipe            → unknown
 *      cancelled / failed during Copy → the engine re-empties Music: the card
 *                                        has no songs; previous catalog stands
 *      failed during Verify / Catalog → new songs on the card; previous
 *                                        catalog stands (not replaced)
 *      failed during Seal             → a new catalog was written but the card
 *                                        did not prove it — unverified
 *      no phase evidence              → unknown, said so
 *    A short count is never a card diagnosis on its own.
 */
import type { SyncStep, SyncTimeline } from './sync-progress-model.ts'
import { stepLabel } from './sync-progress-model.ts'

export type IpodChanged = 'no' | 'unknown' | 'emptied' | 'songs-only' | 'catalog-unverified'
export type CatalogClaim = 'previous' | 'unknown' | 'written-unverified'

export interface SyncFailureCopy {
  stage: SyncStep | 'build' | 'device' | null
  happened: string
  next: string
  raw: string
}

type Rule = { test: RegExp; stage: SyncFailureCopy['stage']; happened: string; next: string }

const AGAIN = 'Sync again without unplugging.'
const AGAIN_CABLE = 'Sync again without unplugging. If it comes up short again, check the cable and the port before anything else.'

const RULES: Rule[] = [
  { test: /no verified ipod mount|ipod is not mounted|no ipod detected/i, stage: 'device', happened: 'No iPod was found.', next: 'Plug it in (a direct USB port, no hub) and try again.' },
  { test: /library is empty|nothing to commit|could not build an activity set|api-failed|io-failed|build failed/i, stage: 'build', happened: 'The set could not be built.', next: 'Try the sheet again; if it keeps failing, check the library and the brain services.' },
  { test: /your pool has \d+ songs/i, stage: 'build', happened: 'The pool is larger than the chosen size.', next: 'Remove songs from the pool or pick a bigger size.' },
  { test: /activity tsa/i, stage: 'prepare', happened: 'Some songs could not board: a file is missing, has no destination, or would collide on the card.', next: 'Open Details for the songs, fix or drop them, and sync again.' },
  { test: /activity wipe/i, stage: 'wipe', happened: 'The iPod could not be emptied for the clean rebuild.', next: 'Reseat the cable (direct USB port) and sync again.' },
  { test: /sync cancelled/i, stage: 'copy', happened: 'You stopped the sync.', next: 'Sync again when ready.' },
  { test: /confirmed on the card after copy/i, stage: 'copy', happened: 'Fewer songs reached the card than were sent.', next: AGAIN_CABLE },
  { test: /only prove the card on macos/i, stage: 'verify', happened: 'The card could not be proved on this system.', next: 'Sync from the Mac.' },
  { test: /could not verify the ipod \(remount failed/i, stage: 'verify', happened: 'The iPod would not remount to prove the write.', next: AGAIN },
  { test: /held across two remounts/i, stage: 'verify', happened: 'Songs dropped off the card between two remounts.', next: AGAIN_CABLE },
  { test: /will not list/i, stage: 'verify', happened: 'Some songs would not be listed by the Mini’s firmware.', next: 'Open Details for the songs, drop or re-encode them, and sync again.' },
  { test: /tsa held \d+ of \d+ songs/i, stage: 'verify', happened: 'Some songs were held back because the Mini would not show them.', next: 'Open Details for the songs, drop or re-encode them, and sync again.' },
  { test: /could not be conformed to firmware id order|could not be laid down as one piece/i, stage: 'catalog', happened: 'The new catalog could not be written correctly.', next: AGAIN },
  { test: /catalog file never made it onto the card|never committed to the card/i, stage: 'seal', happened: 'The new catalog did not reach the card.', next: AGAIN },
  { test: /catalog on the card lists \d+ of \d+/i, stage: 'seal', happened: 'The card’s catalog lists fewer songs than the set.', next: AGAIN },
  { test: /catalog songs are not on the card/i, stage: 'seal', happened: 'Some catalogued songs are not on the card, which the Mini’s firmware cannot tolerate.', next: AGAIN_CABLE },
  { test: /firmware-invalid song records/i, stage: 'seal', happened: 'The files are on the card but the catalog holds records the firmware would reject.', next: AGAIN },
  { test: /could not build a seal|could not seal the set/i, stage: 'seal', happened: 'The songs are on the card but the set could not be sealed.', next: AGAIN },
  { test: /actually stuck on the ipod|card keeps dropping writes|stuck on the ipod/i, stage: 'seal', happened: 'Fewer songs stuck on the card than the set.', next: AGAIN_CABLE },
  { test: /catalog was not sealed/i, stage: 'seal', happened: 'The catalog was written but not sealed.', next: AGAIN },
  { test: /eject failed/i, stage: 'device', happened: 'The iPod could not be ejected.', next: 'Close anything reading the card (a booted simulator counts), then eject again.' },
]

export function syncFailureCopy(raw: string): SyncFailureCopy {
  const text = String(raw || '').trim()
  for (const r of RULES) {
    if (r.test.test(text)) return { stage: r.stage, happened: r.happened, next: r.next, raw: text }
  }
  return { stage: null, happened: 'The sync stopped.', next: 'Open Details, then sync again with the iPod still plugged in.', raw: text || 'Sync failed' }
}

export interface SyncOutcome extends SyncFailureCopy {
  /** Where it stopped, from the evidence (falls back to the message's stage). */
  stoppedAt: SyncStep | 'build' | 'device' | null
  changed: IpodChanged
  catalog: CatalogClaim
  changedLine: string
  /** True when the claim rests on phase evidence rather than the message alone. */
  fromEvidence: boolean
}

const CHANGED_LINE: Record<IpodChanged, string> = {
  no: 'Nothing on the iPod was changed.',
  unknown: 'Whether the iPod changed is not known — check On This iPod before trusting any count.',
  emptied: 'The copied songs were cleared again and no catalog was written. The previous catalog stands, but its songs are no longer on the card — sync again before using the iPod.',
  'songs-only': 'The new songs are on the card, but the catalog was not replaced. The iPod will show the old list until you sync again.',
  'catalog-unverified': 'The new songs are on the card and a new catalog was written, but the card did not prove it. Do not trust the count the iPod shows until a sync seals.',
}

/** The claims, from what actually happened. */
export function syncOutcome(t: SyncTimeline): SyncOutcome | null {
  if (t.status !== 'failed' && t.status !== 'cancelled') return null
  const copy = t.status === 'cancelled' ? syncFailureCopy('Sync cancelled by user') : syncFailureCopy(t.error || '')
  const evidence = t.seen > 0 && t.step != null
  const stoppedAt: SyncOutcome['stoppedAt'] = evidence ? t.step : copy.stage
  let changed: IpodChanged = 'unknown'
  let catalog: CatalogClaim = 'unknown'
  if (!evidence) {
    // No phases seen: only "nothing happened" stages can be trusted from the message.
    if (copy.stage === 'build' || copy.stage === 'device' || copy.stage === 'prepare') { changed = 'no'; catalog = 'previous' }
  } else {
    const catalogDone = t.reached.includes('catalog') && (t.step === 'seal' || t.status === 'failed' && t.step === 'catalog' && t.current >= t.total && t.total > 0)
    switch (t.step) {
      case 'prepare': changed = 'no'; catalog = 'previous'; break
      case 'wipe': changed = 'unknown'; catalog = 'unknown'; break
      case 'copy': changed = 'emptied'; catalog = 'previous'; break        // the engine re-empties Music on abort or cancel
      case 'verify': changed = 'songs-only'; catalog = 'previous'; break
      case 'catalog': changed = catalogDone ? 'catalog-unverified' : 'songs-only'; catalog = catalogDone ? 'written-unverified' : 'previous'; break
      case 'seal': changed = 'catalog-unverified'; catalog = 'written-unverified'; break
    }
  }
  return { ...copy, stoppedAt, changed, catalog, changedLine: CHANGED_LINE[changed], fromEvidence: evidence }
}

/** "Stopped at Verify" / "Stopped" — the lead of the result line. */
export function stoppedLabel(o: SyncOutcome): string {
  if (!o.stoppedAt || o.stoppedAt === 'build' || o.stoppedAt === 'device') return 'Stopped'
  return `Stopped at ${stepLabel(o.stoppedAt)}`
}
