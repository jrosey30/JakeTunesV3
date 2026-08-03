/**
 * Shared durable JSON write: temp file → fsync-ish rename.
 * Callers that previously used direct writeFile for state files should
 * migrate here so an interrupted write cannot leave corrupt JSON.
 */

import { writeFile, rename, mkdir } from 'fs/promises'
import { dirname } from 'path'

export async function writeJsonAtomic(
  targetPath: string,
  value: unknown,
  space: number | undefined = 2,
): Promise<void> {
  const dir = dirname(targetPath)
  await mkdir(dir, { recursive: true })
  const tmp = targetPath + '.partial.json'
  const body = JSON.stringify(value, null, space)
  await writeFile(tmp, body, 'utf-8')
  await rename(tmp, targetPath)
}
