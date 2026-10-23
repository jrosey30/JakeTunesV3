/**
 * Where the Original's brain half comes from at sync time (2026-10-23,
 * common/top1000-sync.ts): homemini's Top 1000, ranked best first — but only
 * for the Original. A different iPod plugged in (Red, or one not set up yet)
 * gets null, and so does homemini not answering; null means Music Man picks
 * the brain half exactly as before. No iPod plugged in (building ahead of the
 * sync) counts as the Original: it is the only iPod JakeTunes will sync
 * (ipod-identity.ts refuses every other one).
 */
import type { IpodIdentity } from '../common/ipod-identity.ts'
import type { QuizListEntry } from '../common/top1000-doc.ts'

export interface Top1000SyncSourceDeps {
  getMount: () => string | null
  identify: (mount: string) => Promise<IpodIdentity>
  list: () => Promise<{ ok: true; value: { list: QuizListEntry[] } } | { ok: false; error: string }>
  log?: (msg: string) => void
}

export function createTop1000SyncSource(deps: Top1000SyncSourceDeps): () => Promise<number[] | null> {
  const log = deps.log ?? ((m: string) => console.log(m))
  return async () => {
    const mount = deps.getMount()
    if (mount) {
      let identity: IpodIdentity
      try {
        identity = await deps.identify(mount)
      } catch (err) {
        log(`[workout-sync] Top 1000: couldn't tell which iPod this is (${(err as Error)?.message ?? err}) — Music Man picks`)
        return null
      }
      if (identity.status !== 'known' || !identity.device.primary) {
        log('[workout-sync] Top 1000: this iPod isn’t the Original — Music Man picks')
        return null
      }
    }
    const r = await deps.list()
    if (!r.ok) {
      log(`[workout-sync] Top 1000 unavailable (${r.error}) — Music Man picks`)
      return null
    }
    return [...r.value.list].sort((a, b) => a.rank - b.rank).map((e) => e.id)
  }
}
