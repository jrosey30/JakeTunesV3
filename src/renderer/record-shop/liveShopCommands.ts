// The live command bus: the same verbs the regular shop performs, on the
// same modules — the one Downloads scheduler, the Listen List's queue
// adapter (same doors: a song queues, a record goes to edition selection),
// the preview player, and library playback. A presentation asks; nothing
// here decides what an item may do (shopActions does).
//
// Fixture ids never reach this bus: every verb refuses `fx:…`.
import { enqueue, cancel, retry, trackQueryId, albumQueryId, type QResult } from '../views/DownloadStore/downloadQueue'
import { queueRecoDownload, prefillDownloadView, recoOrigin, recoKind } from '../listen-to-the-list/ltlDownload'
import { togglePreview } from '../previewPlayer'
import { isFixtureId, recommendationIdOf, queueResultForSelection } from '../../common/record-shop-live'
import type { ShopCommands, ShopVerb } from '../../common/record-shop-commands'
import type { ShopSession } from '../../common/record-shop'
import type { Recommendation } from '../types'

export interface LiveShopDeps {
  session: () => ShopSession
  recById: () => ReadonlyMap<string, Recommendation>
  playTracks: (libraryTrackIds: number[]) => void
  openDownloadView: () => void
  refresh: (itemId: string) => void
  log?: (verb: ShopVerb, id: string, note: string) => void
}

export function liveShopCommands(deps: LiveShopDeps): ShopCommands {
  const guard = (verb: ShopVerb, id: string): boolean => {
    if (isFixtureId(id)) { console.warn(`[record-shop] ${verb} refused: fixture id ${id} never reaches live commands`); return false }
    return true
  }
  const itemOf = (itemId: string) => deps.session().items.find((i) => i.itemId === itemId)
  const recOf = (itemId: string): Recommendation | undefined => { const rid = recommendationIdOf(itemId); return rid ? deps.recById().get(rid) : undefined }
  const note = (verb: ShopVerb, id: string, s: string): void => { deps.log?.(verb, id, s); console.log(`[record-shop] ${verb} ${id}: ${s}`) }
  return {
    saveItem(itemId) {
      if (!guard('saveItem', itemId)) return
      // Every live item is already a saved list entry; shelves that are not
      // on the list arrive with the shelf wiring.
      note('saveItem', itemId, 'already on the list')
    },
    inspectSelection(itemId) {
      if (!guard('inspectSelection', itemId)) return
      deps.refresh(itemId)
    },
    previewItem(itemId) {
      if (!guard('previewItem', itemId)) return
      const it = itemOf(itemId); const p = it?.display.preview
      if (!it || !p) { note('previewItem', itemId, 'no preview'); return }
      togglePreview(itemId, p.url, p.trackTitle, it.display.artist ?? '')
    },
    playOwned(itemId) {
      if (!guard('playOwned', itemId)) return
      const own = deps.session().ownership[itemId]
      if (!own || own.status === 'unknown' || !own.matches.length) { note('playOwned', itemId, 'nothing owned to play'); return }
      deps.playTracks(own.matches.map((m) => m.libraryTrackId))
    },
    getSelection(itemId) {
      if (!guard('getSelection', itemId)) return
      const it = itemOf(itemId); const rec = recOf(itemId)
      if (!it || !rec) { note('getSelection', itemId, 'not a list item'); return }
      if (it.kind === 'release' && it.selection) {
        // The edition Jake chose (by iTunes id) — the same contract the Download view's Get carries.
        const r = queueResultForSelection(it, recoOrigin(rec), { track: trackQueryId, album: albumQueryId })
        if (r) { enqueue(r as QResult); note('getSelection', itemId, `queued ${r.desc}`) }
        return
      }
      const d = queueRecoDownload(rec)   // a song: the regular shop's own door
      if (d.kind === 'queue') note('getSelection', itemId, `queued ${d.result.desc}`)
      else if (d.kind === 'select-edition') { prefillDownloadView(rec, 'album'); deps.openDownloadView(); note('getSelection', itemId, 'edition selection') }
      else { prefillDownloadView(rec, 'song'); deps.openDownloadView(); note('getSelection', itemId, `browse (${d.reason})`) }
    },
    cancelJob(jobId) {
      if (!guard('cancelJob', jobId)) return
      void cancel(jobId)
    },
    retryJob(jobId) {
      if (!guard('retryJob', jobId)) return
      retry(jobId)
    },
    chooseEdition(itemId) {
      if (!guard('chooseEdition', itemId)) return
      const rec = recOf(itemId)
      if (!rec) { note('chooseEdition', itemId, 'not a list item'); return }
      prefillDownloadView(rec, recoKind(rec) === 'album' ? 'album' : 'song')
      deps.openDownloadView()
    },
  }
}
