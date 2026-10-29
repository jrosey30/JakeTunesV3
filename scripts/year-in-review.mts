// Year in Review facts (Class A) from the one listening history.
//   node scripts/year-in-review.mts --history <listening-history.jsonl> \
//     --library <library.json> [--live-sets <live-sets.json>] [--mixtapes <mixtapes.json>] \
//     [--attended <concerts-attended.json>] \
//     [--taste-ledger <taste-ledger.jsonl>] [--recommendations <recommendations.json>] \
//     [--reco-attributions <reco-attributions.json>] [--rock-dna <rock-dna.json>] \
//     [--top1000-answers <top1000-answers.jsonl>] [--known-artists <yir-known-artists.json>] \
//     [--artist-fans <artist-deezer.json>] [--fame <top1000-fame.json>] [--no-fan-lookup] \
//     --out <dir> [--year 2026]
// Writes <out>/year-in-review-<year>.json, plus <out>/artist-fans-cache.json (Deezer
// fan counts it looked up for the found-artist fame guard). Reads its other inputs only.
// The discovery inputs default to the files beside --library (the app's userData), and
// --fame and --top1000-answers to ~/JakeTunesState/; any that is missing is simply left out.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { buildYearInReview, FOUND_SOURCES, type YirConcert, type YirMixtape, type YirAttendedInput, type YirFindEvidence, type YirFame } from '../src/common/year-in-review.ts'
import { tapeTracks } from '../src/common/tape-physics.ts'
import type { Listen } from '../src/common/listening-history.ts'

const args = process.argv.slice(2)
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const histPath = flag('history'), libPath = flag('library'), out = flag('out')
const year = Number(flag('year') || 2026)
if (!histPath || !libPath || !out) { console.error('need --history, --library and --out'); process.exit(2) }

const listens = readFileSync(histPath, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as Listen] } catch { return [] } })
const library = (JSON.parse(readFileSync(libPath, 'utf8')) as { tracks: [] }).tracks

const concerts: YirConcert[] = []
const lsPath = flag('live-sets')
if (lsPath && existsSync(lsPath)) {
  const ls = JSON.parse(readFileSync(lsPath, 'utf8')) as Record<string, { mergedTrackId?: number; createdAt?: string; cues?: Array<{ artist?: string }>; concert?: { venue?: string; city?: string; date?: string; notes?: string } }>
  for (const [key, e] of Object.entries(ls)) {
    const [, albumKey] = key.split('|||')
    const merged = library.find((t: { id: number }) => t.id === e.mergedTrackId) as { album?: string; artist?: string } | undefined
    concerts.push({
      artist: merged?.artist || e.cues?.[0]?.artist || key.split('|||')[0],
      album: (merged?.album || albumKey || '').replace(/\s*\(Live Set\)$/i, ''),
      createdAt: e.createdAt, mergedTrackId: e.mergedTrackId,
      venue: e.concert?.venue, city: e.concert?.city, date: e.concert?.date, notes: e.concert?.notes,
    })
  }
}
const mixtapes: YirMixtape[] = []
const mtPath = flag('mixtapes')
if (mtPath && existsSync(mtPath)) {
  const raw = JSON.parse(readFileSync(mtPath, 'utf8'))
  for (const t of (Array.isArray(raw) ? raw : raw.mixtapes ?? [])) mixtapes.push({ title: t.title, createdAt: t.createdAt, songs: tapeTracks(t).length })
}

// Shows he went to (JakeTunesMobile concerts, Mobile #648): --attended, else homemini's own copy
// beside the other quiz/concert state (~/JakeTunesState/yir). Absent → no attended list.
const attended: YirAttendedInput[] = []
const atPath = flag('attended') ?? join(homedir(), 'JakeTunesState', 'yir', 'concerts-attended.json')
if (existsSync(atPath)) {
  try {
    const raw = JSON.parse(readFileSync(atPath, 'utf8'))
    for (const a of (Array.isArray(raw) ? raw : raw.items ?? [])) if (a && typeof a === 'object') attended.push(a)
  } catch { console.warn(`attended shows unreadable at ${atPath}; leaving them out`) }
}

// Found artists (2026-10-29; Jake: "future shouldnt be considered a found artist....i knew
// about him obviously"). Jake chose "Not famous + new": first downloaded this year, not a
// household name, nothing saying he knew them before. Discovery evidence — a Discover card he
// accepted (not the "You're Missing" lane, which is for artists he already owns), a Listen
// List entry, a friend's "from" — is a plus: from before the download it rescues a borderline name.
const ud = dirname(libPath)
const readJson = <T,>(p: string | undefined): T | undefined => {
  if (!p || !existsSync(p)) return undefined
  try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { console.warn(`unreadable: ${p}; leaving it out`); return undefined }
}
const evidence: YirFindEvidence[] = []
const ledgerPath = flag('taste-ledger') ?? join(ud, 'taste-ledger.jsonl')
if (existsSync(ledgerPath)) {
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.includes('"discover"')) continue
    try {
      const e = JSON.parse(line) as { ts?: string; surface?: string; verdict?: string; key?: { artist?: string }; ctx?: { lane?: string } }
      if (e.surface === 'discover' && e.verdict === 'accept' && e.key?.artist && e.ts && e.ctx?.lane !== 'missing') evidence.push({ artist: e.key.artist, at: e.ts, via: `discover:${e.ctx?.lane ?? ''}` })
    } catch { /* a torn line is not evidence */ }
  }
}
for (const r of readJson<Array<{ artist?: string; createdAt?: string }>>(flag('recommendations') ?? join(ud, 'recommendations.json')) ?? []) {
  if (r?.artist && r.createdAt) evidence.push({ artist: r.artist, at: r.createdAt, via: 'listen-list' })
}
for (const r of readJson<{ attributions?: Array<{ artist?: string; at?: string; friend?: string }> }>(flag('reco-attributions') ?? join(ud, 'reco-attributions.json'))?.attributions ?? []) {
  if (r?.artist && r.at) evidence.push({ artist: r.artist, at: r.at, via: `friend:${r.friend ?? ''}` })
}
// Rock DNA: an artist he picked or rated (anything but "unfamiliar") is one he knew from then on.
const known: YirFindEvidence[] = []
const dna = readJson<{ startedAt?: string; completedAt?: string; answers?: Record<string, { picks?: string[]; at?: string }>; ratings?: Record<string, string> }>(flag('rock-dna') ?? join(ud, 'rock-dna.json'))
if (dna) {
  // a-/b- questions pick an artist; the others pick traits, eras, albums or songs.
  for (const [q, a] of Object.entries(dna.answers ?? {})) if (/^[ab]-/.test(q) && a?.at) for (const p of a.picks ?? []) known.push({ artist: p, at: a.at, via: 'rock-dna' })
  const at = dna.completedAt || dna.startedAt
  if (at) for (const [artist, r] of Object.entries(dna.ratings ?? {})) if (r !== 'unfamiliar') known.push({ artist, at, via: 'rock-dna' })
}
// Top 1000: every song he judged (both sides of a pick) says he knew that artist from then on.
const t1kPath = flag('top1000-answers') ?? join(homedir(), 'JakeTunesState', 'top1000-answers.jsonl')
if (existsSync(t1kPath)) {
  const byId = new Map((library as Array<{ id: number; artist?: string; albumArtist?: string }>).map((t) => [String(t.id), t.albumArtist || t.artist || '']))
  for (const line of readFileSync(t1kPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const a = JSON.parse(line) as { at?: string; ids?: Array<string | number> }
      if (a.at) for (const id of a.ids ?? []) { const artist = byId.get(String(id)); if (artist) known.push({ artist, at: a.at, via: 'top1000' }) }
    } catch { /* torn line */ }
  }
}
// Jake's "I already knew them" list: beats every rule. ~/JakeTunesState/yir-known-artists.json and
// its NAS mirror, both read (a name in either counts); --known-artists replaces both. Shape:
// ["The Shins", …] or { "artists": [...] }. The engine's built-in seed applies regardless.
const alreadyKnew: string[] = []
const knownPaths = flag('known-artists') ? [flag('known-artists')!] : [
  join(homedir(), 'JakeTunesState', 'yir-known-artists.json'),
  join(process.env.JT_NAS_STATE || '/Volumes/JakeShared/JakeTunesState', 'yir-known-artists.json'),
]
for (const p of knownPaths) {
  const raw = readJson<unknown>(p)
  const list = Array.isArray(raw) ? raw : (raw as { artists?: unknown[] } | undefined)?.artists ?? []
  for (const e of list) {
    const name = typeof e === 'string' ? e : (e as { name?: string; artist?: string })?.name ?? (e as { artist?: string })?.artist
    if (name) alreadyKnew.push(name)
  }
}
// Fame: Deezer fans (the artist-photo cache on the laptop, else this script's own lookups),
// and the top song's Deezer rank from the Top 1000 fame file as the fallback.
const fame: Record<string, YirFame> = {}
const key = (s: string | undefined): string => (s || '').toLowerCase().trim()
const fansCachePath = join(out, 'artist-fans-cache.json')
const fansCache = readJson<Record<string, { fans: number | null; at: string }>>(fansCachePath) ?? {}
for (const [name, f] of Object.entries(readJson<Record<string, { fans?: number }>>(flag('artist-fans') ?? join(ud, 'artist-deezer.json')) ?? {})) {
  if (typeof f?.fans === 'number') fame[key(name)] = { fans: f.fans }
}
for (const [name, c] of Object.entries(fansCache)) if (typeof c?.fans === 'number' && !fame[name]) fame[name] = { fans: c.fans }
const ranks = readJson<{ ranks?: Record<string, [number, number]> }>(flag('fame') ?? join(homedir(), 'JakeTunesState', 'top1000-fame.json'))?.ranks ?? {}
for (const t of library as Array<{ id: number; artist?: string; albumArtist?: string }>) {
  const r = ranks[String(t.id)]?.[0]
  if (typeof r !== 'number') continue
  const k = key(t.albumArtist || t.artist)
  fame[k] = { ...fame[k], trackRank: Math.max(fame[k]?.trackRank ?? 0, r) }
}
// Look up fans for every artist with a store download this year and no count yet (cached
// 60 days, so after the first night only newcomers are looked up; best effort).
if (!args.includes('--no-fan-lookup')) {
  const stale = Date.now() - 60 * 86_400_000
  const storeArtists = (library as Array<{ artist?: string; albumArtist?: string; source?: string; dateAdded?: string }>)
    .filter((t) => FOUND_SOURCES.has(t.source ?? '') && (t.dateAdded ?? '').startsWith(String(year)))
    .map((t) => key(t.albumArtist || t.artist))
  // Most-played first: if the budget runs out on a cold cache, the artists the Review
  // actually shows are already checked; the rest fill in on the next night.
  const plays = new Map<string, number>()
  for (const l of listens) if (l.kind === 'play') plays.set(key(l.artist), (plays.get(key(l.artist)) ?? 0) + 1)
  const todo = [...new Set(storeArtists)]
    .filter((k) => k && typeof fame[k]?.fans !== 'number' && !(fansCache[k] && Date.parse(fansCache[k].at) > stale))
    .sort((x, y) => (plays.get(y) ?? 0) - (plays.get(x) ?? 0))
    .slice(0, 2000)
  const deadline = Date.now() + 150_000
  let looked = 0
  // "Angels & Airwaves" on the shelf is "Angels and Airwaves" on Deezer: compare letters and digits.
  const same = (s: string | undefined): string => (s || '').toLowerCase().replace(/&/g, 'and').normalize('NFKD').replace(/[^a-z0-9]/g, '')
  const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 450)) // four workers ≈ 8 a second, under Deezer's 50 per 5 s
  // undefined = the lookup failed (try again next night); null = Deezer has no such artist.
  const lookup = async (name: string): Promise<number | null | undefined> => {
    try {
      const res = await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=10`, { signal: AbortSignal.timeout(8000) })
      const body = await res.json() as { data?: Array<{ name?: string; nb_fan?: number }>; error?: unknown }
      if (!res.ok || body.error) return undefined
      // Same name, several artists ("Love"): the biggest one, so a famous act is never missed.
      const fans = (body.data ?? []).filter((a) => same(a.name) === same(name)).map((a) => a.nb_fan ?? 0)
      return fans.length ? Math.max(...fans) : null
    } catch { return undefined } finally { await pause() }
  }
  const worker = async (): Promise<void> => {
    for (let k = todo.shift(); k !== undefined && Date.now() < deadline; k = todo.shift()) {
      let fans = await lookup(k)
      // A billing Deezer doesn't list ("Kanye West & JAY-Z"): as famous as its most famous name.
      const parts = k.split(/\s*(?:&|,|\+|\/|\bx\b|\bwith\b|\bfeat\.?|\bft\.?)\s*/).map((x) => x.trim()).filter(Boolean)
      if (fans === null && parts.length > 1) {
        const each = await Promise.all(parts.slice(0, 4).map(lookup))
        if (each.some((f) => f === undefined)) fans = undefined
        else { const got = each.filter((f): f is number => typeof f === 'number'); fans = got.length ? Math.max(...got) : null }
      }
      if (fans === undefined) continue // offline or throttled: the song-rank fallback stands
      fansCache[k] = { fans, at: new Date().toISOString() }
      if (fans !== null) fame[k] = { ...fame[k], fans }
      looked++
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  if (looked) { mkdirSync(out, { recursive: true }); writeFileSync(fansCachePath, JSON.stringify(fansCache)) }
}
console.log(`found-artist evidence: ${evidence.length} (${new Set(evidence.map((e) => key(e.artist))).size} artists) · known ${known.length} · already knew ${alreadyKnew.length} (+ seed) · fame ${Object.keys(fame).length}`)

const yir = buildYearInReview({ year, listens, library, concerts, mixtapes, attended, discovery: { evidence, known, fame, alreadyKnew } })
mkdirSync(out, { recursive: true })
writeFileSync(join(out, `year-in-review-${year}.json`), JSON.stringify({ builtAt: new Date().toISOString(), ...yir }, null, 2))

const t = yir.totals
console.log(`${year}: ${t.plays} plays · ${Math.round(t.minutes / 60)} h · ${t.daysListened} days · longest streak ${t.longestStreak.days} days (${t.longestStreak.from} → ${t.longestStreak.to}) · biggest day ${t.biggestDay.date} (${t.biggestDay.plays})`)
console.log(`coverage: ${yir.coverage.firstListen} → ${yir.coverage.lastListen}; not in any log: months ${yir.coverage.monthsBeforeHistory.join(',') || 'none'}; by device ${JSON.stringify(yir.coverage.playsByDevice)}`)
console.log(`real skip rate ${(yir.honesty.realSkipRate ?? 0) * 100}% · glances ${yir.honesty.glances} · mechanical ${yir.honesty.mechanical}`)
console.log('top songs:', yir.topSongs.slice(0, 10).map((s) => `${s.artist} – ${s.name} ${s.plays}`).join(' · '))
console.log('top artists:', yir.topArtists.slice(0, 10).map((a) => `${a.name} ${a.plays}`).join(' · '))
console.log('top albums:', yir.topAlbums.slice(0, 5).map((a) => `${a.artist} – ${a.name} ${a.plays}`).join(' · '))
console.log('top genres:', yir.topGenres.slice(0, 6).map((g) => `${g.name} ${g.plays}`).join(' · '))
console.log('months:', yir.months.map((m) => `${m.month}: ${m.topArtist?.name} (${m.plays})`).join(' · '))
console.log('on repeat:', JSON.stringify(yir.onRepeat))
console.log('first play:', JSON.stringify(yir.firstPlay))
console.log(`discoveries: ${yir.discoveries.newArtistCount} new artists; top:`, yir.discoveries.newArtists.slice(0, 8).map((a) => `${a.name} ${a.plays}`).join(' · '))
console.log(`found through JakeTunes: ${yir.discoveries.foundTotal} by month ${JSON.stringify(yir.discoveries.foundByMonth)}`)
console.log(`starred class: ${yir.starredClass.count}; top:`, yir.starredClass.top.slice(0, 5).map((s) => `${s.artist} – ${s.name} ${s.plays}`).join(' · '))
console.log('concerts:', yir.concerts.map((c) => `${c.artist} – ${c.album}${c.notes ? ' [' + c.notes + ']' : ''} (${c.plays} plays)`).join(' · '))
console.log('attended:', (yir.attended ?? []).map((a) => `${a.artist} @ ${a.venue} ${a.date}`).join(' · ') || 'none')
console.log('tapes:', yir.mixtapes.map((m) => `${m.title} (${m.songs})`).join(' · '))
const peakHour = yir.clock.byHour.indexOf(Math.max(...yir.clock.byHour))
const peakDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][yir.clock.byWeekday.indexOf(Math.max(...yir.clock.byWeekday))]
console.log(`clock: peak hour ${peakHour}:00, peak day ${peakDay}`)
