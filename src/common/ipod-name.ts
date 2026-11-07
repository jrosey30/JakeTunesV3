/**
 * Naming an iPod (2026-11-07, Jake: "i actually want to name the actual ipod
 * punkPod not just a nickname. it shows up as JT Red").
 *
 * One name goes three places: JakeTunes' marker on the card, the drive's own
 * volume label, and the iPod's own catalog (the master playlist title, which is
 * what the iPod calls itself). The drive is FAT32 ("msdos"), so the name has to
 * be a FAT volume label: at most 11 characters, letters, numbers, spaces and a
 * few marks. Measured on a throwaway FAT32 disk image (hdiutil, never the iPod):
 * `diskutil rename` takes "punkPod" and the Mac shows "punkPod" until the iPod
 * is plugged in again; from then on the Mac shows "PUNKPOD". The iPod and
 * JakeTunes keep "punkPod" (they read the catalog and the marker, not the label).
 * It refused "TwelveChars1" (12), "a.b", "a+b", "a=b", "a,b", "a;b", "a[b",
 * 'a"b', "a*b", "a?b", "a|b", "a<b" and "ÅBC"; it took "a-b_c&'()",
 * "x!#$%@^" and "a{b}~".
 *
 * Pure — node --test loads it, and the Device page uses it to check as you type.
 */

export const FAT_LABEL_MAX = 11

const ALLOWED = /^[A-Za-z0-9 !#$%&'()@^_{}~-]+$/

export type IpodNameCheck =
  | {
      ok: true
      /** The name, as JakeTunes and the iPod will show it. */
      name: string
      /** True when the Mac's Finder will show the drive in capitals after a replug. */
      upperOnMac: boolean
      /** What the Finder will show for the drive after a replug. */
      macShows: string
    }
  | { ok: false; error: string }

export function checkIpodName(raw: unknown): IpodNameCheck {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!name) return { ok: false, error: 'Give the iPod a name.' }
  if (name.length > FAT_LABEL_MAX) {
    return { ok: false, error: `“${name}” is ${name.length} characters. An iPod’s drive name can be at most ${FAT_LABEL_MAX}.` }
  }
  if (!ALLOWED.test(name)) {
    return { ok: false, error: 'Use letters, numbers, spaces and - _ ! # $ % & \' ( ) @ ^ { } ~ only. The iPod’s drive can’t hold other characters.' }
  }
  const upper = name.toUpperCase()
  return { ok: true, name, upperOnMac: upper !== name, macShows: upper }
}

/** One plain line for the rename box: what the Mac will call the drive. */
export function macShowsLine(check: Extract<IpodNameCheck, { ok: true }>): string | null {
  return check.upperOnMac
    ? `The iPod and JakeTunes will say ${check.name}. The Mac’s Finder will show the drive as ${check.macShows} (FAT32 drives keep names in capitals).`
    : null
}
