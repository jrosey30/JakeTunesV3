#!/usr/bin/env node
/**
 * JakeTunes "Lyrics Fetcher" — a grounded, resumable batch that pulls real
 * lyrics from LRCLIB (lrclib.net) for the library and writes them to a
 * `lyrics.json` sidecar in STATE_DIR. NEVER touches library.json (V3 is the
 * single writer; mobile reads it). NEVER fabricates a single word — a track
 * with no LRCLIB match is stored as { miss:true }, an instrumental as
 * { instrumental:true }, so the brain and Get Info both know "genuinely no
 * lyrics" vs "not fetched yet".
 *
 * The lyrics feed two things:
 *   1. Get Info's read-only Lyrics section (desktop reads lyrics.json locally).
 *   2. The nightly brain-trainer's "meaning" pass — Gemma turns the words into
 *      a one-line theme so the embedding brain understands what a song is ABOUT.
 *
 * Grounding: LRCLIB matches by normalized title+artist AND a strict ±2s
 * duration window (server-enforced on /api/get), which is what stops a live /
 * remix / wrong-length cut from handing us the wrong lyrics. We send the file's
 * real duration in whole seconds. album_name is deliberately OMITTED from the
 * precise lookup (a mismatched album hard-404s on LRCLIB); the /api/search
 * fallback re-ranks candidates ourselves by duration ±2s + artist match.
 *
 * Runs on the LAPTOP (the desktop app's machine): writes STATE_DIR/lyrics.json
 * locally, which the desktop's existing STATE_FILE_NAMES mirror carries to the
 * NAS, so homemini's nightly trainer sees it. One writer only — do not also run
 * this on homemini or the desktop mirror would clobber it.
 *
 * Run:  node scripts/lyrics-fetch.mjs              (full library, most-played first)
 *       node scripts/lyrics-fetch.mjs --limit 20   (first 20 unfetched)
 *       node scripts/lyrics-fetch.mjs --ids 0,1,2   (specific track ids)
 *       node scripts/lyrics-fetch.mjs --dry --limit 20   (network only, no write)
 *       node scripts/lyrics-fetch.mjs --stats      (coverage report, no fetch)
 * Cost: free (LRCLIB has no key and no enforced rate limit — we stay polite:
 *       descriptive User-Agent, 20s timeout, small delay, cached/resumable).
 *
 * Fallback (2026-10-27): when BOTH LRCLIB paths miss, lyrics.ovh is asked —
 * gated (no remix/edit/dub/live/… titles, ≥80 chars, 1 req/s, 8 s timeout).
 * A double miss on a likely-instrumental track (house/techno/score genres or
 * an "Instrumental"/"Dub" title) is stored as a MISS with likelyInstrumental
 * and retried after 180 days instead of 30 — never claimed as instrumental.
 * Rules + shapes: scripts/lyrics-sources.mjs.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { loadLedger, saveLedger, ledgerPath, markLyricsDone, markLyricsAttempted } from './enrichment-ledger.mjs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLyricsFetcher, missTtlMs } from './lyrics-sources.mjs'

const STATE_DIR = process.env.JT_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const LIB = join(STATE_DIR, 'library.json')
const LYRICS = join(STATE_DIR, 'lyrics.json')

const DELAY_MS = Number(process.env.LYRICS_DELAY_MS || 250)   // polite gap between calls
const log = (...a) => console.log(new Date().toISOString(), '[lyrics-fetch]', ...a)

const argv = process.argv.slice(2)
const getArg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const LIMIT = Number(getArg('--limit') || 0)
const ONLY_IDS = (getArg('--ids') || '').split(',').map(s => s.trim()).filter(Boolean)
const DRY = argv.includes('--dry')
const STATS = argv.includes('--stats')
const FORCE = argv.includes('--force')   // re-fetch stored misses regardless of TTL
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// LRCLIB get/search + the gated lyrics.ovh fallback live in lyrics-sources.mjs
// (injectable fetch → unit-tested without the network).
const fetcher = createLyricsFetcher({ log })

// ── main ──
const libRaw = JSON.parse(readFileSync(LIB, 'utf8'))
let tracks = Array.isArray(libRaw) ? libRaw : (libRaw.tracks || [])
tracks = tracks.filter(t => t && String(t.title || '').trim() && String(t.artist || '').trim())
tracks.sort((a, b) => (Number(b.playCount) || 0) - (Number(a.playCount) || 0))   // songs Jake loves first
if (ONLY_IDS.length) tracks = tracks.filter(t => ONLY_IDS.includes(String(t.id)))

const store = existsSync(LYRICS) ? JSON.parse(readFileSync(LYRICS, 'utf8')) : {}
const now = Date.now()
function needsFetch(id) {
  const rec = store[String(id)]
  if (!rec) return true
  if (rec.miss) return FORCE || (now - (rec.fetchedAt || 0)) > missTtlMs(rec)   // re-check stale misses (30 d; 180 d if likely instrumental)
  return false                                                      // hit / instrumental → done
}

if (STATS) {
  let hit = 0, ovh = 0, instr = 0, miss = 0, likely = 0, unfetched = 0
  for (const t of tracks) {
    const rec = store[String(t.id)]
    if (!rec) unfetched++
    else if (rec.instrumental) instr++
    else if (rec.miss) { miss++; if (rec.likelyInstrumental) likely++ }
    else { hit++; if (rec.source === 'lyrics.ovh') ovh++ }
  }
  const total = tracks.length
  log(`STATS over ${total} tracks: lyrics=${hit} (${(100 * hit / total).toFixed(1)}%, ${ovh} from lyrics.ovh)  instrumental=${instr}  miss=${miss} (${likely} likely-instrumental)  unfetched=${unfetched}`)
  process.exit(0)
}

function persist() {
  const tmp = LYRICS + '.tmp'
  writeFileSync(tmp, JSON.stringify(store))
  renameSync(tmp, LYRICS)   // atomic — never a torn write
  persistLedger()
}

// Brief 177: record outcomes in the cross-job enrichment ledger
// (enrichment-ledger.json beside lyrics.json) so the scheduled catch-up can
// see lyrics state without opening this file's store. Best-effort by
// design — the ledger must never break the fetch; lyrics.json stays the
// authoritative lyrics store and this job's fetch decisions don't change.
const LEDGER = ledgerPath(STATE_DIR)
let _ledger = null
function recordLedger(id, outcome) {
  if (DRY) return
  try {
    if (!_ledger) _ledger = loadLedger(LEDGER)
    if (outcome === 'done') markLyricsDone(_ledger, id)
    else markLyricsAttempted(_ledger, id)
  } catch { /* ledger is a view, not the store — never fail the run over it */ }
}
function persistLedger() {
  if (DRY || !_ledger) return
  try { saveLedger(LEDGER, _ledger) } catch { /* best-effort, as above */ }
}

let processed = 0, hits = 0, instrumentals = 0, misses = 0, skipped = 0, errors = 0
let ovhHits = 0, ovhErrors = 0, likelyInstr = 0
log(`start: ${tracks.length} candidate tracks, store has ${Object.keys(store).length} entries${DRY ? ' (DRY — no writes)' : ''}`)

for (const t of tracks) {
  if (LIMIT && processed >= LIMIT) break
  const id = String(t.id)
  if (!needsFetch(id)) { skipped++; continue }

  processed++
  try {
    const { rec, via, ovhError } = await fetcher.lookup(t)
    store[id] = rec
    if (via === 'lrclib') {
      if (rec.instrumental) instrumentals++; else hits++
      recordLedger(id, 'done')
    } else if (via === 'lyrics.ovh') {
      ovhHits++
      log(`ovh hit id=${id} "${t.artist} — ${t.title}" (${rec.plain.length} chars)`)   // unverified-duration source: keep it auditable
      recordLedger(id, 'done')
    } else {
      misses++
      if (ovhError) ovhErrors++
      if (rec.likelyInstrumental) likelyInstr++
      recordLedger(id, 'attempted')
    }
  } catch (e) {
    errors++   // transient (timeout / 5xx) — do NOT store a miss; retry next run
    log(`err id=${id} "${t.artist} — ${t.title}": ${e.message || e}`)
  }
  if (processed % 25 === 0) { if (!DRY) persist(); log(`… ${processed} (lrclib=${hits} ovh=${ovhHits} instr=${instrumentals} miss=${misses} err=${errors})`) }
  await sleep(DELAY_MS)
}
if (!DRY) persist()
log(`likely-instrumental misses marked this run: ${likelyInstr} (retry after 180 days, never shown as Instrumental)`)
log(`DONE processed=${processed} lyrics=${hits + ovhHits} (lrclib=${hits} lyrics.ovh=${ovhHits}) instrumentals=${instrumentals} misses=${misses} (ovh errors=${ovhErrors}) skipped=${skipped} errors=${errors} | store=${Object.keys(store).length}`)
