/** Pure, dependency-free strict-matching normalizer shared by the artwork
 * resolver (searchDeezerArt) and the preview refresher. Extracted from
 * artwork-engine so unit tests can import it without the electron chain. */
// Normalize an artist/album string for strict matching: drop edition
// parens/brackets, a leading "the", and collapse whitespace.
export function normalizeArtTerm(s: string): string {
  return s.toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}
