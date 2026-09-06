/** Record Shop (6.0): the renderer asks main for an item's catalogue
 *  identity and library ownership; main answers from the same lookup and
 *  the same identity matcher the downloader uses. Read-only. */
import type { IpcRegistrar } from '../ipc-register.ts'
import { itunesAlbumTracks } from '../download-search'
import { loadLibraryTracksLite } from '../import-pipeline.ts'
import { resolveShopSelection } from '../record-shop-resolve.ts'
import type { ShopResolveRequest } from '../../common/record-shop-live.ts'

export function registerRecordShopIpc(ipc: IpcRegistrar): void {
  ipc.handle('record-shop:resolve', async (_event, req: ShopResolveRequest) => {
    const r = req as Partial<ShopResolveRequest> | null
    const okShape = r && typeof r === 'object' && typeof r.artist === 'string'
      && ((r.kind === 'release' && typeof (r as { album?: unknown }).album === 'string' && (r as { album: string }).album.trim())
        || (r.kind === 'recording' && typeof (r as { title?: unknown }).title === 'string' && (r as { title: string }).title.trim()))
    if (!okShape) return { ok: false as const, error: 'bad-request' }
    return resolveShopSelection(req, { albumTracks: itunesAlbumTracks, library: loadLibraryTracksLite })
  }, { refuse: { ok: false, error: 'refused-sender' } })
}
