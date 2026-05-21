import { useCallback, useEffect, useState } from 'react'
import { StoreAlbumWire, UnifiedProfileWire } from '../../types'
import StoreHeader from './StoreHeader'
import StoreSidebar from './StoreSidebar'
import FeaturedCarousel from './FeaturedCarousel'
import PersonalizedSection from './PersonalizedSections'
import AlbumDetailView from './AlbumDetailView'
import './styles/itunes-tokens.css'
import './styles/store.css'
import './styles/animations.css'

type Route = { kind: 'landing' } | { kind: 'search'; query: string } | { kind: 'album' }
type AuthState = { loggedIn: boolean; username?: string }

export default function StoreView() {
  const [auth, setAuth] = useState<AuthState>({ loggedIn: false })
  const [profile, setProfile] = useState<UnifiedProfileWire | null>(null)
  const [featured, setFeatured] = useState<StoreAlbumWire[]>([])
  const [newPicks, setNewPicks] = useState<StoreAlbumWire[]>([])
  const [results, setResults] = useState<StoreAlbumWire[]>([])
  const [detail, setDetail] = useState<StoreAlbumWire | null>(null)
  const [route, setRoute] = useState<Route>({ kind: 'landing' })
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const loadSurfaces = useCallback(async () => {
    const [f, n] = await Promise.all([
      window.electronAPI.bandcampGetSurface('featured-for-you', 10),
      window.electronAPI.bandcampGetSurface('your-new-picks', 20),
    ])
    if (f.ok && f.items) setFeatured(f.items)
    if (n.ok && n.items) setNewPicks(n.items)
  }, [])

  const refreshAll = useCallback(async () => {
    const status = await window.electronAPI.bandcampAuthStatus()
    setAuth(status)
    setProfile(await window.electronAPI.bandcampGetProfile())
    if (status.loggedIn) await loadSurfaces()
  }, [loadSurfaces])

  useEffect(() => { void refreshAll() }, [refreshAll])

  useEffect(() => {
    const off = window.electronAPI.onBandcampPurchaseComplete((r) => {
      setOverlayOpen(false)
      setToast(r.ok ? `Added ${r.trackCount} track${r.trackCount === 1 ? '' : 's'} to your library` : `Purchase routing failed: ${r.error || 'unknown'}`)
      window.setTimeout(() => setToast(null), 6000)
    })
    return off
  }, [])

  const openAlbum = useCallback(async (album: StoreAlbumWire) => {
    setRoute({ kind: 'album' })
    if (album.tracks && album.tracks.length > 0) { setDetail(album); return }
    setBusy(true)
    const res = await window.electronAPI.bandcampGetAlbum(album.url)
    setBusy(false)
    setDetail(res.ok && res.album ? res.album : { ...album })
  }, [])

  const doSearch = useCallback(async (query: string) => {
    if (!query) return
    setActiveTag(null)
    setRoute({ kind: 'search', query })
    setBusy(true)
    const res = await window.electronAPI.bandcampSearch(query)
    setBusy(false)
    setResults(res.ok && res.results ? res.results : [])
  }, [])

  const selectGenre = useCallback((tag: string) => {
    setActiveTag(tag)
    void doSearch(tag)
  }, [doSearch])

  const connect = useCallback(async () => {
    setConnecting(true)
    setOverlayOpen(true)
    await window.electronAPI.bandcampConnect()
    setOverlayOpen(false)
    setConnecting(false)
    await refreshAll()
  }, [refreshAll])

  const buy = useCallback((album: StoreAlbumWire) => {
    setOverlayOpen(true)
    void window.electronAPI.bandcampOpenCheckout(album.url)
  }, [])

  const closeOverlay = useCallback(() => {
    setOverlayOpen(false)
    void window.electronAPI.bandcampCloseOverlay()
  }, [])

  const backToBrowse = useCallback(() => {
    setDetail(null)
    setRoute(activeTag ? { kind: 'search', query: activeTag } : { kind: 'landing' })
  }, [activeTag])

  return (
    <div className="bandcamp-store">
      <StoreHeader auth={auth} onSearch={doSearch} onConnect={connect} connecting={connecting} />

      <div className="bcs-body">
        <StoreSidebar topTags={profile?.topTags || []} activeTag={activeTag} onSelect={selectGenre} />

        <main className="bcs-main">
          {busy && <div className="bcs-loading">Loading…</div>}

          {route.kind === 'album' && detail && (
            <AlbumDetailView album={detail} onBack={backToBrowse} onBuy={buy} />
          )}

          {route.kind === 'search' && (
            <PersonalizedSection
              title={`Results for "${route.query}"`}
              albums={results}
              onOpen={openAlbum}
              emptyLabel={busy ? 'Searching…' : 'No results.'}
            />
          )}

          {route.kind === 'landing' && (
            <>
              {!auth.loggedIn && (
                <div className="bcs-connect-hero">
                  <h2>Personalize your store</h2>
                  <p>Connect your Bandcamp account to surface new releases from artists and labels you actually follow — ranked by your taste, not global popularity.</p>
                  <button className="bcs-connect" onClick={connect} disabled={connecting}>
                    {connecting ? 'Connecting…' : 'Connect Bandcamp'}
                  </button>
                  <p className="bcs-connect-note">You can still search the full catalog without connecting.</p>
                </div>
              )}

              {auth.loggedIn && <FeaturedCarousel items={featured} onOpen={openAlbum} />}

              {auth.loggedIn && (
                <PersonalizedSection
                  title="Your New Picks"
                  albums={newPicks}
                  onOpen={openAlbum}
                  emptyLabel="No new releases from your follows yet. Try Re-sync in a bit."
                />
              )}
            </>
          )}
        </main>
      </div>

      {overlayOpen && (
        <div className="bcs-overlay-bar">
          <span>Bandcamp</span>
          <button className="bcs-overlay-close" onClick={closeOverlay}>Close ✕</button>
        </div>
      )}

      {toast && <div className="bcs-toast">{toast}</div>}
    </div>
  )
}
