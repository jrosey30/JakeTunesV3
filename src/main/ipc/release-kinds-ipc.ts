/**
 * Release kinds IPC (2026-10-18): the renderer's read of release-kinds.json —
 * what each album IS (album / EP / single / live / compilation), as resolved
 * by src/main/release-kinds.ts. Read fresh from disk on every call (a local
 * file, a few hundred KB) so the artist page picks up MusicBrainz answers as
 * the background pass lands them. Read-only: nothing here writes the file.
 */
import type { IpcRegistrar } from '../ipc-register.ts'
import { readReleaseKinds } from '../release-kinds.ts'

export function registerReleaseKindsIpc(ipc: IpcRegistrar, host: { file: () => string }): void {
  ipc.handle('release-kinds:load', async () => {
    const f = await readReleaseKinds(host.file())
    return { ok: true, updatedAt: f.updatedAt, albums: f.albums }
  }, { refuse: { ok: false, updatedAt: '', albums: {} } })
}
