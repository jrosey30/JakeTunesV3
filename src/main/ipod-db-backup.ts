/**
 * Back up an iPod's catalog on the Mac before a sync rewrites it (Brief 265 Part 3,
 * Amendment 4, Jake 2026-11-24). No backup, no DB write: the sync refuses rather
 * than proceed unprotected.
 *
 * What is kept: iTunesDB, plus iTunesSD and Play Counts when the iPod has them, in
 *   <root>/<device key>/<UTC stamp>/
 * where <device key> is the iPod's own id (iPod_Control/jaketunes-device.json) or,
 * without one, its volume name. The last KEEP backups per iPod stay; older ones go.
 * Each copy is read back and compared before it counts.
 *
 * Recovery (the invariant both engines keep): files are transferred and verified
 * first and the iTunesDB is written last, so a sync that dies leaves either the old
 * catalog over the old files or the new catalog over the new files. Restoring a
 * backup (restoreItunesDbBackup) puts the pre-sync catalog back; the next sync
 * copies whatever that catalog's songs are missing.
 *
 * The on-card iTunesDB.bak the engines also write is unchanged (it is the writer's
 * template and the firmware's own habit); this is the copy that lives off the iPod.
 */
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const KEEP_ITUNESDB_BACKUPS = 8
const FILES = ['iTunesDB', 'iTunesSD', 'Play Counts'] as const

export type BackupResult =
  | { ok: true; dir: string; files: string[] }
  | { ok: true; dir: null; files: []; reason: 'no catalog on the iPod yet' }
  | { ok: false; reason: string }

/** The folder name for this iPod: its JakeTunes id, else its volume name. Safe as a path segment. */
export async function deviceBackupKey(mount: string): Promise<string> {
  try {
    const j = JSON.parse(await readFile(join(mount, 'iPod_Control', 'jaketunes-device.json'), 'utf-8')) as { id?: unknown }
    if (typeof j.id === 'string' && j.id.trim()) return safeSegment(j.id)
  } catch { /* no identity file: fall back to the volume name */ }
  return safeSegment(basename(mount) || 'ipod')
}

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'ipod'
}

/** 2026-11-24T19-12-54-123Z: sorts in time order, legal on every filesystem. */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/:/g, '-').replace('.', '-')
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([readFile(a), readFile(b)])
  return x.equals(y)
}

export async function backupItunesDb(opts: {
  mount: string
  root: string
  now?: Date
  keep?: number
}): Promise<BackupResult> {
  const itunes = join(opts.mount, 'iPod_Control', 'iTunes')
  const db = await stat(join(itunes, 'iTunesDB')).catch(() => null)
  if (!db || db.size === 0) return { ok: true, dir: null, files: [], reason: 'no catalog on the iPod yet' }
  const key = await deviceBackupKey(opts.mount)
  const base = join(opts.root, key)
  const dir = join(base, backupStamp(opts.now ?? new Date()))
  try {
    await mkdir(dir, { recursive: true })
    const files: string[] = []
    for (const name of FILES) {
      const src = join(itunes, name)
      const st = await stat(src).catch(() => null)
      if (!st || !st.isFile()) continue
      const dst = join(dir, name)
      await copyFile(src, dst)
      if (!(await sameBytes(src, dst))) return { ok: false, reason: `the backup of ${name} does not match the iPod's copy` }
      files.push(name)
    }
    if (!files.includes('iTunesDB')) return { ok: false, reason: 'iTunesDB was not backed up' }
    await pruneBackups(base, opts.keep ?? KEEP_ITUNESDB_BACKUPS)
    return { ok: true, dir, files }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Keep the newest `keep` backup folders for one iPod. Only folders this module named are touched. */
export async function pruneBackups(base: string, keep: number): Promise<string[]> {
  const names = (await readdir(base).catch(() => [] as string[]))
    .filter((n) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(n))
    .sort()
  const gone = names.slice(0, Math.max(0, names.length - Math.max(1, keep)))
  for (const n of gone) await rm(join(base, n), { recursive: true, force: true })
  return gone
}

/** Put a backup's catalog back on the iPod (the recovery path). Only the files the backup holds. */
export async function restoreItunesDbBackup(dir: string, mount: string): Promise<string[]> {
  const itunes = join(mount, 'iPod_Control', 'iTunes')
  const restored: string[] = []
  for (const name of FILES) {
    const src = join(dir, name)
    if (!(await stat(src).catch(() => null))) continue
    const tmp = join(itunes, `${name}.restore-tmp`)
    await copyFile(src, tmp)
    if (!(await sameBytes(src, tmp))) throw new Error(`restore of ${name} did not land intact`)
    await rename(tmp, join(itunes, name))
    restored.push(name)
  }
  return restored
}

/** The sentence a sync shows when it refuses to write a catalog it could not back up. */
export function backupRefusal(reason: string): string {
  return `Could not back up the iPod's song list on this Mac (${reason}), so the sync did not change it.`
}
