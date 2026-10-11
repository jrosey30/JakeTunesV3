/** Title key for the Artist page's owned-vs-discography matching. */
import { nameKey } from '../../common/fold-text.ts'

/**
 * Normalize a track title for cross-source matching. Strips parens
 * (Remastered), (Deluxe), (feat. X), trailing " - 2019 Mix" suffixes,
 * then collapses non-alphanumeric so canonical → library matching
 * tolerates the small label/release variants that otherwise sink the
 * match rate. Conservative — leans toward false-misses over false-hits
 * since a wrong "owned" badge would be more confusing than missing one.
 *
 * Any script, accents folded (nameKey). Under [a-z0-9] every Hebrew title
 * normalized to '', so one owned Hebrew song made every Hebrew track in the
 * discography read as owned (2026-10-11).
 */
export function normTitle(s: string): string {
  return nameKey(s.toLowerCase()
    // 4.5.0-74 — expand common title-word abbreviations BEFORE stripping
    // punctuation, so "Dr. Robert" matches "Doctor Robert", "St. Anger"
    // matches "Saint Anger", "Rock & Roll" matches "Rock and Roll".
    // Pre-fix, "Dr. Robert" normalized to "drrobert" and "Doctor Robert"
    // to "doctorrobert" — different strings, owned-match failed, the
    // track Jake was literally playing rendered as not-owned in the
    // discography. Match runs in both directions because both sides
    // route through this same function.
    .replace(/\bdr\.?\s+/g, 'doctor ')
    .replace(/\bmr\.?\s+/g, 'mister ')
    .replace(/\bms\.?\s+/g, 'miss ')
    .replace(/\bst\.?\s+/g, 'saint ')
    .replace(/\bpt\.?\s+/g, 'part ')
    .replace(/\bft\.?\s+/g, 'featuring ')
    .replace(/\bfeat\.?\s+/g, 'featuring ')
    .replace(/\bvs\.?\s+/g, 'versus ')
    .replace(/\bno\.?\s+(\d)/g, 'number $1')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s*\((?:feat\.?|featuring|with|prod\.?|produced by)[^)]+\)/g, '')
    .replace(/\s*\[(?:feat\.?|featuring|with)[^\]]+\]/g, '')
    .replace(/\s*\((?:remaster(?:ed)?|deluxe|bonus|live|single version|album version|edit|mono|stereo|reissue|expanded|remix|alternate|demo)[^)]*\)/g, '')
    .replace(/\s+-\s+(?:remaster(?:ed)?|deluxe|bonus|live|single version|album version|edit|mono|stereo|reissue|expanded|remix|alternate|demo)[^-]*$/g, ''), '')
}
