/** iTunes-style sort name — used for BOTH artists and albums via compareNames().
 *  Ignore a leading article so "The Beatles" files under B, "A Tribe Called
 *  Quest" under T. Only a whole leading word counts — "a-ha" and "Theory of a
 *  Deadman" are untouched. ALL leading punctuation/symbols are stripped, so
 *  "“Weird Al” Yankovic" files under W, "...And Justice For All" under A, and
 *  "&Forever" under F (previously these floated to the top by their leading
 *  dots/ampersand). */
export function artistSortName(name: string): string {
  let s = (name || '').trim().toLowerCase()
  // Alternate the two strips until stable: removing the article can expose new
  // leading punctuation ("The '59 Sound" -> "'59 sound" -> "59 sound"), and
  // stripping punctuation can expose an article ("(The Best Of)" -> "the best
  // of" -> "best of"). One pass of each isn't enough.
  let prev = ''
  while (s && s !== prev) {
    prev = s
    s = s.replace(/^[\p{P}\p{S}\s]+/u, '')   // leading punctuation/symbols
    s = s.replace(/^(?:the|a|an)\s+/, '')      // a leading article (whole word)
    s = s.trim()
  }
  return s || (name || '').trim().toLowerCase()
}

/** iTunes-style name comparison: the article/punctuation-insensitive sort name
 *  + natural numeric ordering (so "2" precedes "10") + case/accent-insensitive.
 *  Use EVERYWHERE a list of album or artist names is alphabetized so the whole
 *  app sorts identically. */
export function compareNames(a: string, b: string): number {
  return artistSortName(a).localeCompare(artistSortName(b), undefined, { numeric: true, sensitivity: 'base' })
}

/** Section letter for the A–Z index: first letter of the sort name, or '#'
 *  for digits/symbols/non-Latin. */
export function artistSectionLetter(name: string): string {
  const c = artistSortName(name).charAt(0).toUpperCase()
  return c >= 'A' && c <= 'Z' ? c : '#'
}
