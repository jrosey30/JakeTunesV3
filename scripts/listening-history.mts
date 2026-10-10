// One listening history across every device (Year in Review step 1).
//   npx tsx scripts/listening-history.mts \
//     --laptop  <laptop listening-log.jsonl> \
//     --workmini <replicas/workmini/listening-log.jsonl> \
//     --phone   <NAS mobile-listening-log.jsonl> \
//     --ipod    <ipod-roundtrip-ledger.jsonl> \
//     --library <library.json> --out <dir> [--year 2026] [--kpi-days 28]
// Any source may be omitted (it is reported as missing, never guessed).
// Writes <out>/listening-history.jsonl, <out>/listening-summary-<year>.json and
// <out>/listening-kpi.json (the last --kpi-days, every device, real skips only —
// what the weekly KPI report reads).
// Reads its inputs only; writes only into --out.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyDevice, fromIpodLedger, mergeHistories, attachTrackIds, summarize, windowStats,
  type Device, type RawListen, type IpodLedgerEntry, type Listen,
} from '../src/common/listening-history.ts'

const args = process.argv.slice(2)
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const out = flag('out')
const libPath = flag('library')
const year = Number(flag('year') || 2026)
if (!out || !libPath) { console.error('need --out and --library'); process.exit(2) }

const jsonl = <T>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as T] } catch { return [] } })
const lib = (JSON.parse(readFileSync(libPath, 'utf8')) as { tracks: Array<{ id: number; artist?: string; albumArtist?: string; title?: string; album?: string; genre?: string; duration?: number; playCount?: number }> }).tracks
const byId = new Map(lib.map((t) => [t.id, t]))

const lists: Listen[][] = []
const sources: Record<string, string> = {}
for (const device of ['laptop', 'workmini', 'phone'] as Device[]) {
  const p = flag(device)
  if (!p || !existsSync(p)) { sources[device] = 'missing'; continue }
  const rows = jsonl<RawListen>(p)
  lists.push(classifyDevice(rows, device))
  sources[device] = `${rows.length} rows`
}
const ipodPath = flag('ipod')
if (ipodPath && existsSync(ipodPath)) {
  const entries = jsonl<IpodLedgerEntry>(ipodPath)
  lists.push(fromIpodLedger(entries, (id) => byId.get(id)))
  sources.ipod = `${entries.length} syncs`
} else sources.ipod = 'missing'

const history = attachTrackIds(mergeHistories(lists), lib)
const summary = summarize(history, year, (l) => (l.trackId !== undefined ? byId.get(l.trackId)?.duration : undefined))

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'listening-history.jsonl'), history.map((l) => JSON.stringify(l)).join('\n') + '\n')
writeFileSync(join(out, `listening-summary-${year}.json`), JSON.stringify({ builtAt: new Date().toISOString(), sources, ...summary }, null, 2))
const kpiDays = Number(flag('kpi-days') || 28)
const now = Date.now()
const kpi = windowStats(history, now - kpiDays * 86400000, now)
writeFileSync(join(out, 'listening-kpi.json'), JSON.stringify({ builtAt: new Date(now).toISOString(), windowDays: kpiDays, sources, ...kpi }, null, 2))

const t = summary.totals
const ided = history.filter((l) => l.trackId !== undefined).length
console.log(`sources: ${JSON.stringify(sources)}`)
console.log(`${year}: ${t.play} plays · ${t.skip} skips · ${t.glance} glances · ${t.mechanical} mechanical`)
console.log(`listening time: ${Math.round(summary.minutesListened / 60)} h (${summary.minutesKnownFor}/${t.play} plays have a known length)`)
console.log(`matched to a library song: ${ided}/${history.length}`)
console.log(`first play ${summary.firstListen} · last ${summary.lastListen}`)
console.log(`last ${kpiDays} days: ${kpi.totals.play} plays · ${kpi.totals.skip} skips · real skip rate ${kpi.realSkipRate === null ? 'n/a' : (kpi.realSkipRate * 100).toFixed(1) + '%'}`)
for (const [dev, months] of Object.entries(summary.byDeviceMonth)) {
  console.log(`  ${dev.padEnd(8)} ${Object.entries(months).sort().map(([m, c]) => `${m}:${c.play}`).join(' ')}`)
}
console.log('top artists:', summary.topArtists.slice(0, 10).map((a) => `${a.artist} ${a.plays}`).join(' · '))
console.log('top songs:', summary.topSongs.slice(0, 10).map((s) => `${s.artist} – ${s.title} ${s.plays}`).join(' · '))
