import { useEffect, useState, useMemo, useReducer, useRef, useSyncExternalStore, type CSSProperties } from 'react'
import { useScrollPersistence } from '../../hooks/useScrollPersistence'
import './download-store.css'
import CredentialNotice from './CredentialNotice'
import { showCredentialNotice } from './credential-notice-store'
import { qobuzNoticeFor } from '../../../common/qobuz-notice'
import { nearEditionOf } from '../../../common/near-edition-detect'
import { toggleDownloadsPanel, showDownload } from '../../components/DownloadsPanel'
import { useLibrary } from '../../context/LibraryContext'
import { scoreField, scoreResult, releaseKind, displayAlbumTitle, artistArtwork, isArtistQuery, ownedAlbum, ownsArtist, listedAlbum, listedArtist, listedSong, markLine, pickLibraryHits, type ShopAlbum, type ShopArtist } from '../../../common/shop-search'
import { losslessOf, losslessTitle } from '../../../common/shop-lossless'
import { LIST_MARK, SHOP_WORDS } from '../../../common/shop-names'
import { askLossless, losslessFor, losslessVersion, notePlanRow, subscribeLossless } from './shopLossless'
import { planIsSure, planRowOfJob, planTitle } from '../../../common/shop-qobuz-id'
import { useShopMarks } from './useShopMarks'
import ShopArtistPage from './ShopArtistPage'
import ShopAlbumPage, { type ShopAlbumRef } from './ShopAlbumPage'
import AlbumCardFoot, { editionsKeyName } from './AlbumCardFoot'
import { askEditions } from './EditionMenu'
import type { CardRecord } from '../../../common/shop-card-edition'
import { albumKeyOf } from '../../utils/albumKey'
import { buildIndex, search as searchLibrary, type AlbumRow as LibAlbumRow, type ArtistRow as LibArtistRow, type TrackRow as LibTrackRow } from '../../utils/searchIndex'
import './shop-search.css'
import { enqueue, itemFor, subscribeQueue, getQueue, retry, cancel, primaryFor, trackQueryId, editionQueryId, type QItem, type QResult, type QueueOrigin } from './downloadQueue'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../../previewPlayer'
import type { ItunesSuggestion } from '../../types'
import { explicitWins } from '../../../common/explicit'
import { norm, normQ } from './downloadKeys'
import { createShopFunnel, type ShopFunnelEvent, type ShopSearchHow } from '../../../common/shop-funnel'
import { usage } from '../../usageLog'
import { getShopQuery, setShopQuery, setShopSearching, shopQueryHow, subscribeShopQuery } from './shopQuery'

/**
 * Download v3 (2026-07-16) — "browse fast, resolve slow".
 *
 * Jake's verdict on v2: "the search is flat out a 0/100… it doesn't work,
 * i can't find any songs, i can't cancel downloads." Root cause: live search
 * was wired to the streamrip CLI — 5-15 SECONDS per call, two calls per
 * keystroke pause. The engine worked; the experience was dead on arrival.
 *
 * v3 splits the two jobs:
 *   SEARCH  = iTunes Search (instant, artwork, 30s previews) — find the right
 *             thing in milliseconds, hear it before you commit.
 *   RESOLVE = Qobuz via streamrip, only when you click Get — by artist+title
 *             (or artist+album), server-side best-match (pickBestStreamripMatch).
 *   CANCEL  = every queued item can be removed; an in-flight download kills
 *             the rip process (streamrip:cancel-active).
 */

// Name keys (any script, accents folded) live in downloadKeys.ts.
const mmss = (secs: number): string => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

// Relevance scoring, release kinds and display titles moved to
// common/shop-search.ts (Brief 256) so node tests reach them; re-exported here.
export { scoreResult, releaseKind, displayAlbumTitle }

// Jake, 2026-08-09: "it only shows me a very limited number of things if i
// search via artist (i think only 7 albums and 9 songs max)." It was 8 albums
// minus the hero, and 12 songs. An artist search now returns their catalogue,
// so the shelf has something to show.
const MAX_ALBUMS = 30
const MAX_SONGS = 60

interface SongRow {
  kind: 'song'
  artist: string
  title: string
  album?: string
  artworkUrl?: string
  previewUrl?: string
  /** Length of this exact iTunes version — rides along to the Qobuz resolve
   *  so the downloaded file can be verified against it (wrong-version guard). */
  durationSecs?: number
  releaseYear?: number
  explicitness?: string
  owned: boolean
  score: number
}
interface AlbumRow {
  kind: 'album'
  artist: string
  album: string
  artworkUrl?: string
  owned: boolean
  score: number
  songs: number
  collectionId?: number
  /** From iTunes. Jake, 2026-08-09: "albums and EP's need the release year
   *  next to them." trackCount is the COLLECTION's size, not `songs` — songs
   *  is only how many of this album matched the query, so it can't be used to
   *  tell an EP from an LP. */
  releaseYear?: number
  trackCount?: number
  genre?: string
  explicitness?: string
}

/** The catalogue's artists and albums for the search on screen (Brief 256). albumsOk false:
 *  Apple's album search didn't answer, and the albums are built from the songs, as before. */
interface ShopGroups { artists: ShopArtist[]; albums: ShopAlbum[]; albumsOk: boolean }
const NO_GROUPS: ShopGroups = { artists: [], albums: [], albumsOk: false }

/** A page inside the shop, over the search's results (Brief 256). */
type ShopPage = { kind: 'artist'; artist: ShopArtist; artworkUrl?: string } | { kind: 'album'; album: ShopAlbumRef }

// Page memory — the view unmounts on navigate-away; restore search state on return.
interface DownloadCache { query: string; results: ItunesSuggestion[]; groups: ShopGroups; pages: ShopPage[]; pasteUrl: string }
let pageCache: DownloadCache = { query: '', results: [], groups: NO_GROUPS, pages: [], pasteUrl: '' }

// A prefill (Listen List → "Tracks" / Get on an album) is dispatched BEFORE
// the view that listens for it has mounted — the sender fires the event and
// then switches views, so a listener registered in the component's effect
// was never there to hear it (2026-09-05, live: the search box still showed
// the previous query). The event is captured at module scope and handed to
// the view when it mounts; a mounted view takes it directly.
/** `target` once told the shop's search from the legacy Download route; the
 *  route is gone (Brief 253) and every sender says 'browse'. Kept so a
 *  prefill addressed elsewhere is still left alone. */
/** `how` (Brief 254): the toolbar search's Record Shop row sends words Jake
 *  typed, so the usage log counts that search as typed, not sent from a list. */
export interface DownloadPrefill { query?: string; kind?: string; artist?: string; title?: string; origin?: QueueOrigin; target?: 'browse'; how?: ShopSearchHow }
let pendingPrefill: DownloadPrefill | null = null
if (typeof window !== 'undefined') {
  window.addEventListener('jaketunes-download-prefill', (e: Event) => {
    pendingPrefill = (e as CustomEvent<DownloadPrefill>).detail ?? null
    // The shop's box shows the words at once, before the Search tab mounts.
    const q = pendingPrefill?.query?.trim()
    if (q && (!pendingPrefill?.target || pendingPrefill.target === 'browse')) setShopQuery(q, pendingPrefill?.how === 'typed' ? 'typed' : 'list')
  })
}

// Search → save in the usage log (Brief 253, common/shop-funnel.ts): one
// `shop.search` line per search Jake looked at, with what came of it. The
// words never leave; only their length.
const funnel = createShopFunnel(() => Date.now())
const logFunnel = (ev: ShopFunnelEvent | null): void => { if (ev) usage(ev.kind, ev.name, { ms: ev.ms, ok: ev.ok, detail: ev.detail }) }
if (typeof window !== 'undefined') {
  // Before pagehide, where the usage log sends what it holds.
  window.addEventListener('beforeunload', () => logFunnel(funnel.left()))
}

// Queue entries resolve on Qobuz AT DOWNLOAD TIME by artist+title/album.
// durationMs pins the EXACT version the user clicked — main verifies the
// downloaded file against it, so a re-record/live cut can't slip in. A clean
// row pins nothing: main drops its length (exact-recording.ts requestedLength).
const songQ = (r: SongRow): QResult => ({
  kind: 'query', source: 'qobuz', mediaType: 'track',
  id: trackQueryId(r.artist, r.title),
  desc: `${r.title} — ${r.artist}`,
  artist: r.artist, title: r.title, album: r.album ? displayAlbumTitle(r.album) : r.album,
  durationMs: r.durationSecs ? r.durationSecs * 1000 : undefined,
  cleanedSource: r.explicitness === 'cleaned',
  explicitSource: r.explicitness === 'explicit',
  releaseYear: r.releaseYear,
})
const albumQ = (r: AlbumRow): QResult => ({
  kind: 'query', source: 'qobuz', mediaType: 'album',
  id: editionQueryId(r.artist, r.album, r.collectionId),
  desc: `${displayAlbumTitle(r.album)} — ${r.artist} (album)`,
  artist: r.artist,
  // Search Qobuz without Apple's " - Single"/" - EP" stamp. Identity (id)
  // keeps the raw iTunes name so two editions don't collapse.
  album: displayAlbumTitle(r.album) || r.album,
  cleanedSource: r.explicitness === 'cleaned',
  explicitSource: r.explicitness === 'explicit',
  // The EDITION Jake picked, by id and size — main fetches the ordered
  // tracklist and refuses any other edition (album identity contract).
  collectionId: r.collectionId,
  trackCount: r.trackCount,
  releaseYear: r.releaseYear,
})

/** The Record Shop's Search tab (step 5 slice 4; "Browse" until Brief 253):
 *  the catalogue search, its results and the exact-selection Save. The
 *  Downloads panel carries activity, Preferences → Music Sources carries
 *  setup; paste a link stays as "Add by link". The legacy Download page that
 *  rendered this with its own header and queue bar is gone (Brief 253). */
export default function DownloadView() {
  const downloadPageRef = useRef<HTMLDivElement>(null)
  useScrollPersistence('download-page', downloadPageRef)
  // The words are the shop's one box (DiscoveryView), kept in shopQuery.ts.
  const query = useSyncExternalStore(subscribeShopQuery, getShopQuery)
  const [searching, setSearching] = useState(false)
  useEffect(() => { setShopSearching(searching) }, [searching])
  useEffect(() => () => setShopSearching(false), [])
  const [results, setResults] = useState<ItunesSuggestion[]>(pageCache.results)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)
  const [failures, setFailures] = useState<Array<{ filename: string; error: string }>>([])
  const [pasteUrl, setPasteUrl] = useState(pageCache.pasteUrl)
  const [pasteBusy, setPasteBusy] = useState(false)
  const [qobuz, setQobuz] = useState<{ configured: boolean; email?: string } | null>(null)
  // How the search on screen started: typed, or sent from a list (a prefill).
  const searchHowRef = useRef<ShopSearchHow>('typed')
  const searchStartRef = useRef(0)
  /** The answer time of a search whose results haven't been counted yet. */
  const funnelPendingRef = useRef<number | null>(null)

  /** Setup drawer: paste-a-link, the Qobuz account and the streamrip check.
   *  Closed by default — these are things you do once, and they used to sit
   *  permanently under the results on the page you use every day. */
  const [setupOpen, setSetupOpen] = useState(false)
  const [groups, setGroups] = useState<ShopGroups>(pageCache.groups)
  // Artist and album pages over the results (Brief 256): Back pops one.
  const [pages, setPages] = useState<ShopPage[]>(pageCache.pages)
  const page = pages[pages.length - 1] ?? null
  const openPage = (p: ShopPage): void => {
    usage('action', 'shop.page', { detail: { page: p.kind, depth: pages.length + 1 } })
    setPages((prev) => [...prev, p])
    downloadPageRef.current?.scrollTo?.({ top: 0 })
  }
  const back = (): void => setPages((prev) => prev.slice(0, -1))
  const openAlbum = (a: AlbumRow): void => openPage({ kind: 'album', album: { artist: a.artist, name: a.album, collectionId: a.collectionId, artworkUrl: a.artworkUrl, releaseYear: a.releaseYear, trackCount: a.trackCount, genre: a.genre, explicitness: a.explicitness } })
  const marks = useShopMarks()
  useSyncExternalStore(subscribeLossless, losslessVersion)

  const { state: lib, dispatch } = useLibrary()
  const preview = useSyncExternalStore(subscribePreview, getPreviewSnapshot)
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => subscribeQueue(forceRender), [])
  useEffect(() => {
    const id = window.setInterval(() => {
      if (getQueue().some((q) => q.status === 'downloading')) forceRender()
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  // "Already in your library" index.
  const libIndex = useMemo(() => {
    const tracks = new Set<string>()
    const albums = new Set<string>()
    for (const t of lib.tracks) {
      const a = norm(t.artist)
      if (t.title) tracks.add(norm(t.title) + '|' + a)
      if (t.album) albums.add(norm(t.album) + '|' + a)
    }
    return { tracks, albums }
  }, [lib.tracks])

  // Rank songs + derive albums from the SAME instant result set.
  const ranked = useMemo(() => {
    const q = normQ(query)
    const qTokens = q ? q.split(' ') : []
    const songs: SongRow[] = results.map((s) => {
      const owned = libIndex.tracks.has(norm(s.song) + '|' + norm(s.artist))
      const base = q ? scoreResult(q, qTokens, s.song, s.artist) : 0
      const titleHit = q ? scoreField(normQ(s.song), q, qTokens) > 0 : false
      return {
        kind: 'song' as const,
        artist: s.artist, title: s.song, album: s.album,
        artworkUrl: s.artworkUrl, previewUrl: s.previewUrl,
        durationSecs: s.durationSecs, releaseYear: s.releaseYear, explicitness: s.explicitness,
        owned, score: base > 0 && titleHit ? base + 0.5 : base,
      }
    }).filter((s) => !q || s.score > 0)
    // Collapse the censored/uncensored pair Apple returns for the same song,
    // keeping the explicit one. Without this the list either showed the clean
    // edition (whenever Apple ordered it first) or showed both, which reads as
    // a duplicate with nothing to tell them apart.
    const songBest = new Map<string, SongRow>()
    for (const s of songs) {
      const k = norm(s.title) + '|' + norm(s.artist)
      const prev = songBest.get(k)
      if (!prev) { songBest.set(k, s); continue }
      if (explicitWins(prev.explicitness, s.explicitness)) {
        songBest.set(k, { ...s, score: Math.max(prev.score, s.score) })
      } else {
        prev.score = Math.max(prev.score, s.score)
      }
    }
    songs.length = 0
    songs.push(...songBest.values())
    songs.sort((a, b) => b.score - a.score)

    // Albums come from Apple's album search (Brief 256), ranked in main
    // (common/shop-search.ts rankShop). Only when that search didn't answer
    // are they built from the song hits, as before.
    const fromSearch: AlbumRow[] = groups.albumsOk ? groups.albums.map((a, i) => ({
      kind: 'album' as const, artist: a.artist, album: a.name, artworkUrl: a.artworkUrl,
      owned: libIndex.albums.has(norm(a.name) + '|' + norm(a.artist)),
      score: groups.albums.length - i, songs: 0, collectionId: a.collectionId,
      releaseYear: a.releaseYear, trackCount: a.trackCount, genre: a.genre, explicitness: a.explicitness,
    })) : []
    const albumMap = new Map<string, AlbumRow>()
    if (!groups.albumsOk) for (const s of results) {
      if (!s.album) continue
      const key = `${norm(s.artist)}|${norm(s.album)}`
      const albScore = q ? Math.max(
        scoreResult(q, qTokens, s.album, s.artist),
        scoreResult(q, qTokens, s.song, s.artist) * 0.85,
      ) : 0
      const cur = albumMap.get(key)
      if (cur) {
        cur.songs += 1; cur.score = Math.max(cur.score, albScore)
        // ── The explicit edition wins the row ────────────────────────────
        // Jake, 2026-08-10, searching Migos: "why am i only seeing the clean
        // version?????"
        //
        // Apple lists the censored and uncensored editions of a record under
        // the SAME name, so both collapse onto this artist|album key. First
        // one seen used to keep the row — including its collectionId — and
        // when that was the clean edition, expanding the album fetched the
        // CLEAN tracklist and every download off it was censored. The badge
        // was telling the truth; the row was simply bound to the wrong record.
        //
        // So identity follows the explicit edition when one exists. Only
        // 'cleaned' loses: 'notExplicit' means a record with nothing to
        // censor, which must not be overwritten by anything.
        if (explicitWins(cur.explicitness, s.explicitness)) {
          cur.explicitness = s.explicitness
          if (s.collectionId) cur.collectionId = s.collectionId
          if (s.artworkUrl) cur.artworkUrl = s.artworkUrl
          if (s.trackCount) cur.trackCount = s.trackCount
        } else if (!cur.explicitness && s.explicitness) {
          cur.explicitness = s.explicitness
        }
        if (!cur.artworkUrl) cur.artworkUrl = s.artworkUrl
        if (!cur.collectionId && s.collectionId) cur.collectionId = s.collectionId
        if (!cur.trackCount && s.trackCount) cur.trackCount = s.trackCount
        if (!cur.genre && s.genre) cur.genre = s.genre
        // LATEST wins. Tracks on one collection carry their OWN release dates,
        // not the album's — Turnstile's GLOW ON returns 2021-05-26, 2021-07-30
        // and 2021-08-27 for three of its tracks, because the first two were
        // put out as singles ahead of the record. The album's date is the last
        // of them. Taking the earliest would date an album released in January
        // to the previous year, off the singles that trailed it.
        // Only an inference: the search returns whichever tracks matched, so a
        // hit on a pre-release single alone still reads early. Expanding the
        // album replaces this with the collection's own date (see `year`).
        if (s.releaseYear && (!cur.releaseYear || s.releaseYear > cur.releaseYear)) cur.releaseYear = s.releaseYear
      } else albumMap.set(key, {
        kind: 'album', artist: s.artist, album: s.album, artworkUrl: s.artworkUrl,
        owned: libIndex.albums.has(norm(s.album) + '|' + norm(s.artist)),
        score: albScore, songs: 1, collectionId: s.collectionId,
        releaseYear: s.releaseYear, trackCount: s.trackCount, genre: s.genre, explicitness: s.explicitness,
      })
    }
    const albums = groups.albumsOk ? fromSearch : [...albumMap.values()].filter((a) => !q || a.score > 0).sort((a, b) => b.score - a.score).slice(0, MAX_ALBUMS)

    // Three groups, in this order (Brief 256): Artists, Albums, Songs. The
    // "Top match" hero is gone: an artist named exactly is first by itself.
    return {
      artists: groups.artists,
      songs: songs.slice(0, MAX_SONGS),
      albums,
    }
  }, [results, query, libIndex, groups])

  // Jake's own library, above the catalogue when it matches (Brief 256).
  const libSearchIndex = useMemo(() => buildIndex(lib.tracks, []), [lib.tracks])
  const libraryHits = useMemo(() => {
    const q = query.trim()
    if (q.length < 2) return []
    const r = searchLibrary(libSearchIndex, q, { perSectionCap: 3 })
    return pickLibraryHits({
      artists: r.artists.map((x) => ({ row: x.row as LibArtistRow, score: x.score })),
      albums: r.albums.map((x) => ({ row: x.row as LibAlbumRow, score: x.score })),
      tracks: r.tracks.map((x) => ({ row: x.row as LibTrackRow, score: x.score })),
    })
  }, [libSearchIndex, query])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.streamripGetQobuz?.().then((r) => {
      if (!cancelled && r?.ok) setQobuz({ configured: r.configured, email: r.email })
    }).catch(() => { /* leave the form shown */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    return window.electronAPI.onBandcampPerFileFailed((r) => {
      setFailures((prev) => [...prev, r])
    })
  }, [])

  // Prefill search when opened from Listen to the List.
  //
  // 2026-07-31 — Jake: album rows on the list "just take me to the download
  // search bar and doesnt work". They did exactly that: this handler set the
  // query text, cleared the results, and never SEARCHED. You landed on an
  // empty page with words in a box.
  //
  // Now it runs the search, and when the item is an album it opens that
  // album's tracklist on arrival — so you get the whole record with "Get all"
  // or any single song out of it, which is what an album row should have done
  // all along. Everything below reuses the album expander that already exists;
  // nothing about the tracklist UI is new.
  const runSearchRef = useRef<(raw: string) => Promise<void>>()
  const pendingExpandRef = useRef<{ artist: string; album: string } | null>(null)
  // Provenance of a prefill from the Listen List: every Get made from THIS
  // search carries the recommendation id, so the list sees the job land
  // (and the friend gets credit). Cleared the moment the search changes.
  const pendingOriginRef = useRef<{ query: string; origin: QueueOrigin } | null>(null)
  const withOrigin = (q: QResult): QResult => pendingOriginRef.current ? { ...q, origin: pendingOriginRef.current.origin } : q
  // Every Get goes through here: a missing Qobuz account is said out loud with
  // its fix (Preferences → Music Sources); the job still runs so the other
  // providers can answer for a song. Search and previews never ask.
  const startGet = (asked: QResult, opts: { bulk?: boolean } = {}): void => {
    // An album save is timed from here to Qobuz's first answer (Brief 255, usage log).
    // The album page says how its edition was named (card or picked); a card here is 'card'.
    const q: QResult = asked.mediaType === 'album' ? { ...asked, clickedAt: asked.clickedAt ?? Date.now(), surface: asked.surface ?? 'search', editionFrom: asked.editionFrom ?? (asked.collectionId ? 'card' : 'none') } : asked
    const n = qobuzNoticeFor(qobuz, 'get', { kind: q.mediaType === 'album' ? 'album' : 'song', title: (q.mediaType === 'album' ? q.album : q.title) || q.desc })
    if (n) showCredentialNotice(n)
    funnel.saved(q.mediaType === 'album' ? 'album' : 'song')
    // one Save on one result is a manual try; one of several saved at once is answered from memory
    enqueue(withOrigin(q), opts.bulk ? {} : { askAgain: true })
  }
  // Save album on a record that already has a job: never a silent no-op —
  // the Downloads panel opens on that job (Brief 253).
  const saveAlbum = (q: QResult): void => {
    const existing = itemFor(q)
    if (existing) { showDownload(existing.key); return }
    startGet(q)
  }
  useEffect(() => {
    const applyPrefill = (d: DownloadPrefill | null | undefined) => {
      pendingPrefill = null
      const q = d?.query?.trim()
      if (!q) return
      setShopQuery(q, d?.how === 'typed' ? 'typed' : 'list')
      setResults([])
      setGroups(NO_GROUPS)
      setPages([])
      setSearchErr(null)
      setNotice(null)
      pendingOriginRef.current = d?.origin ? { query: q, origin: d.origin } : null
      searchHowRef.current = d?.how === 'typed' ? 'typed' : 'list'
      pendingExpandRef.current = d?.kind === 'album' && d.artist && d.title
        ? { artist: d.artist, album: d.title }
        : null
      // Ref, not the closure: this effect has [] deps, so capturing runSearch
      // directly would pin the first render's copy forever.
      void runSearchRef.current?.(q)
    }
    const onPrefill = (e: Event) => {
      const d = (e as CustomEvent<DownloadPrefill>).detail
      if (d?.target && d.target !== 'browse') return   // meant for something else
      applyPrefill(d)
    }
    window.addEventListener('jaketunes-download-prefill', onPrefill)
    // Arrived from a prefill that fired before this view mounted.
    if (pendingPrefill && (!pendingPrefill.target || pendingPrefill.target === 'browse')) {
      const d = pendingPrefill
      // runSearchRef is assigned by a later effect in this same commit; defer one tick.
      setTimeout(() => applyPrefill(d), 0)
    }
    return () => window.removeEventListener('jaketunes-download-prefill', onPrefill)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Leaving the tab leaves the search on screen.
  useEffect(() => () => logFunnel(funnel.left()), [])

  useEffect(() => {
    pageCache = { query, results, groups, pages, pasteUrl }
  }, [query, results, groups, pages, pasteUrl])

  useEffect(() => { runSearchRef.current = runSearch })

  // Results have landed — if we arrived here from an ALBUM row on the list,
  // open that album's page (its tracklist, editions and saves; Brief 256). `ranked` is derived from `results`, so this
  // fires exactly once per search, and the ref is cleared so a later manual
  // search never re-expands behind the user's back.
  useEffect(() => {
    const want = pendingExpandRef.current
    if (!want) return
    const all = ranked.albums
    if (all.length === 0) return          // still searching / nothing matched yet
    const wa = norm(want.artist), wl = norm(want.album)
    // Only the album that was asked for opens. The old `|| all[0]` fallback
    // opened whatever ranked first — Sting's "Brand New Day" for a Bedouin
    // record (live, 2026-09-05) — one "Get all" away from the wrong album.
    const reads = (a: string, b: string) => norm(a) === norm(b) || (norm(a).length >= 8 && norm(b).length >= 8 && (norm(a).includes(norm(b)) || norm(b).includes(norm(a))))
    const match = all.find((a) => norm(a.artist) === wa && reads(a.album, want.album))
      || all.find((a) => reads(a.album, want.album))
    pendingExpandRef.current = null
    if (match) openAlbum(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked])

  // The search's results are ranked: it is the one on screen now (and the
  // one before it is left). Counted once per answer.
  useEffect(() => {
    const answerMs = funnelPendingRef.current
    if (answerMs === null) return
    funnelPendingRef.current = null
    logFunnel(funnel.searched({
      len: query.trim().length, hits: results.length,
      songs: ranked.songs.length, albums: ranked.albums.length, artists: ranked.artists.length,
      answerMs, how: searchHowRef.current,
    }))
    // The page's lossless dots: one Qobuz search for all of them (Brief 256).
    if (results.length || ranked.albums.length) askLossless(query.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked])

  // INSTANT search: iTunes answers in ~200ms with art + previews. Newest
  // keystroke wins; Qobuz is only touched when a Get button is clicked.
  const searchTokenRef = useRef(0)
  /** The words whose results are on screen (pages opened from them survive a re-search of the same words). */
  const shownQueryRef = useRef(pageCache.query.trim())
  const runSearch = async (raw: string) => {
    const q = raw.trim()
    if (pendingOriginRef.current && pendingOriginRef.current.query !== q) pendingOriginRef.current = null
    const token = ++searchTokenRef.current
    if (!q) { setResults([]); setGroups(NO_GROUPS); setSearchErr(null); setSearching(false); return }
    setSearching(true)
    setSearchErr(null)
    searchStartRef.current = Date.now()
    try {
      // Artists, albums and songs in one answer (Brief 256); the plain song
      // search stands in for an older main.
      const shop = window.electronAPI.shopSearch ? await window.electronAPI.shopSearch(q).catch(() => null) : null
      // The songs' own answer decides the Qobuz fallback: albums and artists
      // answering must not leave the song list empty when Apple and Deezer both failed.
      const r = shop ? { ok: shop.songsOk ?? shop.ok, results: shop.songs } : await window.electronAPI.searchItunes?.(q)
      if (token !== searchTokenRef.current) return
      setGroups(shop ? { artists: shop.artists, albums: shop.albums, albumsOk: shop.albumsOk } : NO_GROUPS)
      let list = r?.ok ? r.results : []
      if (!r?.ok) {
        // iTunes can rate-limit (403). Fall back to the slower Qobuz catalog
        // search so Jake is never staring at nothing — results just lack
        // artwork/previews until Apple lets us back in.
        const fb = await window.electronAPI.streamripSearch?.({ query: q, source: 'qobuz', mediaType: 'track', numResults: 20 }).catch(() => null)
        if (token !== searchTokenRef.current) return
        if (fb?.ok && fb.results) {
          list = fb.results.map((res) => {
            const i = res.desc.lastIndexOf(' by ')
            return {
              song: i > 0 ? res.desc.slice(0, i).trim() : res.desc,
              artist: i > 0 ? res.desc.slice(i + 4).trim() : '',
            } as ItunesSuggestion
          })
        }
      }
      setResults(list)
      // A new search shows its results, not the page an old one opened (the same
      // words searched again on coming back to the tab keep the page).
      if (q !== shownQueryRef.current) setPages([])
      shownQueryRef.current = q
      setSearchErr(list.length === 0 && !shop?.artists.length && !shop?.albums.length ? `No matches for “${q}”.` : null)
      funnelPendingRef.current = Date.now() - searchStartRef.current
    } catch (e) {
      if (token === searchTokenRef.current) setSearchErr(e instanceof Error ? e.message : 'Search failed.')
    } finally {
      if (token === searchTokenRef.current) setSearching(false)
    }
  }

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults([]); setGroups(NO_GROUPS); setPages([]); setSearchErr(null); setSearching(false); logFunnel(funnel.left()); return }
    // Words typed in the box or sent from a list (shopQuery.ts says which).
    searchHowRef.current = shopQueryHow()
    const h = window.setTimeout(() => { void runSearch(q) }, 300)
    return () => window.clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const downloadPaste = async () => {
    const link = pasteUrl.trim()
    if (!link || pasteBusy) return
    setPasteBusy(true)
    setNotice(null)
    setFailures([])
    try {
      const r = await window.electronAPI.streamripDownload?.(link)
      if (r?.ok && (r.imported ?? 0) > 0) {
        const dup = r.dupes ? `, ${r.dupes} already in library` : ''
        setNotice({ ok: true, msg: `Imported ${r.imported} track${r.imported === 1 ? '' : 's'}${dup}.` })
        setPasteUrl('')
      } else if (r?.ok && r.dupes) {
        setNotice({ ok: true, msg: `Already in your library — all ${r.dupes} track${r.dupes === 1 ? '' : 's'} skipped.` })
      } else if (r?.ok) {
        setNotice({ ok: false, msg: 'Downloaded, but no tracks made it into your library — see below.' })
      } else {
        setNotice({ ok: false, msg: r?.error || 'Download failed.' })
      }
    } catch (e) {
      setNotice({ ok: false, msg: e instanceof Error ? e.message : 'Download failed.' })
    } finally {
      setPasteBusy(false)
    }
  }


  // Right-side action = the item's OWN lifecycle, with CANCEL at every stage
  // before "done" (a mis-click is never a commitment).
  const renderAction = (qres: QResult, item: QItem | undefined) => {
    const st = item?.status
    if (st === 'downloading') {
      const secs = item?.startedAt ? Math.floor((Date.now() - item.startedAt) / 1000) : 0
      return (
        <span className="dl-actions">
          <span className="dl-state dl-state--busy"><span className="dl-spinner" aria-hidden="true" />{mmss(secs)}</span>
          <button className="download-cancel" onClick={() => item && void cancel(item.key)} title="Cancel this download">Cancel</button>
        </span>
      )
    }
    if (st === 'queued') {
      return (
        <span className="dl-actions">
          <span className="dl-state dl-state--queued">Queued</span>
          <button className="download-cancel" onClick={() => item && void cancel(item.key)} title="Remove from queue">✕</button>
        </span>
      )
    }
    if (st === 'done') {
      return (
        <span className="dl-state dl-state--done">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
          In your library{item?.imported ? ` · ${item.imported}` : ''}
        </span>
      )
    }
    if (st === 'canceled') {
      return <button className="download-retry" onClick={() => item && retry(item.key)} title="Download after all">Canceled — redo</button>
    }
    if (st === 'failed') {
      // 6.0 Phase 1: the row shows the short primary status; the full
      // explanation lives in the Downloads panel, never only in a hover.
      const label = item?.primary || primaryFor(item?.outcome, item?.error)
      // A REFUSED verdict (exact edition / version not found, unverifiable)
      // never offers Retry — retrying repeats the same search (Jake 9/7:
      // the card said "Exact edition not found · Retry" while the panel
      // said Needs a choice). It offers the panel, where the choice lives:
      // Compare editions when a near edition was judged, else Choose.
      const refused = item?.outcome === 'exact-not-found' || item?.outcome === 'not-found' || item?.outcome === 'unverifiable'
      if (refused) {
        const near = item && item.result.mediaType === 'album' ? nearEditionOf(item.alternatives as import('../../../common/acquisition-identity').Alternative[] | undefined, item.result.trackCount ?? null) : null
        const verb = near ? 'Details' : SHOP_WORDS.chooseAnother
        return <button className="download-retry download-retry--failed" onClick={() => toggleDownloadsPanel('open')} title={`${label} — open Downloads${near ? ' (the matching tracks can be taken from there)' : ' to choose another'}`}>{label} · {verb}</button>
      }
      return <button className="download-retry download-retry--failed" onClick={() => item && retry(item.key)} title={`${label} — Retry`}>{label} · Retry</button>
    }
    // One word per action (Brief 253): Save for a song, Save album for an album.
    return qres.mediaType === 'album'
      ? <button className="download-result-btn" onClick={() => saveAlbum(qres)}>Save album</button>
      : <button className="download-result-btn" onClick={() => startGet(qres)}>Save</button>
  }

  const artOr = (url: string | undefined, cls: string) => url
    ? <img className={cls} src={url} alt="" loading="lazy" />
    : <span className={`${cls} download-result-art--ph`} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" /></svg>
      </span>

  const previewBtn = (pid: string, url: string, title: string, artist: string, cls = 'download-preview') => {
    const on = preview.playingId === pid
    return (
      <button
        type="button"
        className={`${cls}${on ? ' is-on' : ''}`}
        onClick={(e) => { e.stopPropagation(); togglePreview(pid, url, title, artist) }}
        title={on ? 'Stop preview' : '30s preview'}
      >{on ? '❚❚' : '▶'}</button>
    )
  }

  /** The lossless dot for a row (Brief 256): shown only when the page's one Qobuz answer names it. */
  /** Brief 261: the row's job is also resolved to its Qobuz id (in the background), and a sure plan shows the dot where the page's answer didn't. */
  const dotFor = (kind: 'album' | 'song', artist: string, title: string, scope: { words: string; limit: number }, job?: QResult) => {
    const v = losslessOf(losslessFor(scope.words, scope.limit), kind, artist, title)
    const plan = job ? notePlanRow(planRowOfJob(job), scope.words, scope.limit) : null
    if (v) return <span className={`shop-dot shop-dot--${v}`} title={losslessTitle(v)} aria-label={losslessTitle(v)} />
    if (planIsSure(plan)) return <span className={`shop-dot shop-dot--${plan.hires ? 'hires' : 'lossless'}`} title={planTitle(plan)} aria-label={planTitle(plan)} />
    return null
  }
  const searchScope = { words: query.trim(), limit: 50 }

  /** A song, as a dense aligned row. */
  const renderSong = (s: SongRow, i = 0) => {
    const qres = songQ(s)
    const item = itemFor(qres)
    const pid = `dl|${qres.id}`
    const listed = !s.owned && listedSong(marks.list, s.artist, s.title)
    return (
      <li key={qres.id} className={`dl-song${item ? ` is-${item.status}` : ''}`} style={{ '--i': i } as CSSProperties}>
        <span className="dl-song-lead">
          <span className="dl-song-idx">{i + 1}</span>
          {s.previewUrl && previewBtn(pid, s.previewUrl, s.title, s.artist, 'dl-song-play')}
        </span>
        {artOr(s.artworkUrl, 'dl-song-art')}
        <span className="dl-song-title" title={s.title}>{dotFor('song', s.artist, s.title, searchScope, qres)}<span className="dl-song-name">{s.title}</span>{listed ? <span className="shop-mark shop-mark--list shop-mark--inline">{LIST_MARK}</span> : null}</span>
        <span className="dl-song-artist" title={s.artist}>{s.artist}</span>
        <span className="dl-song-album" title={s.album || ''}>{s.album ? displayAlbumTitle(s.album) : ''}</span>
        {/* Year on songs too: iTunes returns original, remaster, live and comp
            as separate rows, and this is the fastest way to see which one
            you're about to pull. */}
        <span className="dl-song-year">{s.releaseYear || ''}</span>
        <span className="dl-song-dur">{s.durationSecs ? mmss(s.durationSecs) : ''}</span>
        <span className="dl-song-act">{s.owned && !item ? <span className="dl-inlib">In library</span> : renderAction(qres, item)}</span>
      </li>
    )
  }

  // "Save album" ("Get all" until Brief 253) grabs the whole album as ONE Qobuz album download (the same
  // reliable album-id path the header Get uses), NOT a per-track loop. Reason
  // (2026-07-24, the Charli XCX "Music, Fashion, Film" failure): Qobuz indexes
  // albums but NOT always their individual tracks — a per-track search for
  // "Card Declined" returns junk ("2 die 4" by Addison Rae), which the matcher
  // correctly rejects, so 8/11 tracks "failed" even though the album is right
  // there on Qobuz. One album download gets every track; the importer dedups
  // the few already owned. A few songs of an album are saved from its page.

  /** An album search hit (or an artist page's record) as a card row. */
  const albumRowOf = (a: ShopAlbum): AlbumRow => ({
    kind: 'album', artist: a.artist, album: a.name, artworkUrl: a.artworkUrl, owned: false, score: 0, songs: 0,
    collectionId: a.collectionId, releaseYear: a.releaseYear, trackCount: a.trackCount, genre: a.genre, explicitness: a.explicitness,
  })

  /** The facts a release stands on: kind, year, size, genre — whichever of
   *  them iTunes actually stated. A CENSORED edition has to announce itself:
   *  iTunes only carries some albums as "[Amended Version]", and downloading
   *  one of those silently is how Jake ended up with a radio edit of Mo Money
   *  Mo Problems. */
  const releaseFacts = (a: AlbumRow) => {
    const count = a.trackCount
    return { year: a.releaseYear, count, genre: a.genre, clean: a.explicitness === 'cleaned', kind: releaseKind(a.album, count) }
  }

  /** A release, as a cover card. Clicking it opens the album's page (Brief 256).
   *  Under it, always (Phase 2, the approved picture): "In your library", or
   *  Save album and the edition it saves (AlbumCardFoot). */
  const renderRelease = (a: AlbumRow, i = 0, scope: { words: string; limit: number } = searchScope) => {
    const qres = albumQ(a)
    const item = itemFor(qres)
    const { year, count, genre, clean, kind } = releaseFacts(a)
    const owned = ownedAlbum(marks.lib, a.artist, a.album, count)
    const ownsAll = owned?.state === 'all'
    const mark = markLine({ owned: ownsAll ? null : owned, listed: listedAlbum(marks.list, a.artist, a.album) })
    const card: CardRecord = { collectionId: a.collectionId, name: a.album, trackCount: a.trackCount, releaseYear: a.releaseYear, explicitness: a.explicitness }
    const askAlbum = (): void => askEditions(a.artist, editionsKeyName(a.album))
    return (
      <div
        key={qres.id}
        className={`dl-rel${item ? ` is-${item.status}` : ''}`}
        style={{ '--i': i } as CSSProperties}
        onClick={() => openAlbum(a)}
        onPointerEnter={askAlbum}
        onFocus={askAlbum}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAlbum(a) } }}
      >
        <span className="dl-rel-frame">
          {artOr(a.artworkUrl, 'dl-rel-art')}
          {clean && <span className="dl-rel-clean" title="Censored edition — iTunes has no explicit version of this release">CLEAN</span>}
          {ownsAll && <span className="dl-rel-owned" title="In your library">✓</span>}
        </span>
        <span className="dl-rel-title" title={a.album}>{dotFor('album', a.artist, a.album, scope, qres)}{displayAlbumTitle(a.album)}</span>
        <span className="dl-rel-facts">
          <span className={`download-result-badge download-result-badge--${kind.toLowerCase()}`}>{kind}</span>
          {year ? <span className="download-result-year">{year}</span> : null}
          {clean && <span className="dl-clean" title="Censored edition — iTunes has no explicit version of this release">CLEAN</span>}
          {count ? <span className="dl-rel-count">{count} track{count === 1 ? '' : 's'}</span> : null}
        </span>
        <span className="dl-rel-sub" title={a.artist}>{a.artist}{genre ? ` · ${genre}` : ''}</span>
        {mark ? <span className={`shop-mark${mark === LIST_MARK ? ' shop-mark--list' : ''}`}>{mark}</span> : null}
        {ownsAll && !item
          ? <span className="dl-rel-foot"><span className="shop-own">In your library</span></span>
          : <AlbumCardFoot artist={a.artist} card={card} cardJob={qres} action={(job) => renderAction(job, itemFor(job))} />}
      </div>
    )
  }

  /** An artist hit: their picture (an album cover; Apple gives none), name and marks. Opens their page. */
  const renderArtist = (a: ShopArtist, i: number) => {
    const art = artistArtwork(a, groups.albums)
    const mark = markLine({ owned: ownsArtist(marks.lib, a.name), listed: listedArtist(marks.list, a.name) })
    const named = isArtistQuery(query, a.name)
    return (
      <button key={a.artistId} type="button" className={`shop-artist${named ? ' is-named' : ''}`} style={{ '--i': i } as CSSProperties} onClick={() => openPage({ kind: 'artist', artist: a, artworkUrl: art })}>
        {art ? <img className="shop-artist-art" src={art} alt="" loading="lazy" /> : <span className="shop-artist-art shop-artist-art--ph" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span>}
        <span className="shop-artist-name" title={a.name}>{a.name}</span>
        <span className="shop-artist-sub">{a.genre ?? 'Artist'}</span>
        {mark ? <span className={`shop-mark${mark === LIST_MARK ? ' shop-mark--list' : ''}`}>{mark}</span> : null}
      </button>
    )
  }

  /** One of Jake's own matches: opens it in the library (an artist, an album, a song's album). */
  const openLibraryHit = (h: (typeof libraryHits)[number]): void => {
    if (h.kind === 'artist') dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: h.row.name })
    else if (h.kind === 'album') dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: h.row.key })
    else {
      const t = lib.tracks.find((x) => x.id === h.row.id)
      if (t) dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyOf(t) })
    }
  }

  /** Saves from the artist and album pages go the Search tab's way. */
  const savePageJob = (q: QResult, opts: { bulk?: boolean } = {}): void => { if (q.mediaType === 'album') saveAlbum(q); else startGet(q, opts) }

  const hasResults = !!(ranked.artists.length || ranked.songs.length || ranked.albums.length || libraryHits.length)

  return (
    <div className="download-view download-view--browse" ref={downloadPageRef}>
      {/* The search box is the shop's own, above the tabs (DiscoveryView).
          What stays here is the one thing done once in a while: a link. */}
      <div className="dl-bar dl-bar--tools">
        <button
          type="button"
          className={`dl-setup-btn${setupOpen ? ' is-open' : ''}`}
          onClick={() => setSetupOpen((o) => !o)}
          aria-expanded={setupOpen}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></svg>
          Add by link
        </button>
      </div>
      <CredentialNotice />

      {setupOpen && (
        <div className="dl-setup-panel">
          <div className="dl-setup-grid">
            {/* ── Direct link ── */}
            <section className="dl-setup-card">
              <div className="dl-setup-card-head">Add by link</div>
              <div className="download-row">
                <input
                  className="download-input"
                  value={pasteUrl}
                  onChange={(e) => setPasteUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void downloadPaste() }}
                  placeholder="https://…"
                  disabled={pasteBusy}
                  spellCheck={false}
                />
                <button className="download-btn" onClick={() => void downloadPaste()} disabled={pasteBusy || !pasteUrl.trim()}>
                  {pasteBusy ? 'Downloading…' : 'Download'}
                </button>
              </div>
              <div className="download-hint">YouTube needs no login. For lossless Qobuz, connect your account in Preferences → Music Sources.</div>
              {notice && (
                <div className={`download-result ${notice.ok ? 'download-result--ok' : 'download-result--err'}`}>{notice.msg}</div>
              )}
            </section>

          </div>

          {failures.length > 0 && (
            <div className="download-failures">
              <div className="download-failures-head">
                {failures.length} track{failures.length === 1 ? '' : 's'} couldn’t be imported:
              </div>
              <ul className="download-failures-list">
                {failures.map((f, i) => (
                  <li key={`${f.filename}-${i}`}>
                    <span className="download-failures-name">{f.filename}</span>
                    <span className="download-failures-reason">{f.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {searchErr && !searching && <div className="download-result download-result--err dl-inline-err">{searchErr}</div>}

      <div className="dl-body">
        {page?.kind === 'artist' && (
          <ShopArtistPage
            artist={page.artist}
            artworkUrl={page.artworkUrl}
            marks={marks}
            renderAlbum={(a, i, scope) => renderRelease(albumRowOf(a), i, scope)}
            onBack={back}
            backLabel={pages.length > 1 ? 'Back' : 'Results'}
          />
        )}
        {page?.kind === 'album' && (
          <ShopAlbumPage
            album={page.album}
            marks={marks}
            onSave={savePageJob}
            renderAction={renderAction}
            onBack={back}
            backLabel={pages.length > 1 ? (pages[pages.length - 2].kind === 'artist' ? (pages[pages.length - 2] as { artist: ShopArtist }).artist.name : 'Back') : 'Results'}
          />
        )}

        {!page && libraryHits.length > 0 && (
          <section className="dl-sec">
            <div className="dl-sec-head"><span className="dl-sec-title">In your library</span><span className="dl-rule" /></div>
            <div className="shop-lib">
              {libraryHits.map((h, i) => (
                <button key={`${h.kind}-${i}`} type="button" className="shop-lib-hit" onClick={() => openLibraryHit(h)} title="Open in your library">
                  <span className="shop-lib-kind">{h.kind === 'artist' ? 'Artist' : h.kind === 'album' ? 'Album' : 'Song'}</span>
                  <span className="shop-lib-name">{h.kind === 'artist' ? h.row.name : h.kind === 'album' ? h.row.album : h.row.title}</span>
                  {h.kind !== 'artist' ? <span className="shop-lib-sub">{h.row.artist}</span> : null}
                </button>
              ))}
            </div>
          </section>
        )}

        {!page && ranked.artists.length > 0 && (
          <section className="dl-sec">
            <div className="dl-sec-head">
              <span className="dl-sec-title">Artists</span>
              <span className="dl-sec-count">{ranked.artists.length}</span>
              <span className="dl-rule" />
            </div>
            <div className="shop-artists">{ranked.artists.map((a, i) => renderArtist(a, i))}</div>
          </section>
        )}

        {!page && ranked.albums.length > 0 && (
          <section className="dl-sec">
            <div className="dl-sec-head">
              <span className="dl-sec-title">Albums</span>
              <span className="dl-sec-count">{ranked.albums.length}</span>
              <span className="dl-rule" />
            </div>
            <div className="dl-shelf">{ranked.albums.map((a, i) => renderRelease(a, i))}</div>
          </section>
        )}

        {!page && ranked.songs.length > 0 && (
          <section className="dl-sec">
            <div className="dl-sec-head">
              <span className="dl-sec-title">Songs</span>
              <span className="dl-sec-count">{ranked.songs.length}</span>
              <span className="dl-rule" />
            </div>
            <ul className="dl-song-list" role="list">{ranked.songs.map((s, i) => renderSong(s, i))}</ul>
          </section>
        )}

        {!page && !hasResults && !searching && (
          <div className="dl-empty">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" /></svg>
            <span className="dl-empty-title">{query ? 'Nothing matched that.' : 'Search for songs, albums or artists.'}</span>
            <span className="dl-empty-sub">
              {query
                ? 'Try the artist and the song together — "when you die mgmt".'
                : 'Preview where available, then choose what to save.'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
