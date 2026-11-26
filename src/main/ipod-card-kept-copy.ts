/**
 * The card's existing copy of a song whose new copy couldn't be made (Brief 266): the .m4a an
 * earlier conversion of a non-.m4a master wrote, else the song at its destination. A .flac is
 * never kept (the iPod can't play one). The full-library sync keeps it and its song-list row
 * instead of dropping the song, which used to let the verify and the orphan cleanup delete it,
 * and only for a failure that was the Mac's (keepCardCopyFor). Pure apart from stat; node --test loads it.
 */
import { stat } from 'node:fs/promises'
import { isAacConvertTransient, isAacEncoderMissing } from './aac-mirror-recipe.ts'

export async function keptCardCopy(ipodPath: string, localPath: string): Promise<{ abs: string; size: number } | null> {
  const paths: string[] = []
  const ext = localPath.slice(localPath.lastIndexOf('.')).toLowerCase()
  const dot = ipodPath.lastIndexOf('.')
  if (ext !== '.m4a' && ext !== '.mp4' && dot > 0) paths.push(ipodPath.slice(0, dot) + '.m4a')
  if (!paths.includes(ipodPath)) paths.push(ipodPath)
  for (const p of paths) {
    if (p.toLowerCase().endsWith('.flac')) continue
    const st = await stat(p).catch(() => null)
    if (st && st.isFile() && st.size > 0) return { abs: p, size: st.size }
  }
  return null
}

/**
 * May the card's copy stay after this failure? Only when it was the Mac's (a timeout, a killed
 * encoder, a full disk, an encoder check that didn't answer): the next sync tries again. A
 * permanent failure over a lossless card copy would keep the master on an AAC iPod for good
 * (re-review of #519), so that song is left off and named instead.
 */
export function keepCardCopyFor(err: unknown): boolean {
  if (isAacConvertTransient(err)) return true
  return isAacEncoderMissing(err) && (err as { why?: unknown }).why === 'unknown'
}
