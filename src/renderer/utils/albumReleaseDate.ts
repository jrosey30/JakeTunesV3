// ⚠️ TWIN: src/common/albumReleaseDate.ts — keep in sync (main process imports from common).

/** Parse leading YYYY from a tag year or ISO date string. */
export function albumReleaseYear(value: string | number | undefined | null): number | null {
  if (value === null || value === undefined || value === '') return null
  const m = /^(\d{4})/.exec(String(value).trim())
  if (!m) return null
  const y = parseInt(m[1], 10)
  return Number.isFinite(y) ? y : null
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
  if (y >= nowY) return false
  return true
}

/** Pick what to show for "Released …" in the credit line (below Play). */
export function albumCreditReleaseDate(
  tagYear: string | number | undefined | null,
  apiDate: string | undefined,
): string | undefined {
  if (!apiDate || !albumReleaseDatePlausible(tagYear, apiDate)) return undefined
  const trimmed = apiDate.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  const tagY = albumReleaseYear(tagYear)
  const apiY = albumReleaseYear(trimmed)
  if (tagY !== null && apiY === tagY) return undefined
  return trimmed
}
