/**
 * Plain words for a failed sync (Jake, 2026-09-06): what happened, whether
 * the iPod changed, what to do next — with the engine's original sentence
 * kept verbatim for Details. The engine's strings are NOT edited; this maps
 * them. Anything unmapped says plainly that the iPod's state is unknown.
 */
import type { SyncStep } from './sync-progress-model.ts'

export type IpodChanged = 'no' | 'partial' | 'unknown'
export interface SyncFailureCopy {
  stage: SyncStep | 'build' | 'device' | null
  happened: string
  changed: IpodChanged
  changedLine: string
  next: string
  raw: string
}

const CHANGED_LINE: Record<IpodChanged, string> = {
  no: 'Nothing on the iPod was changed.',
  partial: 'The iPod was partly rewritten: songs were copied but no catalog was written, so the previous catalog stands.',
  unknown: 'Whether the iPod changed is not known — check On This iPod before trusting the count.',
}

type Rule = { test: RegExp; stage: SyncFailureCopy['stage']; happened: string; changed: IpodChanged; next: string }

const RULES: Rule[] = [
  // device / before anything is wiped
  { test: /no verified ipod mount|ipod is not mounted|no ipod detected/i, stage: 'device', happened: 'No iPod was found.', changed: 'no', next: 'Plug it in (a direct USB port, no hub) and try again.' },
  { test: /library is empty|nothing to commit|could not build an activity set|api-failed|io-failed|build failed/i, stage: 'build', happened: 'The set could not be built.', changed: 'no', next: 'Try the sheet again; if it keeps failing, check the library and the brain services.' },
  { test: /your pool has \d+ songs/i, stage: 'build', happened: 'The pool is larger than the chosen size.', changed: 'no', next: 'Remove songs from the pool or pick a bigger size.' },
  { test: /activity tsa/i, stage: 'prepare', happened: 'Some songs could not board: a file is missing, has no destination, or would collide on the card.', changed: 'no', next: 'Open Details for the songs, fix or drop them, and sync again.' },
  { test: /activity wipe/i, stage: 'wipe', happened: 'The iPod could not be emptied for the clean rebuild.', changed: 'unknown', next: 'Reseat the cable (direct USB port) and sync again.' },
  { test: /sync cancelled/i, stage: 'copy', happened: 'You stopped the sync.', changed: 'partial', next: 'Sync again when ready; the previous catalog stands.' },
  { test: /confirmed on the card after copy/i, stage: 'copy', happened: 'Fewer songs reached the card than were sent.', changed: 'partial', next: 'Reseat the cable and sync again without unplugging.' },
  { test: /only prove the card on macos/i, stage: 'verify', happened: 'The card could not be proved on this system.', changed: 'partial', next: 'Sync from the Mac.' },
  { test: /could not verify the ipod \(remount failed/i, stage: 'verify', happened: 'The iPod would not remount to prove the write.', changed: 'partial', next: 'Sync again without unplugging; if it repeats, reseat the cable.' },
  { test: /held across two remounts/i, stage: 'verify', happened: 'Songs dropped off the card between two remounts.', changed: 'partial', next: 'Sync again; if it repeats, the card or cable is dropping writes.' },
  { test: /will not list/i, stage: 'verify', happened: 'Some songs would not be listed by the Mini’s firmware.', changed: 'partial', next: 'Open Details for the songs, drop or re-encode them, and sync again.' },
  { test: /could not be conformed to firmware id order|could not be laid down as one piece/i, stage: 'catalog', happened: 'The catalog could not be written correctly.', changed: 'partial', next: 'Sync again. The previous catalog is untouched.' },
  { test: /catalog file never made it onto the card|never committed to the card/i, stage: 'seal', happened: 'The catalog never reached the card.', changed: 'partial', next: 'Sync again without unplugging; the Mac cache is not the Mini.' },
  { test: /actually stuck on the iPod|card keeps dropping writes|stuck on the ipod/i, stage: 'seal', happened: 'Fewer songs stuck on the card than the set.', changed: 'partial', next: 'Reseat the cable and sync again; if it repeats, the card is failing.' },
  { test: /catalog on the card lists \d+ of \d+/i, stage: 'seal', happened: 'The card’s catalog lists fewer songs than the set.', changed: 'partial', next: 'Sync again without unplugging.' },
  { test: /catalog songs are not on the card/i, stage: 'seal', happened: 'Some catalogued songs are not on the card, which the Mini’s firmware cannot tolerate.', changed: 'partial', next: 'Sync again; if it repeats, reseat the cable.' },
  { test: /firmware-invalid song records/i, stage: 'seal', happened: 'The files are on the card but the catalog holds records the firmware would reject.', changed: 'partial', next: 'Sync again. Open Details if it repeats.' },
  { test: /tsa held \d+ of \d+ songs/i, stage: 'verify', happened: 'Some songs were held back because the Mini would not show them.', changed: 'partial', next: 'Open Details for the songs, drop or re-encode them, and sync again.' },
  { test: /could not build a seal|could not seal the set/i, stage: 'seal', happened: 'The songs are on the card but the set could not be sealed.', changed: 'partial', next: 'Sync again without unplugging.' },
  { test: /catalog was not sealed/i, stage: 'seal', happened: 'The catalog was written but not sealed.', changed: 'partial', next: 'Sync again.' },
  { test: /eject failed/i, stage: 'device', happened: 'The iPod could not be ejected.', changed: 'no', next: 'Close anything reading the card (a booted simulator counts), then eject again.' },
]

export function syncFailureCopy(raw: string): SyncFailureCopy {
  const text = String(raw || '').trim()
  for (const r of RULES) {
    if (r.test.test(text)) return { stage: r.stage, happened: r.happened, changed: r.changed, changedLine: CHANGED_LINE[r.changed], next: r.next, raw: text }
  }
  return { stage: null, happened: 'The sync stopped.', changed: 'unknown', changedLine: CHANGED_LINE.unknown, next: 'Open Details, then sync again with the iPod still plugged in.', raw: text || 'Sync failed' }
}
