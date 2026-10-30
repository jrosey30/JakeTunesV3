/**
 * Personnel the way a sleeve prints it (Jake 2026-10-30, on Abbey Road's
 * run-on paragraph: "this is no way to list personnel"): one line per person,
 * the band first, then guests, then the producer and engineers; each person's
 * parts summarised to the few that matter — "lead vocals, guitars, bass,
 * keyboards", not "background vocals, electric bass guitar, lead vocals,
 * piano, handclaps, moog, tubular bells, electric guitar, acoustic guitar".
 *
 * And which tracks (Jake, same day: "i want to know which personnel sings on
 * which tracks and does other stuff on certain tracks … wikipedia even does
 * this well"): a part that is not the person's job across the record carries
 * its track numbers — "drums, lead vocals (5, 15), percussion (1, 3, 6,
 * 9–13)" for Ringo; a part on (nearly) every track prints bare.
 *
 * Pure: MusicBrainz role labels in (lowercase, deduped, most frequent first,
 * see main/album-personnel.ts), display lines out. Used by the album page.
 */

export interface PersonnelCredit { role: string; tracks: readonly number[] }

export interface PersonnelPerson {
  name: string
  roles: string[]
  tracks: number
  /** Each role's track numbers (1-based; [] = credited on the release as a
   *  whole). Absent on data from before per-track credits: parts print bare. */
  credits?: readonly PersonnelCredit[]
  /** A member of the album's artist (artist-members.json), or the artist. */
  member?: boolean
}

export type PersonnelGroup = 'band' | 'guest' | 'production'

export interface PersonnelLine {
  name: string
  group: PersonnelGroup
  /** The parts shown, at most ROLES_SHOWN, each with its track numbers when
   *  it does not cover the record: "lead vocals (5, 15)". */
  roles: string[]
  /** Every credit for the tooltip, un-merged ("hammond organ (2, 6), organ
   *  (6)") and numbered unless on every track, in the same order. */
  allRoles: string[]
}

export const ROLES_SHOWN = 4

/**
 * A part on at least this share of the record prints bare — it is the
 * person's job on the album, and the odd track without it is not news. The
 * brief said 90 % ("every track but one"); on Abbey Road that prints
 * "drums (1–7, 9–16)" for Ringo, because Because and Her Majesty have no
 * drums. Two thirds keeps the band's own parts bare (Ringo's drums on 15 of
 * 17, Paul's bass on 12) and numbers what is really per-song (lead vocals:
 * Paul 10, John 7, George 5, Ringo 2 of 17).
 */
export const WHOLE_RECORD_SHARE = 2 / 3

/** "1–4, 7, 11": ascending, runs of three or more collapsed. */
export function formatTrackList(tracks: readonly number[]): string {
  const sorted = [...new Set(tracks)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j - i >= 2 ? `${sorted[i]}–${sorted[j]}` : j === i ? `${sorted[i]}` : `${sorted[i]}, ${sorted[j]}`)
    i = j + 1
  }
  return parts.join(', ')
}

/** The part's track numbers, when they are worth printing. */
type Coverage = { on: Set<number>; whole: boolean; known: boolean }

const noCoverage = (): Coverage => ({ on: new Set(), whole: false, known: false })
const addCoverage = (into: Coverage, c: Coverage): void => {
  if (!c.known) return
  into.known = true
  if (c.whole) into.whole = true
  for (const n of c.on) into.on.add(n)
}
/** `(1–4, 7)` after the label when the part does not cover `share` of the record; bare otherwise. */
function withTracks(label: string, c: Coverage, trackCount: number, share: number): string {
  if (!c.known || c.whole || !c.on.size || !trackCount) return label
  if (c.on.size / trackCount >= share) return label
  return `${label} (${formatTrackList([...c.on])})`
}

/** Families, in the order a sleeve lists them. */
const FAMILIES = [
  'vocals', 'guitar', 'bass', 'drums', 'keyboards', 'percussion', 'strings', 'horns', 'other',
  'producer', 'executive producer', 'conductor', 'arranger', 'engineer', 'mixing', 'mastering', 'programming', 'remix',
] as const
type Family = (typeof FAMILIES)[number]
const PRODUCTION: ReadonlySet<Family> = new Set(['producer', 'executive producer', 'conductor', 'arranger', 'engineer', 'mixing', 'mastering', 'programming', 'remix'])

/** Credits that are noise on a sleeve line. */
const NOISE = new Set(['handclaps', 'claps', 'clapping', 'finger snaps', 'snaps', 'foot stomps', 'stomps', 'effects', 'sound effects', 'samples', 'sampler', 'other', 'unknown', 'performer', 'instruments', 'other vocals', 'spoken vocals', 'whistling'])

function family(role: string): { family: Family; label: string } | null {
  const r = role.toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
  if (!r || NOISE.has(r)) return null
  // production first: "recording engineer" must not match "recording" as an instrument
  if (/^(co-)?producer$|^production$/.test(r)) return { family: 'producer', label: 'producer' }
  if (/^executive producer$/.test(r)) return { family: 'executive producer', label: 'executive producer' }
  if (/^conductor$/.test(r)) return { family: 'conductor', label: 'conductor' }
  if (/^arrange(r|ment|ments)$|^(string|horn|vocal|orchestral) arrange(r|ments?)$/.test(r)) return { family: 'arranger', label: 'arranger' }
  if (/engineer|^recording$|^recorded by$|^engineering$/.test(r)) return { family: 'engineer', label: 'engineer' }
  if (/^mix(ing|er|ed by)?$/.test(r)) return { family: 'mixing', label: 'mixing' }
  if (/^mastering$|^mastered by$/.test(r)) return { family: 'mastering', label: 'mastering' }
  if (/^programming$|^drum programming$|^programmer$/.test(r)) return { family: 'programming', label: 'programming' }
  if (/^remix(er|ing)?$/.test(r)) return { family: 'remix', label: 'remix' }
  if (/vocal|^voice$|^singer$|^rap$|^rapping$|^choir$|^chorus$/.test(r)) return { family: 'vocals', label: /lead/.test(r) ? 'lead vocals' : 'vocals' }
  if (/bass/.test(r) && !/bass drum|bassoon/.test(r)) return { family: 'bass', label: /double|upright|acoustic bass$|contrabass/.test(r) ? 'double bass' : 'bass' }
  if (/guitar|^dobro$|^lap steel$|^pedal steel$/.test(r)) return { family: 'guitar', label: r.replace(/^electric guitar$/, 'electric guitar') }
  if (/^drums?$|drum set|drum kit|drum machine|^drum(s)? \(.*\)$/.test(r)) return { family: 'drums', label: 'drums' }
  if (/percussion|tambourine|maracas|congas?|bongos?|shaker|cowbell|anvil|timbales|cabasa|triangle|wood ?block|vibraslap|güiro|guiro|claves?|tabla|djembe|cajón|cajon|bells|chimes|glockenspiel|cymbal|gong|timpani|vibraphone|marimba|xylophone/.test(r)) return { family: 'percussion', label: 'percussion' }
  if (/piano|organ|harpsichord|synth|moog|mellotron|keyboard|clavinet|celesta|celeste|rhodes|wurlitzer|harmonium|accordion|keys$/.test(r)) {
    return { family: 'keyboards', label: /organ/.test(r) ? 'organ' : /synth|moog/.test(r) ? 'synthesizer' : /piano/.test(r) ? (/electric/.test(r) ? 'electric piano' : 'piano') : r }
  }
  if (/violin|viola|cello|^strings?$|string section|fiddle|harp$|^harp |double bass/.test(r)) return { family: 'strings', label: r }
  if (/saxophone|^sax$|trumpet|trombone|horn|tuba|flugelhorn|cornet|clarinet|flute|oboe|bassoon|brass|woodwind/.test(r)) return { family: 'horns', label: r }
  return { family: 'other', label: r }
}

const PLURAL_LABEL: Partial<Record<Family, string>> = { guitar: 'guitars', keyboards: 'keyboards' }

export interface SummarizeOptions {
  productionFirst?: boolean
  /** Each role's track numbers (main/album-personnel.ts `credits`). */
  credits?: readonly PersonnelCredit[]
  /** The record's track total — what "on every track" is measured against. */
  trackCount?: number
}

/** The part a tooltip or shown entry names, without its track numbers. */
export const partOf = (entry: string): string => entry.replace(/\s\([\d,\s–]+\)$/, '')

/**
 * A person's parts, summarised: credits merge into families (electric +
 * acoustic + 12 string guitar → "guitars"; piano + Moog → "keyboards"; maracas
 * + tambourine → "percussion"), noise (handclaps, effects) goes, and the
 * families come out in sleeve order — except that the person's main credit
 * (the first, most frequent one) leads, so a drummer who sang a song reads
 * "drums, lead vocals, percussion", not "lead vocals, drums, percussion".
 *
 * With `credits` and `trackCount`, each shown part carries the track numbers
 * of the credits merged into it when they do not cover WHOLE_RECORD_SHARE of
 * the record ("guitars (16, 17)", "lead vocals (5, 15)"); the lead-vocals
 * part counts only the lead-vocal credits, so a drummer's two songs do not
 * hide behind his background vocals. `all` (the tooltip) keeps every credit
 * un-merged, numbered unless it is on every track.
 */
export function summarizeRoles(roles: readonly string[], opts: SummarizeOptions = {}): { shown: string[]; all: string[] } {
  const trackCount = opts.trackCount ?? 0
  const creditTracks = new Map<string, readonly number[]>()
  for (const c of opts.credits ?? []) creditTracks.set(c.role, c.tracks)
  const coverageOf = (role: string): Coverage => {
    const on = creditTracks.get(role)
    if (!on) return noCoverage()
    return { on: new Set(on), whole: on.length === 0, known: true }
  }
  // labels: the family's normalized parts ("bass" for electric bass guitar),
  // merged for the line; raw: the credits as MusicBrainz names them, for the tooltip.
  type FamilyAcc = { labels: Map<string, Coverage>; raw: Array<{ role: string; label: string; c: Coverage }>; first: number }
  const byFamily = new Map<Family, FamilyAcc>()
  roles.forEach((role, i) => {
    const f = family(role)
    if (!f) return
    let cur = byFamily.get(f.family)
    if (!cur) { cur = { labels: new Map(), raw: [], first: i }; byFamily.set(f.family, cur) }
    const own = coverageOf(role)
    const c = cur.labels.get(f.label) ?? noCoverage()
    addCoverage(c, own)
    cur.labels.set(f.label, c)
    cur.raw.push({ role: role.toLowerCase().replace(/\s+/g, ' ').trim(), label: f.label, c: own })
  })
  if (!byFamily.size) return { shown: [], all: [] }
  // The main credit (first = most frequent) leads — among the parts played;
  // production credits keep the sleeve's order, and lead only for the
  // production group ("producer, conductor, keyboards" for George Martin).
  const performing = FAMILIES.filter((f) => byFamily.has(f) && !PRODUCTION.has(f))
  const production = FAMILIES.filter((f) => byFamily.has(f) && PRODUCTION.has(f))
  const lead = [...byFamily.entries()].filter(([f]) => !PRODUCTION.has(f)).sort((a, b) => a[1].first - b[1].first)[0]?.[0]
  const played = lead ? [lead, ...performing.filter((f) => f !== lead)] : performing
  const order = opts.productionFirst ? [...production, ...played] : [...played, ...production]
  const merged = (f: Family, labels: Map<string, Coverage>): string => {
    const union = noCoverage()
    const name = (() => {
      if (f === 'vocals' && labels.has('lead vocals')) { addCoverage(union, labels.get('lead vocals')!); return 'lead vocals' }
      for (const c of labels.values()) addCoverage(union, c)
      if (f === 'vocals') return 'vocals'
      if (labels.size === 1) return [...labels.keys()][0]!
      return PLURAL_LABEL[f] ?? [...labels.keys()].join(', ')
    })()
    return withTracks(name, union, trackCount, WHOLE_RECORD_SHARE)
  }
  const shown = order.map((f) => merged(f, byFamily.get(f)!.labels))
  // The tooltip: every credit as MusicBrainz names it, un-merged ("hammond
  // organ (2, 6), organ (6)"), lead vocals first within the voice, numbered
  // unless it is on every track.
  const all: string[] = []
  for (const f of order) {
    const raw = [...byFamily.get(f)!.raw]
    if (f === 'vocals') raw.sort((a, b) => Number(b.label === 'lead vocals') - Number(a.label === 'lead vocals'))
    for (const r of raw) all.push(withTracks(r.role, r.c, trackCount, 1))
  }
  return { shown: shown.slice(0, ROLES_SHOWN), all }
}

function isProductionOnly(roles: readonly string[]): boolean {
  const fams = roles.map(family).filter((f): f is NonNullable<typeof f> => !!f)
  return fams.length > 0 && fams.every((f) => PRODUCTION.has(f.family))
}
function producesIt(roles: readonly string[]): boolean {
  return roles.some((r) => { const f = family(r); return f?.family === 'producer' || f?.family === 'executive producer' })
}
const names = (line: PersonnelLine): string[] => line.allRoles.map(partOf)

/**
 * The sleeve order: the band (members of the album's artist, or the artist
 * themselves) by how many songs they're on; then guests who played; then
 * the producer and the engineers. A non-member who produced the record sits
 * with production even if they also played (George Martin). People whose
 * every credit is noise are left out. `trackCount` is the record's track
 * total, so the parts can carry their track numbers.
 */
export function arrangePersonnel(people: readonly PersonnelPerson[], trackCount = 0): PersonnelLine[] {
  const band: PersonnelLine[] = []
  const guests: PersonnelLine[] = []
  const production: PersonnelLine[] = []
  const byTracks = (a: PersonnelPerson, b: PersonnelPerson) => b.tracks - a.tracks || a.name.localeCompare(b.name)
  for (const p of [...people].sort(byTracks)) {
    const isBand = !!p.member && !isProductionOnly(p.roles)
    const isProduction = !isBand && (isProductionOnly(p.roles) || producesIt(p.roles))
    const { shown, all } = summarizeRoles(p.roles, { productionFirst: isProduction, credits: p.credits, trackCount })
    if (!all.length) continue
    const line: PersonnelLine = { name: p.name, roles: shown, allRoles: all, group: isBand ? 'band' : isProduction ? 'production' : 'guest' }
    if (isBand) band.push(line)
    else if (isProduction) production.push(line)
    else guests.push(line)
  }
  // Within production: whoever produced it first, then the rest by songs.
  const prodRank = (l: PersonnelLine) => (names(l).includes('producer') ? 0 : names(l).includes('executive producer') ? 1 : 2)
  production.sort((a, b) => prodRank(a) - prodRank(b))
  return [...band, ...guests, ...production]
}

/**
 * The lines shown before "All N": the band, the producer, then guests, then
 * the rest — in sleeve order. A sleeve preview that keeps the anvil player
 * and hides the producer is the wrong six.
 */
export function personnelPreview(lines: readonly PersonnelLine[], cap: number): PersonnelLine[] {
  if (lines.length <= cap) return [...lines]
  const producerAt = lines.findIndex((l) => l.group === 'production' && names(l).includes('producer'))
  const priority = [
    ...lines.map((l, i) => ({ l, i })).filter(({ l }) => l.group === 'band'),
    ...(producerAt >= 0 ? [{ l: lines[producerAt]!, i: producerAt }] : []),
    ...lines.map((l, i) => ({ l, i })).filter(({ l }) => l.group === 'guest'),
    ...lines.map((l, i) => ({ l, i })).filter(({ l }, i) => l.group === 'production' && i !== producerAt),
  ]
  return priority.slice(0, cap).sort((a, b) => a.i - b.i).map(({ l }) => l)
}
