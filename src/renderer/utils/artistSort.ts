/** iTunes-style artist alphabetization: ignore a leading article when sorting,
 *  so "The Beatles" files under B, "A Tribe Called Quest" under T. Only a
 *  whole leading word counts — "a-ha" and "Theory of a Deadman" are untouched.
 *  Leading quotes/brackets are stripped so "“Weird Al” Yankovic" files under W. */
export function artistSortName(name: string): string {
  let s = (name || '').trim().toLowerCase()
  s = s.replace(/^['"“”‘’(\[]+/, '').trim()
  const m = /^(?:the|a|an)\s+(.+)$/.exec(s)
  if (m) s = m[1].trim()
  return s || (name || '').trim().toLowerCase()
}

/** Section letter for the A–Z index: first letter of the sort name, or '#'
 *  for digits/symbols/non-Latin. */
export function artistSectionLetter(name: string): string {
  const c = artistSortName(name).charAt(0).toUpperCase()
  return c >= 'A' && c <= 'Z' ? c : '#'
}
