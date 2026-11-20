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

export type IpodChanged = 'no' | 'unknown' | 'emptied' | 'songs-only' | 'catalog-unverified' | 'swap-kept' | 'drop-kept'
export type CatalogClaim = 'previous' | 'unknown' | 'written-unverified'

export interface SyncFailureCopy {
  stage: SyncStep | 'build' | 'device' | null
  happened: string
  next: string
  raw: string
}

type Rule = { test: RegExp; stage: SyncFailureCopy['stage']; happened: string; next: string }

// Plain words (Jake, 2026-11-19: "its these confusing messages. its AI slop. it needs to be
// simple"): `happened` is one short line in his words, `next` says what to do only when he
// has to do something ('' otherwise). Whether the iPod changed is CHANGED_LINE's, from the
// phase evidence, never claimed here. The engine's own sentence stays in Details.
const AGAIN = 'Sync again.'
const AGAIN_CABLE = 'Sync again. If it happens again, try another cable or USB port.'
const HOMEMINI = 'Try again in a minute.'
const ITS_SONGS = 'Open Details to see which songs, then sync again.'

const RULES: Rule[] = [
  // The page's own refusals before anything touches the iPod (DeviceView, ipod-ready-on-mac,
  // ipod-one-sync). They are already plain: shown as written (happened '' = the message itself).
  { test: /stopped downloading|couldn’t get ready to sync|changed while its songs were downloading|songs are in your library|^set up this ipod/i, stage: 'build', happened: '', next: '' },
  // Refusals before the iPod is touched: the plug-in health check (common/ipod-onboarding.ts
  // healthSyncRefusal / healthBlindRefusal), the identity gate and the card-fit check. Their own
  // line says what to do; the sync never started. sync-front-end-models.test.ts runs each one.
  { test: /is in a different ipod|has a different card now|needs erasing|^unplug the ipod, plug it back in|^the ipod changed|won’t fit on/i, stage: 'build', happened: '', next: '' },
  { test: /^plug in the ipod/i, stage: 'device', happened: '', next: '' },
  { test: /no verified ipod mount|ipod is not mounted|no ipod detected/i, stage: 'device', happened: 'No iPod found.', next: 'Plug it straight into the Mac and try again.' },
  { test: /library is empty|nothing to commit|could not build an activity set|api-failed|io-failed|build failed/i, stage: 'build', happened: 'Couldn’t get the songs ready.', next: AGAIN },
  // One button per iPod (2026-11-07, main/ipod-one-sync.ts): refused before anything is written.
  { test: /top 1000 can’t be read right now|list couldn’t be read|can’t get the top 1000|can’t get .+ songs right now/i, stage: 'build', happened: 'Couldn’t get this iPod’s songs.', next: HOMEMINI },
  { test: /list is empty\. songs are added|has no songs yet/i, stage: 'build', happened: 'This iPod has no songs yet.', next: '' },
  { test: /none of the [\d,]+ songs on .+ list can go on it|none of the top 1000 can go on|none of .+ songs can go on it/i, stage: 'build', happened: 'None of this iPod’s songs can go on it.', next: ITS_SONGS },
  // A list-only iPod (every iPod but the Original, 2026-11-07) with nothing in its Pool.
  { test: /pool is empty\. only its pool goes on/i, stage: 'build', happened: 'This iPod has no songs yet.', next: '' },
  { test: /songs on this ipod's list (can go on it|could be converted for it)/i, stage: 'prepare', happened: 'None of this iPod’s songs can go on it.', next: ITS_SONGS },
  { test: /your pool has \d+ songs/i, stage: 'build', happened: 'Too many songs for this iPod.', next: 'Remove some, then sync again.' },
  // #47 fill-to-N (merged 2026-10-08): refused before the wipe — the library cannot fill N.
  { test: /only \d+ of \d+ requested songs can land/i, stage: 'prepare', happened: 'Not enough songs can go on.', next: 'Pick a smaller size, then sync again.' },
  { test: /activity tsa/i, stage: 'prepare', happened: 'Some songs can’t go on.', next: ITS_SONGS },
  { test: /have damaged audio and there are not enough replacements/i, stage: 'prepare', happened: 'Some songs are damaged.', next: 'Download them again, then sync.' },
  { test: /could not build an ipod-safe alac|flac→alac failed/i, stage: 'prepare', happened: 'A song couldn’t be converted for the iPod.', next: ITS_SONGS },
  { test: /could be fetched from homemini\. nothing on the ipod was touched/i, stage: 'prepare', happened: 'Couldn’t download the new songs.', next: HOMEMINI },
  { test: /arriving song\(s\) and there are not enough replacements/i, stage: 'prepare', happened: 'Couldn’t download some new songs.', next: HOMEMINI },
  { test: /could be fetched from homemini\. not writing a catalog/i, stage: 'copy', happened: 'Couldn’t download the new songs.', next: HOMEMINI },
  { test: /swap’s removal step/i, stage: 'wipe', happened: 'Couldn’t remove the old songs.', next: AGAIN_CABLE },
  { test: /activity wipe/i, stage: 'wipe', happened: 'Couldn’t clear the iPod.', next: AGAIN_CABLE },
  { test: /sync cancelled/i, stage: 'copy', happened: 'You stopped the sync.', next: '' },
  // Brief 260: the iPod's USB reset mid-copy and it never came back, or another iPod did.
  { test: /disconnected during the copy and didn’t come back|kept disconnecting/i, stage: 'copy', happened: 'The iPod disconnected.', next: AGAIN_CABLE },
  { test: /a different ipod came back/i, stage: 'copy', happened: 'A different iPod was plugged in.', next: 'Plug the first iPod back in and sync again.' },
  { test: /confirmed on the card after copy/i, stage: 'copy', happened: 'Some songs didn’t copy.', next: AGAIN_CABLE },
  { test: /only prove the card on macos/i, stage: 'verify', happened: 'This computer can’t check the iPod.', next: 'Sync from the Mac.' },
  { test: /could not verify the ipod \(remount failed/i, stage: 'verify', happened: 'Couldn’t check the iPod.', next: AGAIN },
  { test: /held across two remounts/i, stage: 'verify', happened: 'Some songs didn’t stay on the iPod.', next: AGAIN_CABLE },
  { test: /will not list/i, stage: 'verify', happened: 'Some songs won’t show on the iPod.', next: ITS_SONGS },
  { test: /tsa held \d+ of \d+ songs/i, stage: 'verify', happened: 'Some songs won’t show on the iPod.', next: ITS_SONGS },
  { test: /the catalog would list are not on the card/i, stage: 'catalog', happened: 'Some songs didn’t make it onto the iPod.', next: AGAIN_CABLE },
  { test: /could not be conformed to firmware id order|could not be laid down as one piece/i, stage: 'catalog', happened: 'Couldn’t write the iPod’s song list.', next: AGAIN },
  { test: /catalog file never made it onto the card|never committed to the card/i, stage: 'seal', happened: 'Couldn’t write the iPod’s song list.', next: AGAIN },
  { test: /catalog on the card lists \d+ of \d+/i, stage: 'seal', happened: 'The iPod’s song list came up short.', next: AGAIN },
  { test: /catalog songs are not on the card/i, stage: 'seal', happened: 'Some songs didn’t make it onto the iPod.', next: AGAIN_CABLE },
  { test: /firmware-invalid song records/i, stage: 'seal', happened: 'The iPod’s song list came out wrong.', next: AGAIN },
  { test: /could not build a seal|could not seal the set/i, stage: 'seal', happened: 'The sync didn’t finish.', next: AGAIN },
  { test: /actually stuck on the ipod|card keeps dropping writes|stuck on the ipod/i, stage: 'seal', happened: 'Some songs didn’t stay on the iPod.', next: AGAIN_CABLE },
  { test: /catalog was not sealed/i, stage: 'seal', happened: 'The sync didn’t finish.', next: AGAIN },
  { test: /eject failed/i, stage: 'device', happened: 'Couldn’t eject the iPod.', next: 'Close anything using it, then eject again.' },
]

export function syncFailureCopy(raw: string): SyncFailureCopy {
  const text = String(raw || '').trim()
  for (const r of RULES) {
    if (r.test.test(text)) return { stage: r.stage, happened: r.happened || text, next: r.next, raw: text }
  }
  return { stage: null, happened: 'The sync stopped.', next: AGAIN, raw: text || 'Sync failed' }
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
  no: 'Nothing on the iPod changed.',
  unknown: 'The iPod may be half-synced. Sync again before you use it.',
  emptied: 'The iPod’s songs were cleared. Sync again before you use it.',
  'songs-only': 'The iPod still shows its old songs until you sync again.',
  'catalog-unverified': 'The iPod may show the wrong songs until you sync again.',
  'swap-kept': 'The iPod still works. Sync again to finish.',
  'drop-kept': 'The songs copied so far stay on the iPod. Sync again: it copies only the rest.',
}

/** Appended by the Activity engine when an abort after the wipe removed
 *  the songs it had copied (rewipeAndStop) — the claim then is 'emptied'
 *  whatever step the abort happened at. */
export const REWIPED_NOTE = 'The songs copied this run were taken off the card again.'

/** Appended by the Activity engine when a SWAP stops (2026-11-07): the files
 *  it copied came off again and the card's catalog names only songs that are
 *  on it. `restored` = the card is exactly as the last sync left it. */
export const SWAP_KEPT_MARK = 'The iPod still has a working song list'
export function swapKeptNote(songs: number, restored: boolean): string {
  const n = songs.toLocaleString('en-US')
  return restored
    ? `${SWAP_KEPT_MARK}: nothing on it changed, all ${n} songs are still there.`
    : `${SWAP_KEPT_MARK} of the ${n} songs on it. Sync again to finish.`
}

/** Appended by the Activity engine when the iPod dropped off USB mid-copy and
 *  didn't come back (Brief 260, 2026-11-20): nothing was taken off the card,
 *  and the next sync adopts what was confirmed instead of copying it again. */
export const DROP_KEPT_MARK = 'The songs copied so far stay on the iPod'
export function dropKeptNote(songs: number): string {
  return `${DROP_KEPT_MARK} (${songs.toLocaleString('en-US')}); the next sync copies only the rest.`
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
  if ((t.error || '').includes(REWIPED_NOTE)) { changed = 'emptied'; catalog = 'previous' }
  else if ((t.error || '').includes(DROP_KEPT_MARK)) { changed = 'drop-kept'; catalog = 'previous' }
  else if ((t.error || '').includes(SWAP_KEPT_MARK)) {
    const untouched = (t.error || '').includes('nothing on it changed')
    changed = untouched ? 'no' : 'swap-kept'
    catalog = untouched ? 'previous' : 'unknown'
  }
  return { ...copy, stoppedAt, changed, catalog, changedLine: CHANGED_LINE[changed], fromEvidence: evidence }
}

/** "Sync stopped" — the lead of the result line. The step it stopped at is the strip's
 *  ✕, and Details names it; the line itself stays plain (2026-11-19). */
export function stoppedLabel(_o: SyncOutcome): string {
  return 'Sync stopped'
}

/**
 * The whole stopped-sync message as one line: what happened, whether the iPod changed,
 * and what to do (only when there is something to do), with nothing said twice.
 */
export function outcomeLine(o: SyncOutcome): string {
  // The page's own refusals (shown as written) come before the iPod is touched, and with no
  // iPod there "nothing on the iPod changed" says nothing: no changed line for either.
  const quiet = o.changed === 'no' && (o.happened === o.raw || o.stoppedAt === 'device')
  const parts = [o.happened, quiet ? '' : o.changedLine]
  // "Sync again." after a changed line that already says to sync again is said once.
  if (o.next && !(/sync again/i.test(o.changedLine) && o.next === AGAIN)) parts.push(o.next)
  return parts.filter(Boolean).join(' ')
}
