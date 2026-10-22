import { useLibrary } from '../context/LibraryContext'
import HomeView from '../views/HomeView'
import SongsView from '../views/SongsView'
import ArtistsView from '../views/ArtistsView'
import ArtistDetailView from '../views/ArtistDetailView'
import AlbumsView from '../views/AlbumsView'
import AlbumDetailView from '../views/AlbumDetailView'
import ConcertsView from '../views/ConcertsView'
import ConcertDetailView from '../views/ConcertDetailView'
import MixtapeView from '../views/MixtapeView'
import MixDetailView from '../views/MixDetailView'
import GenresPage from '../views/GenresPage'
import DiscoveryView from '../views/DiscoveryView'
import DJView from '../views/DJView'
import MusicManView from '../views/MusicManView'
import PlaylistView from '../views/PlaylistView'
import SmartPlaylistView from '../views/SmartPlaylistView'
import DeviceView from '../views/DeviceView'
import ActivityPoolView from '../views/ActivityPoolView'
import CDImportView from '../views/CDImportView'
import StoreView from '../views/BandcampStore'
import DownloadView from '../views/DownloadStore'
import ScotusView from '../views/ScotusView'
import RecordStoreView from '../views/RecordStore'
import YearInReviewView from '../views/YearInReviewView'
import ViewModeToggle from './ViewModeToggle'
import { useDiscHandoffView } from '../discHandoff'
import { useLayoutEffect, useRef, useState } from 'react'
import { nextKeptRoot, type KeptRoot } from '../keptView'
import { takeHistoryNavigation } from '../navIntent'
import '../styles/main-content.css'

/** Arrive vs return, decided ONCE per mounted page (its key) and then held
 *  for that page's lifetime — flipping data-nav later would restart the very
 *  entrance animations the return switched off. */
function useNavArrival(key: string): 'return' | 'arrive' {
  const ref = useRef<{ key: string; kind: 'return' | 'arrive' } | null>(null)
  if (!ref.current || ref.current.key !== key) {
    ref.current = { key, kind: takeHistoryNavigation() ? 'return' : 'arrive' }
  }
  return ref.current.kind
}

function renderKeptRoot(root: KeptRoot): JSX.Element {
  switch (root) {
    case 'artists': return <ArtistsView />
    case 'albums': return <AlbumsView />
  }
}

// V5 facelift: views that get the List / Grid / Cover Flow mode bar.
// Only the flat-table views — Albums is already the grid metaphor;
// Artists / Genres have their own browse structures.
const MODE_ELIGIBLE = new Set(['songs', 'playlist', 'smart-playlist'])

export default function MainContent() {
  const { state } = useLibrary()
  const isMusicMan = state.currentView === 'musicman'

  // The view on screen. Normally the current one; for the Island Albums
  // disc handoff (Home ↔ the album page that came out of the jewel case's
  // disc) the previous view is held for the frame the View Transition
  // captures it, then swapped inside the transition (discHandoff.ts).
  const shown = useDiscHandoffView({
    view: state.currentView,
    albumKey: state.currentView === 'album-detail' ? state.pendingAlbumKey : null,
  })
  const view = shown.view

  // For PlaylistView and SmartPlaylistView the "identity" of the view
  // is the active playlist id — we want a fresh fade-in when the user
  // clicks a different playlist, not just when they switch view type.
  const transitionKey =
    view === 'playlist' ? `playlist:${state.activePlaylistId}` :
    view === 'smart-playlist' ? `smart:${state.activeSmartPlaylist}` :
    view === 'album-detail' ? `album:${shown.albumKey}` :
    view

  // 2026-10-21: the grid you came from (Artists / Albums) stays mounted,
  // hidden, under the artist and album pages — back is an unhide, not a
  // rebuild (keptView.ts has the measurements). Follows the view ON SCREEN
  // (the disc handoff may hold the previous one for a frame). Derived during
  // render ("adjust state while rendering"), so the very first render of a
  // new view already knows what to keep.
  const [kept, setKept] = useState<KeptRoot | null>(() => nextKeptRoot(view, null))
  const wantKept = nextKeptRoot(view, kept)
  if (wantKept !== kept) setKept(wantKept)
  const keptActive = wantKept !== null && view === wantKept
  const activeKey = keptActive ? `kept:${wantKept}` : transitionKey
  const arrival = useNavArrival(activeKey)
  // The kept page's data-nav is fixed at ITS mount (see useNavArrival).
  const keptArrivalRef = useRef<{ root: KeptRoot; kind: 'return' | 'arrive' } | null>(null)
  if (wantKept && keptActive && keptArrivalRef.current?.root !== wantKept) keptArrivalRef.current = { root: wantKept, kind: arrival }
  if (!wantKept) keptArrivalRef.current = null
  // Parking a page must not leave keyboard focus on one of its cards — Space /
  // Enter on a hidden artist card would navigate from under the detail page.
  const keptBoxRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = document.activeElement
    if (!keptActive && el instanceof HTMLElement && keptBoxRef.current?.contains(el)) el.blur()
  }, [keptActive])

  // Brief 023: MusicManView stays MOUNTED across navigation — its
  // wrapper is just toggled visible/hidden based on currentView. This
  // preserves chat history, in-flight analysis state, caller selection,
  // scroll position, and DJ Mode state when the user clicks Songs /
  // Albums / etc. and comes back. The previous unmount-on-switch
  // pattern erased the whole conversation on a single Songs-view trip.
  //
  // Other views still mount/unmount per their existing fade-on-switch
  // behavior — none of them have session-local state worth preserving,
  // and unmount-on-switch keeps the React tree from accumulating
  // background work in views the user isn't looking at.
  let viewElement: JSX.Element | null = null
  if (!keptActive) switch (view) {
    case 'home': viewElement = <HomeView />; break
    case 'songs': viewElement = <SongsView />; break
    case 'artists': viewElement = <ArtistsView />; break
    case 'artist-detail': viewElement = <ArtistDetailView />; break
    case 'albums': viewElement = <AlbumsView />; break
    case 'album-detail': viewElement = <AlbumDetailView />; break
    case 'concerts': viewElement = <ConcertsView />; break
    case 'year-in-review': viewElement = <YearInReviewView />; break
    case 'concert-detail': viewElement = <ConcertDetailView />; break
    case 'mixtape-detail': viewElement = <MixtapeView />; break
    case 'activity-pool': viewElement = <ActivityPoolView />; break
    case 'mix-detail': viewElement = <MixDetailView />; break
    case 'genres': viewElement = <GenresPage />; break   // Browse (GenresView, untouched) | Icebergs
    case 'discovery': viewElement = <DiscoveryView />; break
    case 'dj': viewElement = <DJView />; break
    // Back-compat: the old standalone view names still resolve, landing on
    // the matching Discovery tab (nothing dispatches them now but the sidebar
    // 'discovery' entry — kept so any stray/deep-linked nav still works).
    case 'listen-to-the-list': viewElement = <DiscoveryView initialTab="your-list" />; break
    case 'new-for-you': viewElement = <DiscoveryView initialTab="new-for-you" />; break
    case 'musicman': break  // handled by the always-mounted wrapper below
    case 'playlist': viewElement = <PlaylistView />; break
    case 'smart-playlist': viewElement = <SmartPlaylistView />; break
    case 'device': viewElement = <DeviceView />; break
    case 'cd-import': viewElement = <CDImportView />; break
    case 'store': viewElement = <StoreView />; break
    case 'download': viewElement = <DownloadView />; break
    case 'scotus': viewElement = <ScotusView />; break
    case 'recordstore': viewElement = <RecordStoreView />; break
    default: viewElement = <SongsView />
  }

  // 4.4.24: subtle 140ms fade-in on view switch. The `key` forces a
  // re-mount of the non-MusicMan wrapper on every transition so the
  // CSS animation replays. The MusicMan wrapper deliberately does NOT
  // have a transition key — it never re-mounts after first render, so
  // its fade-in fires once at app start and that's it. State
  // preservation > re-fade on every visit.
  return (
    <>
      {wantKept && (
        // Always the same box (absolute, full size) whether shown or parked:
        // swapping display types on park would rebuild its layout, and
        // display:none costs a full relayout on unhide (measured 93 ms on
        // Artists, 70 ms on Albums). Parked = visibility:hidden — the laid-out
        // page stays, scroll intact (main-content.css says why not
        // content-visibility).
        <div
          className={`main-content-view main-content-view--kept${keptActive ? '' : ' main-content-view--parked'}`}
          key={`kept:${wantKept}`}
          ref={keptBoxRef}
          data-nav={keptArrivalRef.current?.kind === 'return' ? 'return' : undefined}
          aria-hidden={keptActive ? undefined : true}
        >
          {renderKeptRoot(wantKept)}
        </div>
      )}
      {viewElement !== null && (
        <div className="main-content-view" key={transitionKey} data-nav={arrival === 'return' ? 'return' : undefined}>
          {MODE_ELIGIBLE.has(view) ? (
            // V5 facelift: thin chrome strip above the view hosting the
            // segmented view-mode toggle, right-aligned (iTunes 10 kept
            // this control top-right). Flex column so the view below
            // keeps its height:100% behavior.
            <div className="view-with-mode-bar">
              <div className="view-mode-bar"><ViewModeToggle /></div>
              <div className="view-mode-bar-content">{viewElement}</div>
            </div>
          ) : viewElement}
        </div>
      )}
      <div
        className="main-content-view"
        style={isMusicMan ? undefined : { display: 'none' }}
      >
        <MusicManView />
      </div>
    </>
  )
}
