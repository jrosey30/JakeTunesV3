import { Fragment, useEffect, useState, useMemo, useReducer, useRef, useSyncExternalStore, type CSSProperties } from 'react'
import { useScrollPersistence } from '../../hooks/useScrollPersistence'
import './download-store.css'
import CredentialNotice from './CredentialNotice'
import { showCredentialNotice } from './credential-notice-store'
import { qobuzNoticeFor } from '../../../common/qobuz-notice'
import { nearEditionOf } from '../../../common/near-edition-detect'
import { toggleDownloadsPanel, showDownload } from '../../components/DownloadsPanel'
import { useLibrary } from '../../context/LibraryContext'
import { saveSongsLabel } from './albumEditions'
import { enqueue, itemFor, subscribeQueue, getQueue, retry, cancel, primaryFor, trackQueryId, albumQueryId, type QItem, type QResult, type QueueOrigin } from './downloadQueue'
import { getPreviewSnapshot, subscribePreview, togglePreview } from '../../previewPlayer'
import type { ItunesSuggestion } from '../../types'
import { explicitWins } from '../../../common/explicit'
import { withinEditDistance, typoBudget } from '../../../common/fold-text'
import { norm, normQ } from './downloadKeys'
import { createShopFunnel, type ShopFunnelEvent, type ShopSearchHow } from '../../../common/shop-funnel'
import { usage } from '../../usageLog'

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

// Relevance scorer — a TWIN of the universal-search ranker in
// utils/searchIndex.ts (exact > prefix > token-start > substring > all-tokens).
// normQ (downloadKeys.ts) is the twin of searchIndex's normalize.
function scoreField(field: string, query: string, qTokens: string[]): number {
  if (!field || !query) return 0
  if (field === query) return 100 + Math.min(20, query.length)
  if (field.startsWith(query)) return 70 + Math.min(20, query.length)
  if ((' ' + field).includes(' ' + query)) return 50
  if (field.includes(query)) return 30
  if (qTokens.length > 1 && qTokens.every((qt) => field.includes(qt))) return 20
  // TYPO TIER — last, so it never outranks a real match. iTunes already
  // corrects the spelling ("radiohed" -> Radiohead); this stops us discarding
  // the correction because it isn't a substring of what was typed.
  const fTokens = field.split(' ').filter(Boolean)
  if (qTokens.length && fTokens.length) {
    const near = qTokens.every((qt) =>
      fTokens.some((ft) => withinEditDistance(qt, ft, typoBudget(qt.length))))
    if (near) return 14
  }
  return 0
}
const stripThe = (s: string): string => s.replace(/^the /, '')
export function scoreResult(q: string, qTokens: string[], title: string, artist: string): number {
  const t = scoreField(normQ(title), q, qTokens)
  const aRaw = normQ(artist)
  const a = Math.max(scoreField(aRaw, q, qTokens), scoreField(stripThe(aRaw), q, qTokens))
  // COMBINED match — the most natural query is "song artist" ("when you die
  // mgmt"), which no SINGLE field contains, so per-field scoring returned 0
  // and the view filtered every correct result to a blank page (Jake,
  // 2026-07-16). Score the joined field both ways too.
  const combo = Math.max(
    scoreField(`${normQ(title)} ${aRaw}`, q, qTokens),
    scoreField(`${aRaw} ${normQ(title)}`, q, qTokens),
  )
  return Math.max(t * 1.0 + a * 1.15, combo * 1.2)
}

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
const albumKey = (a: AlbumRow): string => `${norm(a.artist)}|${norm(a.album)}`

/**
 * What kind of release this is, and the title with Apple's suffix removed.
 *
 * Every row used to render a hardcoded "ALBUM" badge, so a 3-track EP and a
 * 14-track LP were indistinguishable. Apple states the kind two ways and they
 * disagree often enough to need an order of precedence:
 *
 *   1. the NAME suffix ("Sundowning - EP", "Bags - Single"). Apple's own
 *      labelling, so it wins — a 7-track "EP" is still an EP if that is what
 *      the artist released it as.
 *   2. trackCount, only when the name says nothing. Deliberately conservative:
 *      1 track is a single, 2-6 is an EP, and anything else stays ALBUM rather
 *      than guessing at the boundary.
 *
 * The suffix is also stripped from the DISPLAY title, so the row reads
 * "Sundowning · EP · 2019" instead of "Sundowning - EP · ALBUM". Display only —
 * albumKey and the Qobuz query keep the raw name, because that is what the
 * matcher and the download path have always resolved against.
 */
type ReleaseKind = 'ALBUM' | 'EP' | 'SINGLE'
export function releaseKind(name: string, trackCount?: number): ReleaseKind {
  if (/\s[-–—]\s*EP$/i.test(name)) return 'EP'
  if (/\s[-–—]\s*Single$/i.test(name)) return 'SINGLE'
  if (typeof trackCount === 'number' && trackCount > 0) {
    if (trackCount === 1) return 'SINGLE'
    if (trackCount <= 6) return 'EP'
  }
  return 'ALBUM'
}
export function displayAlbumTitle(name: string): string {
  // ⚠️ TWIN: src/main/streamrip-match.ts searchTitle — same Apple
  // " - Single" / " - EP" suffix. Display strips it so the shelf doesn't
  // read "It's Nearly Over - Single · ALBUM"; search strips it so Qobuz
  // is asked for the name it actually uses.
  return name.replace(/\s[-–—]\s*(EP|Single)$/i, '').trim() || name
}

// Page memory — the view unmounts on navigate-away; restore search state on return.
interface DownloadCache { query: string; results: ItunesSuggestion[]; pasteUrl: string }
let pageCache: DownloadCache = { query: '', results: [], pasteUrl: '' }

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
  window.addEventListener('jaketunes-download-prefill', (e: Event) => { pendingPrefill = (e as CustomEvent<DownloadPrefill>).detail ?? null })
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
  id: albumQueryId(r.artist, r.album),
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
  const [query, setQuery] = useState(pageCache.query)
  const [searching, setSearching] = useState(false)
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

  // Album expansion — the search only surfaces a few of an album's songs, so
  // opening a card fetches its FULL tracklist from iTunes (2026-07-23, Jake:
  // "there has to be an easier way to see all tracks on this album"). Raw
  // tracks are cached per album key; owned/preview are computed at render.
  const [expandedAlbums, setExpandedAlbums] = useState<Set<string>>(() => new Set())
  /** Songs ticked in an open tracklist, per album, for "Save N songs" (Brief 255). */
  const [tickedTracks, setTickedTracks] = useState<Record<string, number[]>>({})
  const toggleTick = (key: string, i: number) => setTickedTracks((m) => {
    const cur = m[key] ?? []
    return { ...m, [key]: cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i] }
  })
  /** Setup drawer: paste-a-link, the Qobuz account and the streamrip check.
   *  Closed by default — these are things you do once, and they used to sit
   *  permanently under the results on the page you use every day. */
  const [setupOpen, setSetupOpen] = useState(false)
  const [albumTracks, setAlbumTracks] = useState<Record<string, { loading: boolean; tracks?: ItunesSuggestion[]; error?: string; releaseYear?: number; trackCount?: number; genre?: string; explicitness?: string; collectionId?: number }>>({})

  const toggleAlbum = (a: AlbumRow) => {
    const key = albumKey(a)
    setExpandedAlbums((prev) => {
      const next = new Set(prev)
      if (next.has(key)) { next.delete(key); return next }
      next.add(key)
      // Lazy-fetch the tracklist the first time it's opened — and again
      // after a failure, so a transient iTunes miss isn't pinned to the
      // card until restart (2026-09-03).
      // A row without a collection id (the Deezer failover, when Apple
      // throttles the search) asks main by NAME; main resolves it only to
      // one unambiguous edition and the tracklist comes back with that id,
      // so the Get carries the edition — never a guess (2026-09-05).
      if (!albumTracks[key] || albumTracks[key].error) {
        setAlbumTracks((m) => ({ ...m, [key]: { loading: true } }))
        window.electronAPI.itunesAlbumTracks?.(a.collectionId ?? { artist: a.artist, album: a.album })
          .then((r) => setAlbumTracks((m) => ({
            ...m,
            [key]: r?.ok && r.tracks?.length
              ? { loading: false, tracks: r.tracks, releaseYear: r.releaseYear, trackCount: r.trackCount, genre: r.genre, explicitness: r.explicitness, collectionId: r.collectionId }
              : { loading: false, error: a.collectionId ? 'Couldn’t load the tracklist.' : 'Couldn’t pin this edition in the catalogue — search it by name to pick one.' },
          })))
          .catch(() => setAlbumTracks((m) => ({ ...m, [key]: { loading: false, error: 'Couldn’t load the tracklist.' } })))
      }
      return next
    })
  }

  const { state: lib } = useLibrary()
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

    const albumMap = new Map<string, AlbumRow>()
    for (const s of results) {
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
    const albums = [...albumMap.values()].filter((a) => !q || a.score > 0).sort((a, b) => b.score - a.score).slice(0, MAX_ALBUMS)

    const topSong = songs[0] ?? null
    const topAlbum = albums[0] ?? null
    // The hero is whichever type matched harder.
    const hero: SongRow | AlbumRow | null =
      topSong && topAlbum ? (topAlbum.score > topSong.score ? topAlbum : topSong) : (topSong || topAlbum)
    return {
      hero,
      songs: songs.filter((s) => s !== hero).slice(0, MAX_SONGS),
      albums: albums.filter((a) => a !== hero),
    }
  }, [results, query, libIndex])

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
  const startGet = (asked: QResult): void => {
    // An album save is timed from here to Qobuz's first answer (Brief 255, usage log).
    const q: QResult = asked.mediaType === 'album' ? { ...asked, clickedAt: Date.now(), surface: 'search', editionFrom: asked.collectionId ? 'card' : 'none' } : asked
    const n = qobuzNoticeFor(qobuz, 'get', { kind: q.mediaType === 'album' ? 'album' : 'song', title: (q.mediaType === 'album' ? q.album : q.title) || q.desc })
    if (n) showCredentialNotice(n)
    funnel.saved(q.mediaType === 'album' ? 'album' : 'song')
    enqueue(withOrigin(q))
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
      setQuery(q)
      setResults([])
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
    pageCache = { query, results, pasteUrl }
  }, [query, results, pasteUrl])

  useEffect(() => { runSearchRef.current = runSearch })

  // Results have landed — if we arrived here from an ALBUM row on the list,
  // open that album's tracklist. `ranked` is derived from `results`, so this
  // fires exactly once per search, and the ref is cleared so a later manual
  // search never re-expands behind the user's back.
  useEffect(() => {
    const want = pendingExpandRef.current
    if (!want) return
    const all = [ranked.hero, ...ranked.albums].filter(
      (r): r is AlbumRow => !!r && (r as AlbumRow).kind === 'album',
    )
    if (all.length === 0) return          // still searching / nothing matched yet
    const wa = norm(want.artist), wl = norm(want.album)
    // Only the album that was asked for opens. The old `|| all[0]` fallback
    // opened whatever ranked first — Sting's "Brand New Day" for a Bedouin
    // record (live, 2026-09-05) — one "Get all" away from the wrong album.
    const reads = (a: string, b: string) => norm(a) === norm(b) || (norm(a).length >= 8 && norm(b).length >= 8 && (norm(a).includes(norm(b)) || norm(b).includes(norm(a))))
    const match = all.find((a) => norm(a.artist) === wa && reads(a.album, want.album))
      || all.find((a) => reads(a.album, want.album))
    pendingExpandRef.current = null
    if (match && !expandedAlbums.has(albumKey(match))) toggleAlbum(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked])

  // The search's results are ranked: it is the one on screen now (and the
  // one before it is left). Counted once per answer.
  useEffect(() => {
    const answerMs = funnelPendingRef.current
    if (answerMs === null) return
    funnelPendingRef.current = null
    const heroSong = ranked.hero?.kind === 'song' ? 1 : 0
    const heroAlbum = ranked.hero?.kind === 'album' ? 1 : 0
    logFunnel(funnel.searched({
      len: query.trim().length, hits: results.length,
      songs: ranked.songs.length + heroSong, albums: ranked.albums.length + heroAlbum,
      answerMs, how: searchHowRef.current,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked])

  // INSTANT search: iTunes answers in ~200ms with art + previews. Newest
  // keystroke wins; Qobuz is only touched when a Get button is clicked.
  const searchTokenRef = useRef(0)
  const runSearch = async (raw: string) => {
    const q = raw.trim()
    if (pendingOriginRef.current && pendingOriginRef.current.query !== q) pendingOriginRef.current = null
    const token = ++searchTokenRef.current
    if (!q) { setResults([]); setSearchErr(null); setSearching(false); return }
    setSearching(true)
    setSearchErr(null)
    searchStartRef.current = Date.now()
    try {
      const r = await window.electronAPI.searchItunes?.(q)
      if (token !== searchTokenRef.current) return
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
      setSearchErr(list.length === 0 ? `No matches for “${q}”.` : null)
      funnelPendingRef.current = Date.now() - searchStartRef.current
    } catch (e) {
      if (token === searchTokenRef.current) setSearchErr(e instanceof Error ? e.message : 'Search failed.')
    } finally {
      if (token === searchTokenRef.current) setSearching(false)
    }
  }

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults([]); setSearchErr(null); setSearching(false); logFunnel(funnel.left()); return }
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
        const verb = near ? 'Details' : item?.result.mediaType === 'album' ? 'Choose edition…' : 'Choose version…'
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

  /** A song, as a dense aligned row. */
  const renderSong = (s: SongRow, i = 0) => {
    const qres = songQ(s)
    const item = itemFor(qres)
    const pid = `dl|${qres.id}`
    return (
      <li key={qres.id} className={`dl-song${item ? ` is-${item.status}` : ''}`} style={{ '--i': i } as CSSProperties}>
        <span className="dl-song-lead">
          <span className="dl-song-idx">{i + 1}</span>
          {s.previewUrl && previewBtn(pid, s.previewUrl, s.title, s.artist, 'dl-song-play')}
        </span>
        {artOr(s.artworkUrl, 'dl-song-art')}
        <span className="dl-song-title" title={s.title}>{s.title}</span>
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

  const asSongRow = (t: ItunesSuggestion): SongRow => ({
    kind: 'song', artist: t.artist, title: t.song, album: t.album,
    artworkUrl: t.artworkUrl, previewUrl: t.previewUrl,
    durationSecs: t.durationSecs, releaseYear: t.releaseYear, explicitness: t.explicitness,
    owned: libIndex.tracks.has(norm(t.song) + '|' + norm(t.artist)), score: 0,
  })

  // "Save album" ("Get all" until Brief 253) grabs the whole album as ONE Qobuz album download (the same
  // reliable album-id path the header Get uses), NOT a per-track loop. Reason
  // (2026-07-24, the Charli XCX "Music, Fashion, Film" failure): Qobuz indexes
  // albums but NOT always their individual tracks — a per-track search for
  // "Card Declined" returns junk ("2 die 4" by Addison Rae), which the matcher
  // correctly rejects, so 8/11 tracks "failed" even though the album is right
  // there on Qobuz. One album download gets every track; the importer dedups
  // the few already owned. asSongRow stays — individual track rows still use it.

  const renderAlbumTrack = (t: ItunesSuggestion, i: number, key: string) => {
    const s = asSongRow(t)
    const qres = songQ(s)
    const item = itemFor(qres)
    const pid = `dl|${qres.id}`
    // A song in the library, or one already on its way, can't be ticked.
    const tickable = !s.owned && (!item || item.status === 'failed' || item.status === 'canceled')
    return (
      <li key={qres.id} className={`dl-track${item ? ` is-${item.status}` : ''}`}>
        <input type="checkbox" className="dl-track-tick" aria-label={`Pick ${t.song}`} disabled={!tickable} checked={tickable && (tickedTracks[key] ?? []).includes(i)} onChange={() => toggleTick(key, i)} />
        <span className="dl-track-lead">
          <span className="dl-track-num">{t.trackNumber ?? i + 1}</span>
          {t.previewUrl && previewBtn(pid, t.previewUrl, t.song, t.artist, 'dl-track-play')}
        </span>
        <span className="dl-track-title" title={t.song}>{t.song}</span>
        <span className="dl-track-dur">{t.durationSecs ? mmss(t.durationSecs) : ''}</span>
        <span className="dl-track-act">{s.owned && !item ? <span className="dl-inlib">In library</span> : renderAction(qres, item)}</span>
      </li>
    )
  }

  /** The facts a release stands on: kind, year, size, genre — whichever of
   *  them iTunes actually stated. */
  const releaseFacts = (a: AlbumRow) => {
    const cache = albumTracks[albumKey(a)]
    const year = cache?.releaseYear ?? a.releaseYear
    const count = cache?.trackCount ?? a.trackCount
    const genre = cache?.genre ?? a.genre
    // A CENSORED edition has to announce itself. iTunes only carries some
    // albums as "[Amended Version]", and downloading one of those silently is
    // how Jake ended up with a radio edit of Mo Money Mo Problems.
    const clean = (cache?.explicitness ?? a.explicitness) === 'cleaned'
    return { year, count, genre, clean, kind: releaseKind(a.album, count) }
  }

  /** A release, as a cover card. Art-forward because this is where the year
   *  and the ALBUM/EP distinction live. */
  const renderRelease = (a: AlbumRow, i = 0) => {
    const pinned = albumTracks[albumKey(a)]
    const qres = albumQ({ ...a, collectionId: a.collectionId ?? pinned?.collectionId, trackCount: a.trackCount ?? pinned?.trackCount, releaseYear: a.releaseYear ?? pinned?.releaseYear })
    const item = itemFor(qres)
    const key = albumKey(a)
    const isOpen = expandedAlbums.has(key)
    const cache = albumTracks[key]
    const { year, count, genre, clean, kind } = releaseFacts(a)
    // 'done' is already said by the green check; everything else needs a
    // control (cancel / retry) that must stay reachable without hovering.
    const busy = !!item && item.status !== 'done'
    return (
      <Fragment key={qres.id}>
        <div
          className={`dl-rel${item ? ` is-${item.status}` : ''}${isOpen ? ' is-open' : ''}`}
          style={{ '--i': i } as CSSProperties}
          onClick={() => toggleAlbum(a)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAlbum(a) } }}
        >
          <span className="dl-rel-frame">
            {artOr(a.artworkUrl, 'dl-rel-art')}
            {/* A release that is DOING something says so on a strip along the
                bottom, always visible. It used to reuse the hover stack, which
                put a full-size timer and Cancel pill in the middle of the
                artwork with "HIDE TRACKS" underneath — unreadable over a photo
                and, on a busy card, three competing things at once. */}
            {busy ? (
              <span className="dl-rel-busy" onClick={(e) => e.stopPropagation()}>{renderAction(qres, item)}</span>
            ) : (
              <span className="dl-rel-hover">
                <span className="dl-rel-get" onClick={(e) => e.stopPropagation()}>{renderAction(qres, item)}</span>
                <span className="dl-rel-open">{isOpen ? 'Hide tracks' : 'See tracks'}</span>
              </span>
            )}
            {clean && <span className="dl-rel-clean" title="Censored edition — iTunes has no explicit version of this release">CLEAN</span>}
            {a.owned && <span className="dl-rel-owned" title="In your library">✓</span>}
          </span>
          <span className="dl-rel-title" title={a.album}>{displayAlbumTitle(a.album)}</span>
          <span className="dl-rel-facts">
            <span className={`download-result-badge download-result-badge--${kind.toLowerCase()}`}>{kind}</span>
            {year ? <span className="download-result-year">{year}</span> : null}
            {clean && <span className="dl-clean" title="Censored edition — iTunes has no explicit version of this release">CLEAN</span>}
            {count ? <span className="dl-rel-count">{count} track{count === 1 ? '' : 's'}</span> : null}
          </span>
          <span className="dl-rel-sub" title={a.artist}>{a.artist}{genre ? ` · ${genre}` : ''}</span>
        </div>

        {isOpen && (
          <div className="dl-rel-panel">
            <div className="dl-rel-panel-head">
              <span className="dl-rel-panel-title">{displayAlbumTitle(a.album)}</span>
              <span className="dl-rel-panel-meta">
                {kind}{year ? ` · ${year}` : ''}{genre ? ` · ${genre}` : ''}
                {cache?.tracks ? ` · ${cache.tracks.length} tracks` : ''}
              </span>
              <span className="dl-rel-panel-spacer" />
              {cache?.tracks && (() => {
                // A few songs of this edition, each an ordinary song save (Brief 255).
                const picked = (tickedTracks[key] ?? []).map((ti) => cache.tracks![ti]).filter((t): t is ItunesSuggestion => Boolean(t)).map(asSongRow).filter((sr) => !sr.owned)
                if (!picked.length) return null
                return <button type="button" className="download-result-btn download-result-btn--sm" onClick={() => { for (const sr of picked) startGet(songQ(sr)); setTickedTracks((m) => ({ ...m, [key]: [] })) }}>{saveSongsLabel(picked.length)}</button>
              })()}
              {cache?.tracks && cache.tracks.length > 0 && (
                <button type="button" className="download-result-btn download-result-btn--sm" onClick={() => { if (item) showDownload(item.key); else startGet(albumQ({ ...a, collectionId: a.collectionId ?? cache?.collectionId, trackCount: a.trackCount ?? cache?.trackCount, releaseYear: a.releaseYear ?? cache?.releaseYear })) }} title={item ? 'Show it in Downloads' : undefined}>Save album</button>
              )}
              <button type="button" className="dl-rel-panel-close" onClick={() => toggleAlbum(a)} title="Close">✕</button>
            </div>
            {cache?.loading && <div className="dl-rel-panel-note"><span className="dl-spinner" aria-hidden="true" /> Loading tracklist…</div>}
            {cache?.error && <div className="dl-rel-panel-note dl-rel-panel-note--err">{cache.error}</div>}
            {/* Explicit rows + column flow keeps 1-5 / 6-10 reading DOWN each
                column (what CSS `columns` gave) without CSS columns' fatal
                flaw here: an overflowing cell bleeds across the gap. "✓ In
                your library" is far wider than the action cell, so it was
                landing on top of the next column's track titles. */}
            {cache?.tracks && cache.tracks.length > 0 && (
              <ul
                className="dl-track-list"
                role="list"
                style={{ gridTemplateRows: `repeat(${Math.ceil(cache.tracks.length / 2)}, auto)` }}
              >{cache.tracks.map((t, ti) => renderAlbumTrack(t, ti, key))}</ul>
            )}
          </div>
        )}
      </Fragment>
    )
  }

  /** Top match — the one result that matched hardest, given room to say so. */
  const renderHero = (h: SongRow | AlbumRow) => {
    if (h.kind === 'album') {
      const { year, count, genre, clean, kind } = releaseFacts(h)
      const qres = albumQ(h)
      const item = itemFor(qres)
      return (
        <div className="dl-hero" onClick={() => toggleAlbum(h)} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAlbum(h) } }}>
          {artOr(h.artworkUrl, 'dl-hero-art')}
          <div className="dl-hero-body">
            <span className="dl-hero-title" title={h.album}>{displayAlbumTitle(h.album)}</span>
            <span className="dl-hero-artist">{h.artist}</span>
            <span className="dl-hero-facts">
              <span className={`download-result-badge download-result-badge--${kind.toLowerCase()}`}>{kind}</span>
              {year ? <span className="download-result-year">{year}</span> : null}
              {clean && <span className="dl-clean">CLEAN</span>}
              {count ? <span className="dl-rel-count">{count} tracks</span> : null}
              {genre ? <span className="dl-rel-count">{genre}</span> : null}
              {h.owned && <span className="download-owned">In your library</span>}
            </span>
          </div>
          <span className="dl-hero-act" onClick={(e) => e.stopPropagation()}>{renderAction(qres, item)}</span>
        </div>
      )
    }
    const qres = songQ(h)
    const item = itemFor(qres)
    const pid = `dl|${qres.id}`
    return (
      <div className="dl-hero">
        <span className="dl-hero-artwrap">
          {artOr(h.artworkUrl, 'dl-hero-art')}
          {h.previewUrl && previewBtn(pid, h.previewUrl, h.title, h.artist, 'dl-hero-play')}
        </span>
        <div className="dl-hero-body">
          <span className="dl-hero-title" title={h.title}>{h.title}</span>
          <span className="dl-hero-artist">{h.artist}</span>
          <span className="dl-hero-facts">
            {h.album && <span className="dl-rel-count">{displayAlbumTitle(h.album)}</span>}
            {h.releaseYear ? <span className="download-result-year">{h.releaseYear}</span> : null}
            {h.durationSecs ? <span className="dl-rel-count">{mmss(h.durationSecs)}</span> : null}
            {h.owned && <span className="download-owned">In your library</span>}
          </span>
        </div>
        <span className="dl-hero-act">{renderAction(qres, item)}</span>
      </div>
    )
  }

  const hasResults = !!(ranked.hero || ranked.songs.length || ranked.albums.length)

  return (
    <div className="download-view download-view--browse" ref={downloadPageRef}>
      {/* ── command bar. Pinned, because the search field IS the page and it
             used to scroll away the moment results arrived. ── */}
      <div className="dl-bar">
        <div className="dl-field-row">
        <div className="dl-field">
          <svg className="dl-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input
            className="dl-input"
            value={query}
            onChange={(e) => { searchHowRef.current = 'typed'; setQuery(e.target.value) }}
            placeholder="Search a song, album, or artist…"
            spellCheck={false}
            autoFocus
          />
          {searching && <span className="dl-spinner dl-field-spin" aria-hidden="true" />}
          {!searching && query && <button type="button" className="dl-field-clear" onClick={() => setQuery('')} title="Clear">✕</button>}
        </div>
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
        {ranked.hero && (
          <section className="dl-sec dl-sec--hero">
            <div className="dl-sec-head"><span className="dl-sec-title dl-sec-title--top">Top match</span><span className="dl-rule" /></div>
            {renderHero(ranked.hero)}
          </section>
        )}

        {ranked.albums.length > 0 && (
          <section className="dl-sec">
            <div className="dl-sec-head">
              <span className="dl-sec-title">Releases</span>
              <span className="dl-sec-count">{ranked.albums.length}</span>
              <span className="dl-rule" />
            </div>
            <div className="dl-shelf">{ranked.albums.map((a, i) => renderRelease(a, i))}</div>
          </section>
        )}

        {ranked.songs.length > 0 && (
          <section className="dl-sec">
            <div className="dl-sec-head">
              <span className="dl-sec-title">Songs</span>
              <span className="dl-sec-count">{ranked.songs.length}</span>
              <span className="dl-rule" />
            </div>
            <ul className="dl-song-list" role="list">{ranked.songs.map((s, i) => renderSong(s, i))}</ul>
          </section>
        )}

        {!hasResults && !searching && (
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
