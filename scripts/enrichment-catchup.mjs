#!/usr/bin/env node
/**
 * enrichment-catchup.mjs — Brief 177: the scheduled enrichment catch-up
 * driver. CLAP freshness and lyrics fetching were both manual-only; this
 * is the job launchd runs nightly (template in scripts/launchd/, Brief 183)
 * so newly-added tracks reach the audio index and the lyrics store within
 * a day instead of whenever someone remembers.
 *
 * One run:
 *   1. REFRESH the enrichment ledger from the source stores (read-only):
 *      lyricsDone from lyrics.json, taxonomyDone from
 *      metadata-overrides.json (tracks carrying a subgenre).
 *   2. CLAP delta: count library tracks missing from audio-index.bin,
 *      then run scripts/audio-embed.py with --limit = tonight's cap.
 *      audio-embed itself consults the ledger (fresh first, recently
 *      failed deferred to the back, 30-day retry TTL).
 *      THE CAP: from clap-probe.json in the state dir when the probe has
 *      been run on this machine (scripts/clap-probe.py), scaled to this
 *      run's budget; otherwise the --cap / CLAP_NIGHTLY_CAP fallback
 *      (default 300) — and the summary SAYS which, because an unmeasured
 *      cap is a placeholder, not a fact.
 *   3. LYRICS batch: scripts/lyrics-fetch.mjs --limit (default 200) with
 *      whatever budget remains; skipped if the CLAP phase ate the window.
 *   4. Write enrichment-status.json (state dir) + print a summary.
 *
 * Usage:
 *   node scripts/enrichment-catchup.mjs [--budget-min 60] [--cap N]
 *     [--lyrics-limit 200] [--python /path/to/python] [--skip-clap] [--dry-run]
 *
 * --skip-clap runs the ledger refresh + lyrics only (the nightly wrapper
 * passes it while JakeTunes is playing audio — CLAP decoding is CPU-heavy).
 *
 * --dry-run prints the plan (counts, cap source, exact commands) and
 * spawns nothing and writes nothing.
 * JT_STATE_DIR works as everywhere else. The CLAP python defaults to
 * .venv-clap/bin/python in the repo when present, else python3.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readFileSync as _rf } from 'node:fs'
import { loadLedger, saveLedger, ledgerPath, markLyricsDone, markTaxonomyDone } from './enrichment-ledger.mjs'

// Ids in an EMBD container (audio-index.bin) — header + per-record id walk.
// Local on purpose: this driver must not depend on another brief's module.
function readEmbIds(path) {
  const buf = _rf(path)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'EMBD') throw new Error(`${path}: bad magic`)
  const dim = buf.readUInt16LE(6), count = buf.readUInt32LE(8), rec = 4 + dim * 4
  const ids = new Set()
  let off = 12
  for (let i = 0; i < count && off + 4 <= buf.length; i++) { ids.add(buf.readUInt32LE(off)); off += rec }
  return ids
}

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_DIR = process.env.JT_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const argv = process.argv.slice(2)
const argVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const DRY = argv.includes('--dry-run')
const SKIP_CLAP = argv.includes('--skip-clap')
const BUDGET_MIN = Number(argVal('--budget-min') || 60)
const LYRICS_LIMIT = Number(argVal('--lyrics-limit') || 200)
const log = (...a) => console.log(new Date().toISOString(), '[enrichment-catchup]', ...a)

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

// ── 1) ledger refresh from the source stores ──
const libRaw = readJson(join(STATE_DIR, 'library.json'), null)
if (!libRaw) { log(`no readable library.json under ${STATE_DIR} — nothing to do`); process.exit(1) }
const tracks = Array.isArray(libRaw) ? libRaw : (libRaw.tracks || [])
const LEDGER = ledgerPath(STATE_DIR)
const ledger = loadLedger(LEDGER)

const lyricsStore = readJson(join(STATE_DIR, 'lyrics.json'), {})
let lyricsRefreshed = 0
for (const [id, rec] of Object.entries(lyricsStore)) {
  if (rec && !rec.miss && (rec.plain || rec.synced || rec.instrumental)) {
    if (!ledger.tracks[id]?.lyricsDone) lyricsRefreshed++
    markLyricsDone(ledger, Number(id))
  }
}
const overrides = readJson(join(STATE_DIR, 'metadata-overrides.json'), {})
let taxonomyRefreshed = 0
for (const [id, e] of Object.entries(overrides)) {
  if (e?.fields?.subgenre) {
    if (!ledger.tracks[id]?.taxonomyDone) taxonomyRefreshed++
    markTaxonomyDone(ledger, Number(id))
  }
}
log(`ledger refresh: +${lyricsRefreshed} lyricsDone, +${taxonomyRefreshed} taxonomyDone derived from source stores`)

// ── 2) CLAP delta + cap ──
let clapDoneIds = new Set()
try { clapDoneIds = readEmbIds(join(STATE_DIR, 'audio-index.bin')) } catch { /* no index yet — everything is delta */ }
const clapTodo = tracks.filter((t) => Number.isInteger(t.id) && !clapDoneIds.has(t.id))
const probe = readJson(join(STATE_DIR, 'clap-probe.json'), null)
let cap, capSource
if (probe?.recommendedNightlyCap && probe?.budgetMin) {
  cap = Math.max(1, Math.round(probe.recommendedNightlyCap * (BUDGET_MIN / probe.budgetMin)))
  capSource = `clap-probe measurement (${probe.tracksPerMin} tracks/min on ${probe.measuredAt}, scaled to a ${BUDGET_MIN}-min budget)`
} else {
  cap = Number(argVal('--cap') || process.env.CLAP_NIGHTLY_CAP || 300)
  capSource = 'UNMEASURED fallback (run scripts/clap-probe.py on this machine and --write to replace this guess)'
}
const clapRun = SKIP_CLAP ? 0 : Math.min(cap, clapTodo.length)
log(`CLAP: ${clapDoneIds.size} indexed, ${clapTodo.length} in delta, tonight's cap ${cap} (${capSource}) → running ${clapRun}`)

const venvPython = join(HERE, '..', '.venv-clap', 'bin', 'python')
const PYTHON = argVal('--python') || (existsSync(venvPython) ? venvPython : 'python3')
const clapCmd = [PYTHON, join(HERE, 'audio-embed.py'), '--limit', String(clapRun)]
const lyricsCmd = ['node', join(HERE, 'lyrics-fetch.mjs'), '--limit', String(LYRICS_LIMIT)]

if (DRY) {
  log('DRY-RUN — plan only; nothing spawned, nothing written (ledger refresh above was computed in memory)')
  if (clapRun > 0) log('would run:', clapCmd.join(' '))
  else log(`would skip CLAP (${SKIP_CLAP ? '--skip-clap' : 'delta empty'})`)
  log('would run:', lyricsCmd.join(' '), `(if budget remains after CLAP)`)
  log(`budget: ${BUDGET_MIN} min total`)
  process.exit(0)
}

saveLedger(LEDGER, ledger)
const status = { at: new Date().toISOString(), budgetMin: BUDGET_MIN, cap, capSource, dryRun: false, phases: {} }
const t0 = Date.now()
const elapsedMin = () => (Date.now() - t0) / 60000

if (clapRun > 0) {
  const r = spawnSync(clapCmd[0], clapCmd.slice(1), { stdio: 'inherit', env: { ...process.env, JT_STATE_DIR: STATE_DIR } })
  status.phases.clap = { ran: clapRun, exitCode: r.status, minutes: Math.round(elapsedMin() * 10) / 10 }
  if (r.status !== 0) log(`CLAP phase exited ${r.status} — continuing to lyrics with remaining budget`)
} else {
  status.phases.clap = { ran: 0, note: SKIP_CLAP ? 'skipped (--skip-clap: music was playing)' : 'delta empty' }
}

if (elapsedMin() < BUDGET_MIN * 0.85) {
  const before = elapsedMin()
  const r = spawnSync(lyricsCmd[0], lyricsCmd.slice(1), { stdio: 'inherit', env: { ...process.env, JT_STATE_DIR: STATE_DIR } })
  status.phases.lyrics = { limit: LYRICS_LIMIT, exitCode: r.status, minutes: Math.round((elapsedMin() - before) * 10) / 10 }
} else {
  status.phases.lyrics = { skipped: `budget ${BUDGET_MIN} min effectively consumed by the CLAP phase` }
  log('lyrics phase skipped — CLAP consumed the window; lyrics keep their place at the front of tomorrow\'s run')
}

const statusPath = join(STATE_DIR, 'enrichment-status.json')
const tmp = `${statusPath}.${process.pid}.tmp`
writeFileSync(tmp, JSON.stringify(status, null, 2))
renameSync(tmp, statusPath)
log('summary:', JSON.stringify(status.phases), `| cap source: ${capSource}`)
