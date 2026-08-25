/**
 * Put homemini bytes back on this Mac so iPod sync can copyFile them.
 *
 * Playback talks to homemini. The Mini cannot. Pass-through eviction
 * (2026-08-16) trashes the laptop copy once homemini hashes match —
 * then Activity Sync refused "no playable file" for songs that still
 * exist on homemini. Pull over HTTP (never SMB) into the library path
 * before anything is wiped.
 *
 * Also covers a NAS symlink: do not follow it; replace it with bytes
 * from homemini.
 */

import { dirname } from 'path'
import { colonPathToAbs, type LstatLike } from './activity-boardable.ts'

export interface MaterializeFetchResult {
  ok: boolean
  status: number
  buffer: Buffer
}

export interface MaterializeTrackOpts {
  colonPath: string
  trackId: number | string
  localMount: string
  pathSep: string
  homeminiAudioBase: string
  lstat: LstatLike
  mkdir: (p: string, o: { recursive: true }) => Promise<unknown>
  writeFile: (p: string, buf: Buffer) => Promise<unknown>
  rename: (a: string, b: string) => Promise<unknown>
  unlink: (p: string) => Promise<unknown>
  fetchAudio: (url: string) => Promise<MaterializeFetchResult>
}

export type MaterializeTrackResult =
  | { ok: true; abs: string; pulled: boolean }
  | { ok: false; error: string }

export async function materializeTrackFromHomemini(opts: MaterializeTrackOpts): Promise<MaterializeTrackResult> {
  const colon = String(opts.colonPath || '').trim()
  if (!colon) return { ok: false, error: 'no path' }
  const abs = colonPathToAbs(colon, opts.localMount, opts.pathSep)
  try {
    const st = await opts.lstat(abs)
    if (!st.isSymbolicLink() && st.isFile()) return { ok: true, abs, pulled: false }
  } catch {
    /* evicted or never staged — pull */
  }
  const url = `${opts.homeminiAudioBase.replace(/\/$/, '')}/${encodeURIComponent(String(opts.trackId))}`
  let audio: MaterializeFetchResult
  try {
    audio = await opts.fetchAudio(url)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'homemini fetch failed' }
  }
  if (!audio.ok && audio.status !== 200 && audio.status !== 206) {
    return { ok: false, error: `homemini ${audio.status}` }
  }
  if (!audio.buffer || audio.buffer.length <= 0) {
    return { ok: false, error: 'homemini returned no bytes' }
  }
  const tmp = `${abs}.dl.tmp`
  try {
    await opts.mkdir(dirname(abs), { recursive: true })
    await opts.unlink(tmp).catch(() => {})
    await opts.writeFile(tmp, audio.buffer)
    await opts.rename(tmp, abs)
  } catch (err) {
    await opts.unlink(tmp).catch(() => {})
    return { ok: false, error: err instanceof Error ? err.message : 'failed to write pulled file' }
  }
  return { ok: true, abs, pulled: true }
}
