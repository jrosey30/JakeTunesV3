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
 *
 * Brief 197 (2026-10-14): the date comparison had a hole exactly the
 * shape of a phone download. A track that lands in the hub's library
 * from the phone ("Cure for Pain", added the same day) is OLDER than
 * the newest song on either desktop, so a later publish from the
 * lineage that never absorbed it passed this guard while silently
 * dropping the track — it vanished from every surface. Second rule:
 * a NAS-only song added within the last 30 days refuses the push
 * regardless of how it compares to this machine's newest, and the
 * refusal names the songs. A deliberate drop (including deleting a
 * recently added song) goes through the same manual reconcile
 * override as before — deleting the newest song already refused here.
 */

interface LibTrack { id?: unknown; dateAdded?: unknown; title?: unknown; artist?: unknown }
export interface LibLike { tracks?: LibTrack[] }

/** How long a NAS-only song's addition protects it from a silent drop. */
export const RECENT_DROP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

const tracksOf = (lib: unknown): LibTrack[] => {
  if (Array.isArray(lib)) return lib as LibTrack[]
  const t = (lib as LibLike | null)?.tracks
  return Array.isArray(t) ? t : []
}
const added = (t: LibTrack): number => {
  const ms = Date.parse(String(t.dateAdded ?? ''))
  return Number.isFinite(ms) ? ms : NaN
}

export interface PushVerdict {
  push: boolean
  reason: string
  nasOnlyNewer: number
  /** Brief 197: NAS-only songs added within RECENT_DROP_WINDOW_MS. */
  nasOnlyRecent: number
  /** Names of the recent NAS-only songs a push would drop (first 10). */
  droppedRecent: string[]
}

export function libraryPushVerdict(local: unknown, nas: unknown, nowMs: number = Date.now()): PushVerdict {
  const lt = tracksOf(local)
  const nt = tracksOf(nas)
  if (nt.length === 0) return { push: true, reason: 'NAS library empty or unreadable', nasOnlyNewer: 0, nasOnlyRecent: 0, droppedRecent: [] }
  if (lt.length === 0) return { push: false, reason: 'this machine has no library to push', nasOnlyNewer: 0, nasOnlyRecent: 0, droppedRecent: [] }
  const localIds = new Set(lt.map((t) => String(t.id)))
  let localNewest = -Infinity
  for (const t of lt) { const a = added(t); if (a > localNewest) localNewest = a }
  let nasOnlyNewer = 0
  let example = ''
  let nasOnlyRecent = 0
  const droppedRecent: string[] = []
  const recentCutoff = nowMs - RECENT_DROP_WINDOW_MS
  for (const t of nt) {
    if (localIds.has(String(t.id))) continue
    const a = added(t)
    if (a > localNewest) { nasOnlyNewer++; if (!example) example = String(t.dateAdded) }
    if (Number.isFinite(a) && a > recentCutoff) {
      nasOnlyRecent++
      if (droppedRecent.length < 10) {
        const title = typeof t.title === 'string' && t.title ? t.title : ''
        const artist = typeof t.artist === 'string' && t.artist ? t.artist : ''
        droppedRecent.push(title ? (artist ? `${title} — ${artist}` : title) : `id ${String(t.id)}`)
      }
    }
  }
  if (nasOnlyNewer > 0) {
    const since = Number.isFinite(localNewest) ? new Date(localNewest).toISOString().slice(0, 10) : 'never'
    return {
      push: false,
      nasOnlyNewer,
      nasOnlyRecent,
      droppedRecent,
      reason: `the NAS has ${nasOnlyNewer} song(s) this machine has never seen, added after its newest (${since}); this machine is behind, so it pushes nothing`,
    }
  }
  if (nasOnlyRecent > 0) {
    const names = droppedRecent.join('; ') + (nasOnlyRecent > droppedRecent.length ? '; …' : '')
    return {
      push: false,
      nasOnlyNewer,
      nasOnlyRecent,
      droppedRecent,
      reason: `the NAS has ${nasOnlyRecent} song(s) this machine has never seen, added in the last 30 days (${names}); a push would silently drop them, so it pushes nothing — reconcile by hand if the drop is deliberate`,
    }
  }
  return { push: true, reason: 'ok', nasOnlyNewer: 0, nasOnlyRecent: 0, droppedRecent: [] }
}
