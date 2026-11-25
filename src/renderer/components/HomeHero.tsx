/**
 * TONIGHT ON JAKETUNES — the top of the desktop Home (V7, 2026-11-24, Jake's
 * approved design; common/home-layout.ts has the page's order).
 *
 * One album: its cover, title, artist · year, one line tying it to an upcoming
 * show when homemini's concerts feed has one by that artist, one Music Man line,
 * ▶ Play and Shuffle. The phone's hero is the same card (V7 / Mobile V3 stay
 * aligned).
 *
 *   which album   the album you're living in (homemini's merged history,
 *                 renderer/homeSpotlight.ts); with none, the album with the
 *                 most songs on On Repeat (common/home-layout.ts heroChoice).
 *                 Until the answer is in, the card holds its space, empty, so
 *                 a launch never shows one album and swaps in another
 *   the line      the Music Man's, only when the album is the one he wrote it
 *                 about. Click it and he introduces the record, then it plays
 *                 from track 1 (launch/musicManIntro.ts — kept from launch
 *                 page G); click again to stop him
 *   the cover     opens the album; right-click is the Albums view's album menu,
 *                 drag carries the album (like any album in the library)
 *
 * Nothing here is invented: no album, no hero; no show, no show line.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AlbumArtImage from './AlbumArtImage'
import { useHomeSpotlight, homeSpotlightAnswered } from '../homeSpotlight'
import { useHomeShelves } from '../homeShelves'
import { albumKeyOf } from '../utils/albumKey'
import { useHomeItemMenus } from './HomeItemMenus'
import { groupTracksIntoAlbums, type Album } from '../utils/albumGroups'
import { indexAlbumsForIsland } from '../utils/islandSlots'
import { islandAlbumKey } from '../../common/synced-picks'
import { albumKeyFromStrings } from '../utils/albumKey'
import { lookupArtwork, queueArtworkResolutions } from '../utils/artworkLookup'
import { sortAlbumTracks } from '../utils/albumTrackOrder'
import { setAlbumDragPayload } from '../utils/trackDrag'
import { audioFromBase64Mpeg } from '../audio/base64-audio'
import { attachClipToBroadcast, detachClipFromBroadcast } from '../audio/eq'
import { createMusicManIntro, type IntroPhase, type MusicManIntro } from '../launch/musicManIntro'
import { setNotice } from '../activity'
import { heroByline, heroChoice, heroShowLine, HERO_HOLD_MS, type HeroShow } from '../../common/home-layout'
import { nyDate } from '../../common/concerts-feed'
import type { Track } from '../types'
import PlayButton from './PlayButton'
import '../styles/home-hero.css'

type HeroAction =
  | { type: 'VIEW_ALBUM_DETAIL'; albumKey: string }
  | { type: 'ADD_ARTWORK'; key: string; hash: string }

interface Props {
  /** The REGULAR library (declared live sets' songs excluded) — HomeView's projection. */
  tracks: Track[]
  /** The whole library (On Repeat's ids resolve here, as on the shelves). */
  allTracks: Track[]
  artworkMap: Record<string, string>
  artIndex: Map<string, string>
  /** Upcoming shows (homemini's concerts feed, items + discover). */
  shows: readonly HeroShow[]
  dispatch: (action: HeroAction) => void
  playTrack: (track: Track, queue?: Track[], queueIndex?: number, djTransition?: boolean, freshContext?: boolean, preserveOrder?: boolean) => void
}

const FADE_READY_CAP_MS = 2000

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

function shuffled<T>(xs: readonly T[]): T[] {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function DiscGlyph(): JSX.Element {
  return (
    <svg width="56" height="56" viewBox="0 0 40 40" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" aria-hidden="true">
      <circle cx="20" cy="20" r="18" />
      <circle cx="20" cy="20" r="6" />
      <circle cx="20" cy="20" r="2" fill="rgba(255,255,255,0.5)" />
    </svg>
  )
}

export default function HomeHero({ tracks, allTracks, artworkMap, artIndex, shows, dispatch, playTrack }: Props): JSX.Element | null {
  const spot = useHomeSpotlight()
  const menus = useHomeItemMenus()
  const living = spot.doc?.livingIn ?? null

  const albums = useMemo(() => groupTracksIntoAlbums(tracks), [tracks])
  const byIdentity = useMemo(() => indexAlbumsForIsland(albums), [albums])
  const livingAlbum = useMemo(
    () => (living ? byIdentity.get(islandAlbumKey({ artist: living.artist, album: living.album })) : undefined),
    [living, byIdentity],
  )
  // On Repeat (the shelves' document): the fallback album when there is none you're living in.
  const { shelves } = useHomeShelves(allTracks, tracks)
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])
  const onRepeatKeys = useMemo((): string[] | null => {
    if (!shelves) return null
    const ids = shelves.onRepeat.length ? shelves.onRepeat : shelves.listeningALot.map((h) => h.id)
    return ids.map((id) => byId.get(id)).filter((t): t is Track => !!t).map((t) => albumKeyOf(t))
  }, [shelves, byId])
  const albumsByKey = useMemo(() => {
    const m = new Map<string, Album>()
    for (const a of albums) { const t = a.tracks[0]; if (t) m.set(albumKeyOf(t), a) }
    return m
  }, [albums])
  // Holding is bounded: after HERO_HOLD_MS the hero draws what it has.
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setWaited(true), HERO_HOLD_MS)
    return () => window.clearTimeout(t)
  }, [])
  const choice = heroChoice({ answered: homeSpotlightAnswered(), living: !!livingAlbum, onRepeat: onRepeatKeys, waitedMs: waited ? HERO_HOLD_MS : 0 })
  const album: Album | null = choice.kind === 'living' ? livingAlbum ?? null
    : choice.kind === 'on-repeat' ? albumsByKey.get(choice.albumKey) ?? null
      : null
  const isLiving = choice.kind === 'living'

  const ordered = useMemo(() => (album ? sortAlbumTracks(album.tracks) : []), [album])

  // The cover: homemini's hash for the album you're living in, then this Mac's
  // own artwork by artist + album (any artist spelling on the album).
  const [refusedHash, setRefusedHash] = useState<string | null>(null)
  const localHash = useMemo((): string | undefined => {
    if (!album) return undefined
    for (const a of [album.artist, ...album.artists]) {
      const hit = lookupArtwork(artworkMap, artIndex, a, album.name)
      if (hit) return hit
    }
    return undefined
  }, [album, artworkMap, artIndex])
  const remoteHash = isLiving && living?.artworkHash && living.artworkHash !== refusedHash ? living.artworkHash : undefined
  const hash = remoteHash ?? localHash
  const onArtError = useCallback(() => {
    if (remoteHash && remoteHash !== localHash) setRefusedHash(remoteHash)
  }, [remoteHash, localHash])
  useEffect(() => {
    if (album && !localHash) queueArtworkResolutions([{ artist: album.artist, album: album.name }], dispatch)
  }, [album, localHash, dispatch])

  // ── Play, Shuffle, and the Music Man's introduction ───────────────────
  const play = useCallback(() => {
    if (ordered.length === 0) return
    // Front to back from track 1, verbatim (preserveOrder: shuffle can't reorder a record).
    playTrack(ordered[0]!, ordered, 0, undefined, true, true)
  }, [ordered, playTrack])
  const shuffle = useCallback(() => {
    if (ordered.length === 0) return
    const q = shuffled(ordered)
    playTrack(q[0]!, q, 0, undefined, true, true)
  }, [ordered, playTrack])
  const playRef = useRef(play)
  playRef.current = play

  const [introPhase, setIntroPhase] = useState<IntroPhase>('idle')
  const introRef = useRef<MusicManIntro | null>(null)
  useEffect(() => {
    const intro = createMusicManIntro({
      speak: (line) => window.electronAPI.musicmanSpeak(line, false),
      makeClip: domClip,
      emit: (name) => window.dispatchEvent(new Event(name)),
      waitForDuck,
      playAlbum: () => playRef.current(),
      onPhase: setIntroPhase,
      notice: (m) => setNotice(m),
    })
    introRef.current = intro
    // Leaving the Home mid-introduction stops him and never starts the record.
    return () => { intro.cancel(); introRef.current = null }
  }, [])
  const onPlay = useCallback(() => { introRef.current?.cancel(); play() }, [play])
  const onShuffle = useCallback(() => { introRef.current?.cancel(); shuffle() }, [shuffle])

  const mmLine = isLiving ? spot.doc?.musicMan?.line ?? null : null
  const onIntro = useCallback(() => {
    const intro = introRef.current
    if (!intro || !mmLine) return
    if (intro.phase() !== 'idle') { intro.cancel(); return }
    void intro.start(mmLine)
  }, [mmLine])

  const open = useCallback(() => {
    if (album) dispatch({ type: 'VIEW_ALBUM_DETAIL', albumKey: albumKeyFromStrings(album.artist, album.name) })
  }, [album, dispatch])

  const showLine = useMemo(
    () => (album ? heroShowLine(album.artist, shows, nyDate(Date.now())) : null),
    [album, shows],
  )

  if (choice.kind === 'hold') {
    // The card's own size, empty: nothing to read yet, nothing to swap later.
    return <section className="home-hero home-hero--waiting" aria-hidden="true"><div className="home-hero-cover" /></section>
  }
  if (!album) return null
  const year = album.year || album.tracks.find((t) => t.year)?.year || ''

  return (
    <section className="home-hero" aria-label="Tonight on JakeTunes">
      {/* V7 (common/card-rules.ts): the cover opens the album; Play beside it plays. */}
      <div
        className="jt-card home-hero-cover"
        data-card-kind="album"
        role="button"
        tabIndex={0}
        aria-label={`Open ${album.name} by ${album.artist}`}
        title={`Open ${album.name}`}
        onClick={open}
        onKeyDown={(e) => {
          if ((e.key !== 'Enter' && e.key !== ' ') || e.target !== e.currentTarget) return
          e.preventDefault()
          e.stopPropagation()
          open()
        }}
        onContextMenu={(e) => menus?.openAlbumMenu(e, album.tracks)}
        draggable
        onDragStart={(e) => setAlbumDragPayload(e, ordered.map((t) => t.id))}
      >
        {hash
          ? <AlbumArtImage hash={hash} alt={`${album.name} by ${album.artist}`} priority onError={onArtError} />
          : <div className="home-hero-cover-ph"><DiscGlyph /></div>}
      </div>
      <div className="home-hero-copy">
        <div className="home-hero-eyebrow">TONIGHT ON JAKETUNES</div>
        <h1 className="home-hero-title">{album.name}</h1>
        <div className="home-hero-byline">{heroByline(album.artist, year)}</div>
        {showLine && <div className="home-hero-show">{showLine}</div>}
        {mmLine && (
          <button
            type="button"
            className={`home-hero-mm${introPhase !== 'idle' ? ' home-hero-mm--on' : ''}`}
            onClick={onIntro}
            aria-pressed={introPhase !== 'idle'}
            title={introPhase === 'idle' ? 'Let the Music Man introduce it' : 'Stop the introduction'}
          >
            The Music Man: “{mmLine}”
          </button>
        )}
        <div className="home-hero-actions">
          <PlayButton className="home-hero-btn home-hero-btn--play" name={album.name} onPlay={onPlay} />
          <button type="button" className="home-hero-btn home-hero-btn--shuffle" onClick={onShuffle}>Shuffle</button>
        </div>
      </div>
    </section>
  )
}
