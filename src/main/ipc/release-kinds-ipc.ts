/**
 * Release kinds IPC (2026-10-18): the renderer's read of release-kinds.json —
 * what each album IS (album / EP / single / live / compilation), as resolved
 * by src/main/release-kinds.ts. Read fresh from disk on every call (a local
 * file, a few hundred KB) so the artist page picks up MusicBrainz answers as
 * the background pass lands them. Read-only: nothing here writes the file.
 *
 * 2026-10-20: on a replica (workmini) the file is homemini's copy, pulled every
 * couple of minutes (src/main/replica-hub-files.ts). The replica never resolves
 * kinds itself; without the pull it had no file and its artist pages fell back
 * to the title/shape rules for every album. Inert on the MacBook.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import { readReleaseKinds } from '../release-kinds.ts'
import { createReleaseKindsPuller, startReplicaTimer } from '../replica-hub-files.ts'

export function registerReleaseKindsIpc(ipc: IpcRegistrar, host: { file: () => string; hubBase?: () => Promise<string | null> }): void {
  ipc.handle('release-kinds:load', async () => {
    const f = await readReleaseKinds(host.file())
    return { ok: true, updatedAt: f.updatedAt, albums: f.albums }
  }, { refuse: { ok: false, updatedAt: '', albums: {} } })
  if (host.hubBase) {
    const puller = createReleaseKindsPuller({ file: host.file(), hubBase: host.hubBase, log: (m) => console.warn(m) })
    startReplicaTimer(puller.pull, 20_000)
  }
}
