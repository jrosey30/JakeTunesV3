/**
 * TONIGHT ON JAKETUNES — launch page "G", the top of the desktop Home
 * (Jake approved 2026-10-18 after five rejected directions: "give me
 * goosebumps", "stay in line with the JakeTunes world"; references: Apple
 * Music Now Playing, the old iTunes/iPod, a Letterboxd profile).
 *
 *   backdrop   the cover of the album you're living in, blurred 70px +
 *              saturate(1.35), drifting slowly (still under reduced motion),
 *              under a rgba(12,22,36,0.42) veil; the art dissolves into the
 *              Home canvas at the bottom.
 *   hero       400px cover · TONIGHT ON JAKETUNES (pix Chicago) · headline ·
 *              the Music Man's frosted pill (his line + the stats line) ·
 *              ONE button, Play <album>. The pill itself is the intro: click
 *              → he speaks his line, then the record plays from track 1
 *              (launch/musicManIntro.ts). Jake, mid-build: "calm the page".
 *   islands    the synced TOP 10 ISLAND ALBUMS (renderer/syncedPicks.ts) as a
 *              classic glossy Cover Flow (common/cover-flow.ts) — click a side
 *              cover to bring it forward, ←/→ when focused, the mouse's side
 *              wheel or the trackpad's two-finger side swipe over it
 *              (common/cover-flow-wheel.ts). The centred cover sits in a CD
 *              jewel case (JewelCase.tsx, the phone's twin): click it (or
 *              Enter) and the lid pops, swings open on its left hinge, the
 *              disc lifts and the album page comes out of the disc; back from
 *              that page it shrinks into the disc and the lid snaps shut
 *              (discHandoff.ts). Reduce Motion: straight to the album.
 *   digging    NOW DIGGING — five 2:3 artist posters (the app's artist photos,
 *              an initials poster otherwise), click → the artist page.
 *
 * Like the library (Jake, 2026-10-20): the hero cover and every island cover
 * you own right-click to the Albums view's album menu (HomeItemMenus) and drag
 * as the album; a Now Digging poster drags as the artist's songs, the way an
 * Artists tile does (the library has no artist menu, so neither does this).
 *
 * Facts come from homemini's merged-history document (renderer/homeSpotlight.ts),
 * this Mac's own history when homemini is away; nothing here is invented, and
 * an empty part hides rather than apologising. Names wrap, never clip.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import AlbumArtImage from './AlbumArtImage'
import JewelCase, { type JewelCaseMode } from './JewelCase'
import { armDiscOpen, discHandoffSupported, endReturningCase, peekReturningCase, prefersReducedMotion } from '../discHandoff'
import { albumArtUrl, artRevision } from '../artRevision'
import { useHomeSpotlight } from '../homeSpotlight'
import { useIslandAlbums } from '../syncedPicks'
import { islandAlbumKey } from '../../common/synced-picks'
import { coverFlowPoses, stepCover, coverFlowKeyDelta, clampCoverIndex, COVER_FLOW_DEFAULTS } from '../../common/cover-flow'
import { COVER_WHEEL_DEFAULTS } from '../../common/cover-flow-wheel'
import { useCoverFlowWheel } from '../hooks/useCoverFlowWheel'
import { groupTracksIntoAlbums, type Album } from '../utils/albumGroups'
import { indexAlbumsForIsland } from '../utils/islandSlots'
import { albumKeyFromStrings } from '../utils/albumKey'
import { lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { canonicalArtist } from '../utils/artistAlias'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import { tracksForArtist } from '../utils/artistTracks'
import { setAlbumDragPayload } from '../utils/trackDrag'
import { useHomeItemMenus } from './HomeItemMenus'
import { sessionArtistImages, hashColor, initials } from '../utils/artistPortrait'
import { audioFromBase64Mpeg } from '../audio/base64-audio'
import { attachClipToBroadcast, detachClipFromBroadcast } from '../audio/eq'
import { createMusicManIntro, type IntroPhase, type MusicManIntro } from '../launch/musicManIntro'
import { setNotice } from '../activity'
import type { Track } from '../types'
import type { DiggingCard } from '../../common/home-spotlight-doc'
import '../styles/home-tonight.css'

type HomeAction =
  | { type: 'VIEW_ALBUM_DETAIL'; albumKey: string }
  | { type: 'VIEW_ARTIST_DETAIL'; artistName: string }
  | { type: 'ADD_ARTWORK'; key: string; hash: string }

interface Props {
  /** The REGULAR library (declared live sets' songs excluded) — HomeView's projection. */
  tracks: Track[]
  artworkMap: Record<string, string>
  artIndex: Map<string, string>
  dispatch: (action: HomeAction) => void
  playTrack: (track: Track, queue?: Track[], queueIndex?: number, djTransition?: boolean, freshContext?: boolean, preserveOrder?: boolean) => void
}

const FADE_READY_CAP_MS = 2000

function DiscGlyph({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" aria-hidden="true">
      <circle cx="20" cy="20" r="18" />
      <circle cx="20" cy="20" r="6" />
      <circle cx="20" cy="20" r="2" fill="rgba(255,255,255,0.55)" />
    </svg>
  )
}

/** The frosted pill's inside: on-air dot, station ident, his line, then the facts. */
function MusicManPillBody({ line, stats, live }: { line: string; stats: string | null; live: boolean }): JSX.Element {
  return (
    <>
      <span className={`tn-mm-dot${live ? ' tn-mm-dot--live' : ''}`} aria-hidden="true" />
      <span className="tn-mm-body">
        <span className="tn-mm-label">THE MUSIC MAN · WJLR 330.9</span>
        <span className="tn-mm-line">“{line}”</span>
        {stats && <span className="tn-mm-stats">{stats}</span>}
      </span>
    </>
  )
}

/** The speech clip for the intro: audioFromBase64Mpeg (blob URL) + the broadcast graph. */
function domClip(b64: string) {
  const el = audioFromBase64Mpeg(b64)
  return {
    play: () => el.play(),
    onEnd: (cb: (() => void) | null) => {
      el.onended = cb ? () => cb() : null
      el.onerror = cb ? () => cb() : null
    },
    attach: () => attachClipToBroadcast(el),
    detach: () => detachClipFromBroadcast(el),
    release: () => {
      el.pause()
      if (el.src.startsWith('blob:')) URL.revokeObjectURL(el.src)
    },
  }
}

function waitForDuck(): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (): void => {
      window.removeEventListener('musicman-fade-ready', done)
      if (timer) clearTimeout(timer)
      resolve()
    }
    window.addEventListener('musicman-fade-ready', done)
    timer = setTimeout(done, FADE_READY_CAP_MS)
  })
}

/** The jewel case's run on the front cover: opening, back open on Home, or snapping shut. */
interface CaseRun { key: string; mode: 'open' | 'held-open' | 'close' }
/** A cover's identity in the flow (the React key too). */
const flowKeyOf = (f: { slot: number; pick: { artist: string; album: string } }): string => `${f.slot}|${islandAlbumKey(f.pick)}`
/** A step's case plastic: off the old front (tnCasePlasticOut, 220 ms), up on the new (tnCasePlasticIn, 330 + 220 ms). */
const CASE_LEAVE_MS = 240
const CASE_ARRIVE_MS = 580

/** Warm the album page's full-size cover while the case opens (the transition waits for it to load). */
function warmAlbumCover(hash: string | undefined): void {
  if (!hash) return
  const img = new Image()
  img.decoding = 'async'
  img.src = albumArtUrl(hash, undefined, artRevision(hash))
  img.decode().then(() => undefined, () => undefined)
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`
/** "Oden & Fatzo" → "OF", "The Beatles" → "B": words with a letter or digit only. */
const posterInitials = (name: string): string =>
  initials(name.replace(/^the\s+/i, '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).join(' ') || name)

export default function TonightOnJakeTunes({ tracks, artworkMap, artIndex, dispatch, playTrack }: Props): JSX.Element | null {
  const spot = useHomeSpotlight()
  const island = useIslandAlbums()
  const menus = useHomeItemMenus()
  const doc = spot.doc
  const living = doc?.livingIn ?? null

  // Library albums, matched to the living-in album and to the island picks
  // under either artist form (the phone may group under a different spelling).
  const albums = useMemo(() => groupTracksIntoAlbums(tracks), [tracks])
  const byIdentity = useMemo(() => indexAlbumsForIsland(albums), [albums])

  const artFor = useCallback((album: Album | undefined, artist: string, name: string): string | undefined => {
    if (album) {
      for (const a of album.artists) {
        const hit = lookupArtwork(artworkMap, artIndex, a, album.name)
        if (hit) return hit
      }
      const hit = lookupArtwork(artworkMap, artIndex, album.artist, album.name)
      if (hit) return hit
    }
    return lookupArtwork(artworkMap, artIndex, artist, name)
  }, [artworkMap, artIndex])

  const livingAlbum = useMemo(() => (living ? byIdentity.get(islandAlbumKey({ artist: living.artist, album: living.album })) : undefined), [living, byIdentity])
  const livingTracks = useMemo(() => livingAlbum?.tracks ?? [], [livingAlbum])
  // The cover: homemini's artworkHash first (the /api/albums hash — md5 of
  // "artist|||album", the desktop's own artwork file name); if that file
  // won't load here, this Mac's artwork lookup by artist + album.
  const [refusedHash, setRefusedHash] = useState<string | null>(null)
  const localLivingHash = living ? artFor(livingAlbum, living.artist, living.album) : undefined
  const livingHash = living
    ? (living.artworkHash && living.artworkHash !== refusedHash ? living.artworkHash : localLivingHash)
    : undefined
  const onLivingArtError = useCallback(() => {
    if (living?.artworkHash && living.artworkHash !== localLivingHash) setRefusedHash(living.artworkHash)
  }, [living, localLivingHash])
  // The hero cover opens its album, as the phone's does (Jake's parity audit,
  // 2026-10-21); right-click and drag stay the library's.
  const openLiving = useCallback(() => {
    if (!living) return
    if (livingAlbum) dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyFromStrings(livingAlbum.artist, livingAlbum.name) })
    else setNotice(`${living.album} by ${living.artist} isn’t in this library`)
  }, [living, livingAlbum, dispatch])

  // Island picks in rank order; the rank is the slot (No. 1 … No. 10).
  const flow = useMemo(() => island.values
    .map((pick, slot) => {
      if (!pick) return null
      const album = byIdentity.get(islandAlbumKey(pick))
      return { slot, pick, album, hash: artFor(album, pick.artist, pick.album) }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null), [island.values, byIdentity, artFor])

  // Covers the artwork map doesn't have yet — the same idle resolver the grids use.
  useEffect(() => {
    const missing: Array<{ artist: string; album: string }> = []
    if (living && livingAlbum && !localLivingHash) missing.push({ artist: livingAlbum.artist, album: livingAlbum.name })
    for (const f of flow) if (f.album && !f.hash) missing.push({ artist: f.album.artist, album: f.album.name })
    if (missing.length) queueArtworkResolutions(missing, dispatch)
  }, [living, livingAlbum, localLivingHash, flow, dispatch])

  // ── Play / the Music Man's introduction ──────────────────────────────
  const playLiving = useCallback(() => {
    if (livingTracks.length === 0) return
    // Front to back from track 1, verbatim (preserveOrder: shuffle can't reorder a record).
    playTrack(livingTracks[0], livingTracks, 0, undefined, true, true)
  }, [livingTracks, playTrack])
  const playLivingRef = useRef(playLiving)
  playLivingRef.current = playLiving

  const [introPhase, setIntroPhase] = useState<IntroPhase>('idle')
  const introRef = useRef<MusicManIntro | null>(null)
  useEffect(() => {
    const intro = createMusicManIntro({
      speak: (line) => window.electronAPI.musicmanSpeak(line, false),
      makeClip: domClip,
      emit: (name) => window.dispatchEvent(new Event(name)),
      waitForDuck,
      playAlbum: () => playLivingRef.current(),
      onPhase: setIntroPhase,
      notice: (m) => setNotice(m),
    })
    introRef.current = intro
    // Leaving the Home mid-introduction stops him and never starts the record.
    return () => { intro.cancel(); introRef.current = null }
  }, [])

  const onPlay = useCallback(() => {
    introRef.current?.cancel()
    playLiving()
  }, [playLiving])
  const onIntro = useCallback(() => {
    const intro = introRef.current
    const line = doc?.musicMan?.line
    if (!intro) return
    if (intro.phase() !== 'idle') { intro.cancel(); return }
    if (line) void intro.start(line)
  }, [doc])

  // ── Cover Flow ───────────────────────────────────────────────────────
  // Back from an album page that came out of the case's disc, the case comes
  // back OPEN on that cover (discHandoff.ts) — the page shrinks into its disc,
  // then it shuts. Pure reads here (StrictMode runs initializers twice).
  const [caseRun, setCaseRun] = useState<CaseRun | null>(() => {
    const r = peekReturningCase()
    return r && flow.some((f) => flowKeyOf(f) === r.flowKey) ? { key: r.flowKey, mode: 'held-open' } : null
  })
  const [active, setActive] = useState(() => {
    const r = peekReturningCase()
    const i = r ? flow.findIndex((f) => flowKeyOf(f) === r.flowKey) : -1
    return i >= 0 ? i : 0
  })
  const at = clampCoverIndex(active, flow.length)
  // While the case runs the flow holds still: no steps, no second open.
  const caseBusyRef = useRef(false)
  caseBusyRef.current = caseRun !== null
  // The case's plastic sits on the front cover only: a step fades it off the
  // old front and up on the new one (derived during render, so the new front
  // never flashes its plastic before the fade).
  const [shownAt, setShownAt] = useState(at)
  const [stepped, setStepped] = useState<{ arrive: string; leave: string | null } | null>(null)
  if (shownAt !== at) {
    setShownAt(at)
    const from = flow[shownAt]
    const to = flow[at]
    setStepped(to ? { arrive: flowKeyOf(to), leave: from ? flowKeyOf(from) : null } : null)
  }
  useEffect(() => {
    if (!stepped) return
    // The old front's plastic is gone; the new front's has come up (then it
    // is plain 'rest' again, so a later class change never replays the fade).
    const t1 = stepped.leave ? window.setTimeout(() => setStepped((s) => (s === stepped ? { ...s, leave: null } : s)), CASE_LEAVE_MS) : 0
    const t2 = window.setTimeout(() => setStepped((s) => (s && s.arrive === stepped.arrive ? null : s)), CASE_ARRIVE_MS)
    return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
  }, [stepped])

  const stageRef = useRef<HTMLDivElement>(null)
  const frontReflectionRef = useRef<HTMLSpanElement>(null)
  const getFrontReflection = useCallback(() => frontReflectionRef.current, [])
  const [stageWidth, setStageWidth] = useState(1104)
  // Measured before paint: the case coming back open must be where the
  // album page's cover shrinks to on the transition's first frame.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageWidth(el.clientWidth || 1104))
    ro.observe(el)
    setStageWidth(el.clientWidth || 1104)
    return () => ro.disconnect()
  }, [flow.length > 0])
  // Side wheel / side swipe: horizontal gestures step the covers (and never
  // scroll the page); vertical ones scroll the Home as before.
  useCoverFlowWheel(stageRef, (steps) => {
    if (caseBusyRef.current) return
    setActive((cur) => stepCover(clampCoverIndex(cur, flow.length), steps, flow.length))
  }, COVER_WHEEL_DEFAULTS, flow.length > 0)
  const poses = useMemo(() => coverFlowPoses(flow.length, at, { width: stageWidth }), [flow.length, at, stageWidth])

  const openFlow = useCallback((i: number) => {
    const f = flow[i]
    if (!f) return
    if (f.album) dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyFromStrings(f.album.artist, f.album.name) })
    else setNotice(`${f.pick.album} by ${f.pick.artist} isn’t in this library`)
  }, [flow, dispatch])

  // The front cover: open its jewel case, then the album page comes out of
  // the disc (JewelCase → onDiscUp). Reduce Motion, or nothing to open: the
  // plain way.
  const openFront = useCallback((i: number) => {
    if (caseBusyRef.current) return
    const f = flow[i]
    if (!f) return
    if (!f.album || prefersReducedMotion()) { openFlow(i); return }
    warmAlbumCover(f.hash)
    setCaseRun({ key: flowKeyOf(f), mode: 'open' })
  }, [flow, openFlow])
  const onDiscUp = useCallback(() => {
    const f = caseRun ? flow.find((x) => flowKeyOf(x) === caseRun.key) : undefined
    if (!f?.album) { setCaseRun(null); return }
    const albumKey = albumKeyFromStrings(f.album.artist, f.album.name)
    // MainContent turns this navigation into the disc → page transition.
    if (discHandoffSupported()) armDiscOpen(albumKey, flowKeyOf(f))
    dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey })
  }, [caseRun, flow, dispatch])
  // Back on Home with the case open: once the page has shrunk into the disc,
  // the disc drops and the lid snaps shut.
  useEffect(() => {
    if (caseRun?.mode !== 'held-open') return
    const r = peekReturningCase()
    let live = true
    const shut = (): void => {
      if (live) setCaseRun((c) => (c && c.mode === 'held-open' ? { ...c, mode: 'close' } : c))
    }
    if (r) void r.finished.then(shut)
    else shut()
    return () => { live = false }
  }, [caseRun?.mode])
  const onShut = useCallback(() => {
    endReturningCase(peekReturningCase())
    setCaseRun(null)
  }, [])
  // The island list changed under a running case (a sync from the phone):
  // its cover isn't in front any more — drop the run so the flow isn't held.
  const frontKey = flow[at] ? flowKeyOf(flow[at]) : null
  useEffect(() => {
    if (caseRun && caseRun.key !== frontKey) {
      if (caseRun.mode !== 'open') endReturningCase(peekReturningCase())
      setCaseRun(null)
    }
  }, [caseRun, frontKey])

  const onFlowKey = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const d = coverFlowKeyDelta(e.key)
    if (d !== 0) {
      // stopPropagation is LOAD-BEARING: App.tsx's document-level transport
      // handler takes ←/→ as previous/next track (the CoverFlowView lesson).
      e.preventDefault()
      e.stopPropagation()
      if (caseBusyRef.current) return
      setActive((cur) => stepCover(clampCoverIndex(cur, flow.length), d, flow.length))
    } else if (e.key === 'Enter' && e.target === e.currentTarget) {
      e.preventDefault()
      e.stopPropagation()
      openFront(at)
    }
  }, [flow.length, at, openFront])

  // ── Now Digging portraits ────────────────────────────────────────────
  const digging: DiggingCard[] = doc?.nowDigging ?? []
  const [photos, setPhotos] = useState<Map<string, string | null>>(() => new Map(sessionArtistImages))
  const diggingNames = digging.map((d) => d.artist).join('\u0000')
  useEffect(() => {
    let live = true
    for (const name of diggingNames ? diggingNames.split('\u0000') : []) {
      if (sessionArtistImages.has(name)) continue
      window.electronAPI.getArtistImage(name).then((r) => (r.ok ? r.slug : null)).catch(() => null).then((slug) => {
        sessionArtistImages.set(name, slug)
        if (live) setPhotos((prev) => new Map(prev).set(name, slug))
      })
    }
    return () => { live = false }
  }, [diggingNames])

  // The backdrop: the album you're living in; with none, the No. 1 island cover.
  const backdropHash = livingHash ?? flow[0]?.hash
  if (!living && flow.length === 0 && digging.length === 0) return null

  const spotlight = doc?.spotlight ?? null
  const mm = doc?.musicMan ?? null
  const canPlay = livingTracks.length > 0
  const current = flow[at]

  return (
    <section className="tn" aria-label="Tonight on JakeTunes">
      <div className="tn-art" aria-hidden="true">
        {backdropHash && <AlbumArtImage hash={backdropHash} alt="" size={320} className="tn-art-img" onError={backdropHash === livingHash ? onLivingArtError : undefined} />}
        <div className="tn-veil" />
      </div>

      <div className="tn-inner">
        {living && (
          <div className="tn-hero">
            <div
              className="tn-cover"
              role="button"
              tabIndex={0}
              aria-label={`Open ${living.album} by ${living.artist}`}
              title={`Open ${living.album}`}
              onClick={openLiving}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.target !== e.currentTarget) return
                e.preventDefault()
                e.stopPropagation()
                openLiving()
              }}
              {...(livingAlbum ? {
                onContextMenu: (e: React.MouseEvent) => menus?.openAlbumMenu(e, livingAlbum.tracks),
                draggable: true,
                onDragStart: (e: React.DragEvent) => setAlbumDragPayload(e, sortAlbumTracks(livingAlbum.tracks).map((t) => t.id)),
              } : {})}
            >
              {livingHash
                ? <AlbumArtImage hash={livingHash} alt={`${living.album} by ${living.artist}`} priority onError={onLivingArtError} />
                : <div className="tn-cover-ph"><DiscGlyph size={72} /></div>}
            </div>
            <div className="tn-copy">
              <div className="tn-eyebrow">TONIGHT ON JAKETUNES</div>
              <h1 className="tn-headline">{spotlight?.headline ?? `${living.album}, ${living.artist}`}</h1>
              {mm ? (
                // The Music Man's pill IS the intro control (Jake, 2026-10-18: "calm
                // the page" — one button, the pill speaks): click / Enter / Space →
                // his line, then the record from track 1; again → stop him. Static
                // when the record isn't in this library (nothing to introduce).
                canPlay ? (
                  <button
                    type="button"
                    className={`tn-mm tn-mm--action${introPhase !== 'idle' ? ' tn-mm--on' : ''}`}
                    onClick={onIntro}
                    aria-pressed={introPhase !== 'idle'}
                    aria-label={introPhase === 'idle'
                      ? `The Music Man: “${mm.line}” Let him introduce ${living.album}, then play it.`
                      : 'Stop the Music Man’s introduction'}
                    title={introPhase === 'idle' ? 'Let the Music Man introduce it' : 'Stop the introduction'}
                  >
                    <MusicManPillBody line={mm.line} stats={spotlight?.statsLine ?? null} live={introPhase === 'speaking'} />
                  </button>
                ) : (
                  <div className="tn-mm">
                    <MusicManPillBody line={mm.line} stats={spotlight?.statsLine ?? null} live={false} />
                  </div>
                )
              ) : (
                // No line from him (offline: this Mac's own history) → no pill;
                // the facts stay, as one quiet line.
                spotlight?.statsLine && <div className="tn-stats">{spotlight.statsLine}</div>
              )}
              {canPlay && (
                <div className="tn-actions">
                  <button type="button" className="tn-btn tn-btn--play" onClick={onPlay}>
                    {/* 13×13 play glyph in a 50px-tall pill (~1/4 of its height) */}
                    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9-5.5z" fill="currentColor" /></svg>
                    <span>Play {living.album}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {flow.length > 0 && (
          <div className="tn-islands">
            <div className="tn-sec-head">
              <h2 className="tn-h2">Island albums</h2>
              <span className="tn-sub">Your ten, desert-island ranked · click a cover</span>
            </div>
            <div
              ref={stageRef}
              className="tn-flow"
              tabIndex={0}
              role="group"
              aria-roledescription="carousel"
              aria-label="Island albums. Left and right arrows move; Enter opens the album in front."
              onKeyDown={onFlowKey}
            >
              {flow.map((f, i) => {
                const p = poses[i]
                if (!p) return null
                const front = i === at
                const key = flowKeyOf(f)
                const style: CSSProperties = {
                  transform: `translate3d(${p.tx}px, ${p.ty}px, 0) rotateY(${p.rotateY}deg) scale(${p.scale})`,
                  zIndex: p.zIndex,
                  visibility: p.onStage ? 'visible' : 'hidden',
                }
                const run = front && caseRun?.key === key ? caseRun : null
                const caseMode: JewelCaseMode | null = run
                  ? run.mode
                  : front
                    ? (stepped?.arrive === key ? 'arrive' : 'rest')
                    : (stepped?.leave === key ? 'leave' : null)
                return (
                  <button
                    key={key}
                    type="button"
                    tabIndex={-1}
                    className={`tn-flow-cover${front ? ' tn-flow-cover--front' : ''}${f.album ? '' : ' tn-flow-cover--missing'}${run?.mode === 'held-open' ? ' tn-flow-cover--case-open' : ''}`}
                    style={style}
                    onClick={() => {
                      if (caseBusyRef.current) return
                      if (front) openFront(i)
                      else setActive(i)
                    }}
                    {...(f.album ? {
                      onContextMenu: (e: React.MouseEvent) => menus?.openAlbumMenu(e, f.album!.tracks),
                      draggable: true,
                      onDragStart: (e: React.DragEvent) => setAlbumDragPayload(e, sortAlbumTracks(f.album!.tracks).map((t) => t.id)),
                    } : {})}
                    aria-label={`No. ${f.slot + 1}: ${f.pick.album} by ${f.pick.artist}${front ? ' — open the album' : ''}`}
                    title={front ? `Open ${f.pick.album}` : `${f.pick.album} — ${f.pick.artist}`}
                  >
                    {f.hash
                      ? <AlbumArtImage hash={f.hash} alt="" size={480} className="tn-flow-img" />
                      : <span className="tn-flow-ph"><DiscGlyph size={64} /></span>}
                    {/* The gloss: a flipped copy under the cover, inside the same
                        button so it turns with it (-webkit-box-reflect on 3D-turned
                        covers drops whole covers mid-move — CoverFlowView's
                        "no per-card reflections" lesson). */}
                    <span className="tn-flow-reflection" aria-hidden="true" ref={front ? frontReflectionRef : undefined}>
                      {f.hash
                        ? <AlbumArtImage hash={f.hash} alt="" size={480} className="tn-flow-img" />
                        : <span className="tn-flow-ph"><DiscGlyph size={64} /></span>}
                    </span>
                    {caseMode && (
                      <JewelCase
                        hash={f.hash}
                        artPx={COVER_FLOW_DEFAULTS.centerSize}
                        mode={caseMode}
                        reflection={front ? getFrontReflection : undefined}
                        onDiscUp={front ? onDiscUp : undefined}
                        onShut={front ? onShut : undefined}
                      />
                    )}
                  </button>
                )
              })}
            </div>
            {current && (
              <div className="tn-flow-caption" aria-live="polite">
                <span className="tn-flow-rank">No. {current.slot + 1}</span>
                <span className="tn-flow-album">{current.pick.album}</span>
                <span className="tn-flow-artist">{current.pick.artist}</span>
              </div>
            )}
          </div>
        )}

        {digging.length > 0 && (
          <div className="tn-digging">
            <div className="tn-sec-head">
              <h2 className="tn-h2">Now digging</h2>
              <span className="tn-sub">New bands you can't stop playing · last 30 days</span>
            </div>
            <div className="tn-dig-grid">
              {digging.map((d, i) => {
                const slug = photos.get(d.artist)
                return (
                  <button
                    key={d.artist}
                    type="button"
                    className="tn-dig"
                    onClick={() => dispatch({ type: 'VIEW_ARTIST_DETAIL', artistName: canonicalArtist(d.artist) })}
                    draggable
                    onDragStart={(e) => {
                      const ids = tracksForArtist(tracks, d.artist).map((t) => t.id)
                      if (ids.length) setAlbumDragPayload(e, ids)
                      else e.preventDefault()
                    }}
                    aria-label={`Number ${i + 1}: ${d.artist}, ${plural(d.plays30, 'play', 'plays')} in 30 days`}
                  >
                    <span className="tn-poster" style={slug ? undefined : { background: hashColor(d.artist) }}>
                      {slug
                        ? <img src={`artist-image://${slug}.jpg`} alt="" draggable={false} decoding="async" />
                        : <span className="tn-poster-ini">{posterInitials(d.artist)}</span>}
                      <span className="tn-dig-rank">{i + 1}</span>
                    </span>
                    <span className="tn-dig-name">{d.artist}</span>
                    <span className="tn-dig-meta">{plural(d.plays30, 'play', 'plays')}{d.topSong ? <> · “{d.topSong.title}”</> : null}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
