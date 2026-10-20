/**
 * Phone playlist edits, live (2026-10-20). The IO half of
 * phone-playlist-edits.ts: read the phone's mirrored playlist files, fold
 * them into the desktop's playlists (newest edit wins, per track), persist,
 * and tell everyone.
 *
 * Runs at two moments:
 *   - when the renderer loads playlists at launch (so the first sidebar
 *     render already has the phone's edits — what Brief 121's startup merge
 *     in App.tsx used to do, minus re-applying old adds every launch), and
 *   - whenever the phone mirrors refresh one of these files (every 5 min),
 *     so a phone edit arrives while the app is running.
 *
 * Applying is a desktop change like any other: modifiedAt and
 * memberChangedAt are stamped (stampModifiedPlaylists), a playlist dropped
 * because the phone deleted it gets a desktop tombstone (recordPlaylistSave),
 * and the hub converge carries it to the other Mac.
 *
 * Electron-free: deps injected, node --test loads it.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  applyPhonePlaylistEdits,
  parseEditFile,
  parseDeletionLedger,
  type PhoneApplyReport,
  type PhoneMobilePlaylist,
} from './phone-playlist-edits.ts'
import { stampModifiedPlaylists, type HubPlaylistLike } from './playlist-hub-sync.ts'
import { loadTombstones, recordPlaylistSave } from './playlist-tombstones.ts'

/**
 * The phone's playlist ledgers that are NOT in the contracts' never-push
 * list (that list covers mobile-playlists.json + playlist-additions.json).
 * Same single-writer rule: homemini writes them, desktops only mirror.
 */
export const PHONE_PLAYLIST_LEDGERS = ['playlist-removals.json', 'mobile-playlist-deletions.json'] as const

/** Every phone file this module reads (all mirrored into mirrorDir). */
export const PHONE_PLAYLIST_FILES = [
  'mobile-playlists.json',
  'playlist-additions.json',
  ...PHONE_PLAYLIST_LEDGERS,
] as const

export interface PhonePlaylistSyncDeps {
  /** Where refreshPhoneMirrors lands the phone files (userData). */
  mirrorDir: string
  tombstonesFile: string
  getPlaylists: () => Promise<HubPlaylistLike[]>
  setPlaylists: (p: HubPlaylistLike[]) => void
  /** Non-null = saves are locked; skip this pass (the next one retries). */
  isSaveLocked: () => string | null
  /** After a change is persisted: push to the renderer, sync, converge. */
  onChanged?: (playlists: HubPlaylistLike[], why: string) => void
  now?: () => string
  log?: (m: string) => void
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as unknown
  } catch {
    return null   // missing or torn mirror: treat as empty, never as "delete everything"
  }
}

function describe(r: PhoneApplyReport): string {
  const parts: string[] = []
  if (r.added.length) parts.push(`${r.added.length} add(s)`)
  if (r.removed.length) parts.push(`${r.removed.length} removal(s)`)
  if (r.adopted.length) parts.push(`${r.adopted.length} new phone playlist(s)`)
  if (r.deleted.length) parts.push(`${r.deleted.length} phone-deleted playlist(s)`)
  return parts.join(', ')
}

export function createPhonePlaylistSync(deps: PhonePlaylistSyncDeps): { apply: (why: string) => Promise<PhoneApplyReport | null> } {
  const log = deps.log ?? ((m: string) => console.log(m))
  let chain: Promise<unknown> = Promise.resolve()

  async function applyOnce(why: string): Promise<PhoneApplyReport | null> {
    const lock = deps.isSaveLocked()
    if (lock) return null
    const [additionsRaw, removalsRaw, mobileRaw, deletionsRaw, tombstones] = await Promise.all([
      readJson(join(deps.mirrorDir, 'playlist-additions.json')),
      readJson(join(deps.mirrorDir, 'playlist-removals.json')),
      readJson(join(deps.mirrorDir, 'mobile-playlists.json')),
      readJson(join(deps.mirrorDir, 'mobile-playlist-deletions.json')),
      loadTombstones(deps.tombstonesFile),
    ])
    const mobile = (mobileRaw && typeof mobileRaw === 'object' && Array.isArray((mobileRaw as { playlists?: unknown }).playlists))
      ? (mobileRaw as { playlists: PhoneMobilePlaylist[] }).playlists
      : []
    const prev = await deps.getPlaylists()
    const { playlists: next, changed, report } = applyPhonePlaylistEdits(prev, {
      additions: parseEditFile(additionsRaw, 'additions'),
      removals: parseEditFile(removalsRaw, 'removals'),
      mobilePlaylists: mobile,
      phoneDeletions: parseDeletionLedger(deletionsRaw),
      desktopTombstoneIds: new Set(tombstones.map((t) => String(t.id))),
    })
    if (!changed) return report
    const stamped = stampModifiedPlaylists(prev, next, deps.now)
    deps.setPlaylists(stamped)
    // Phone deletions become desktop tombstones, so the hub (and workmini)
    // drop the playlist too instead of handing it back on the next converge.
    await recordPlaylistSave(prev, stamped, deps.tombstonesFile, deps.now)
      .catch((err) => log(`[phone-playlists] tombstone record failed: ${err instanceof Error ? err.message : err}`))
    log(`[phone-playlists] applied from the phone (${why}): ${describe(report)}`)
    deps.onChanged?.(stamped, why)
    return report
  }

  return {
    // Serialized: the launch pass and a mirror refresh can't interleave.
    apply: (why: string) => {
      const run = chain.then(() => applyOnce(why))
      chain = run.catch(() => null)
      return run
    },
  }
}
