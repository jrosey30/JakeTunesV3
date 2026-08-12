/**
 * playlist-covers — the things a playlist has that the library record can't
 * hold: a cover image, and a description Jake wrote himself.
 *
 * Both live here for the same reason. LibraryContext is do-not-touch, so
 * adding fields to Playlist would mean new reducer actions inside a protected
 * file. Keeping them beside the library instead costs one side-file and keeps
 * the protected reducer untouched.
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
import { dialog, BrowserWindow, app, protocol, net } from 'electron'
import type { IpcRegistrar } from './ipc-register.ts'
import { REFUSED_SENDER } from './ipc-register.ts'
import { safeIpcError } from './safe-ipc-error.ts'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdir, unlink, copyFile, stat, readdir, readFile, writeFile, rename } from 'fs/promises'
import { join } from 'path'
import { pathToFileURL } from 'url'

const execP = promisify(execFile)

const COVERS_DIR = (): string => join(app.getPath('userData'), 'playlist-covers')
/** Descriptions Jake typed: { [playlistId]: text }. One small JSON file. */
const NOTES_FILE = (): string => join(app.getPath('userData'), 'playlist-notes.json')

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

async function loadNotes(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(NOTES_FILE(), 'utf-8')
    const o = JSON.parse(raw)
    return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, string> : {}
  } catch {
    return {}   // missing file = no descriptions yet
  }
}

export function registerPlaylistCoverIpc(
  ipc: IpcRegistrar,
  getMainWindow: () => BrowserWindow | null,
): void {
  /**
   * Playlist descriptions (2026-08-09). Jake: "id like abolity to write a
   * description for each playlist if i want."
   *
   * Playlist.commentary already exists and renders, but nothing can WRITE it
   * — there's no reducer action for it, and adding one means editing the
   * do-not-touch LibraryContext. So a description Jake types lives here and
   * takes precedence over any commentary a generated playlist arrived with;
   * clearing it falls back to that.
   */
  ipc.handle('playlist-notes-get', async () => ({ ok: true, notes: await loadNotes() }), { public: true })

  ipc.handle('playlist-note-set', async (_e, playlistId: string, text: string) => {
    const id = safeId(String(playlistId || ''))
    if (!id) return { ok: false, error: 'bad playlist id' }
    try {
      const notes = await loadNotes()
      const clean = String(text ?? '').slice(0, 2000).trim()
      if (clean) notes[id] = clean
      else delete notes[id]
      // tmp + rename: a killed write can't leave a torn file that loses every
      // OTHER playlist's description too.
      const tmp = NOTES_FILE() + '.tmp'
      await writeFile(tmp, JSON.stringify(notes, null, 2))
      await rename(tmp, NOTES_FILE())
      return { ok: true }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

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
  ipc.handle('playlist-covers-map', async () => {
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
  }, { public: true })

  /** Open a picker, normalize the pick to JPEG, return the stored path. */
  ipc.handle('playlist-cover-pick', async (_e, playlistId: string) => {
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
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  /**
   * Inherit a cover — a tape made FROM a playlist keeps that playlist's
   * picture. Jake, 2026-08-09: "shouldnt my custom cover be the custom cover
   * for this mixtape since it came from a playlist?" Yes: the tape inherits
   * the playlist's name and running order already, so the cover was simply an
   * oversight.
   *
   * COPIES rather than aliases. If the tape pointed at the playlist's file,
   * changing the playlist's cover later would silently change the tape's too,
   * and deleting the playlist would leave the tape blank. They're separate
   * objects from the moment the tape exists.
   *
   * Playlist ids (pl-…) and tape ids (mix-…) share this directory without
   * colliding — different prefixes, and both are validated by safeId().
   */
  ipc.handle('playlist-cover-copy', async (_e, fromId: string, toId: string) => {
    const a = safeId(String(fromId || ''))
    const b = safeId(String(toId || ''))
    if (!a || !b) return { ok: false, error: 'bad id' }
    try {
      const src = join(COVERS_DIR(), `${a}.jpg`)
      const st = await stat(src).catch(() => null)
      if (!st || !st.isFile()) return { ok: true, copied: false }   // nothing to inherit
      await mkdir(COVERS_DIR(), { recursive: true })
      await copyFile(src, join(COVERS_DIR(), `${b}.jpg`))
      return { ok: true, copied: true }
    } catch (err) {
      return { ok: false, error: safeIpcError(err, 'io-failed') }
    }
  }, { refuse: REFUSED_SENDER })

  /** Back to the 4-up mosaic. Identity-gated: only ever our own directory. */
  ipc.handle('playlist-cover-clear', async (_e, playlistId: string) => {
    const id = safeId(String(playlistId || ''))
    if (!id) return { ok: false, error: 'bad playlist id' }
    await unlink(join(COVERS_DIR(), `${id}.jpg`)).catch(() => {})
    return { ok: true }
  }, { refuse: REFUSED_SENDER })
}
