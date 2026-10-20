/**
 * Which Wikipedia page is an artist's bio (2026-10-20).
 *
 * ⚠️ TWIN: JakeTunesMobile backend/src/util/wikipedia.ts (assessSummary,
 * hasArtistEvidence, searchTitleEligible + the lookup order). The phone fixed
 * this exact bug in Brief 200; the desktop never got the twin, and on 10/20
 * Geese's artist page on both Macs showed the Wikipedia article about the
 * BIRD ("Geese" redirects to "Goose") and Nirvana's showed the Buddhist
 * concept. Change a rule here and change it there (and the reverse) — the
 * fixtures in __tests__/wiki-artist-bio.test.ts are the phone's, verbatim.
 *
 * Three defenses:
 *   a) parenthetical titles first ("Geese (band)") — where Wikipedia keeps
 *      common-noun artists;
 *   b) canonical-title guard — the page returned must BE this artist (name,
 *      name + parenthetical, or the exact title asked for); a redirect to a
 *      different entity (Geese → Goose) is rejected however it reads;
 *   c) artist evidence — the description or first sentence must read like a
 *      musical act; generic words ("group", "ensemble") only count next to a
 *      music qualifier, and a description naming a WORK (album / song / film)
 *      disqualifies the page.
 *
 * Pure — main and the tests share it.
 */

export interface WikiSummaryLike {
  type?: string
  title?: string
  description?: string
  extract?: string
  content_urls?: { desktop?: { page?: string } }
}

export interface ArtistBio { title: string; extract: string; url?: string }

const STRONG_ARTIST =
  /\b(band|musician|musicians|singer|singers|songwriter|songwriters|rapper|rappers|dj|producer|producers|composer|composers|vocalist|vocalists|guitarist|guitarists|duo|trio|quartet|quintet|orchestra|choir)\b/i
const NOT_ARTIST = /\b(album|song|single|ep|mixtape|soundtrack|film|tour|concert)\b/i
const GENERIC_ARTIST_WORDS = new Set(['group', 'ensemble', 'collective', 'act', 'artist'])
const MUSIC_QUALIFIERS = new Set([
  'music', 'musical', 'rock', 'pop', 'jazz', 'folk', 'country', 'metal', 'punk', 'electronic',
  'dance', 'girl', 'boy', 'hip', 'hop', 'vocal', 'recording', 'performing',
])

export function hasArtistEvidence(text: string): boolean {
  if (STRONG_ARTIST.test(text)) return true
  const words = text.toLowerCase().match(/[a-z][a-z-]*/g) ?? []
  for (let i = 0; i < words.length; i++) {
    if (!GENERIC_ARTIST_WORDS.has(words[i]!)) continue
    const window = words.slice(Math.max(0, i - 3), i)
    if (window.some((w) => MUSIC_QUALIFIERS.has(w))) return true
  }
  return false
}

function normTitle(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ')
}

/** One REST summary vs the artist it was fetched for: the bio, or null. */
export function assessSummary(artistName: string, queriedTitle: string, sum: WikiSummaryLike | null | undefined): ArtistBio | null {
  if (!sum || typeof sum !== 'object') return null
  if (sum.type === 'disambiguation') return null
  const extract = typeof sum.extract === 'string' ? sum.extract.trim() : ''
  if (!extract) return null
  const title = typeof sum.title === 'string' ? sum.title : queriedTitle

  const returned = normTitle(title)
  const artist = normTitle(artistName)
  const titleOk = returned === artist || returned === normTitle(queriedTitle) || returned.startsWith(artist + ' (')
  if (!titleOk) return null

  const description = typeof sum.description === 'string' ? sum.description : ''
  const firstSentence = extract.split(/(?<=[.!?])\s/)[0] ?? extract
  const probe = `${description} ${extract.slice(0, 180)}`
  if (NOT_ARTIST.test(probe) && !hasArtistEvidence(probe)) return null
  if (NOT_ARTIST.test(description) && !hasArtistEvidence(description)) return null
  if (!hasArtistEvidence(description) && !hasArtistEvidence(firstSentence)) return null

  return { title, extract, url: sum.content_urls?.desktop?.page }
}

/** A search hit is eligible only when titled as this artist (Dan Gilroy regression). */
export function searchTitleEligible(title: string, name: string): boolean {
  const t = normTitle(title)
  const n = normTitle(name)
  return t === n || t.startsWith(n + ' (')
}

/**
 * Titles to try, in order: MusicBrainz's own Wikipedia link when it has one,
 * then the parentheticals (band / musician, plus rapper / DJ / singer /
 * composer when MusicBrainz's tags say so), then the bare name LAST. Every
 * one is still checked by assessSummary.
 */
export function bioTitleCandidates(name: string, canon?: { wikiTitle?: string | null; type?: string; tags?: string[] } | null): string[] {
  const n = name.trim()
  const out: string[] = []
  if (canon?.wikiTitle) out.push(canon.wikiTitle)
  const tags = (canon?.tags ?? []).join(' ')
  if (/\brap|hip[- ]?hop|trap\b/.test(tags)) out.push(`${n} (rapper)`)
  out.push(`${n} (band)`, `${n} (musician)`)
  if (/\belectronic|techno|house|dance|edm\b/.test(tags)) out.push(`${n} (DJ)`)
  if (canon?.type === 'Person') out.push(`${n} (singer)`)
  if (/\bclassical|opera|orchestra\b/.test(tags)) out.push(`${n} (composer)`)
  out.push(n)
  const seen = new Set<string>()
  return out.filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
}
