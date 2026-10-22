/**
 * Artist profile IPC (2026-10-20) — the rebuilt artist page's data. The client
 * and its cache live in ../artist-profile-client.ts; the contract in
 * ../../common/artist-profile.ts.
 *
 *   'artist-profile:get'      (name)  → { ok, state }   the cached profile, no network — instant
 *   'artist-profile:refresh'  (name)  → { ok, state }   one GET (ETag, throttled per artist) +
 *                                                       any member photo not saved yet
 *   'artist-profile:set-member-photo' (artist, member, path | null)
 *                                     → { ok, state } | { ok: false, canceled? , error? }
 *       Jake's own photo of a member. path = a dropped file; null = open a
 *       picker. The picture is normalized to JPEG (long side ≤ 1800 px) with
 *       sips, then PUT to homemini (/api/artist/:name/members/:member/photo),
 *       which face-crops it and keeps it as that member's override. A failure comes back as a readable error the page shows
 *       inline — nothing is saved locally on a failure, so the phone and the
 *       Macs never disagree about whose face is on the tile.
 *
 * Registered by registerReleaseKindsIpc (its sibling on the artist page), so
 * main/index.ts does not grow. Member photos are saved into the artist-image
 * folder and drawn through the existing artist-image:// protocol.
 */
import { app, BrowserWindow, dialog } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join, extname, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { quietWarn } from '../flight-recorder'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'
import { createArtistProfileClient } from '../artist-profile-client.ts'

const execP = promisify(execFile)

/** What a person would hand us as a photo (the playlist-cover picker's list). */
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'tiff', 'gif', 'bmp']
const MAX_SOURCE_BYTES = 60 * 1024 * 1024
const MAX_UPLOAD_SIDE = 1800

/** ⚠️ Same folder as getArtistImageDir() in main/index.ts — artist-image:// serves it. */
const artistImageDir = (): string => join(app.getPath('userData'), 'artist-images')

/**
 * A picture file → JPEG bytes (long side ≤ 1800 px), or an error a person can
 * read. sips refusing the file is a refusal here (unlike playlist covers,
 * which keep the raw bytes): only something macOS can open as an image is
 * ever sent to homemini.
 * ⚠️ TWIN: JakeTunesMobile ios/JakeTunesMobile/MemberPhotoPick.swift jpeg(from:)
 * — the phone's copy of these limits (JPEG q88, ≤ 1800 px, 60 MB) and words.
 */
async function normalizeToJpeg(src: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const ext = extname(src).slice(1).toLowerCase()
  if (!isAbsolute(src) || !IMAGE_EXTS.includes(ext)) return { ok: false, error: 'That is not a picture file (JPEG, PNG, HEIC, WebP…).' }
  const st = await stat(src).catch(() => null)
  if (!st || !st.isFile()) return { ok: false, error: 'That file could not be opened.' }
  if (st.size > MAX_SOURCE_BYTES) return { ok: false, error: 'That picture is too big (over 60 MB).' }
  const dir = await mkdtemp(join(tmpdir(), 'jt-member-photo-'))
  try {
    const out = join(dir, 'photo.jpg')
    let longSide = 0
    try {
      const { stdout } = await execP('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src], { timeout: 20_000 })
      const dims = [...stdout.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1]))
      longSide = Math.max(0, ...dims)
    } catch (err) {
      quietWarn('artist-profile:sips', '[artist-profile] sips could not read the picture:', err instanceof Error ? err.message : err)
      return { ok: false, error: 'That file could not be read as a picture.' }
    }
    if (longSide <= 0) return { ok: false, error: 'That file could not be read as a picture.' }
    const resize = longSide > MAX_UPLOAD_SIDE ? ['-Z', String(MAX_UPLOAD_SIDE)] : []
    try {
      await execP('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', ...resize, src, '--out', out], { timeout: 30_000 })
    } catch (err) {
      quietWarn('artist-profile:sips', '[artist-profile] sips could not convert the picture:', err instanceof Error ? err.message : err)
      return { ok: false, error: 'That picture could not be converted to JPEG.' }
    }
    const bytes = await readFile(out)
    if (bytes.length === 0) return { ok: false, error: 'That file could not be read as a picture.' }
    return { ok: true, bytes: new Uint8Array(bytes) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
      quietWarn('artist-profile:tmp', '[artist-profile] temp cleanup failed:', err instanceof Error ? err.message : err))
  }
}

export function registerArtistProfileIpc(ipc: IpcRegistrar): void {
  const client = createArtistProfileClient({
    baseUrl: MOBILE_BACKEND_URL.replace(/\/audio$/, ''),
    profileDir: join(app.getPath('userData'), 'artist-profiles'),
    photoDir: artistImageDir(),
    warn: (key: string, m: string) => quietWarn(`artist-profile:${key}`, m),
  })

  const nameOf = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 300) : '')

  ipc.handle('artist-profile:get', async (_e, name: unknown) =>
    ({ ok: true, state: await client.read(nameOf(name)) }), { refuse: REFUSED_SENDER })
  ipc.handle('artist-profile:refresh', async (_e, name: unknown) =>
    ({ ok: true, state: await client.refresh(nameOf(name)) }), { refuse: REFUSED_SENDER })

  ipc.handle('artist-profile:set-member-photo', async (event, artist: unknown, member: unknown, path: unknown) => {
    const a = nameOf(artist)
    const m = nameOf(member)
    if (!a || !m) return { ok: false, error: 'No member to set a photo for.' }
    let src = typeof path === 'string' && path ? path : ''
    if (!src) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: `Choose a photo of ${m}`,
        properties: ['openFile' as const],
        filters: [{ name: 'Images', extensions: IMAGE_EXTS }],
      }
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
      src = res.filePaths[0]
    }
    const jpeg = await normalizeToJpeg(src)
    if (!jpeg.ok) return { ok: false, error: jpeg.error }
    return client.putMemberPhoto(a, m, jpeg.bytes)
  }, { refuse: REFUSED_SENDER })
}
