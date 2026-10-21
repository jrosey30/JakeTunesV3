/**
 * Per-surface tweaks to the library's song menu (utils/libraryMenus.ts
 * songMenuEntries), applied by HomeItemMenus' host:
 *   • omitDelete — drop "Delete Song" (the entry wired to the host's delete
 *     action, found by identity, not by label) and the separator above it.
 *     The now-playing pill and cover use it for a live concert's merged
 *     recording: removing a show is the concert page's job.
 *   • extra — entries a surface adds at the end (the now-playing cover's
 *     Remove Artwork).
 */
import type { MenuEntry } from '../components/ContextMenu'

export interface SongMenuExtras {
  extra?: MenuEntry[]
  omitDelete?: boolean
}

export function withSongMenuExtras(items: MenuEntry[], deleteAction: () => void, extras?: SongMenuExtras): MenuEntry[] {
  let out = items
  if (extras?.omitDelete) {
    const i = out.findIndex((m) => !m.separator && m.onClick === deleteAction)
    if (i >= 0) out = out.filter((m, j) => j !== i && !(j === i - 1 && m.separator))
  }
  if (extras?.extra?.length) out = [...out, { separator: true as const }, ...extras.extra]
  return out
}
