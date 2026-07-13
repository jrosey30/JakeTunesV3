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
 *       descriptive User-Agent, 10s timeout, small delay, cached/resumable).
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_DIR = process.env.JT_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const LIB = join(STATE_DIR, 'library.json')
const LYRICS = join(STATE_DIR, 'lyrics.json')

const BASE = 'https://lrclib.net'
// Etiquette: LRCLIB asks for a descriptive User-Agent so the maintainer can
// identify heavy clients (mirrors the reference client lrcget's shape).
const UA = 'JakeTunes/1.0 (personal music library; +https://github.com/jaketunes)'
const TIMEOUT_MS = 20000   // LRCLIB latency is variable; be patient before aborting
const DELAY_MS = Number(process.env.LYRICS_DELAY_MS || 250)   // polite gap between calls
const MISS_TTL_MS = 30 * 24 * 3600 * 1000                     // re-check a known miss after 30 days
const log = (...a) => console.log(new Date().toISOString(), '[lyrics-fetch]', ...a)

const argv = process.argv.slice(2)
const getArg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const LIMIT = Number(getArg('--limit') || 0)
const ONLY_IDS = (getArg('--ids') || '').split(',').map(s => s.trim()).filter(Boolean)
const DRY = argv.includes('--dry')
const STATS = argv.includes('--stats')
const FORCE = argv.includes('--force')   // re-fetch stored misses regardless of TTL

// ── Query normalization (boosts the precise-lookup hit rate; storage always
// keys by track id and never depends on this, so over-cleaning only costs a
// match, never data integrity). Strips feat credits + remaster/version tags. ──
function cleanTitle(s) {
  return String(s || '')
    .replace(/\s*[([](feat\.?|ft\.?|featuring|with)\b[^)\]]*[)\]]/ig, '')
    .replace(/\s*[([][^)\]]*\b(remaster(ed)?|mono|stereo|deluxe|anniversary|bonus|reissue)\b[^)\]]*[)\]]/ig, '')
    .replace(/\s*-\s*(\d{4}\s+)?remaster(ed)?\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
function cleanArtist(s) {
  // Strip a trailing "feat./ft./featuring X" credit. The leading \s+ is
  // LOAD-BEARING: with \s* (zero-width ok), "ft" matches INSIDE words like
  // "Daft Punk" ("Da" + "ft Punk") → mangles the artist to "Da". Requiring
  // real whitespace before the token makes it only match a standalone word.
  return String(s || '').replace(/\s+(?:feat|ft|featuring)\.?\s+.*$/i, '').trim()
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// GET with a timeout + transient-retry. LRCLIB latency is variable and it can
// briefly 5xx/stall under load; retry aborts/network-errors/5xx up to 3 attempts
// with backoff so a slow window doesn't turn a real track into a missed fetch.
async function httpGet(url, attempt = 1) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal })
    if (r.status >= 500 && attempt < 3) { await sleep(1000 * attempt); return httpGet(url, attempt + 1) }
    return r
  } catch (e) {
    if (attempt < 3) { await sleep(1500 * attempt); return httpGet(url, attempt + 1) }
    throw e
  } finally { clearTimeout(to) }
}

// Precise lookup: single object on 200, { notFound } on 404, throw on transient.
// LRCLIB can return a COLD-CACHE 404 on a track's first-ever lookup and then
// serve it 200 on the next call — so a bare 404 is not trustworthy. Retry once
// after a beat before believing "not found". Only genuine misses pay this cost.
async function lrclibGet(title, artist, durSec) {
  const p = new URLSearchParams({ track_name: title, artist_name: artist })
  if (durSec >= 1 && durSec <= 3600) p.set('duration', String(durSec))
  const url = `${BASE}/api/get?${p.toString()}`
  let r = await httpGet(url)
  if (r.status === 200) return { hit: await r.json() }
  if (r.status === 404) {
    await sleep(1200)
    r = await httpGet(url)
    if (r.status === 200) return { hit: await r.json() }
    if (r.status === 404) return { notFound: true }
  }
  throw new Error(`get ${r.status}`)
}

// Fallback: array (may be []); /api/search has NO duration filter so we re-rank.
async function lrclibSearch(title, artist) {
  const p = new URLSearchParams({ track_name: title, artist_name: artist })
  const r = await httpGet(`${BASE}/api/search?${p.toString()}`)
  if (r.status !== 200) return []
  const arr = await r.json()
  return Array.isArray(arr) ? arr : []
}

// Pick the search candidate whose duration is within ±2s AND whose artist
// matches — never trust result[0] blindly (LRCLIB has junk/mislabeled rows).
function pickCandidate(arr, durSec, artist) {
  const na = norm(artist)
  let best = null, bestScore = Infinity
  for (const c of arr) {
    const cd = Number(c.duration) || 0
    if (durSec && Math.abs(cd - durSec) > 2) continue
    const naC = norm(c.artistName)
    if (!(na && naC && (naC.includes(na) || na.includes(naC)))) continue
    const score = durSec ? Math.abs(cd - durSec) : 0
    if (score < bestScore) { bestScore = score; best = c }
  }
  return best
}

// Turn an LRCLIB object into a grounded store record (or null if it has no
// usable lyrics). Instrumental hits are a definitive "no lyrics".
function recordFrom(obj) {
  if (obj && obj.instrumental) return { instrumental: true, source: 'lrclib', lrclibId: obj.id, fetchedAt: Date.now() }
  const plain = typeof obj?.plainLyrics === 'string' && obj.plainLyrics.trim() ? obj.plainLyrics : undefined
  const synced = typeof obj?.syncedLyrics === 'string' && obj.syncedLyrics.trim() ? obj.syncedLyrics : undefined
  if (!plain && !synced) return null
  return { plain, synced, source: 'lrclib', lrclibId: obj.id, fetchedAt: Date.now() }
}

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
  if (rec.miss) return FORCE || (now - (rec.fetchedAt || 0)) > MISS_TTL_MS   // re-check stale misses
  return false                                                      // hit / instrumental → done
}

if (STATS) {
  let hit = 0, instr = 0, miss = 0, unfetched = 0
  for (const t of tracks) {
    const rec = store[String(t.id)]
    if (!rec) unfetched++
    else if (rec.instrumental) instr++
    else if (rec.miss) miss++
    else hit++
  }
  const total = tracks.length
  log(`STATS over ${total} tracks: lyrics=${hit} (${(100 * hit / total).toFixed(1)}%)  instrumental=${instr}  miss=${miss}  unfetched=${unfetched}`)
  process.exit(0)
}

function persist() {
  const tmp = LYRICS + '.tmp'
  writeFileSync(tmp, JSON.stringify(store))
  renameSync(tmp, LYRICS)   // atomic — never a torn write
}

let processed = 0, hits = 0, instrumentals = 0, misses = 0, skipped = 0, errors = 0
log(`start: ${tracks.length} candidate tracks, store has ${Object.keys(store).length} entries${DRY ? ' (DRY — no writes)' : ''}`)

for (const t of tracks) {
  if (LIMIT && processed >= LIMIT) break
  const id = String(t.id)
  if (!needsFetch(id)) { skipped++; continue }

  const title = cleanTitle(t.title), artist = cleanArtist(t.artist)
  const durSec = Math.round((Number(t.duration) || 0) / 1000)
  processed++
  try {
    let rec = null
    const g = await lrclibGet(title, artist, durSec)
    if (g.hit) {
      rec = recordFrom(g.hit)
    } else if (g.notFound) {
      const cand = pickCandidate(await lrclibSearch(title, artist), durSec, artist)
      if (cand) rec = recordFrom(cand)
    }
    if (rec) {
      if (rec.instrumental) instrumentals++; else hits++
      store[id] = rec
    } else {
      store[id] = { miss: true, source: 'lrclib', fetchedAt: Date.now() }
      misses++
    }
  } catch (e) {
    errors++   // transient (timeout / 5xx) — do NOT store a miss; retry next run
    log(`err id=${id} "${t.artist} — ${t.title}": ${e.message || e}`)
  }
  if (processed % 25 === 0) { if (!DRY) persist(); log(`… ${processed} (lyrics=${hits} instr=${instrumentals} miss=${misses} err=${errors})`) }
  await sleep(DELAY_MS)
}
if (!DRY) persist()
log(`DONE processed=${processed} lyrics=${hits} instrumentals=${instrumentals} misses=${misses} skipped=${skipped} errors=${errors} | store=${Object.keys(store).length}`)
