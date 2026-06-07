/**
 * 4.5.0-43: artist canonicalization.
 *
 * Tracks come into the library tagged with whatever the file metadata
 * says — "Paul McCartney & Wings", "Wings", "John Lennon / Plastic Ono
 * Band". Without canonicalization the Artists view scatters these into
 * separate rows, and Paul McCartney's discography looks like he made
 * 3 albums when he actually has dozens spread across personas.
 *
 * This module returns the canonical artist name for a given tagged
 * name. The alias map is intentionally CURATED (a short hand-written
 * list of well-known cases) rather than algorithmic — "X & Band Y" is
 * too risky to auto-merge in general (David Bowie & Bing Crosby on
 * "Peace on Earth" is NOT a Bowie album).
 *
 * Comparison is case-insensitive and ignores leading "The ". Extend the
 * map below as Jake's library surfaces more split personas.
 */

const ALIAS_RULES: Array<[RegExp | string, string]> = [
  // Paul McCartney's many guises
  [/^paul mccartney( and| &| with)? wings$/i, 'Paul McCartney'],
  [/^wings$/i, 'Paul McCartney'],
  [/^paul mccartney( and| &) wings$/i, 'Paul McCartney'],
  [/^paul( and| &) linda mccartney$/i, 'Paul McCartney'],
  [/^paul mccartney( and| &) linda mccartney$/i, 'Paul McCartney'],

  // John Lennon side projects
  [/^john lennon( and| &) yoko ono$/i, 'John Lennon'],
  [/^john lennon\s*\/\s*plastic ono band$/i, 'John Lennon'],
  [/^plastic ono band$/i, 'John Lennon'],
  [/^john lennon( and| &) the plastic ono band$/i, 'John Lennon'],

  // George Harrison
  [/^george harrison( and| &) friends$/i, 'George Harrison'],

  // Ringo Starr
  [/^ringo starr( and| &) his all-starr band$/i, 'Ringo Starr'],

  // Bruce Springsteen — released a few solo records but library
  // canonically reads under "Bruce Springsteen", with the E Street
  // Band merging into him.
  [/^bruce springsteen( and| &) the e[- ]street band$/i, 'Bruce Springsteen'],

  // Tom Petty
  [/^tom petty( and| &) the heartbreakers$/i, 'Tom Petty'],

  // Bob Marley
  [/^bob marley( and| &) the wailers$/i, 'Bob Marley'],

  // Prince — the symbol era. Keep "Prince" canonical.
  [/^the artist( formerly known as prince)?$/i, 'Prince'],
  [/^prince( and| &) the revolution$/i, 'Prince'],
  [/^prince( and| &) the new power generation$/i, 'Prince'],

  // ELO
  [/^electric light orchestra$/i, 'ELO'],

  // Elvis
  [/^elvis presley( and| &) the jordanaires$/i, 'Elvis Presley'],
]

// ── User/AI-managed alias map — extends the curated ALIAS_RULES baseline. ──
// Loaded from artist-aliases.json on boot (setUserAliases) and updated when the
// user approves AI groupings or edits by hand. Keyed by the same
// normalizeForCompare() form the rules use; value = canonical artist name. The
// store version lets the Artists view + artist page regroup the instant it
// changes (via useSyncExternalStore). This is what moves grouping out of code
// and into the user's own data.
let userAliases: Record<string, string> = {}
let aliasVersion = 0
const aliasListeners = new Set<() => void>()

/** Replace the user/AI alias map (called on boot + after every approve/edit). */
export function setUserAliases(map: Record<string, string>): void {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(map || {})) {
    const key = normalizeForCompare(String(k))
    const val = String(v ?? '').trim()
    if (key && val) next[key] = val
  }
  userAliases = next
  aliasVersion++
  for (const l of aliasListeners) l()
}

/** Current map (raw, for the management UI). */
export function getUserAliases(): Record<string, string> {
  return userAliases
}

export function subscribeAliases(cb: () => void): () => void {
  aliasListeners.add(cb)
  return () => { aliasListeners.delete(cb) }
}

/** Snapshot for useSyncExternalStore — a version number that bumps on change. */
export function getAliasVersion(): number {
  return aliasVersion
}

/**
 * Case-insensitive identity key for artist grouping, dedupe, and sync.
 * All words — articles ("the", "a"), prepositions ("of", "in"), etc. —
 * are folded so trivial casing drift does not split one artist into two.
 *
 * Example: "The Presidents of The United States Of America" and
 * "The Presidents Of the United States of America" → same key.
 */
export function artistIdentityKey(name: string): string {
  return canonicalArtist(name || '').toLowerCase().trim()
}

/**
 * Strip leading "The " and lowercase + trim for alias-rule matching.
 * Note we DON'T strip "The " from the canonical OUTPUT — "The Beatles"
 * stays "The Beatles" in the Artists list.
 */
function normalizeForCompare(name: string): string {
  return (name || '').replace(/^the\s+/i, '').toLowerCase().trim()
}

/**
 * Canonicalize a tagged artist string. Returns the original input if
 * no rule matches.
 */
export function canonicalArtist(name: string): string {
  if (!name) return name
  const trimmed = name.trim()
  if (!trimmed) return trimmed
  // User/AI map wins over the curated baseline — it's the override layer.
  const userHit = userAliases[normalizeForCompare(trimmed)]
  if (userHit) return userHit
  for (const [pattern, canonical] of ALIAS_RULES) {
    if (typeof pattern === 'string') {
      if (normalizeForCompare(trimmed) === normalizeForCompare(pattern)) return canonical
    } else if (pattern.test(trimmed)) {
      return canonical
    }
  }
  return trimmed
}

/**
 * Helper for places that need to know whether two artist strings should
 * be treated as the same person. e.g. "Paul McCartney" and "Wings"
 * should both match when viewing the canonical Paul page.
 */
export function isSameArtist(a: string, b: string): boolean {
  return artistIdentityKey(a) === artistIdentityKey(b)
}
