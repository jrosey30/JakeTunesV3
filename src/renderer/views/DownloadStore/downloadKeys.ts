/**
 * Download's name keys — one place, so DownloadView and the queue fold names
 * the same way, and node tests can reach them (DownloadView is .tsx).
 *
 * Any script (2026-10-11): these were foldAccents + [a-z0-9], which turned
 * every Hebrew/Cyrillic name into ''. One Hebrew song in the library made
 * every Hebrew result read "In your library", every Hebrew album in a search
 * collapsed into one row, and every Hebrew song queued under the same id.
 * Accents still fold first (JAŸ-Z → jayz) — see src/common/fold-text.ts.
 */
import { nameKey } from '../../../common/fold-text.ts'

/** Squashed key: library ownership, album-row identity, queue ids. */
export const norm = (s: string): string => nameKey(s, '')

/** Spaced key for relevance scoring.
 *  ⚠️ TWIN: src/renderer/utils/searchIndex.ts (normalize). They had DRIFTED
 *  once — searchIndex folded diacritics and this did not, which is why
 *  universal search found Beyoncé and Download rendered "Nothing matched
 *  that." for JAY-Z. */
export const normQ = (s: string): string => nameKey(s)
