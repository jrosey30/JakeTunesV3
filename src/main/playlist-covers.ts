/**
 * playlist-covers — a custom cover image for a playlist.
 *
 * Jake, 2026-08-09: "playlists on desktop need covers....like it is on mobile
 * (first 4 songs' album covers or i can upload a custom cover that i want in
 * jpg jpeg or png etc"
 *
 * The 4-up mosaic half needs nothing from main — MixArtwork already builds it
 * in the renderer from the library's own artwork map, using the same rule iOS
 * uses (first 4 UNIQUE album covers). This module is only the OTHER half: the
 * picture Jake chooses himself.
 *
 * Chosen files are COPIED into userData/playlist-covers/<playlistId>.jpg, not
 * referenced where they sit. A reference would break the moment he moved or
 * deleted the original — and covers picked off a camera roll or a Downloads
 * folder are exactly the files that get moved. The copy is normalized to JPEG
 * via `sips`, which is already how set-custom-artwork handles album art, so
 * HEIC off an iPhone works alongside jpg/png/webp.
 */
import { ipcMain, dialog, BrowserWindow, app, protocol, net } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir, unlink, copyFile, stat, readdir } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'

const execP = promisify(execFile)

const COVERS_DIR = (): string => join(app.getPath('userData'), 'playlist-covers')

/** Only what a person would actually hand us as a cover. */
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'tiff', 'gif', 'bmp']

/** Playlist ids are app-generated (`pl-<ts>`), but this file becomes a PATH,
 *  so refuse anything that could climb out of the covers directory. */
function safeId(id: string): string | null {
  return /^[A-Za-z0-9._-]{1,120}$/.test(id) && !id.includes('..') ? id : null
}

/**
 * `playlist-cover://<playlistId>.jpg` — its own tiny protocol.
 *
 * Not album-art:// (that resolves a HASH inside the artwork cache, and a
 * playlist cover isn't album art — filing it there would put it in front of
 * the artwork index's self-heal), and not ipod-audio:// (an audio streamer
 * with range handling that has no business serving an <img>). Its own
 * scheme keeps the concerns apart and the validation honest: the id is
 * checked with the same safeId() that governs writes, so a crafted URL can't
 * walk out of the covers directory.
 *
 * Call inside app.whenReady().
 */
export function registerPlaylistCoverProtocol(): void {
  protocol.handle('playlist-cover', async (request) => {
    const raw = request.url.replace('playlist-cover://', '').split('?')[0]
    const id = safeId(decodeURIComponent(raw).replace(/\.jpg$/i, ''))
    if (!id) return new Response('Forbidden', { status: 403 })
    const file = join(COVERS_DIR(), `${id}.jpg`)
    const st = await stat(file).catch(() => null)
    if (!st || !st.isFile()) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

export function registerPlaylistCoverIpc(getMainWindow: () => BrowserWindow | null): void {
  /**
   * Which playlists have a custom cover, and how fresh each one is.
   *
   * Deliberately derived from the DIRECTORY rather than stored on the
   * playlist record: LibraryContext is do-not-touch, so adding a field to
   * Playlist would mean a new reducer action in a protected file. The
   * filename IS the key (<playlistId>.jpg), which also means a cover can
   * never disagree with itself — there's one source of truth and it's the
   * file. mtime rides along as a cache-buster for replaced covers.
   */
  ipcMain.handle('playlist-covers-map', async () => {
    try {
      const names = await readdir(COVERS_DIR()).catch(() => [] as string[])
      const out: Record<string, number> = {}
      for (const n of names) {
        if (!n.endsWith('.jpg')) continue
        const st = await stat(join(COVERS_DIR(), n)).catch(() => null)
        if (st && st.size > 0) out[n.slice(0, -4)] = st.mtimeMs
      }
      return { ok: true, covers: out, dir: COVERS_DIR() }
    } catch {
      return { ok: true, covers: {}, dir: COVERS_DIR() }
    }
  })

  /** Open a picker, normalize the pick to JPEG, return the stored path. */
  ipcMain.handle('playlist-cover-pick', async (_e, playlistId: string) => {
    const id = safeId(String(playlistId || ''))
    if (!id) return { ok: false, error: 'bad playlist id' }
    const win = getMainWindow()
    const res = win
      ? await dialog.showOpenDialog(win, {
        title: 'Choose a cover',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: IMAGE_EXTS }],
      })
      : await dialog.showOpenDialog({
        title: 'Choose a cover',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: IMAGE_EXTS }],
      })
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
    const src = res.filePaths[0]
    try {
      await mkdir(COVERS_DIR(), { recursive: true })
      const dest = join(COVERS_DIR(), `${id}.jpg`)
      // sips normalizes HEIC/PNG/WebP → JPEG and strips the surprises (CMYK,
      // rotation EXIF) that make an image load fine in Preview and blank in a
      // renderer. Same tool set-custom-artwork uses for album art.
      try {
        await execP('sips', ['-s', 'format', 'jpeg', src, '--out', dest], { timeout: 30000 })
      } catch {
        // sips missing or refused the file: keep the bytes rather than fail.
        await copyFile(src, dest)
      }
      const st = await stat(dest).catch(() => null)
      if (!st || st.size === 0) return { ok: false, error: 'that file could not be read as an image' }
      // Cache-buster: the path never changes when a cover is REPLACED, so
      // without this the renderer would keep showing the old picture.
      return { ok: true, path: dest, stamp: st.mtimeMs }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'could not save that cover' }
    }
  })

  /** Back to the 4-up mosaic. Identity-gated: only ever our own directory. */
  ipcMain.handle('playlist-cover-clear', async (_e, playlistId: string) => {
    const id = safeId(String(playlistId || ''))
    if (!id) return { ok: false, error: 'bad playlist id' }
    await unlink(join(COVERS_DIR(), `${id}.jpg`)).catch(() => {})
    return { ok: true }
  })
}
