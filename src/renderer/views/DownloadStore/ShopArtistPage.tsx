/**
 * An artist's page inside the Record Shop (Brief 256): their albums, EPs and
 * singles, newest first, each a card with Save album, what Jake already has
 * marked, and the lossless dot. Clicking a card opens its album page.
 *
 * The cards are DownloadView's own (renderRelease), handed in, so a save here
 * is the Search tab's save: the same queue, preflight and Downloads panel.
 * One Apple lookup per artist (kept ten minutes in main), one Qobuz search for
 * all the dots.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { markLine, ownsArtist, listedArtist, type ArtistReleases, type ShopAlbum, type ShopArtist } from '../../../common/shop-search'
import { askLossless, losslessVersion, subscribeLossless } from './shopLossless'
import type { LibraryMarks, ListMarks } from '../../../common/shop-search'
import { LIST_MARK } from '../../../common/shop-names'

/** The artist page's dots ask Qobuz for this many items (a big catalogue needs more than a search's 50). */
export const ARTIST_LOSSLESS_LIMIT = 100

export default function ShopArtistPage({ artist, artworkUrl, marks, renderAlbum, onBack, backLabel }: {
  artist: ShopArtist
  artworkUrl?: string
  marks: { lib: LibraryMarks; list: ListMarks }
  /** A release card (DownloadView's renderRelease), its dots asked under the artist's name. */
  renderAlbum: (a: ShopAlbum, i: number, scope: { words: string; limit: number }) => ReactNode
  onBack: () => void
  backLabel: string
}) {
  const [state, setState] = useState<{ loading: boolean; releases?: ArtistReleases; error?: boolean }>({ loading: true })
  useSyncExternalStore(subscribeLossless, losslessVersion)

  useEffect(() => {
    let live = true
    setState({ loading: true })
    const api = window.electronAPI.shopArtistReleases
    if (!api) { setState({ loading: false, error: true }); return }
    api(artist.artistId, artist.name)
      .then((r) => { if (live) setState(r?.ok ? { loading: false, releases: r.releases } : { loading: false, error: true }) })
      .catch(() => { if (live) setState({ loading: false, error: true }) })
    askLossless(artist.name, ARTIST_LOSSLESS_LIMIT)
    return () => { live = false }
  }, [artist.artistId, artist.name])

  const scope = { words: artist.name, limit: ARTIST_LOSSLESS_LIMIT }
  const mark = markLine({ owned: ownsArtist(marks.lib, artist.name), listed: listedArtist(marks.list, artist.name) })
  const r = state.releases
  const art = artworkUrl ?? r?.albums[0]?.artworkUrl ?? r?.eps[0]?.artworkUrl ?? r?.singles[0]?.artworkUrl
  const section = (title: string, list: ShopAlbum[]) => list.length === 0 ? null : (
    <section className="dl-sec">
      <div className="dl-sec-head">
        <span className="dl-sec-title">{title}</span>
        <span className="dl-sec-count">{list.length}</span>
        <span className="dl-rule" />
      </div>
      <div className="dl-shelf">{list.map((a, i) => renderAlbum(a, i, scope))}</div>
    </section>
  )

  return (
    <div className="shop-page">
      <button type="button" className="shop-back" onClick={onBack}>‹ {backLabel}</button>
      <div className="shop-page-head">
        {art
          ? <img className="shop-artist-art" src={art} alt="" />
          : <span className="shop-artist-art shop-artist-art--ph" aria-hidden="true">{artist.name.slice(0, 1).toUpperCase()}</span>}
        <div className="shop-page-titles">
          <span className="shop-page-kind">Artist</span>
          <span className="shop-page-title">{artist.name}</span>
          <span className="shop-page-sub">
            {artist.genre ? <span>{artist.genre}</span> : null}
            {mark ? <span className={`shop-mark${mark === LIST_MARK ? ' shop-mark--list' : ''}`}>{mark}</span> : null}
          </span>
        </div>
      </div>
      {state.loading && <div className="dl-rel-panel-note"><span className="dl-spinner" aria-hidden="true" /> Loading releases…</div>}
      {state.error && <div className="dl-rel-panel-note dl-rel-panel-note--err">Couldn’t load this artist’s records.</div>}
      {r && !r.albums.length && !r.eps.length && !r.singles.length && <div className="dl-rel-panel-note">No records listed for this artist.</div>}
      {r && section('Albums', r.albums)}
      {r && section('EPs', r.eps)}
      {r && section('Singles', r.singles)}
    </div>
  )
}
