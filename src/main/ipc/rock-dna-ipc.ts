/**
 * Rock DNA storage (Rocksurgence step 2, 2026-10-11): userData/rock-dna.json,
 * structured and hand-editable. The quiz saves after every answer, so Jake can
 * stop anywhere and resume. Load also returns his taste-profile exceptions
 * (Angine de Poitrine) so the profile can say why each one is loved.
 * The rules live in src/common/rock-dna.ts; the Record Shop reads the same
 * file in src/main/discovery-focus.ts.
 *
 * Both Macs (2026-10-20): load returns the quiz merged with the other Mac's
 * copy (discovery-focus.ts loadRockDna), so he can carry on wherever he is;
 * save writes this Mac's file only, and the sync carries it across.
 */
import { app } from 'electron'
import { join } from 'path'
import { writeFile, rename } from 'fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { normalizeDnaState, type DnaState } from '../../common/rock-dna.ts'
import { loadTasteProfile } from '../taste-profile.ts'
import { TASTE_PROFILE_FILE, ROCK_DNA_FILE, loadRockDna } from '../discovery-focus.ts'
import { triggerSync } from '../sync-orchestrator'

async function saveRockDna(dir: string, raw: unknown): Promise<DnaState> {
  const state = { ...normalizeDnaState(raw), updatedAt: new Date().toISOString() }
  const file = join(dir, ROCK_DNA_FILE), tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, file)
  return state
}

export function registerRockDnaIpc(ipc: IpcRegistrar): void {
  const dir = (): string => app.getPath('userData')
  ipc.handle('rock-dna:load', async () => {
    const [state, taste] = await Promise.all([loadRockDna(dir()), loadTasteProfile(join(dir(), TASTE_PROFILE_FILE))])
    return { state, exceptions: taste.exceptions.map((e) => ({ artist: e.artist, genre: e.genre })) }
  }, { refuse: REFUSED_SENDER })
  ipc.handle('rock-dna:save', async (_e, state: unknown) => {
    try {
      const saved = await saveRockDna(dir(), state)
      triggerSync('taste')   // the other Mac merges it in on its next pull
      return { ok: true, state: saved }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  }, { refuse: REFUSED_SENDER })
}
