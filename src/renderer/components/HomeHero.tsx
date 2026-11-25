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
 *                 renderer/homeSpotlight.ts); with none, today's pick: the
 *                 same album all day from your 50 most played (it used to be
 *                 its own "Today's pick" band lower on the Home)
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
import { useHomeSpotlight } from '../homeSpotlight'
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
import { heroByline, heroShowLine, type HeroShow } from '../../common/home-layout'
import { nyDate } from '../../common/concerts-feed'
import type { Track } from '../types'
import '../styles/home-hero.css'

type HeroAction =
  | { type: 'VIEW_ALBUM_DETAIL'; albumKey: string }
  | { type: 'ADD_ARTWORK'; key: string; hash: string }

interface Props {
  /** The REGULAR library (declared live sets' songs excluded) — HomeView's projection. */
  tracks: Track[]
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

/** Today's pick: one album all day, from the 50 most played (recency when nothing is played yet). */
function todaysPick(albums: Album[]): Album | null {
  if (albums.length === 0) return null
  const scored = albums.map((a) => {
    let plays = 0
    let newest = ''
    for (const t of a.tracks) {
      plays += Number(t.playCount) || 0
      if (t.dateAdded && t.dateAdded > newest) newest = t.dateAdded
    }
    return { a, plays, newest }
  })
  scored.sort((x, y) => y.plays - x.plays || y.newest.localeCompare(x.newest))
  const pool = scored.slice(0, 50)
  const day = Math.floor(Date.now() / 86_400_000)
  return pool[day % pool.length]!.a
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

export default function HomeHero({ tracks, artworkMap, artIndex, shows, dispatch, playTrack }: Props): JSX.Element | null {
  const spot = useHomeSpotlight()
  const menus = useHomeItemMenus()
  const living = spot.doc?.livingIn ?? null

  const albums = useMemo(() => groupTracksIntoAlbums(tracks), [tracks])
  const byIdentity = useMemo(() => indexAlbumsForIsland(albums), [albums])
  const livingAlbum = useMemo(
    () => (living ? byIdentity.get(islandAlbumKey({ artist: living.artist, album: living.album })) : undefined),
    [living, byIdentity],
  )
  const pick = useMemo(() => (livingAlbum ? null : todaysPick(albums)), [livingAlbum, albums])
  const album: Album | null = livingAlbum ?? pick
  const isLiving = !!livingAlbum

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

  if (!album) return null
  const year = album.year || album.tracks.find((t) => t.year)?.year || ''

  return (
    <section className="home-hero" aria-label="Tonight on JakeTunes">
      <div
        className="home-hero-cover"
        role="button"
        tabIndex={0}
        aria-label={`Open ${album.name} by ${album.artist}`}
        title={`Open ${album.name}`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.target !== e.currentTarget) return
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
          <button type="button" className="home-hero-btn home-hero-btn--play" onClick={onPlay}>
            {/* 12×12 play glyph in a 36px-tall pill (1/3 of its height) */}
            <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9-5.5z" fill="currentColor" /></svg>
            <span>Play</span>
          </button>
          <button type="button" className="home-hero-btn home-hero-btn--shuffle" onClick={onShuffle}>Shuffle</button>
        </div>
      </div>
    </section>
  )
}
