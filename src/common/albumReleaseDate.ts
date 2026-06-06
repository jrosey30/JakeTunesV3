/** Parse leading YYYY from a tag year or ISO date string.
 *  ⚠️ TWIN: src/renderer/utils/albumReleaseDate.ts — keep in sync. */
export function albumReleaseYear(value: string | number | undefined | null): number | null {
  if (value === null || value === undefined || value === '') return null
  const m = /^(\d{4})/.exec(String(value).trim())
  if (!m) return null
  const y = parseInt(m[1], 10)
  return Number.isFinite(y) ? y : null
}

export function tagYearStr(year: string | number | undefined | null): string {
  if (year === null || year === undefined || year === '') return ''
  return String(year).trim()
}

/** True when an API release date agrees with the library's tagged album year. */
export function albumReleaseDatePlausible(
  tagYear: string | number | undefined | null,
  releaseDate: string,
): boolean {
  const libY = albumReleaseYear(tagYear)
  const y = albumReleaseYear(releaseDate)
  const nowY = new Date().getFullYear()
  if (y === null || y < 1900) return false
  if (libY !== null) {
    if (y > libY + 2) return false
    if (y < libY - 10) return false
    return true
  }
  // No tag year — reject dates in the current calendar year (often iTunes catalog re-adds).
  if (y >= nowY) return false
  return true
}

/** Merge API release dates for IPC storage (main process). */
export function pickAlbumReleaseDate(
  libraryYear: string | number | undefined | null,
  mb?: string,
  it?: string,
): string | undefined {
  const tag = tagYearStr(libraryYear)
  const libY = albumReleaseYear(tag)
  const nowY = new Date().getFullYear()

  if (mb && albumReleaseDatePlausible(tag, mb)) return mb
  if (it && albumReleaseDatePlausible(tag, it)) return it
  if (libY !== null && libY >= 1900 && libY <= nowY) return String(libY)
  return undefined
}

export interface AlbumCreditsLike {
  released?: string
  label?: string
  producer?: string
  recorded?: string
}

export function sanitizeAlbumCredits<T extends AlbumCreditsLike>(
  libraryYear: string | number | undefined | null,
  credits: T,
): T {
  const out = { ...credits }
  if (out.released && !albumReleaseDatePlausible(libraryYear, out.released)) {
    out.released = pickAlbumReleaseDate(libraryYear)
  }
  return out
}

/** Pick what to show for "Released …" in the credit line (below Play). */
export function albumCreditReleaseDate(
  tagYear: string | number | undefined | null,
  apiDate: string | undefined,
): string | undefined {
  if (!apiDate || !albumReleaseDatePlausible(tagYear, apiDate)) return undefined
  const trimmed = apiDate.trim()
  // Full date from MusicBrainz / iTunes — worth showing alongside the facts line.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  // Year-only duplicates the tag year already shown in "2007 · 12 songs · …".
  const tagY = albumReleaseYear(tagYear)
  const apiY = albumReleaseYear(trimmed)
  if (tagY !== null && apiY === tagY) return undefined
  return trimmed
}
