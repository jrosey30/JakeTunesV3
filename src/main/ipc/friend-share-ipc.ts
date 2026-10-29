/**
 * Friend share IPC (2026-10-29) — the desktop twin of the phone's Share Song /
 * Share Album sheet (JakeTunesMobile FriendShare.swift).
 *
 *   'friend-share:info'  (trackId, kind)            → { ok, value: ShareInfo } | { ok: false, error }
 *        homemini builds the message + links (GET /api/share/link), so both
 *        Macs and the phone send the same thing.
 *   'friend-share:share' ({ text } | { png, name })  → { ok }
 *        macOS's own Share menu (Messages, Mail, AirDrop, Notes…) at the cursor:
 *        the message as text, or the card as a PNG file.
 *   'friend-share:copy'  ({ text } | { png })        → { ok }   clipboard
 *   'friend-share:save'  ({ png, name })             → { ok, path? } | { ok: false, canceled }
 *
 * `png` is a data:image/png;base64 URL drawn by the renderer
 * (utils/friendShareCard.ts). Only PNG data URLs are accepted.
 */
import { app, clipboard, dialog, nativeImage, ShareMenu, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { IpcRegistrar } from '../ipc-register.ts'
import { REFUSED_SENDER } from '../ipc-register.ts'
import { MOBILE_BACKEND_URL } from './recommendations-ipc.ts'
import { createFriendShareClient } from '../friend-share-client.ts'
import { cardFileName } from '../../common/friend-share-card.ts'

export interface FriendShareIpcHost {
  getMainWindow: () => BrowserWindow | null
}

const PNG_PREFIX = 'data:image/png;base64,'
const MAX_PNG_BYTES = 12 * 1024 * 1024

function pngBytes(png: unknown): Buffer | null {
  if (typeof png !== 'string' || !png.startsWith(PNG_PREFIX)) return null
  const buf = Buffer.from(png.slice(PNG_PREFIX.length), 'base64')
  return buf.length > 8 && buf.length <= MAX_PNG_BYTES && buf.readUInt32BE(0) === 0x89504e47 ? buf : null
}

async function writeTempCard(png: Buffer, name: unknown): Promise<string> {
  const dir = join(app.getPath('temp'), 'jaketunes-share')
  await mkdir(dir, { recursive: true })
  const path = join(dir, cardFileName(name))
  await writeFile(path, png)
  return path
}

export function registerFriendShareIpc(ipc: IpcRegistrar, host: FriendShareIpcHost): void {
  const client = createFriendShareClient({ baseUrl: MOBILE_BACKEND_URL })

  ipc.handle('friend-share:info', async (_e, trackId: unknown, kind: unknown) => {
    if ((typeof trackId !== 'string' && typeof trackId !== 'number') || String(trackId).length > 64) return { ok: false, error: 'bad track' }
    return client.info(trackId, kind === 'album' ? 'album' : 'song')
  }, { refuse: REFUSED_SENDER })

  ipc.handle('friend-share:share', async (_e, item: { text?: unknown; png?: unknown; name?: unknown }) => {
    const win = host.getMainWindow()
    if (!win) return { ok: false }
    if (typeof item?.text === 'string' && item.text.length <= 4000) {
      new ShareMenu({ texts: [item.text] }).popup({ window: win })
      return { ok: true }
    }
    const png = pngBytes(item?.png)
    if (!png) return { ok: false }
    const path = await writeTempCard(png, item?.name)
    new ShareMenu({ filePaths: [path] }).popup({ window: win })
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('friend-share:copy', async (_e, item: { text?: unknown; png?: unknown }) => {
    if (typeof item?.text === 'string' && item.text.length <= 4000) { clipboard.writeText(item.text); return { ok: true } }
    const png = pngBytes(item?.png)
    if (!png) return { ok: false }
    clipboard.writeImage(nativeImage.createFromBuffer(png))
    return { ok: true }
  }, { refuse: REFUSED_SENDER })

  ipc.handle('friend-share:save', async (_e, item: { png?: unknown; name?: unknown }) => {
    const png = pngBytes(item?.png)
    const win = host.getMainWindow()
    if (!png || !win) return { ok: false }
    const result = await dialog.showSaveDialog(win, {
      title: 'Save Share Card',
      defaultPath: join(app.getPath('pictures'), cardFileName(item?.name)),
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await writeFile(result.filePath, png)
    return { ok: true, path: result.filePath }
  }, { refuse: REFUSED_SENDER })
}
