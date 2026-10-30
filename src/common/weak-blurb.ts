/**
 * An AI answer that says it has nothing ("drawing a blank") — the album page
 * shows it as nothing, and the main process never keeps it on disk: kept, it
 * would hide that album's history forever (2026-10-30 review); unkept, the
 * next open asks again. The phrases are the Music Man's own.
 */
export function isWeakBlurb(text: string): boolean {
  const lower = (text || '').toLowerCase()
  return (
    lower.includes('drawing a blank')
    || lower.includes("didn't stick")
    || lower.includes('pulling a name')
    || lower.includes('land a take worth hearing')
  )
}
