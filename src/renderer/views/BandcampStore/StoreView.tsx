import { useEffect, useMemo, useRef, useState , useSyncExternalStore } from 'react'
import { foldAccents } from '../../../common/fold-text'
import { useLibrary } from '../../context/LibraryContext'
import { setNotice } from '../../activity'
import { subscribeMixtapes, getDeckState } from '../../mixtapes'
import './store-header.css'

// v4 Bandcamp Store: this view is just a layout placeholder for the
// embedded WebContentsView. The renderer draws nothing visible inside
// the container; the native view paints over the same rectangle on the
// main process side. We send the container's viewport-relative bounds
// over IPC so main can size the WebContentsView correctly, and re-send
// on any resize. Unmount detaches the view but does NOT destroy it, so
// session state (login, scroll position, current URL) survives sidebar
// navigation round-trips.
//
// 4.5: a thin "Library status" strip sits above the embedded view. As
// the user browses, main parses each navigation URL into {artistSlug,
// albumSlug} and ships it over IPC; this strip computes how many of
// the visible artist/album tracks are already in the library and shows
// a one-line ownership status with a click target into the matching
// ArtistDetailView. Goal: stop the user from buying duplicates and
// surface "complete the album" opportunities at the moment of choice.

interface StoreContext {
  url: string
  artistSlug: string | null
  albumSlug: string | null
}

function slugToDisplay(slug: string): string {
  return slug.replace(/-/g, ' ').trim()
}

function normalize(s: string | undefined | null): string {
  // Accent-folded first: a Bandcamp page for Sigur Rós must match the library.
  return foldAccents(s).replace(/[^a-z0-9]/g, '')
}

export default function StoreView() {
  const ref = useRef<HTMLDivElement>(null)
  const { state: lib, dispatch } = useLibrary()
  const [ctx, setCtx] = useState<StoreContext | null>(null)
  // A tape in the deck floats the DeckBar over the content area — carve
  // out its strip so the native store view never covers it.
  const deckLoaded = useSyncExternalStore(subscribeMixtapes, getDeckState) != null

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const bounds = () => {
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
    }

    void window.electronAPI.bandcampMount(bounds())

    const ro = new ResizeObserver(() => {
      void window.electronAPI.bandcampResize(bounds())
    })
    ro.observe(el)

    const onWindowResize = () => {
      void window.electronAPI.bandcampResize(bounds())
    }
    window.addEventListener('resize', onWindowResize)

    // ── Overlay guard: a native WebContentsView composites ABOVE every
    // piece of renderer DOM — context menus, sheets, dialogs all appear
    // BEHIND the store (Jake: "options for everything appear behind
    // bandcamp always"). Watch the document for any known overlay and
    // hide the native view while one is up.
    const OVERLAYS = '.context-menu, .confirm-overlay, .activity-sheet-overlay, [class*="-overlay"], [class*="modal"]'
    let hidden = false
    const checkOverlays = () => {
      const anyOpen = !!document.querySelector(OVERLAYS)
      if (anyOpen !== hidden) {
        hidden = anyOpen
        void window.electronAPI.bandcampSetVisible?.(!anyOpen)
      }
    }
    const mo = new MutationObserver(checkOverlays)
    mo.observe(document.body, { childList: true, subtree: true })
    checkOverlays()

    return () => {
      mo.disconnect()
      void window.electronAPI.bandcampSetVisible?.(true)
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
      void window.electronAPI.bandcampUnmount()
    }
  }, [])

  useEffect(() => {
    return window.electronAPI.onBandcampUrlChanged?.((p) => setCtx(p)) || (() => {})
  }, [])

  // 4.5.0-47: track in-Bandcamp nav state so the back arrow correctly
  // dims when there's no history to walk. Polls on every URL change.
  const [navState, setNavState] = useState<{ canGoBack: boolean; canGoForward: boolean }>({ canGoBack: false, canGoForward: false })
  const [destinations, setDestinations] = useState<Array<{ id: string; label: string; url: string }>>([])
  const [dest, setDest] = useState('bandcamp')
  useEffect(() => {
    void window.electronAPI.bandcampDestinations?.()
      .then((r) => { if (r?.ok) setDestinations(r.destinations) })
      .catch(() => { /* older main process — switcher stays hidden */ })
  }, [])
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      window.electronAPI.bandcampNavState?.().then(r => {
        if (!cancelled && r) setNavState({ canGoBack: !!r.canGoBack, canGoForward: !!r.canGoForward })
      }).catch(() => { setNotice("Couldn't read Bandcamp navigation state.", { kind: 'error', durationMs: 4000 }) })
    }
    refresh()
    // Re-check whenever the URL changes (navigation done) — but also a
    // delayed poll because Bandcamp uses client-side routing that
    // doesn't fire url-changed reliably for every history shift.
    const onChange = () => { refresh(); setTimeout(refresh, 250) }
    const unsub = window.electronAPI.onBandcampUrlChanged?.(() => onChange()) || (() => {})
    return () => { cancelled = true; unsub() }
  }, [])

  // Compute library matches for the current Bandcamp context. The slug
  // → display compare normalizes both sides (lower-case, strip
  // punctuation/spaces) so "foo-fighters" matches "Foo Fighters",
  // "drake-official" loosely matches tracks tagged "Drake", etc.
  // matchedArtistName is the canonical library-side spelling so the
  // click-through navigates to the same string ArtistsView uses.
  const match = useMemo(() => {
    if (!ctx || !ctx.artistSlug) return null
    const artistDisplay = slugToDisplay(ctx.artistSlug)
    const artistNorm = normalize(artistDisplay)
    if (!artistNorm) return null

    let matchedArtistName: string | null = null
    let artistTrackCount = 0
    let albumTracks: typeof lib.tracks = []
    const albumNorm = ctx.albumSlug ? normalize(slugToDisplay(ctx.albumSlug)) : ''

    for (const t of lib.tracks) {
      const tArtistNorm = normalize(t.artist)
      if (!tArtistNorm) continue
      // 4.5.0-104: substring fallback was over-matching short artist
      // names — "a-ha" normalized to "aha" (3 chars) was a substring of
      // dozens of unrelated Bandcamp subdomains (mahalia, ahab, bahamas,
      // yahaba). Require both norms to be ≥4 chars before allowing a
      // substring match. Exact match still works for short names.
      const SUBSTR_MIN = 4
      const artistHit =
        tArtistNorm === artistNorm ||
        (tArtistNorm.length >= SUBSTR_MIN && artistNorm.length >= SUBSTR_MIN &&
          (tArtistNorm.includes(artistNorm) || artistNorm.includes(tArtistNorm)))
      if (!artistHit) continue
      artistTrackCount++
      if (!matchedArtistName) matchedArtistName = t.artist || null
      if (albumNorm) {
        const tAlbumNorm = normalize(t.album)
        // Same SUBSTR_MIN guard — "X", "÷", "1989" all normalize to
        // 1-4 chars and would over-match without it.
        const albumHit = tAlbumNorm && (
          tAlbumNorm === albumNorm ||
          (tAlbumNorm.length >= SUBSTR_MIN && albumNorm.length >= SUBSTR_MIN &&
            (tAlbumNorm.includes(albumNorm) || albumNorm.includes(tAlbumNorm)))
        )
        if (albumHit) {
          albumTracks.push(t)
        }
      }
    }

    return {
      artistDisplay,
      matchedArtistName,
      artistTrackCount,
      albumName: ctx.albumSlug ? slugToDisplay(ctx.albumSlug) : null,
      albumOwnedCount: albumTracks.length,
    }
  }, [ctx, lib.tracks])

  function goToArtist() {
    if (match?.matchedArtistName) {
      dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: match.matchedArtistName })
    }
  }

  return (
    <div className="store-view-root" style={{ paddingBottom: deckLoaded ? 78 : 0 }}>
      <div className="store-library-header">
        {/* 4.5.0-47: back arrow is ALWAYS rendered. Walks the embedded
            Bandcamp WebContentsView's history (browser-style). Dimmed
            when there's nothing behind. The library-status strip lives
            to its right ONLY when we have a real match — the old
            "Browse Bandcamp..." hint was noise and is gone. */}
        <div className="store-library-header__nav">
          <button
            className="store-library-header__navbtn"
            onClick={() => window.electronAPI.bandcampGoBack?.()}
            disabled={!navState.canGoBack}
            title="Back"
            aria-label="Back"
          >‹</button>
          <button
            className="store-library-header__navbtn"
            onClick={() => window.electronAPI.bandcampGoForward?.()}
            disabled={!navState.canGoForward}
            title="Forward"
            aria-label="Forward"
          >›</button>
          {/* Store switcher. The embedded view is just a browser whose
              downloads land in the library, so it can point at any store on
              the main-process allow-list — squid.wtf is back on it. */}
          <span className="store-library-header__dests">
            {destinations.map((d) => (
              <button
                key={d.id}
                className={`store-library-header__dest${dest === d.id ? ' is-active' : ''}`}
                onClick={() => {
                  setDest(d.id)
                  void window.electronAPI.bandcampNavigate?.(d.id)
                }}
                title={`Browse ${d.label}`}
              >{d.label}</button>
            ))}
          </span>
        </div>
        {match && match.artistTrackCount > 0 ? (
          <button className="store-library-header__match" onClick={goToArtist} title="Jump to artist in your library">
            <span className="store-library-header__dot store-library-header__dot--own" />
            {match.albumName ? (
              <span>
                You own <strong>{match.albumOwnedCount}</strong> track{match.albumOwnedCount === 1 ? '' : 's'} from <em>{match.albumName}</em>
                <span className="store-library-header__sep"> · </span>
                <strong>{match.artistTrackCount}</strong> total from {match.matchedArtistName || match.artistDisplay}
              </span>
            ) : (
              <span>
                You own <strong>{match.artistTrackCount}</strong> track{match.artistTrackCount === 1 ? '' : 's'} by {match.matchedArtistName || match.artistDisplay}
              </span>
            )}
            <span className="store-library-header__cta">View in Library →</span>
          </button>
        ) : match ? (
          <span className="store-library-header__nomatch">
            <span className="store-library-header__dot store-library-header__dot--none" />
            No tracks from <strong>{match.artistDisplay}</strong> in your library yet
          </span>
        ) : null}
      </div>
      <div ref={ref} className="store-view-embed" aria-label="Bandcamp Store" />
    </div>
  )
}
