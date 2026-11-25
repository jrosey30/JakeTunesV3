/**
 * Save album on a For You card that isn't on the Listening List (Record Shop
 * Phase 2: "Save album works from For You … without a detour"). The record's
 * edition is named the way the list's one-click save names it (saveAlbumNamed:
 * main's choice or Jake's pick from the Edition menu), the album is queued,
 * and the button follows that job: Queued, Saving, In your library, or Retry
 * with the one-tap offers when the exact edition isn't there.
 *
 * A save already running or done for the same edition opens Downloads on it
 * (never a silent no-op, Brief 253).
 */
import { useState, useSyncExternalStore } from 'react'
import { getQueue, subscribeQueue } from './downloadQueue'
import { saveAlbumNamed } from '../../listen-to-the-list/ltlDownload'
import { showDownload } from '../../components/DownloadsPanel'
import OfferButtons from './OfferButtons'
import { albumSaveButton } from '../../../common/shop-save-button'
import type { AlbumSaveSurface } from '../../../common/album-preflight'

export default function AlbumSaveButton({ artist, album, surface, className, offerClassName }: { artist: string; album: string; surface: AlbumSaveSurface; className?: string; offerClassName?: string }) {
  const queue = useSyncExternalStore(subscribeQueue, getQueue)
  const [key, setKey] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const item = key ? queue.find((q) => q.key === key) : undefined
  const b = albumSaveButton(item?.status, waiting)
  const save = (): void => {
    if (!b.clickable) return
    setWaiting(true)
    void saveAlbumNamed(artist, album, surface)
      .then((r) => {
        if (r.key) setKey(r.key)
        if (r.existingKey) showDownload(r.existingKey)
      })
      .finally(() => setWaiting(false))
  }
  return (
    <>
      <button type="button" className={className} onClick={(e) => { e.stopPropagation(); save() }} disabled={!b.clickable} title={b.failed ? (item?.primary || 'Try again') : 'Save the album'}>{b.label}</button>
      {b.failed && <OfferButtons jobKey={key ?? undefined} compact className={offerClassName} />}
    </>
  )
}
