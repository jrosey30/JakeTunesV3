/**
 * What JakeTunes already knows about the thing Jake is asking about, read
 * from where it already lives. Nothing here is new knowledge: it is the
 * library row, the brain's description of the audio, the artist page's
 * profile, the album page's credits and history, the Top 1000, the iPod
 * lists. Until 2026-11-13 none of it reached the Music Man.
 *
 *   library.json rows            plays, stars, when added, where from, bpm, key, genre
 *   brain-descriptors.json       how each song sounds, what it is about
 *   artist-profiles/<file>.json  homemini's checked profile (the artist page's)
 *   artist-members.json, artist-tags.json
 *   album-credits.json, album-personnel.json, album-notes.json (the history)
 *   ipod-lists-cache.json        which iPods it rides on
 *   friend-credits.json          who sent it
 *   homemini /api/top1000        the rank, when homemini answers in time
 *
 * A file that is missing or torn is simply absent from the packet. Every
 * network ask is bounded; nothing here can hold the mic for long.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AskSubject, PacketAlbum, PacketArtist, PacketInput, PacketSong } from '../common/music-man-packet.ts'
import { artistProfilePath, parseArtistProfile, profileCacheFile, type ArtistProfile } from '../common/artist-profile.ts'
import { albumCreditsKey, ALBUM_CREDITS_FILE } from './album-credits.ts'
import { personnelCacheKey, PERSONNEL_CACHE_FILE } from './album-personnel.ts'
import { albumNotesKey } from './album-notes.ts'

/** A library row, as much of it as this reads. */
export interface GatherTrack {
  id: number
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  year?: string | number
  genre?: string
  subgenre?: string
  subgenreLean?: string
  trackNumber?: number
  discNumber?: number
  duration?: number
  playCount?: number
  skipCount?: number
  rating?: number
  starredAt?: string | number
  dateAdded?: string
  lastPlayedAt?: number
  bpm?: number
  keyRoot?: string
  keyMode?: string
  source?: string
  addedVia?: string
}

export interface GatherDeps {
  tracks: () => Promise<GatherTrack[]>
  userDataDir: string
  /** homemini's base URL, no trailing slash. */
  hubUrl: string
  fetchImpl?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
  /** Adds the companion header. */
  withAuth?: (init?: RequestInit) => RequestInit | undefined
  /** Press and reference text for an artist (Wikipedia, MusicBrainz, Exa). */
  press?: (artist: string, album?: string) => Promise<string>
  today?: () => string
  now?: () => number
  warn?: (msg: string) => void
}

export const PRESS_WAIT_MS = 3500
export const PRESS_WAIT_HARDER_MS = 9000
export const HUB_WAIT_MS = 2500
const TOP1000_TTL_MS = 10 * 60_000

const low = (s: unknown): string => String(s ?? '').toLowerCase().trim()
const squash = (s: unknown): string => low(s).replace(/[^a-z0-9]+/g, '')

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => { const t = setTimeout(() => resolve(fallback), ms); (t as { unref?: () => void }).unref?.() }),
  ])
}

export interface MusicManGather {
  gather(subject: AskSubject, nowPlayingId?: number | null): Promise<PacketInput | null>
  lookHarder(subject: AskSubject, input: PacketInput): Promise<PacketInput>
}

export function createMusicManGather(deps: GatherDeps): MusicManGather {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))
  const withAuth = deps.withAuth ?? ((init) => init)
  const now = deps.now ?? (() => Date.now())
  const today = deps.today ?? (() => new Date(now()).toISOString().slice(0, 10))
  const warn = deps.warn ?? (() => {})

  /** A JSON file in userData, re-read only when it changed. */
  const files = new Map<string, { mtimeMs: number; value: unknown }>()
  async function json(name: string): Promise<unknown> {
    const path = join(deps.userDataDir, name)
    try {
      const st = await stat(path)
      const had = files.get(name)
      if (had && had.mtimeMs === st.mtimeMs) return had.value
      const value: unknown = JSON.parse(await readFile(path, 'utf-8'))
      files.set(name, { mtimeMs: st.mtimeMs, value })
      return value
    } catch {
      return null // not there yet, or mid-write: absent from the packet
    }
  }
  const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

  let top1000: { at: number; ranks: Map<number, number> } | null = null
  async function ranks(): Promise<Map<number, number>> {
    if (top1000 && now() - top1000.at < TOP1000_TTL_MS) return top1000.ranks
    const got = await within((async () => {
      const res = await fetchImpl(`${deps.hubUrl}/api/top1000`, withAuth({ signal: AbortSignal.timeout(HUB_WAIT_MS) }))
      if (!res.ok) return null
      const list = record(await res.json()).list
      const out = new Map<number, number>()
      if (Array.isArray(list)) for (const row of list) {
        const r = record(row)
        const id = Number(r.id) // homemini sends the id as a string
        if (Number.isInteger(id) && typeof r.rank === 'number' && r.rank <= 1000) out.set(id, r.rank)
      }
      return out
    })(), HUB_WAIT_MS, null)
    if (!got) return top1000?.ranks ?? new Map()
    top1000 = { at: now(), ranks: got }
    return got
  }

  async function profile(name: string, fresh: boolean): Promise<ArtistProfile | null> {
    if (!fresh) {
      const cached = record(await json(join('artist-profiles', profileCacheFile(name))))
      const doc = low(cached.name) === low(name) ? parseArtistProfile(cached.doc) : null
      if (doc) return doc
    }
    // Not on disk (or a fresh look was asked for): homemini has it, or this ask puts the artist on its build list.
    return within((async () => {
      const res = await fetchImpl(`${deps.hubUrl}${artistProfilePath(name)}`, withAuth({ signal: AbortSignal.timeout(HUB_WAIT_MS) }))
      return res.ok ? parseArtistProfile(await res.json()) : null
    })(), HUB_WAIT_MS, null)
  }

  async function artistFacts(name: string, fresh = false): Promise<PacketArtist | null> {
    if (!name) return null
    const [p, membersFile, tagsFile] = await Promise.all([profile(name, fresh), json('artist-members.json'), json('artist-tags.json')])
    const out: PacketArtist = { name }
    if (p) {
      out.oneLiner = p.oneLiner
      out.place = p.origin?.place
      out.since = p.origin?.since
      out.until = p.origin?.until
      if (p.bio) out.bio = [p.bio.lede, p.bio.body].filter(Boolean).join(' ')
      out.facts = p.facts?.map((f) => ({ label: f.label, value: f.value }))
      const people = p.members?.people?.map((m) => `${m.name}${m.roles?.length ? ` (${m.roles.slice(0, 3).join(', ')})` : ''}`)
      if (people?.length) out.members = people
    }
    if (!out.members?.length) {
      const entry = Object.entries(record(membersFile)).find(([k]) => low(k) === low(name))?.[1]
      const members = record(entry).members
      if (Array.isArray(members) && members.length > 1) out.members = members.filter((m): m is string => typeof m === 'string')
    }
    const tags = record(record(tagsFile)[low(name)]).tags
    if (Array.isArray(tags) && tags.length) out.tags = tags.filter((t): t is string => typeof t === 'string')
    const has = out.oneLiner || out.place || out.bio || out.facts?.length || out.members?.length || out.tags?.length
    return has ? out : null
  }

  async function albumFacts(artist: string, album: string, year: string): Promise<PacketAlbum | null> {
    const [credits, personnel, notes] = await Promise.all([json(ALBUM_CREDITS_FILE), json(PERSONNEL_CACHE_FILE), json('album-notes.json')])
    const out: PacketAlbum = {}
    const c = record(record(record(record(credits).entries)[albumCreditsKey(artist, album, year)]).credits)
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    out.label = str(c.label)
    out.released = str(c.released)
    out.producer = str(c.producer)
    const p = record(record(record(personnel).entries)[personnelCacheKey(artist, album)])
    out.label ??= str(p.label)
    out.released ??= str(p.released)
    if (Array.isArray(p.people)) {
      out.people = p.people.slice(0, 10).map((raw) => {
        const person = record(raw)
        const roles = Array.isArray(person.roles) ? person.roles.filter((r): r is string => typeof r === 'string').slice(0, 3) : []
        return `${String(person.name ?? '')}${roles.length ? ` (${roles.join(', ')})` : ''}`
      }).filter((s) => s.trim())
    }
    const blurbs = record(record(notes).blurbs)
    out.history = str(blurbs[albumNotesKey(artist, album, year)]) ?? str(blurbs[albumNotesKey(artist, album)])
    return out.label || out.released || out.producer || out.people?.length || out.history ? out : null
  }

  async function songs(rows: GatherTrack[]): Promise<PacketSong[]> {
    const [descriptors, lists, credits, rank] = await Promise.all([
      json('brain-descriptors.json'), json('ipod-lists-cache.json'), json('friend-credits.json'), ranks(),
    ])
    const d = record(descriptors)
    const ipods = (Array.isArray(record(lists).lists) ? record(lists).lists as unknown[] : []).map((l) => {
      const r = record(l)
      return { name: String(r.name ?? ''), ids: new Set(Array.isArray(r.ids) ? r.ids.filter((i): i is number => typeof i === 'number') : []) }
    }).filter((l) => l.name)
    const friendOf = new Map<string, string>()
    for (const raw of Array.isArray(record(credits).credits) ? record(credits).credits as unknown[] : []) {
      const c = record(raw)
      if (typeof c.friend !== 'string' || !Array.isArray(c.keys)) continue
      for (const k of c.keys) if (typeof k === 'string') friendOf.set(k, c.friend)
    }
    return rows.map((t) => {
      const desc = record(d[String(t.id)])
      const year = t.year ? String(t.year) : undefined
      const sub = [t.subgenre, t.subgenreLean].filter((s) => s && String(s).trim()).join(', ')
      const friend = friendOf.get(`${squash(t.title)}|${squash(t.artist)}`)
      const on = ipods.filter((l) => l.ids.has(t.id)).map((l) => l.name)
      const song: PacketSong = {
        id: t.id,
        title: String(t.title ?? ''),
        artist: String(t.artist ?? ''),
        album: String(t.album ?? ''),
        albumArtist: t.albumArtist || undefined,
        year: year && year !== '0' ? year : undefined,
        genre: t.genre || undefined,
        subgenre: sub || undefined,
        trackNumber: t.trackNumber || undefined,
        durationMs: t.duration || undefined,
        plays: t.playCount ?? 0,
        skips: t.skipCount ?? 0,
        starred: (t.rating ?? 0) >= 5 || !!t.starredAt,
        addedAt: t.dateAdded || undefined,
        lastPlayedAt: t.lastPlayedAt || undefined,
        bpm: typeof t.bpm === 'number' && t.bpm > 0 ? t.bpm : undefined,
        key: t.keyRoot ? `${t.keyRoot} ${t.keyMode ?? ''}`.trim() : undefined,
        from: t.source || undefined,
        sentBy: friend || (t.addedVia ? `a link from ${t.addedVia}` : undefined),
        sound: typeof desc.d === 'string' ? desc.d : undefined,
        mood: typeof desc.m === 'string' ? desc.m : undefined,
        top1000: rank.get(t.id),
        ipods: on.length ? on : undefined,
      }
      return song
    })
  }

  const order = (a: GatherTrack, b: GatherTrack): number =>
    (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0)
  const credited = (t: GatherTrack): string => t.albumArtist || t.artist || ''

  async function pressFor(artist: string, album: string | undefined, ms: number): Promise<string | undefined> {
    if (!deps.press || !artist) return undefined
    const text = await within(deps.press(artist, album), ms, '')
    return text.trim() || undefined
  }

  return {
    async gather(subject, nowPlayingId) {
      const all = await deps.tracks()
      let rows: GatherTrack[] = []
      let artistName = ''
      let albumName = ''
      let year = ''
      let records: PacketInput['records']
      if (subject.kind === 'album') {
        artistName = subject.artist
        albumName = subject.album
        rows = all.filter((t) => low(t.album) === low(albumName) && (low(credited(t)) === low(artistName) || low(t.artist) === low(artistName))).sort(order)
        if (rows.length === 0) rows = all.filter((t) => low(t.album) === low(albumName)).sort(order)
        year = subject.year || String(rows.find((t) => t.year)?.year ?? '')
      } else if (subject.kind === 'artist') {
        artistName = subject.name
        rows = all.filter((t) => low(credited(t)) === low(artistName) || low(t.artist) === low(artistName))
        const byAlbum = new Map<string, { album: string; year?: string; songs: number; plays: number }>()
        for (const t of rows) {
          const k = low(t.album)
          const r = byAlbum.get(k) ?? { album: String(t.album ?? ''), year: t.year ? String(t.year) : undefined, songs: 0, plays: 0 }
          r.songs++
          r.plays += t.playCount ?? 0
          byAlbum.set(k, r)
        }
        const blurbs = record(record(await json('album-notes.json')).blurbs)
        records = [...byAlbum.values()].filter((r) => r.album).sort((a, b) => b.plays - a.plays || b.songs - a.songs).map((r) => {
          // The history the album page shows, when one was written: it often names the people in the band.
          const history = blurbs[albumNotesKey(artistName, r.album, r.year)] ?? blurbs[albumNotesKey(artistName, r.album)]
          return typeof history === 'string' && history.trim() ? { ...r, history: history.trim() } : r
        })
      } else if (subject.kind === 'song') {
        const t = all.find((x) => x.id === subject.trackId)
        if (!t) return null
        rows = [t]
        artistName = credited(t)
        albumName = String(t.album ?? '')
        year = t.year ? String(t.year) : ''
      } else {
        const want = new Map(subject.trackIds.map((id, i) => [id, i]))
        rows = all.filter((t) => want.has(t.id)).sort((a, b) => (want.get(a.id) ?? 0) - (want.get(b.id) ?? 0))
      }
      if (rows.length === 0 && subject.kind !== 'artist') return null

      const np = typeof nowPlayingId === 'number' ? all.find((t) => t.id === nowPlayingId) : undefined
      const [packetSongs, artist, album, playing, press] = await Promise.all([
        songs(rows),
        artistName ? artistFacts(artistName) : Promise.resolve(null),
        albumName ? albumFacts(artistName, albumName, year) : Promise.resolve(null),
        np ? songs([np]) : Promise.resolve([] as PacketSong[]),
        subject.kind === 'list' ? Promise.resolve(undefined) : pressFor(artistName, albumName || undefined, PRESS_WAIT_MS),
      ])
      if (rows.length === 0 && !artist) return null
      return { subject, songs: packetSongs, artist, album, records, nowPlaying: playing[0] ?? null, press, today: today() }
    },

    async lookHarder(subject, input) {
      const artistName = subject.kind === 'album' ? subject.artist : subject.kind === 'artist' ? subject.name : input.songs[0]?.albumArtist || input.songs[0]?.artist || ''
      if (!artistName || subject.kind === 'list') return input
      const albumName = subject.kind === 'album' ? subject.album : subject.kind === 'song' ? input.songs[0]?.album : undefined
      const [artist, press] = await Promise.all([
        artistFacts(artistName, true).catch((err: Error) => { warn(`[musicman-ask] profile for ${artistName}: ${err.message}`); return null }),
        input.press ? Promise.resolve(input.press) : pressFor(artistName, albumName, PRESS_WAIT_HARDER_MS),
      ])
      return { ...input, artist: artist ?? input.artist, press: press ?? input.press }
    },
  }
}
