/**
 * Artist profile (2026-10-20) — the document homemini builds for one artist,
 * and the shapes the desktop's main process and artist page pass around.
 *
 * Jake, on the old artist pages: "horrific. Amateur hour. Bios loading late
 * and often wrong." homemini now pre-builds each profile (grounded bio, facts,
 * members with face-cropped photos) and serves it instantly:
 *
 *   GET  {MOBILE_BACKEND_URL}/api/artist/:name/profile
 *        → 200 ArtistProfile (ETag; If-None-Match → 304) | 404 not built yet
 *   GET  {MOBILE_BACKEND_URL}/api/artist-photo/:file
 *        → a cropped 900×900 JPEG; immutable, so a client caches it forever
 *   PUT  {MOBILE_BACKEND_URL}/api/artist/:name/members/:member/photo
 *        → Jake's own photo of a member (memberPhotoPath below)
 *
 * On a 404, or with homemini away and nothing cached, the page falls back to
 * the validated Wikipedia summary it showed before, with no members.
 *
 * ⚠️ TWIN: JakeTunesMobile backend — the profile builder and its routes
 * (Brief "artist profile", feat/artist-profile-builder). The contract text is
 * the shared spec; keep the field names byte-for-byte in step.
 *
 * Pure and import-free — main, preload and renderer share it.
 */

export const ARTIST_PROFILE_VERSION = 1

export type ArtistKind = 'person' | 'group' | 'other'
/** Where a photo came from. 'unknown' is this client's catch-all for a source a
 *  newer builder adds — read leniently, never a reason to drop the photo. */
export type MemberPhotoSource = 'jake' | 'commons' | 'wikidata' | 'discogs' | 'deezer' | 'library' | 'unknown'

export interface ArtistProfilePhoto {
  /** "/api/artist-photo/<file>" on homemini. */
  url: string
  credit?: string
  source: MemberPhotoSource
  faceScore?: number
}

export interface ArtistProfileMember {
  name: string
  legalName?: string
  roles: string[]
  years?: string
  mbid?: string
  /** Exact library artist name when this member is also an artist in Jake's library. */
  libraryArtist?: string
  photo?: ArtistProfilePhoto
  /** No photo passed Jake's bar (contract addition 10/20): the tile keeps its
   *  initials and shows the "Set photo" drop target plainly so he can fill it. */
  needsPhoto?: boolean
}

export interface ArtistProfileFact { label: string; value: string; url?: string }

export interface ArtistProfile {
  version: 1
  name: string
  mbid?: string
  kind: ArtistKind
  oneLiner?: string
  /** `until` (contract addition 10/20): the year an act ended — the eyebrow
   *  then reads "1987–1994" instead of "Since 1987". */
  origin?: { place: string; since?: string; until?: string }
  /** The app's existing artist-image slug. */
  heroPhoto?: string
  /** A credited header photo the builder chose when the app's own image failed
   *  its photo gates (contract addition 10/20). Preferred over heroPhoto; not
   *  square — the header's own aspect. */
  hero?: ArtistProfilePhoto
  /** No header photo shows the right line-up (contract addition 10/21 — e.g.
   *  Sublime's own image is the 2023 band with Jakob Nowell): never show the
   *  app's artist image; the header takes the most played record's cover. */
  heroNeedsPhoto?: boolean
  bio?: {
    lede: string
    body: string
    sources: Array<{ label: string; url: string }>
    checkedAt: string
  }
  facts: ArtistProfileFact[]
  legalName?: string
  members?: {
    mode: 'current' | 'classic'
    era?: string
    people: ArtistProfileMember[]
    photoCredit?: string
  }
  updatedAt: string
}

/**
 * What the artist page draws, as main hands it over.
 *  - 'homemini' — confirmed by homemini during this session
 *  - 'cache'    — the copy on disk, not yet confirmed (homemini away, or not asked yet)
 *  - 'missing'  — homemini answered 404: no profile for this artist (yet)
 *  - 'none'     — nothing on disk and no answer from homemini
 * `photos` maps a member photo's url to the local artist-image:// slug it was
 * saved under; a photo still downloading (or failed) is simply absent.
 */
export type ArtistProfileSource = 'homemini' | 'cache' | 'missing' | 'none'

export interface ArtistProfileState {
  name: string
  profile: ArtistProfile | null
  source: ArtistProfileSource
  photos: Record<string, string>
  fetchedAt: number | null
}

export function emptyProfileState(name: string, source: ArtistProfileSource = 'none'): ArtistProfileState {
  return { name, profile: null, source, photos: {}, fetchedAt: null }
}

export function artistProfilePath(name: string): string {
  return `/api/artist/${encodeURIComponent(name)}/profile`
}

export const ARTIST_PHOTO_PREFIX = '/api/artist-photo/'

/**
 * The bare file name of a homemini artist photo, or null when the url is not
 * one. Accepts "/api/artist-photo/x.jpg" or an absolute URL with that path —
 * but only the FILE survives, so a client always fetches from its own
 * configured homemini, never from a host a document names.
 */
export function artistPhotoFileOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null
  let path = url
  const abs = /^https?:\/\/[^/]+(\/.*)$/i.exec(url)
  if (abs) path = abs[1]
  path = path.split(/[?#]/)[0]
  if (!path.startsWith(ARTIST_PHOTO_PREFIX)) return null
  let file = path.slice(ARTIST_PHOTO_PREFIX.length)
  try { file = decodeURIComponent(file) } catch { return null }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(file) && !file.includes('..') ? file : null
}

/** 32-bit FNV-1a, hex — a stable, dependency-free tag for cache names. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * The artist-image:// slug a homemini photo is saved under on this Mac. The
 * artist-image protocol keeps only [a-z0-9-], so the file name is folded to
 * that and tagged with a hash of the exact name: two files can never share a
 * slug, and no artist's own photo slug (artistSlug) starts with "ap-…-<hash>".
 */
export function photoCacheSlug(file: string): string {
  const base = file.toLowerCase().replace(/\.(jpe?g|png|webp)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `ap-${base || 'photo'}-${fnv1a(file)}`
}

/** One file per artist in the profile cache: readable, collision-free. */
export function profileCacheFile(name: string): string {
  const base = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${base || 'artist'}-${fnv1a(String(name || '').trim().toLowerCase())}.json`
}

const str = (v: unknown, max = 4000): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

const safeUrl = (v: unknown): string | undefined => {
  const s = str(v, 2000)
  return s && /^https?:\/\//i.test(s) ? s : undefined
}

function parsePhoto(v: unknown): ArtistProfilePhoto | undefined {
  if (!v || typeof v !== 'object') return undefined
  const p = v as Record<string, unknown>
  const url = str(p.url, 400)
  if (!url || !artistPhotoFileOf(url)) return undefined
  const sources: MemberPhotoSource[] = ['jake', 'commons', 'wikidata', 'discogs', 'deezer', 'library']
  const source = sources.includes(p.source as MemberPhotoSource) ? p.source as MemberPhotoSource : 'unknown'
  const out: ArtistProfilePhoto = { url, source }
  const credit = str(p.credit, 300)
  if (credit) out.credit = credit
  if (typeof p.faceScore === 'number' && Number.isFinite(p.faceScore)) out.faceScore = p.faceScore
  return out
}

function parseMember(v: unknown): ArtistProfileMember | null {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  const name = str(m.name, 200)
  if (!name) return null
  const roles = Array.isArray(m.roles) ? m.roles.map((r) => str(r, 80)).filter((r): r is string => !!r).slice(0, 12) : []
  const out: ArtistProfileMember = { name, roles }
  const legalName = str(m.legalName, 200)
  if (legalName && legalName !== name) out.legalName = legalName
  const years = str(m.years, 60)
  if (years) out.years = years
  const mbid = str(m.mbid, 64)
  if (mbid) out.mbid = mbid
  const libraryArtist = str(m.libraryArtist, 300)
  if (libraryArtist) out.libraryArtist = libraryArtist
  const photo = parsePhoto(m.photo)
  if (photo) out.photo = photo
  if (m.needsPhoto === true) out.needsPhoto = true
  return out
}

/**
 * The route's body → a profile, or null when it isn't one (wrong version,
 * an HTML error page from a proxy, torn JSON). Bad members / facts / sources
 * are dropped one by one rather than sinking the whole document.
 */
export function parseArtistProfile(body: unknown): ArtistProfile | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (b.version !== ARTIST_PROFILE_VERSION) return null
  const name = str(b.name, 300)
  if (!name) return null
  const kind: ArtistKind = b.kind === 'person' || b.kind === 'group' ? b.kind : 'other'
  const out: ArtistProfile = { version: 1, name, kind, facts: [], updatedAt: str(b.updatedAt, 40) ?? '' }
  const mbid = str(b.mbid, 64)
  if (mbid) out.mbid = mbid
  const oneLiner = str(b.oneLiner, 400)
  if (oneLiner) out.oneLiner = oneLiner
  if (b.origin && typeof b.origin === 'object') {
    const o = b.origin as Record<string, unknown>
    const place = str(o.place, 200)
    if (place) {
      out.origin = { place }
      const since = str(o.since, 20)
      const until = str(o.until, 20)
      if (since) out.origin.since = since
      if (until) out.origin.until = until
    }
  }
  const hero = str(b.heroPhoto, 120)
  if (hero && /^[a-z0-9-]+$/.test(hero)) out.heroPhoto = hero
  const credited = parsePhoto(b.hero)
  if (credited) out.hero = credited
  if (b.heroNeedsPhoto === true) out.heroNeedsPhoto = true
  if (b.bio && typeof b.bio === 'object') {
    const bio = b.bio as Record<string, unknown>
    const lede = str(bio.lede, 600)
    const bodyText = str(bio.body, 4000)
    if (lede || bodyText) {
      const sources = Array.isArray(bio.sources)
        ? bio.sources.map((s) => {
          if (!s || typeof s !== 'object') return null
          const label = str((s as Record<string, unknown>).label, 80)
          const url = safeUrl((s as Record<string, unknown>).url)
          return label && url ? { label, url } : null
        }).filter((s): s is { label: string; url: string } => !!s).slice(0, 8)
        : []
      out.bio = { lede: lede ?? '', body: bodyText ?? '', sources, checkedAt: str(bio.checkedAt, 40) ?? '' }
    }
  }
  if (Array.isArray(b.facts)) {
    for (const f of b.facts) {
      if (!f || typeof f !== 'object') continue
      const label = str((f as Record<string, unknown>).label, 60)
      const value = str((f as Record<string, unknown>).value, 400)
      if (!label || !value) continue
      const url = safeUrl((f as Record<string, unknown>).url)
      out.facts.push(url ? { label, value, url } : { label, value })
      if (out.facts.length >= 12) break
    }
  }
  const legalName = str(b.legalName, 200)
  if (legalName && legalName !== name) out.legalName = legalName
  if (b.members && typeof b.members === 'object') {
    const m = b.members as Record<string, unknown>
    const people = Array.isArray(m.people) ? m.people.map(parseMember).filter((p): p is ArtistProfileMember => !!p).slice(0, 24) : []
    if (people.length > 0) {
      out.members = { mode: m.mode === 'classic' ? 'classic' : 'current', people }
      const era = str(m.era, 60)
      if (era) out.members.era = era
      const credit = str(m.photoCredit, 600)
      if (credit) out.members.photoCredit = credit
    }
  }
  return out
}

/** Every member photo url in a profile, in member order. */
export function memberPhotoUrls(p: ArtistProfile | null | undefined): string[] {
  const out: string[] = []
  for (const m of p?.members?.people ?? []) if (m.photo?.url && !out.includes(m.photo.url)) out.push(m.photo.url)
  return out
}

/** Every photo a profile draws from homemini: the header photo, then the members'.
 *  A 'library' hero is the app's own artist image re-framed for the wide header
 *  (common/artist-page.ts headerPhotoChoice), a file of its own, so it is drawn too. */
export function profilePhotoUrls(p: ArtistProfile | null | undefined): string[] {
  const out = memberPhotoUrls(p)
  if (p?.hero?.url && !out.includes(p.hero.url)) out.unshift(p.hero.url)
  return out
}

// ── Jake's member-photo override ──────────────────────────────────────────

/**
 * PUT {MOBILE_BACKEND_URL}/api/artist/:name/members/:member/photo
 * Content-Type: image/jpeg (+ the companion header when configured)
 * Body: the picture's bytes.
 *
 * The desktop sends the picture Jake dropped or chose, normalized to JPEG
 * with its long side at most 1800 px. homemini face-crops it to 900×900,
 * stores it as that member's override (source 'jake' — "Jake's own pick
 * always wins"), names the file by its content (photos are immutable and
 * cached forever), and applies it on the next profile read, so the profile's
 * ETag changes. Reply: 200 { ok: true, photo }; 4xx/5xx { ok: false, error }.
 * DELETE on the same path goes back to the built photo (not used by the page).
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/routes/artistProfile.ts (the route).
 */
export function memberPhotoPath(artist: string, member: string): string {
  return `/api/artist/${encodeURIComponent(artist)}/members/${encodeURIComponent(member)}/photo`
}
