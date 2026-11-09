/**
 * Rename an iPod list (2026-11-09, Jake: "allow me to rename the ipod playlists
 * too!! if i want"). The list is a playlist: its name is homemini's
 * (PATCH /api/ipod-lists/:id { name }), so the phone and every Mac show it.
 * Any Mac can rename one, the hub and the replicas alike.
 *
 * It renames the list, never the iPod: the card's marker, the registry and the
 * drive keep their name (that is the Device page's Rename, main/ipod-rename.ts).
 *
 * The name joins the same queue as the iPod rename's (ipod-list-renames.json,
 * newest wins): on disk before homemini is asked, shown at once
 * (main/ipod-lists-gather.ts lays it over homemini's), and sent on the next list
 * read or the 5-minute retry when homemini is away.
 */
import { checkListName } from '../common/ipod-list-name.ts'
import { flushAllHomeminiNames, queueHomeminiName } from './ipod-rename.ts'

export interface RenameIpodListDeps {
  stateDir: string
  send: (deviceId: string, name: string) => Promise<'done' | 'retry' | 'drop'>
  /** Every OTHER list's name as shown now, the Top 1000's included. */
  others: (deviceId: string) => Promise<string[]>
  warn?: (msg: string) => void
}

export type RenameIpodListResult =
  | { ok: true; name: string; homemini: 'saved' | 'later' }
  | { ok: false; error: string }

export async function renameIpodList(deps: RenameIpodListDeps, deviceId: unknown, raw: unknown): Promise<RenameIpodListResult> {
  if (typeof deviceId !== 'string' || !/^[a-z0-9-]{6,64}$/.test(deviceId)) return { ok: false, error: 'No list.' }
  const check = checkListName(raw, await deps.others(deviceId).catch(() => [] as string[]))
  if (!check.ok) return check
  await queueHomeminiName(deps.stateDir, deviceId, check.name)
  let answer = 'retry' as 'done' | 'retry' | 'drop'
  await flushAllHomeminiNames(deps.stateDir, async (id, name) => (answer = await deps.send(id, name)), deviceId, deps.warn)
  if (answer === 'drop') return { ok: false, error: 'homemini wouldn’t take that name (another list may have it).' }
  return { ok: true, name: check.name, homemini: answer === 'done' ? 'saved' : 'later' }
}
