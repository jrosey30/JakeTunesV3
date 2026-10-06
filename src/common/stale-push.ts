/**
 * A machine that is BEHIND the NAS never auto-pushes to it.
 *
 * 2026-10-05. homemini has its own copy of the desktop app whose library
 * stopped at Sep 4. Twice (9/27 03:09, 10/5 22:02) it booted after an NAS
 * outage, saved its local library (fresh mtime, three-week-old content),
 * and autoBackupStateToNas pushed it — mtime-wins, whole file — over the
 * real one: 11,007 songs became 10,263 on the NAS, and the phone (which
 * mirrors the NAS copy) lost every song added since Sep 4.
 *
 * mtime can't tell a stale lineage from a fresh edit; content can. If the
 * NAS library holds songs this machine has never seen that were added
 * AFTER this machine's newest song, this machine is the stale one. It
 * pushes nothing (every state file it holds is from the same old
 * lineage). Deletes and edits on an up-to-date machine are unaffected:
 * a deleted song is older than the newest one, so it never trips this.
 * The manual "Push local edits to NAS" reconcile stays the override.
 * Pure, so node --test loads it.
 */

interface LibTrack { id?: unknown; dateAdded?: unknown }
export interface LibLike { tracks?: LibTrack[] }

const tracksOf = (lib: unknown): LibTrack[] => {
  if (Array.isArray(lib)) return lib as LibTrack[]
  const t = (lib as LibLike | null)?.tracks
  return Array.isArray(t) ? t : []
}
const added = (t: LibTrack): number => {
  const ms = Date.parse(String(t.dateAdded ?? ''))
  return Number.isFinite(ms) ? ms : NaN
}

export interface PushVerdict { push: boolean; reason: string; nasOnlyNewer: number }

export function libraryPushVerdict(local: unknown, nas: unknown): PushVerdict {
  const lt = tracksOf(local)
  const nt = tracksOf(nas)
  if (nt.length === 0) return { push: true, reason: 'NAS library empty or unreadable', nasOnlyNewer: 0 }
  if (lt.length === 0) return { push: false, reason: 'this machine has no library to push', nasOnlyNewer: 0 }
  const localIds = new Set(lt.map((t) => String(t.id)))
  let localNewest = -Infinity
  for (const t of lt) { const a = added(t); if (a > localNewest) localNewest = a }
  let nasOnlyNewer = 0
  let example = ''
  for (const t of nt) {
    if (localIds.has(String(t.id))) continue
    const a = added(t)
    if (a > localNewest) { nasOnlyNewer++; if (!example) example = String(t.dateAdded) }
  }
  if (nasOnlyNewer > 0) {
    const since = Number.isFinite(localNewest) ? new Date(localNewest).toISOString().slice(0, 10) : 'never'
    return {
      push: false,
      nasOnlyNewer,
      reason: `the NAS has ${nasOnlyNewer} song(s) this machine has never seen, added after its newest (${since}); this machine is behind, so it pushes nothing`,
    }
  }
  return { push: true, reason: 'ok', nasOnlyNewer: 0 }
}
