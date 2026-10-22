/**
 * Artists (2026-10-11 redesign — Jake: "we gotta make the artist page way way
 * way way better… this is shit"). A photo grid instead of a list of initials:
 * every card carries the artist's genre shelf, country and how much of them
 * is here; six sorts; Heavy rotation + New in your library on top of A–Z.
 *
 * Kept from the list: click → the artist page, drag → the whole discography,
 * the filter, ✦ Group artists, the A–Z rail, ⌘F find, scroll memory, drill-in
 * from Home, auto-follow of the playing artist. The inline album expander and
 * its right-click menu had been unreachable since the artist page shipped (4.5).
 *
 * Photos come from main (artist-photo.ts: Deezer, confirmed against Jake's own
 * albums/songs), requested as cards scroll near the viewport. No photo = an
 * initials disc — never album art in a circle (Jake, twice: "that's an album
 * picture not an artist").
 */
import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore, memo } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { usePlayback } from '../context/PlaybackContext'
import { useAudio } from '../hooks/useAudio'
import { useRegularLibraryTracks } from '../hooks/useRegularLibraryTracks'
import { useScrollPersistence } from '../hooks/useScrollPersistence'
import { useScrollingClass } from '../hooks/useScrollingClass'
import { sessionArtistImages, hashColor, initials } from '../utils/artistPortrait'
import { compareNames, artistSectionLetter } from '../utils/artistSort'
import ScrollTopButton from '../components/ScrollTopButton'
import FindBar from '../components/FindBar'
import { useFindState } from '../hooks/useFindState'
import { consumeDrillIn } from '../utils/drillIn'
import { setAlbumDragPayload } from '../utils/trackDrag'
import { groupTracksByArtist } from '../utils/artistTracks'
import EmptyState from '../components/EmptyState'
import ArtistGroupingModal from '../components/ArtistGroupingModal'
// 2026-10-18 — 5 FAVORITE ARTISTS, synced with the phone through homemini.
import FavoriteArtistsRow, { type FavoriteCandidate } from '../components/FavoriteArtistsRow'
import { Track } from '../types'
import { artistIdentityKey, canonicalArtist, subscribeAliases, getAliasVersion } from '../utils/artistAlias'
import { GENRES } from '../../common/genre-vocab'
import { playsEverywhere } from '../../common/plays-elsewhere'
import { usePlaysElsewhere } from '../playsElsewhere'
import '../styles/artists.css'
import '../styles/artists-grid.css'

const AZ_LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const FAMILY = new Map(GENRES.map((g) => [g.name, g.area]))
// Depth = ListenBrainz listeners (music fans), not Deezer fans — Deezer put
// Hayley Williams (510K) in the Tip with The Beatles and Television (20K)
// down in Below (Jake: "how does hayley williams end up with the beatles????").
const LAYERS: Array<[string, number]> = [['The Tip', 150_000], ['Just Below', 50_000], ['Below', 10_000], ['Deep Water', 1_000], ['The Abyss', 0]]
type SortId = 'az' | 'played' | 'added' | 'genre' | 'country' | 'depth'
const SORTS: Array<[SortId, string]> = [['az', 'A–Z'], ['played', 'Most played'], ['added', 'Recently added'], ['genre', 'Genre'], ['country', 'Country'], ['depth', 'Depth']]
/** The sort survives leaving the view (MainContent unmounts it). */
let lastSort: SortId = 'az'

interface ArtistCard {
  name: string
  tracks: Track[]
  albums: number
  plays: number
  added: string          // earliest dateAdded (YYYY-MM-DD) — when the artist arrived
  genre: string          // the shelf most of their songs are on
  family: string
  origin: string
}

const plural = (n: number, w: string): string => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`
const top = (m: Map<string, number>): string => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
const monthOf = (d: string): string => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Date unknown')
const PHOTO_CONCURRENCY = 4

interface ArtistCardProps {
  a: ArtistCard
  slug: string | null | undefined
  chip?: string
  wide?: boolean
  hideOrigin: boolean
  observe: (el: HTMLElement | null) => void
  onOpen: (name: string) => void
  onPlay: (a: ArtistCard) => void
}

/** One artist card. Memoized (2026-10-21): a playback tick or one arriving
 *  photo used to re-render all ~1,940 cards (26 ms per tick; 30–120 ms per
 *  photo burst while scrolling into unseen letters) — now only the card whose
 *  photo arrived re-renders. */
const ArtistCardView = memo(function ArtistCardView({ a, slug, chip, wide, hideOrigin, observe, onOpen, onPlay }: ArtistCardProps) {
  const meta = [a.genre, hideOrigin ? '' : a.origin].filter(Boolean).join(' · ')
  return (
    <div
      ref={observe}
      className={`ag-card${wide ? ' ag-card--shelf' : ''}`}
      data-artist-name={a.name}
      role="button"
      tabIndex={0}
      title={a.name}
      onClick={() => onOpen(a.name)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(a.name) } }}
      draggable
      onDragStart={(e) => setAlbumDragPayload(e, a.tracks.map((t) => t.id))}
    >
      <div className="ag-ph">
        {slug
          ? <img src={`artist-image://${slug}.jpg`} alt="" draggable={false} loading="lazy" decoding="async" />
          : <div className="ag-ini" style={{ background: hashColor(a.name) }}>{initials(a.name.replace(/^the\s+/i, ''))}</div>}
        {/* Hover play (Jake 2026-10-21, option A of three he was shown): the
            photo dims a touch and a white disc with the orange play sits in
            its exact centre. The triangle's box is centred, then nudged right
            by 1/12 of its width so it LOOKS centred (a triangle's mass sits
            left of its box centre). */}
        <span className="ag-scrim" aria-hidden="true" />
        <button type="button" className="ag-play" aria-label={`Play ${a.name}`} title={`Play ${a.name}`}
          onClick={(e) => { e.stopPropagation(); onPlay(a) }} onKeyDown={(e) => e.stopPropagation()}>
          <svg className="ag-play-tri" width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><path d="M0 0L16 9L0 18Z" fill="currentColor" /></svg>
        </button>
      </div>
      <div className="ag-name">{a.name}</div>
      {meta && <div className="ag-meta">{meta}</div>}
      <div className="ag-meta">{a.albums ? `${plural(a.albums, 'album')} · ` : ''}{plural(a.tracks.length, 'song')}</div>
      {chip && <div className="ag-chip">{chip}</div>}
    </div>
  )
})

export default function ArtistsView(): JSX.Element {
  const { state: lib, dispatch: libDispatch } = useLibrary()
  const { state: pb } = usePlayback()
  const { playTrack } = useAudio()
  const [sort, setSortState] = useState<SortId>(lastSort)
  const setSort = (s: SortId): void => { lastSort = s; setSortState(s) }
  const [photos, setPhotos] = useState<Map<string, string | null>>(() => new Map(sessionArtistImages))
  const [fans, setFans] = useState<Record<string, number>>({})   // ListenBrainz listeners, for Depth
  const [heavy, setHeavy] = useState<Array<{ artist: string; plays: number }>>([])
  const [groupingOpen, setGroupingOpen] = useState(false)
  const [listFilter, setListFilter] = useState('')
  const aliasVersion = useSyncExternalStore(subscribeAliases, getAliasVersion)
  const regularTracks = useRegularLibraryTracks(lib.tracks)
  // 2026-10-20 — "Most played" counts the phone's and workmini's plays too. Display only.
  const elsewhere = usePlaysElsewhere()
  const viewRootRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('artists', viewRootRef)
  // Scroll cost (2026-10-21, measured off-screen at 120 Hz on the Artists
  // flick: 92 fps → 117 with both): hover is off while scrolling
  // (useScrollingClass), and letter sections out of view skip rendering
  // (content-visibility, artists-grid.css). Sections render fully on mount —
  // the scroll restore lands exactly and every section's real height is
  // remembered (contain-intrinsic-size: auto) — and only then start skipping.
  useScrollingClass(viewRootRef)
  const [skipOffscreen, setSkipOffscreen] = useState(false)
  useEffect(() => {
    let r2 = 0
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setSkipOffscreen(true)) })
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
  }, [])

  // One card per canonical artist; a collab track counts for every contributor.
  const artists = useMemo((): ArtistCard[] => {
    // (the grouping rule lives in utils/artistTracks.ts — shared with the Home)
    const map = groupTracksByArtist(regularTracks)
    return [...map.values()].map(({ name, tracks }) => {
      const albums = new Set<string>(), genres = new Map<string, number>(), origins = new Map<string, number>()
      let plays = 0, added = ''
      for (const t of tracks) {
        if (t.album) albums.add(t.album)
        if (t.genre) genres.set(t.genre, (genres.get(t.genre) ?? 0) + 1)
        if (t.origin) origins.set(t.origin, (origins.get(t.origin) ?? 0) + 1)
        plays += playsEverywhere(t, elsewhere)
        const d = String(t.dateAdded || '').slice(0, 10)
        if (d && (!added || d < added)) added = d
      }
      const genre = top(genres)
      return { name, tracks, albums: albums.size, plays, added, genre, family: FAMILY.get(genre) ?? '', origin: top(origins) }
    }).sort((a, b) => compareNames(a.name, b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regularTracks, aliasVersion, elsewhere])

  // The toolbar search pill + the in-view filter (name, genre, family or country).
  const q = (lib.searchQuery || '').trim().toLowerCase()
  const lf = listFilter.trim().toLowerCase()
  const visible = useMemo(() => artists.filter((a) => {
    if (q && !(a.name.toLowerCase().includes(q) || a.tracks.some((t) => (t.album || '').toLowerCase().includes(q) || (t.title || '').toLowerCase().includes(q)))) return false
    return !lf || a.name.toLowerCase().includes(lf) || a.genre.toLowerCase().includes(lf) || a.family.toLowerCase().includes(lf) || a.origin.toLowerCase().includes(lf)
  }), [artists, q, lf])

  // Heavy rotation: the last 30 days of plays (listening memory), mapped onto cards.
  useEffect(() => {
    let live = true
    window.electronAPI.getListeningMemory?.().then((m) => { const top = m.ok ? m.insights?.topArtists30d : undefined; if (live && top) setHeavy(top) }).catch(() => {})
    return () => { live = false }
  }, [])
  // Depth reads the ListenBrainz listener counts (artist-listeners.json).
  useEffect(() => {
    if (sort !== 'depth') return
    let live = true
    window.electronAPI.artistListeners?.().then((f) => { if (live) setFans(f) }).catch(() => {})
    return () => { live = false }
  }, [sort])

  const byKey = useMemo(() => new Map(artists.map((a) => [artistIdentityKey(a.name), a])), [artists])
  const favCandidates = useMemo((): FavoriteCandidate[] => artists.map((a) => ({ name: a.name, albums: a.albums, songs: a.tracks.length })), [artists])
  const shelves = useMemo(() => {
    if (sort !== 'az' || q || lf) return null
    const rotation = heavy.map((h) => ({ card: byKey.get(artistIdentityKey(canonicalArtist(h.artist))), plays: h.plays }))
      .filter((x): x is { card: ArtistCard; plays: number } => !!x.card).slice(0, 12)
    const fresh = artists.filter((a) => a.added).sort((a, b) => b.added.localeCompare(a.added)).slice(0, 12)
    return { rotation, fresh }
  }, [sort, q, lf, heavy, byKey, artists])

  const sections = useMemo((): Array<{ id?: string; title: string; sub?: string; items: ArtistCard[]; chip?: (a: ArtistCard) => string }> => {
    const group = (key: (a: ArtistCard) => string): Map<string, ArtistCard[]> => {
      const m = new Map<string, ArtistCard[]>()
      for (const a of visible) { const k = key(a); m.set(k, [...(m.get(k) ?? []), a]) }
      return m
    }
    if (sort === 'played') return [{ title: 'Most played', sub: 'all-time plays', items: [...visible].sort((a, b) => b.plays - a.plays || b.tracks.length - a.tracks.length), chip: (a) => (a.plays ? plural(a.plays, 'play') : '') }]
    if (sort === 'added') {
      return [...group((a) => monthOf(a.added)).entries()].sort((x, y) => (y[1][0].added || '').localeCompare(x[1][0].added || ''))
        .map(([k, v]) => ({ title: k, items: v.sort((a, b) => b.added.localeCompare(a.added)) }))
    }
    if (sort === 'genre') {
      return [...group((a) => a.family || 'Unfiled').entries()].sort((x, y) => y[1].length - x[1].length)
        .map(([k, v]) => ({ title: k, items: v.sort((a, b) => a.genre.localeCompare(b.genre) || compareNames(a.name, b.name)) }))
    }
    if (sort === 'country') {
      return [...group((a) => a.origin || 'Origin unknown').entries()].sort((x, y) => Number(x[0] === 'Origin unknown') - Number(y[0] === 'Origin unknown') || y[1].length - x[1].length)
        .map(([k, v]) => ({ title: k, items: v }))
    }
    if (sort === 'depth') {
      const layer = (a: ArtistCard): string => { const f = fans[a.name]; return f === undefined ? 'Not placed yet' : LAYERS.find(([, min]) => f >= min)![0] }
      const order = (k: string): number => (k === 'Not placed yet' ? 99 : LAYERS.findIndex(([n]) => n === k))
      return [...group(layer).entries()].sort((x, y) => order(x[0]) - order(y[0]))
        .map(([k, v]) => ({ title: k, sub: k === 'Not placed yet' ? 'no listener count yet' : 'by ListenBrainz listeners', items: v.sort((a, b) => (fans[b.name] ?? 0) - (fans[a.name] ?? 0)), chip: (a) => (fans[a.name] !== undefined ? `${fans[a.name].toLocaleString()} listeners` : '') }))
    }
    const m = group((a) => artistSectionLetter(a.name))
    return AZ_LETTERS.filter((L) => m.has(L)).map((L) => ({ id: L, title: L, items: m.get(L)! }))
  }, [sort, visible, fans])

  // ── Photos, requested as cards come near the viewport ──
  // Arrivals are batched (2026-10-21): photos resolve four at a time as you
  // scroll into unseen letters, and each one used to be its own full re-render.
  const pendingPhotosRef = useRef(new Map<string, string | null>())
  const photoFlushRef = useRef(0)
  const queuePhoto = useCallback((name: string, slug: string | null) => {
    pendingPhotosRef.current.set(name, slug)
    if (photoFlushRef.current) return
    photoFlushRef.current = window.setTimeout(() => {
      photoFlushRef.current = 0
      const batch = pendingPhotosRef.current
      pendingPhotosRef.current = new Map()
      setPhotos((prev) => { const next = new Map(prev); for (const [n, sl] of batch) next.set(n, sl); return next })
    }, 80)
  }, [])
  useEffect(() => () => { if (photoFlushRef.current) clearTimeout(photoFlushRef.current) }, [])
  const queueRef = useRef<string[]>([])
  const askedRef = useRef(new Set<string>(sessionArtistImages.keys()))
  const activeRef = useRef(0)
  const pump = useCallback(() => {
    const api = window.electronAPI
    while (activeRef.current < PHOTO_CONCURRENCY && queueRef.current.length) {
      const name = queueRef.current.shift()!
      activeRef.current++
      api.getArtistImage(name).then((r) => r.ok ? r.slug : null).catch(() => null).then((slug) => {
        sessionArtistImages.set(name, slug)
        queuePhoto(name, slug)
      }).finally(() => { activeRef.current--; pump() })
    }
  }, [queuePhoto])
  const observerRef = useRef<IntersectionObserver | null>(null)
  // Card refs run before effects: cards that mount first wait here for the observer.
  const pendingRef = useRef(new Set<HTMLElement>())
  useEffect(() => {
    observerRef.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const name = (e.target as HTMLElement).dataset.artistName
        observerRef.current?.unobserve(e.target)
        if (!name || askedRef.current.has(name) || name === 'Unknown Artist') continue
        askedRef.current.add(name)
        queueRef.current.push(name)
      }
      pump()
    }, { root: viewRootRef.current, rootMargin: '600px 0px' })
    for (const el of pendingRef.current) observerRef.current.observe(el)
    pendingRef.current.clear()
    return () => observerRef.current?.disconnect()
  }, [pump])
  const observe = useCallback((el: HTMLElement | null) => {
    if (!el) return
    if (observerRef.current) observerRef.current.observe(el); else pendingRef.current.add(el)
  }, [])

  const playArtist = useCallback((a: ArtistCard) => {
    const n = (v: number | string | undefined): number => Number(v) || 0
    const list = [...a.tracks].sort((x, y) => (x.album || '').localeCompare(y.album || '') || n(x.discNumber) - n(y.discNumber) || n(x.trackNumber) - n(y.trackNumber))
    if (list.length) playTrack(list[0], list, 0, undefined, true)
  }, [playTrack])

  // ⌘F find + drill-in + auto-follow all land on a card the same way.
  const lastActivityRef = useRef(0)
  const autoScrollAtRef = useRef(0)
  const noteActivity = useCallback(() => { if (Date.now() - autoScrollAtRef.current > 200) lastActivityRef.current = Date.now() }, [])
  const flashCard = useCallback((name: string, block: ScrollLogicalPosition = 'center') => {
    // The artist's place in the list, not its copy in a shelf at the top
    // (Heavy rotation / New in your library) — a follow used to yank the page
    // up to the shelf (2026-10-21, measured: back landed at 694 px from 48,694).
    const sel = `.ag-card[data-artist-name="${CSS.escape(name)}"]`
    const el = (viewRootRef.current?.querySelector(`.ag-sec ${sel}`) ?? viewRootRef.current?.querySelector(sel)) as HTMLElement | null
    if (!el) return
    autoScrollAtRef.current = Date.now()
    el.scrollIntoView({ block })
    el.classList.add('find-hit')
    window.setTimeout(() => el.classList.remove('find-hit'), 1400)
  }, [])
  const find = useFindState(lib.currentView === 'artists')   // a kept-alive (hidden) grid never answers ⌘F
  const findMatches = useMemo(() => {
    const t = find.query.trim().toLowerCase()
    return t ? visible.filter((a) => a.name.toLowerCase().includes(t)).map((a) => a.name) : []
  }, [visible, find.query])
  useEffect(() => {
    if (find.open && findMatches.length) flashCard(findMatches[Math.min(find.cursor, findMatches.length - 1)])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find.open, find.query, findMatches.length])
  const stepFind = (d: number): void => {
    if (!findMatches.length) return
    const c = (find.cursor + d + findMatches.length) % findMatches.length
    find.setCursor(c); flashCard(findMatches[c])
  }
  useEffect(() => {
    const requested = consumeDrillIn('artist')
    if (!requested) return
    const hit = artists.find((a) => a.name === requested) ?? artists.find((a) => a.name.toLowerCase() === requested.toLowerCase())
    if (hit) requestAnimationFrame(() => flashCard(hit.name, 'start'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Follow the playing artist when the TRACK CHANGES while this page is up and
  // idle — never on mount or on a return. The activity clock starts at 0 on
  // every mount, so the old "idle for 5 s" test passed instantly and every back
  // to Artists jumped away from the restored position (2026-10-21).
  const followedIdRef = useRef(pb.nowPlaying?.id)
  useEffect(() => {
    const id = pb.nowPlaying?.id
    if (id === followedIdRef.current) return
    followedIdRef.current = id
    if (lib.currentView !== 'artists' || !pb.nowPlaying || Date.now() - lastActivityRef.current < 5000) return
    const name = canonicalArtist(pb.nowPlaying.artist || '')
    if (visible.some((a) => a.name === name)) requestAnimationFrame(() => flashCard(name, 'nearest'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pb.nowPlaying?.id, lib.currentView])

  const openArtist = useCallback((name: string) => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: name }), [libDispatch])
  const hideOrigin = sort === 'country'
  const card = (a: ArtistCard, chip?: string, wide?: boolean): JSX.Element => (
    <ArtistCardView key={a.name} a={a} slug={photos.get(a.name)} chip={chip} wide={wide} hideOrigin={hideOrigin}
      observe={observe} onOpen={openArtist} onPlay={playArtist} />
  )
  // The shelves + A–Z sections as ONE memoized element tree (2026-10-21): a
  // render for any other reason (a playback tick, the find bar) reuses it, so
  // React skips all ~1,940 cards instead of diffing them.
  const body = useMemo(() => (
    <>
      {shelves && shelves.rotation.length > 0 && (
        <section className="ag-shelf">
          <h2 className="ag-h2">Heavy rotation <small>last 30 days</small></h2>
          <div className="ag-row">{shelves.rotation.map(({ card: a, plays }) => card(a, plural(plays, 'play'), true))}</div>
        </section>
      )}
      {shelves && shelves.fresh.length > 0 && (
        <section className="ag-shelf">
          <h2 className="ag-h2">New in your library</h2>
          <div className="ag-row">{shelves.fresh.map((a) => card(a, new Date(`${a.added}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), true))}</div>
        </section>
      )}
      {sections.map((s) => (
        <section key={s.title} className="ag-sec" data-letter={s.id}>
          <h2 className="ag-h2">{s.title} <small>{s.sub ? `${s.sub} · ` : ''}{plural(s.items.length, 'artist')}</small></h2>
          <div className="ag-grid">{s.items.map((a) => card(a, s.chip?.(a)))}</div>
        </section>
      ))}
    </>
    // card() closes over exactly these:
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [shelves, sections, photos, hideOrigin, observe, openArtist, playArtist])

  return (
    <div className={`artists-view ag${skipOffscreen ? ' ag--skip-offscreen' : ''}`} ref={viewRootRef} onClickCapture={noteActivity} onWheelCapture={noteActivity} onKeyDownCapture={noteActivity}>
      <div className="ag-head">
        <h1 className="ag-title">Artists<span>{plural(visible.length, 'artist')}</span></h1>
        <div className="artists-toolbar ag-tools">
          <div className="list-filter">
            <span className="list-filter-icon" aria-hidden="true">⌕</span>
            <input className="list-filter-input" type="text" placeholder="Filter by artist, genre or country" value={listFilter}
              onChange={(e) => setListFilter(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setListFilter('') }} spellCheck={false} aria-label="Filter artists" />
            {listFilter && <button className="list-filter-clear" onClick={() => setListFilter('')} aria-label="Clear filter" title="Clear">×</button>}
          </div>
          <button className="artists-group-btn" onClick={() => setGroupingOpen(true)} title="Let the Music Man group bands, side projects & aliases under one artist">✦ Group artists</button>
        </div>
      </div>
      <div className="ag-sorts" role="tablist" aria-label="Sort artists">
        {SORTS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={sort === id} className={`ag-sort${sort === id ? ' ag-sort--on' : ''}`}
            onClick={() => { setSort(id); viewRootRef.current?.scrollTo({ top: 0 }) }}>{label}</button>
        ))}
      </div>
      <ScrollTopButton targetRef={viewRootRef} />
      {find.open && (
        <FindBar query={find.query} onQuery={find.setQuery} current={find.cursor} total={findMatches.length}
          onNext={() => stepFind(1)} onPrev={() => stepFind(-1)} onClose={find.close} placeholder="Find artist…" />
      )}
      {visible.length === 0 && <EmptyState query={lib.searchQuery} noun="artists" />}
      {sort === 'az' && visible.length > 0 && (
        <div className="artists-az-anchor">
          <div className="artists-az-rail">
            {AZ_LETTERS.map((L) => (
              <button key={L} type="button" className="artists-az-letter" disabled={!sections.some((s) => s.id === L)}
                onClick={() => { autoScrollAtRef.current = Date.now(); viewRootRef.current?.querySelector(`[data-letter="${L}"]`)?.scrollIntoView({ block: 'start' }) }}>{L}</button>
            ))}
          </div>
        </div>
      )}
      {/* Top of the page in every sort; hidden only while a filter narrows it. */}
      {!q && !lf && (
        <FavoriteArtistsRow artists={favCandidates} onOpenArtist={(name) => libDispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: name })} />
      )}
      {body}
      {groupingOpen && <ArtistGroupingModal onClose={() => setGroupingOpen(false)} />}
    </div>
  )
}
