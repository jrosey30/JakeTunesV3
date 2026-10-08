/**
 * IO half of src/common/stale-push.ts: read both library.json copies and
 * say whether this machine is behind the NAS. null = safe to push.
 */
import { readFile } from 'fs/promises'
import { libraryPushVerdict } from '../common/stale-push'

export async function machineBehindNas(localLibPath: string, nasLibPath: string): Promise<string | null> {
  let nas: unknown
  try { nas = JSON.parse(await readFile(nasLibPath, 'utf8')) } catch { return null } // absent/torn NAS copy is not evidence
  let local: unknown
  try { local = JSON.parse(await readFile(localLibPath, 'utf8')) } catch { return 'this machine cannot read its own library.json' }
  const v = libraryPushVerdict(local, nas)
  return v.push ? null : v.reason
}
