/**
 * Classify a library path for iPod copy, and name anything that cannot
 * be copied even after a homemini pull (blank tags, no path).
 *
 * Missing local files and NAS symlinks are NOT a refuse — pass-through
 * eviction is supposed to delete the Mac copy once homemini has it.
 * Sync pulls those bytes over HTTP (ipod-sync-materialize.ts) before wipe.
 *
 * Identity is path + lstat, never title. Do not stat()-follow — a dead
 * NAS target must not hang on SMB.
 */

import { join } from 'path'

export type LocalLibraryFileKind = 'ok' | 'no-path' | 'missing' | 'streamed' | 'not-file'

export type LstatLike = (abs: string) => Promise<{
  isSymbolicLink: () => boolean
  isFile: () => boolean
}>

export function colonPathToAbs(colon: string, localMount: string, pathSep: string): string {
  return join(localMount, colon.replace(/:/g, pathSep))
}

export async function classifyLocalLibraryFile(
  colonPath: string | undefined | null,
  opts: { localMount: string; pathSep: string; lstat: LstatLike },
): Promise<LocalLibraryFileKind> {
  const colon = String(colonPath || '').trim()
  if (!colon) return 'no-path'
  const abs = colonPathToAbs(colon, opts.localMount, opts.pathSep)
  try {
    const st = await opts.lstat(abs)
    if (st.isSymbolicLink()) return 'streamed'
    if (!st.isFile()) return 'not-file'
    return 'ok'
  } catch {
    return 'missing'
  }
}

export function formatNamedList(names: string[], max = 8): string {
  const shown = names.slice(0, max)
  const extra = names.length - shown.length
  if (extra > 0) return `${shown.join('; ')} (+${extra} more)`
  return shown.join('; ')
}

export function formatSyncSetFileRefuse(opts: {
  lead: string
  fileless: string[]
  blanks: string[]
  total: number
  nothingVerb: 'sent' | 'wiped'
}): string {
  const parts: string[] = []
  if (opts.blanks.length) parts.push(`${opts.blanks.length} with blank title/artist`)
  if (opts.fileless.length) parts.push(`${opts.fileless.length} with no playable file on this Mac`)
  const lead = `${opts.lead} — ${parts.join(' and ')} in the ${opts.total}-song set. Nothing was ${opts.nothingVerb}.`
  const names = [...opts.blanks, ...opts.fileless]
  if (names.length === 0) return lead
  return `${lead} They are: ${formatNamedList(names)}`
}

export function formatSyncSetStreamedRefuse(streamed: string[], total: number): string {
  return `Activity sync refused — ${streamed.length} of ${total} songs are streamed off the NAS (not downloaded locally). Pin/download them first. Nothing was wiped. They are: ${formatNamedList(streamed)}`
}

export function formatHomeminiPullRefuse(failed: string[], total: number): string {
  return `Activity sync refused — ${failed.length} of ${total} songs could not be pulled from homemini. Nothing was wiped. They are: ${formatNamedList(failed)}`
}

export interface ActivityPullNeeded {
  id: number
  path: string
  label: string
}

export async function classifyActivitySyncTracks(
  tracks: Array<Record<string, unknown>>,
  opts: { localMount: string; pathSep: string; lstat: LstatLike },
): Promise<{
  blanks: string[]
  fileless: string[]
  streamed: string[]
  missing: string[]
  toPull: ActivityPullNeeded[]
}> {
  const blanks: string[] = []
  const fileless: string[] = []
  const streamed: string[] = []
  const missing: string[] = []
  const toPull: ActivityPullNeeded[] = []
  for (const t of tracks) {
    const title = String(t.title || '').trim()
    const artist = String(t.artist || '').trim()
    if (!title || !artist) {
      blanks.push(`id ${t.id}: title=${JSON.stringify(title)} artist=${JSON.stringify(artist)}`)
      continue
    }
    const colon = String(t.path || '')
    const kind = await classifyLocalLibraryFile(colon, opts)
    const label = `${title} — ${artist}`
    if (kind === 'ok') continue
    if (kind === 'streamed' || kind === 'missing') {
      toPull.push({ id: Number(t.id), path: colon, label })
      if (kind === 'streamed') streamed.push(label)
      else missing.push(`${label} (no local file: ${colon})`)
      continue
    }
    if (kind === 'no-path') fileless.push(`${label} (no path)`)
    else fileless.push(`${label} (no local file: ${colon})`)
  }
  return { blanks, fileless, streamed, missing, toPull }
}

export interface ActivityBoardableTrack {
  id: number
  title?: string
  artist?: string
  path?: string
  audioMissing?: boolean
}

export type ActivityUnboardableReason = LocalLibraryFileKind | 'audio-missing'

export async function filterActivityBoardableTracks<T extends ActivityBoardableTrack>(
  tracks: T[],
  opts: { localMount: string; pathSep: string; lstat: LstatLike },
): Promise<{
  kept: T[]
  dropped: Array<{ id: number; title: string; artist: string; reason: ActivityUnboardableReason }>
}> {
  const kept: T[] = []
  const dropped: Array<{ id: number; title: string; artist: string; reason: ActivityUnboardableReason }> = []
  for (const t of tracks) {
    const title = String(t.title || '').trim()
    const artist = String(t.artist || '').trim()
    if (t.audioMissing === true) {
      dropped.push({ id: t.id, title, artist, reason: 'audio-missing' })
      continue
    }
    const kind = await classifyLocalLibraryFile(t.path, opts)
    if (kind === 'ok') kept.push(t)
    else dropped.push({ id: t.id, title, artist, reason: kind })
  }
  return { kept, dropped }
}
