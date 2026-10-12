/**
 * The "you already own this album" key for Music Man's album picks
 * (musicman-recommendations in index.ts). Moved out of index.ts so it can
 * be tested.
 *
 * ⚠️ Intentionally NOT shared with the file-identity normalize in index.ts
 * (twin-paired with core/repair_mismatches.py). That one is for sync-time
 * identity matching and any change must be mirrored in Python. This one is
 * local, non-destructive, and free to evolve. Do not consolidate.
 *
 * Any script (2026-10-11): the last step stripped [^a-z0-9], so every
 * all-Hebrew or all-Cyrillic artist|album keyed as '|', and owning one such
 * album hid every such pick as "already owned". The strip is now nameKey's.
 */
import { foldAccents, nameKey } from '../common/fold-text.ts'

export function normForOwnership(s: string): string {
  if (!s) return ''
  return nameKey(
    foldAccents(s.normalize('NFKD'))                              // strip diacritics, ø → o
      .replace(/\s*[\(\[][^\)\]]*[\)\]]\s*/g, ' ')            // drop ( ... ) and [ ... ]
      .replace(/\bpts?\b\.?/g, m => m.startsWith('pts') ? 'parts' : 'part')
      .replace(/\bvols?\b\.?/g, m => m.startsWith('vols') ? 'volumes' : 'volume')
      .replace(/\bno\.?\s*(\d)/g, 'number $1')                // "No. 1" → "number 1"
      .replace(/&/g, ' and ')
      .replace(/\bthe\b/g, ' '),
  )                                                           // strip remaining punct (no mid-word merging), any script
}
