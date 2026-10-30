/**
 * The album page's label line, from MusicBrainz's own releases (Nevermind →
 * DGC) rather than whatever iTunes row a search led with (Jake 2026-10-30:
 * "isnt nevermind on sub pop not robotic empire??" — the lead row was a
 * tribute album on Robotic Empire). Pure; ipc/album-info-ipc.ts calls it.
 */
/** The label of the earliest official release that names one (bare years
 *  sort as the end of that year), else of any release that names one. */
export function mbReleaseLabel(releases: ReadonlyArray<{ status?: string; date?: string; 'label-info'?: Array<{ label?: { name?: string } }> }>): string | undefined {
  const named = releases.filter((r) => (r['label-info'] || []).some((li) => li.label?.name?.trim()))
  const dateKey = (d?: string) => (d ? (d.length === 4 ? `${d}-12-31` : d.length === 7 ? `${d}-31` : d) : '9999-99-99')
  const sorted = [...named].sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)))
  const pick = sorted.find((r) => r.status === 'Official') || sorted[0]
  return pick?.['label-info']?.find((li) => li.label?.name?.trim())?.label?.name?.trim()
}

