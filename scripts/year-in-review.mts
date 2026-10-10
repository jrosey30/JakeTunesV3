// Year in Review facts (Class A) from the one listening history.
//   node scripts/year-in-review.mts --history <listening-history.jsonl> \
//     --library <library.json> [--live-sets <live-sets.json>] [--mixtapes <mixtapes.json>] \
//     --out <dir> [--year 2026]
// Writes <out>/year-in-review-<year>.json. Reads its inputs only.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildYearInReview, type YirConcert, type YirMixtape } from '../src/common/year-in-review.ts'
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

const yir = buildYearInReview({ year, listens, library, concerts, mixtapes })
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
console.log('tapes:', yir.mixtapes.map((m) => `${m.title} (${m.songs})`).join(' · '))
const peakHour = yir.clock.byHour.indexOf(Math.max(...yir.clock.byHour))
const peakDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][yir.clock.byWeekday.indexOf(Math.max(...yir.clock.byWeekday))]
console.log(`clock: peak hour ${peakHour}:00, peak day ${peakDay}`)
