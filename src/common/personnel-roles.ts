/**
 * Personnel the way a sleeve prints it (Jake 2026-10-30, on Abbey Road's
 * run-on paragraph: "this is no way to list personnel"): one line per person,
 * the band first, then guests, then the producer and engineers; each person's
 * parts summarised to the few that matter — "lead vocals, guitars, bass,
 * keyboards", not "background vocals, electric bass guitar, lead vocals,
 * piano, handclaps, moog, tubular bells, electric guitar, acoustic guitar".
 *
 * Pure: MusicBrainz role labels in (lowercase, deduped, most frequent first,
 * see main/album-personnel.ts), display lines out. Used by the album page.
 */

export interface PersonnelPerson {
  name: string
  roles: string[]
  tracks: number
  /** A member of the album's artist (artist-members.json), or the artist. */
  member?: boolean
}

export type PersonnelGroup = 'band' | 'guest' | 'production'

export interface PersonnelLine {
  name: string
  group: PersonnelGroup
  /** The parts shown, at most ROLES_SHOWN. */
  roles: string[]
  /** Every part, for the tooltip, in the same order. */
  allRoles: string[]
}

export const ROLES_SHOWN = 4

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

/**
 * A person's parts, summarised: credits merge into families (electric +
 * acoustic + 12 string guitar → "guitars"; piano + Moog → "keyboards"; maracas
 * + tambourine → "percussion"), noise (handclaps, effects) goes, and the
 * families come out in sleeve order — except that the person's main credit
 * (the first, most frequent one) leads, so a drummer who sang a song reads
 * "drums, lead vocals, percussion", not "lead vocals, drums, percussion".
 */
export function summarizeRoles(roles: readonly string[], opts: { productionFirst?: boolean } = {}): { shown: string[]; all: string[] } {
  const byFamily = new Map<Family, { labels: Set<string>; first: number }>()
  roles.forEach((role, i) => {
    const f = family(role)
    if (!f) return
    const cur = byFamily.get(f.family)
    if (cur) cur.labels.add(f.label)
    else byFamily.set(f.family, { labels: new Set([f.label]), first: i })
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
  const all = order.map((f) => {
    const { labels } = byFamily.get(f)!
    if (f === 'vocals') return labels.has('lead vocals') ? 'lead vocals' : 'vocals'
    if (labels.size === 1) return [...labels][0]!
    return PLURAL_LABEL[f] ?? [...labels].join(', ')
  })
  return { shown: all.slice(0, ROLES_SHOWN), all }
}

function isProductionOnly(roles: readonly string[]): boolean {
  const fams = roles.map(family).filter((f): f is NonNullable<typeof f> => !!f)
  return fams.length > 0 && fams.every((f) => PRODUCTION.has(f.family))
}
function producesIt(roles: readonly string[]): boolean {
  return roles.some((r) => { const f = family(r); return f?.family === 'producer' || f?.family === 'executive producer' })
}

/**
 * The sleeve order: the band (members of the album's artist, or the artist
 * themselves) by how many songs they're on; then guests who played; then
 * the producer and the engineers. A non-member who produced the record sits
 * with production even if they also played (George Martin). People whose
 * every credit is noise are left out.
 */
export function arrangePersonnel(people: readonly PersonnelPerson[]): PersonnelLine[] {
  const band: PersonnelLine[] = []
  const guests: PersonnelLine[] = []
  const production: PersonnelLine[] = []
  const byTracks = (a: PersonnelPerson, b: PersonnelPerson) => b.tracks - a.tracks || a.name.localeCompare(b.name)
  for (const p of [...people].sort(byTracks)) {
    const isBand = !!p.member && !isProductionOnly(p.roles)
    const isProduction = !isBand && (isProductionOnly(p.roles) || producesIt(p.roles))
    const { shown, all } = summarizeRoles(p.roles, { productionFirst: isProduction })
    if (!all.length) continue
    const line: PersonnelLine = { name: p.name, roles: shown, allRoles: all, group: isBand ? 'band' : isProduction ? 'production' : 'guest' }
    if (isBand) band.push(line)
    else if (isProduction) production.push(line)
    else guests.push(line)
  }
  // Within production: whoever produced it first, then the rest by songs.
  const prodRank = (l: PersonnelLine) => (l.allRoles[0] === 'producer' || l.allRoles.includes('producer') ? 0 : l.allRoles.includes('executive producer') ? 1 : 2)
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
  const producerAt = lines.findIndex((l) => l.group === 'production' && l.allRoles.includes('producer'))
  const priority = [
    ...lines.map((l, i) => ({ l, i })).filter(({ l }) => l.group === 'band'),
    ...(producerAt >= 0 ? [{ l: lines[producerAt]!, i: producerAt }] : []),
    ...lines.map((l, i) => ({ l, i })).filter(({ l }) => l.group === 'guest'),
    ...lines.map((l, i) => ({ l, i })).filter(({ l }, i) => l.group === 'production' && i !== producerAt),
  ]
  return priority.slice(0, cap).sort((a, b) => a.i - b.i).map(({ l }) => l)
}
