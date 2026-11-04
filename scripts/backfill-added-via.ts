/**
 * Give library rows back the share source they lost (the rules and the reasons
 * are in src/main/added-via-backfill.ts).
 *
 * Reads only, unless you pass --commit. --commit writes only the rows you name,
 * out of a plan you reviewed, and each must still be the row the plan describes.
 * --library is required: no default could reach live data by accident. Writing
 * the app's own library.json goes through the Brief 165 gate: JakeTunes must be
 * quit (exit 3 otherwise), because its next save would silently overwrite this.
 *
 *   # 1. the list (writes nothing but --plan-out)
 *   node --experimental-strip-types scripts/backfill-added-via.ts \
 *     --library <library.json> --snapshots <dir of recommendations*.json> \
 *     --log <file of [add-resolve]/[add-request] lines> --plan-out plan.json
 *
 *   # 2. the write
 *   node --experimental-strip-types scripts/backfill-added-via.ts \
 *     --library <library.json> --plan plan.json --ids 13779,13780 --commit
 *
 * Exit codes: 0 ok · 1 refused or failed, nothing written · 2 bad arguments ·
 * 3 the app is running · 4 written, but the file on disk is not what was meant
 * (restore the .bak it names).
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs'
import { join } from 'path'
import { assertAppNotRunning, writeJsonAtomic } from './lib/atomic-write.mjs'
import { LIBRARY_PATH } from './lib-orphan-shared.mjs'
import {
  applyStamps,
  diffLibraries,
  evidenceFromRecoRows,
  evidenceFromShareLog,
  mergeEvidence,
  planBackfill,
  type LibraryRow,
  type PlannedStamp,
  type RecoRow,
} from '../src/main/added-via-backfill.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
function die(code: number, message: string): never {
  console.error(message)
  process.exit(code)
}

type Library = { tracks: LibraryRow[] } & Record<string, unknown>

const libraryPath = arg('--library')
if (!libraryPath) die(2, 'Pass --library <library.json>. There is no default.')
if (!existsSync(libraryPath)) die(2, `No such library: ${libraryPath}`)
const library = JSON.parse(readFileSync(libraryPath, 'utf8')) as Library

if (process.argv.includes('--commit')) commit(library, libraryPath)
else plan(library)

function plan(lib: Library): void {
  const dir = arg('--snapshots')
  const log = arg('--log')
  if (!dir && !log) die(2, 'Pass --snapshots <dir> and/or --log <file>.')
  const rows: RecoRow[] = []
  for (const f of dir ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []) {
    const parsed = JSON.parse(readFileSync(join(dir as string, f), 'utf8')) as RecoRow[] | { items?: RecoRow[] }
    rows.push(...(Array.isArray(parsed) ? parsed : parsed.items ?? []))
  }
  const lines = log ? readFileSync(log, 'utf8').split('\n') : []
  const evidence = mergeEvidence(evidenceFromRecoRows(rows), evidenceFromShareLog(lines))
  const { stamps, excluded } = planBackfill(lib.tracks, evidence)

  console.log(`${lib.tracks.length} library rows · ${evidence.length} shares on record · ${stamps.length} rows could be stamped`)
  for (const group of ['desktop', 'phone-listed', 'phone-log'] as const) {
    const inGroup = stamps.filter((s) => s.group === group)
    console.log(`\n── ${group} (${inGroup.length}) ──`)
    for (const s of inGroup) {
      console.log(`${s.id}  ${s.addedVia.padEnd(9)}  ${s.dateAdded.slice(0, 16)}  ${s.title} — ${s.artist}  [${s.evidence.how}${s.evidence.link ? ' + link' : ''}, reco ${s.evidence.recoId.slice(0, 8)}]`)
    }
  }
  console.log(`\n── left out (${excluded.length}) ──`)
  for (const x of excluded) console.log(`${x.id}  ${x.reason}  ${x.title} — ${x.artist}  [${x.keys.join(', ')}]`)

  const out = arg('--plan-out')
  if (out) {
    writeFileSync(out, JSON.stringify({ stamps, excluded }, null, 2))
    console.log(`\nPlan: ${out}`)
  }
  console.log('\nNothing was written to the library.')
}

function commit(lib: Library, path: string): void {
  const planPath = arg('--plan')
  const ids = (arg('--ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)
  if (!planPath) die(2, '--commit needs --plan <file>.')
  if (ids.length === 0 || ids.some((n) => !Number.isInteger(n))) die(2, '--commit needs --ids with the reviewed track ids, comma separated.')
  const { stamps } = JSON.parse(readFileSync(planPath, 'utf8')) as { stamps: PlannedStamp[] }
  const picked: PlannedStamp[] = []
  for (const id of ids) {
    const s = stamps.find((x) => x.id === id)
    if (!s) die(1, `Refused, nothing written: id ${id} is not in the plan.`)
    picked.push(s)
  }

  if (realpathSync(path) === (existsSync(LIBRARY_PATH) ? realpathSync(LIBRARY_PATH) : LIBRARY_PATH)) {
    assertAppNotRunning('write addedVia into library.json')
  }

  const { library: next, changed, already, refused } = applyStamps(lib, picked)
  if (refused.length > 0) {
    for (const r of refused) console.error(`${r.id}: ${r.why}`)
    die(1, `Refused, nothing written: ${refused.length} row(s) are not what the plan reviewed. Run the plan again.`)
  }
  if (changed.length === 0) {
    console.log(`Nothing to do: ${already.length} row(s) already carry their stamp. Nothing was written.`)
    return
  }
  const { changedIds, problems } = diffLibraries(lib, next as Library)
  const wanted = changed.map((c) => c.id).sort((a, b) => a - b)
  if (problems.length > 0 || JSON.stringify([...changedIds].sort((a, b) => a - b)) !== JSON.stringify(wanted)) {
    die(1, `Refused, nothing written: the result differs in more than the planned rows.\n${problems.join('\n')}`)
  }

  const backup = `${path}.pre-addedvia-backfill-${new Date().toISOString().replace(/[:.]/g, '')}.bak`
  copyFileSync(path, backup)
  writeJsonAtomic(path, next)

  const landed = readFileSync(path, 'utf8')
  if (landed !== JSON.stringify(next, null, 2)) {
    die(4, `The file on disk is not what was written. Restore it from ${backup}.`)
  }
  for (const c of changed) console.log(`${c.id}  addedVia: (none) → ${c.addedVia}  ${c.title} — ${c.artist}`)
  if (already.length > 0) console.log(`Already stamped, untouched: ${already.join(', ')}`)
  console.log(`Changed ${changed.length} row(s), each by addedVia only. Backup: ${backup}`)
}
