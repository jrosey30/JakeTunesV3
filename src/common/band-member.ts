// ⚠️ TWIN: JakeTunesMobile backend/src/util/bandMember.ts. Byte-identical apart from
// this comment. Change both, so a record's sleeve reads the same on the desktop and the phone.
/**
 * Is this person in the band, under whatever name the sleeve credits them?
 *
 * The band list comes from MusicBrainz's artist names (artist-members.json); a sleeve
 * credits people its own way. Nevermind says "David Grohl" and "Chris Novoselic", the
 * list says Dave and Krist, and an exact match made them guests on their own record.
 * Audited on every album in the library (2026-11-05):
 *
 *   SAME LETTERS   "D.J. Homicide" / "DJ Homicide", "Slim Kid 3" / "SLIMKID3",
 *                  "Jack White III" / "Jack White"
 *   PART OF IT     "Axl" / "Axl Rose", "David Roth" / "David Lee Roth",
 *                  "Mark “Fish Guts” Hoppus" / "Mark Hoppus",
 *                  "Donald (Buck Dharma) Roeser" / "Buck Dharma"
 *   SAME SURNAME   with a first name that is the same one: "Philip" / "Phil",
 *                  "Chris" / "Krist", "William" / "Billy", "Marty" / "Martin", "Graham" / "Graeham",
 *                  "A. Hughes" / "Andy Hughes"
 *
 * A shared surname alone proves nothing, and neither does playing on the whole record:
 * Hollie Fallon sings across The '59 Sound and is not Brian; Jan Van Halen plays clarinet
 * and is Eddie's father; Magdalena Bay's strings are on every track. So first names that
 * don't relate need both a matching first letter and half the record: "Diamond" /
 * "Dimebag" passes, Jackie Johnson and Scott Borland don't.
 *
 * A one-word member inside a longer credit ("Rostam Batmanglij", "Cheryl "Salt" James")
 * counts when it's quoted or the person is on half the record. Who can't be told apart
 * by name ("Count SA" for S.A. Martinez, "David Evans" for The Edge) stays a guest: a
 * guest who was really in the band is a smaller lie than a stranger called a member.
 *
 * LEAF MODULE: no imports. nameKey and the production test are injected.
 */

export interface CreditedPerson {
  name: string
  roles: readonly string[]
  tracks: number
  credits?: ReadonlyArray<{ role: string; tracks: readonly number[] }>
}

export interface BandContext {
  artist: string
  members: readonly string[]
  trackCount: number
}

export interface BandMemberRules {
  nameKey: (s: string) => string
  isProductionCredit: (role: string) => boolean
}

const HALF_THE_RECORD = 0.5
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv'])
const TITLES = new Set(['the', 'dr', 'dj', 'mc', 'mr', 'mrs', 'ms', 'sir'])
/** Not one person: "Grandmaster Melle Mel & The Furious Five", "John Bonham Drum Orchestra". */
const NOT_A_PERSON = /&|\b(?:and|with|orchestra|ensemble|choir|strings|singers|quartet|horns|band)\b/i
/** Quoted or bracketed parts of a credit: "Terry “Geezer” Butler", "Donald (Buck Dharma) Roeser". */
const SET_APART = /["“”]([^"“”]+)["“”]|\(([^)]+)\)|(?:^|\s)['‘’]([^'‘’]+)['‘’](?=\s|$)/g
/** What a longer name adds when it is someone else: Jan and Jane, Chris and Christine, Eric and Erica. */
const ANOTHER_NAME = /^(?:a|e|ia|ie|ina|ine|ette|elle|ela|ella|ene|ena|ara|et|ice|tine|tina|ielle|iela|andra|antha|ricia)$/

/** Names a prefix can't connect. */
const SAME_NAME: ReadonlyArray<readonly string[]> = [
  ['michael', 'mike', 'mikey', 'mick', 'mickey'],
  ['william', 'bill', 'billy', 'will', 'willie'],
  ['robert', 'rob', 'robbie', 'bob', 'bobby'],
  ['richard', 'rick', 'ricky', 'ric', 'rich', 'richie', 'dick'],
  ['david', 'dave', 'davey', 'davy'],
  ['james', 'jim', 'jimmy', 'jimmie', 'jamie'],
  ['john', 'jon', 'johnny', 'jonny'],
  ['nicholas', 'nicolas', 'nick', 'nicky', 'nic'],
  ['christopher', 'chris', 'kris', 'krist'],
  ['edward', 'ed', 'eddie', 'eddy', 'ted', 'teddy'],
  ['anthony', 'tony'],
  ['charles', 'charlie', 'chuck'],
  ['stephen', 'steven', 'steve', 'stevie'],
  ['andrew', 'andy', 'drew'],
  ['jeffrey', 'jefferson', 'geoffrey', 'jeff', 'geoff'],
  ['matthew', 'matt', 'matty'],
  ['philip', 'phillip', 'phil'],
  ['lawrence', 'laurence', 'larry'],
  ['joseph', 'joe', 'joey'],
  ['thomas', 'tom', 'tommy'],
  ['daniel', 'dan', 'danny'],
  ['gregory', 'greg'],
  ['deborah', 'debra', 'debbie'],
  ['elizabeth', 'liz', 'lizzy', 'beth'],
  ['katherine', 'catherine', 'kate', 'katie', 'cathy', 'kathy'],
]

interface ParsedName {
  /** The name's words, without what's set apart or a suffix. */
  words: string[]
  /** Those plus what's set apart. */
  all: Set<string>
  /** The set-apart parts, each as its words. */
  apart: string[][]
  squashed: string
}

function parse(name: string, nameKey: (s: string) => string): ParsedName {
  const apart: string[][] = []
  const rest = name.replace(SET_APART, (_, a?: string, b?: string, c?: string) => {
    apart.push(nameKey(a ?? b ?? c ?? '').split(' ').filter(Boolean))
    return ' '
  })
  const clean = (s: string): string[] => nameKey(s).split(' ').filter((w) => w && !SUFFIXES.has(w))
  const words = clean(rest)
  return { words, apart, all: new Set([...words, ...apart.flat()]), squashed: clean(name).join('') }
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[b.length]!
}

const nearSpelling = (a: string, b: string): boolean => Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 1

/** One first name, written two ways. */
function sameFirstName(a: string, b: string): boolean {
  if (a === b) return true
  if (SAME_NAME.some((names) => names.includes(a) && names.includes(b))) return true
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  // "A. Hughes" / "Andy Hughes".
  if (short.length === 1) return long.startsWith(short)
  if (short.length >= 3 && long.startsWith(short)) return !ANOTHER_NAME.test(long.slice(short.length))
  // "Marty" / "Martin", "Shanny" / "Shannon": the same name, ended two ways.
  let shared = 0
  while (shared < short.length && short[shared] === long[shared]) shared++
  if (shared >= 4 && long.length - shared <= 3) return true
  return nearSpelling(a, b)
}

/** "Kristoffer" sounds like "Christopher". */
function firstLetter(name: string): string {
  if (name.startsWith('ph')) return 'f'
  return name[0] === 'k' ? 'c' : (name[0] ?? '')
}

/** How much of the record they play on: 1 for a credit on the release, null for production only. */
function shareOfRecord(person: CreditedPerson, trackCount: number, isProduction: (role: string) => boolean): number | null {
  const credits = person.credits ?? []
  if (credits.length > 0) {
    const playing = credits.filter((c) => !isProduction(c.role))
    if (playing.length === 0) return null
    if (playing.some((c) => c.tracks.length === 0)) return 1
    return trackCount > 0 ? new Set(playing.flatMap((c) => c.tracks)).size / trackCount : 0
  }
  if (person.roles.length > 0 && person.roles.every(isProduction)) return null
  if (person.tracks === 0) return 1
  return trackCount > 0 ? person.tracks / trackCount : 0
}

const personWords = (words: readonly string[]): string[] => {
  const kept = words.filter((w) => !TITLES.has(w))
  return kept.length > 0 ? kept : [...words]
}

function isSamePerson(credited: ParsedName, member: ParsedName, share: number): boolean {
  if (credited.squashed === member.squashed) return true
  if (credited.words.length === 0 || member.words.length === 0) return false

  // The credit is part of the member's name: "Axl", "David Roth", "Billie Joe".
  const known = personWords(credited.words)
  if (known.every((w) => w.length >= 2 && member.all.has(w))) return true

  // The member's name is part of the credit.
  const memberWords = personWords(member.words)
  if (memberWords.every((w) => credited.all.has(w))) {
    if (memberWords.length === 1) {
      const quoted = credited.apart.some((part) => part.includes(memberWords[0]!))
      return quoted || share >= HALF_THE_RECORD
    }
    if (credited.apart.some((part) => memberWords.every((w) => part.includes(w)))) return true
    return credited.words.at(-1) === member.words.at(-1)
  }

  // The same surname and one first name, written two ways.
  if (known.length < 2 || memberWords.length < 2) return false
  const [first, last] = [known[0]!, known.at(-1)!]
  const [memberFirst, memberLast] = [memberWords[0]!, memberWords.at(-1)!]
  if (first === memberFirst && last !== memberLast && nearSpelling(last, memberLast)) return true
  if (last !== memberLast) return false
  if (sameFirstName(first, memberFirst)) return true
  return firstLetter(first) === firstLetter(memberFirst) && share >= HALF_THE_RECORD
}

export function isBandMember(person: CreditedPerson, band: BandContext, rules: BandMemberRules): boolean {
  const exact = rules.nameKey(person.name)
  if (!exact) return false
  if (exact === rules.nameKey(band.artist)) return true
  if (band.members.some((m) => rules.nameKey(m) === exact)) return true
  if (NOT_A_PERSON.test(person.name)) return false

  const share = shareOfRecord(person, band.trackCount, rules.isProductionCredit)
  if (share === null) return false
  const credited = parse(person.name, rules.nameKey)
  // A solo artist's other spellings. A band's name never makes a member: Jan Van Halen.
  const names = band.members.length > 0 ? band.members : [band.artist]
  return names.some((m) => isSamePerson(credited, parse(m, rules.nameKey), share))
}
