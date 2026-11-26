/**
 * The card's existing copy of a song whose new copy couldn't be made (Brief 266): at its
 * destination, or at the .m4a an earlier conversion of a non-.m4a master wrote. The
 * full-library sync keeps it and its song-list row instead of dropping the song, which used
 * to let the verify and the orphan cleanup delete it. Pure apart from stat; node --test loads it.
 */
import { stat } from 'node:fs/promises'

export async function keptCardCopy(ipodPath: string, localPath: string): Promise<{ abs: string; size: number } | null> {
  const paths = [ipodPath]
  const ext = localPath.slice(localPath.lastIndexOf('.')).toLowerCase()
  const dot = ipodPath.lastIndexOf('.')
  if (ext !== '.m4a' && ext !== '.mp4' && dot > 0) {
    const m4a = ipodPath.slice(0, dot) + '.m4a'
    if (m4a !== ipodPath) paths.push(m4a)
  }
  for (const p of paths) {
    const st = await stat(p).catch(() => null)
    if (st && st.isFile() && st.size > 0) return { abs: p, size: st.size }
  }
  return null
}
