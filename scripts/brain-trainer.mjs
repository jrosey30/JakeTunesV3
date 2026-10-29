#!/usr/bin/env node
/**
 * JakeTunes "Brain Trainer" — a nightly background exercise that teaches the
 * embedding brain to HEAR the music.
 *
 * The brain knows every track only by artist/title/album/genre/year — it has
 * no idea what anything actually SOUNDS like, which caps how well mixes,
 * vibe-matching, recommendations and Music Man chat can work. This job fixes
 * that a little every night: for a bounded batch of tracks, homemini's local
 * Gemma (free) writes a one-line sound/mood/energy descriptor; we fold it into
 * the track's embedding text and re-embed via OpenAI text-embedding-3-small
 * (the SAME 1536-dim space as the rest of the brain), then update embeddings.bin
 * in place. The existing desktop→NAS sync carries the richer brain to homemini,
 * so the mixes get smarter too.
 *
 * Most-played tracks first, so the brain learns the music Jake actually loves
 * first. Over ~a month the whole library is enriched; after that it only has to
 * catch newly-added tracks. Idempotent + resumable via brain-descriptors.json.
 * Backs embeddings.bin up before writing and self-verifies after — restores the
 * backup if the rewrite didn't round-trip. Bounded so it stays invisible.
 *
 * Run:  node scripts/brain-trainer.mjs            (default batch)
 *       BRAIN_BATCH=25 node scripts/brain-trainer.mjs   (small test batch)
 * Cost: Gemma is free (local); OpenAI embed is ~$0.000002/track (~2¢ for the
 *       whole library, once).
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, appendFileSync } from 'node:fs'
import { planMoodPrune } from './brain-prune.mjs'
import { writeBrainStatus } from './brain-status.mjs'
import { comparePurity, gateDecision, PURITY_MAX_REGRESSION } from './brain-purity.mjs'
import { pickBatch } from './brain-batch.mjs'
import { musicStreamActive, nightlyTrainerActive, untilMs, redescribeCandidates, candidateDescriptors, promoteNext, staleStaged, describeTrack, PROMPT_VERSION } from './brain-redescribe.mjs'
import { baseText, moodText, tempoEnergy } from '../src/common/embedding-text.ts'   // Brief 181: the text twins' ONE source of truth (the app imports it too)
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'

// STATE_DIR defaults to the desktop app's local dir, but JT_STATE_DIR lets the
// homemini nightly job point it at the NAS canonical (/Volumes/JakeShared/
// JakeTunesState) so the mini owns + writes the shared brain. See
// project_brain_homemini_migration.
const STATE_DIR = process.env.JT_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const LIB = join(STATE_DIR, 'library.json')
const EMB = join(STATE_DIR, 'embeddings.bin')
const MOOD = join(STATE_DIR, 'mood-index.bin')
const DESC = join(STATE_DIR, 'brain-descriptors.json')
const DESC_NEXT = join(STATE_DIR, 'brain-descriptors.next.json')   // staged re-describe (scripts/brain-redescribe.mjs)
const LYRICS = join(STATE_DIR, 'lyrics.json')   // grounded LRCLIB lyrics (scripts/lyrics-fetch.mjs)
const ENV = join(homedir(), 'JakeTunesV3', '.env')
const GEMMA_URL = process.env.GEMMA_URL || 'http://homemini:11434/api/generate'
// GEMMA_MODEL env-overridable (2026-08-23, the descriptor-upgrade program):
// the Mini carries gemma4:e4b (9.6GB) alongside the 4b — bigger model, same
// prompt, opt-in per run. Timeout scales with model size below.
const GEMMA_MODEL = process.env.GEMMA_MODEL || 'gemma3:4b'
const EMBED_URL = 'https://api.openai.com/v1/embeddings'
const EMBED_MODEL = 'text-embedding-3-small'
const EMBED_DIM = 1536
const BATCH = Number(process.env.BRAIN_BATCH || 300)
// A whole run's time budget (2026-10-12). New adds are no longer capped by
// BATCH (see pickBatch); this is what bounds a huge import night, so the
// trainer (02:00) is always finished well before brain-improve (03:05).
const MINUTES = Number(process.env.BRAIN_MINUTES || 40)
const MAGIC = 'EMBD', VERSION = 1

const log = (...a) => console.log(new Date().toISOString(), '[brain-trainer]', ...a)

// ── HEALTH REPORTING ─────────────────────────────────────────────────────────
// 2026-07-25: this job died on 2026-07-21 (the NAS dropped, so library.json and
// embeddings.bin were unreachable) and failed EVERY NIGHT for five nights while
// logging FATAL to a file nobody reads. Jake only found out because he noticed
// his mixes had gone stale. A nightly job that can fail silently for a week is
// not a working system.
//
// Every run now writes brain-status.json next to the brain — ok/failed, when,
// and why — and a failure additionally posts a macOS notification. The status
// file is the durable signal (any other process, or a future UI, can read
// "last successful run" and shout if it's older than a couple of days); the
// notification is the immediate one.
const STATUS = join(STATE_DIR, 'brain-status.json')
// The status file must ALSO land somewhere readable when STATE_DIR is the NAS
// and the NAS is exactly what's broken — otherwise the one job that knows about
// the outage can't report it. Local copy is the fallback.
const STATUS_LOCAL = join(homedir(), 'Library', 'Application Support', 'JakeTunes', 'brain-status.json')

function writeStatus(payload) {
  // Brief 176: the write itself lives in scripts/brain-status.mjs — the one
  // module that owns brain-status.json's shape, shared with the watchdog.
  writeBrainStatus([STATUS, STATUS_LOCAL], payload)
}

// Deliberately SEPARATE from the async notify() further down: this one is
// synchronous (so it lands before process.exit) and ignores BRAIN_QUIET — a
// bulk run may suppress progress pings, but never a failure.
function notifyFailure(title, message) {
  try {
    execFileSync('/usr/bin/osascript', ['-e',
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
      { timeout: 5000, stdio: 'ignore' })
  } catch { /* headless / no GUI session — the status file still carries it */ }
  // Brief 176: a failure also pushes to the phone via the SAME ntfy channel
  // notify() uses on success/stall (topic file ~/.config/jaketunes/ntfy-topic).
  // Synchronous curl because fatal() exits immediately after this returns —
  // an async fetch would be cut off by process.exit. Best-effort throughout.
  try {
    const tf = join(homedir(), '.config', 'jaketunes', 'ntfy-topic')
    if (existsSync(tf)) {
      const topic = readFileSync(tf, 'utf8').trim()
      if (topic) {
        const url = topic.startsWith('http') ? topic : `https://ntfy.sh/${topic}`
        execFileSync('/usr/bin/curl', ['-s', '-m', '8',
          '-H', `Title: ${title.replace(/[^\x20-\x7E]/g, '').trim() || 'Brain Trainer'}`,
          '-d', message, url], { timeout: 10000, stdio: 'ignore' })
      }
    }
  } catch { /* phone push best-effort — the status file still carries it */ }
}

/** Log loudly, record the failure durably, notify, and exit non-zero. */
function fatal(reason) {
  log('FATAL: ' + reason)
  writeStatus({ ok: false, error: reason })
  notifyFailure('JakeTunes brain: nightly training FAILED', reason)
  process.exit(1)
}

// ── QUALITY GATE (Brief 179) ─────────────────────────────────────────────────
// Integrity checks (dim/count/round-trip) prove the candidate index is
// INTACT, not that it is GOOD — a degraded embed model would pass them all
// while the brain quietly got worse every night. Before any publish, score
// the candidate's sampled neighbour purity against the currently-published
// index (scripts/brain-purity.mjs); a regression beyond the threshold
// BLOCKS the publish: previous index kept, failure status written, alert
// pushed. The gate only ever blocks — it never writes an index itself.
// A gate that cannot score (empty sample, unreadable previous index)
// abstains and logs, rather than wedging the nightly job.
function purityGate(candidateMap, meta, label) {
  try {
    const prev = readEmb(EMB)
    const maxRegression = Number(process.env.BRAIN_PURITY_MAX_REGRESSION) || PURITY_MAX_REGRESSION
    const cmp = comparePurity(candidateMap, prev.map, meta, { sampleSize: 100, k: 10 })
    const decision = gateDecision(cmp, maxRegression)
    log(`purity gate (${label}):`, decision.reason)
    if (decision.block) {
      writeStatus({ ok: false, gateBlocked: true, error: `purity gate blocked the ${label} publish: ${decision.reason}`,
        candidatePurity: cmp.candidate.purity, previousPurity: cmp.previous.purity })
      notifyFailure('JakeTunes brain: publish BLOCKED by purity gate', decision.reason)
    }
    return decision
  } catch (e) {
    log(`purity gate (${label}) could not score — abstaining:`, e.message)
    return { block: false, reason: `gate abstained: ${e.message}` }
  }
}

const KEY = (existsSync(ENV)
  ? (readFileSync(ENV, 'utf8').split('\n').find(l => l.startsWith('OPENAI_API_KEY=')) || '').slice('OPENAI_API_KEY='.length).trim().replace(/^["']|["']$/g, '')
  : '') || process.env.OPENAI_API_KEY || ''
if (!KEY) fatal('no OPENAI_API_KEY (checked ~/JakeTunesV3/.env and env)')

// ── embeddings.bin (EMBD binary format, shared with src/main/ai/embeddings.ts) ──
// ⚠️ TWIN: src/main/ai/embeddings.ts parseEmbeddingsBlob (desktop) and
// ~/JakeTunesMobile/backend/src/util/embeddingsBlob.ts parseEmbeddingsBlob (phone backend) parse
// this same format — a format or guard change here must be mirrored there.
function readEmb(path) {
  const buf = readFileSync(path)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('embeddings.bin: bad magic')
  const dim = buf.readUInt16LE(6), count = buf.readUInt32LE(8), rec = 4 + dim * 4
  // A short SMB read must be FATAL, never tolerated: on 2026-08-25 a flapping
  // mount handed readFileSync 8510 of 9790 records without an error, the
  // silent partial parse became the in-memory map, and the nightly write
  // amputated 1280 vectors from the live brain. The header count is the
  // truth — if the bytes don't cover it, this read cannot be trusted.
  if (buf.length < 12 + count * rec) throw new Error(`${path}: truncated read — header says ${count} vectors but bytes cover only ${Math.floor((buf.length - 12) / rec)} (flaky mount?)`)
  const map = new Map(); let off = 12
  for (let i = 0; i < count && off + rec <= buf.length; i++) {
    const id = buf.readUInt32LE(off); off += 4
    const v = new Float32Array(dim)
    for (let j = 0; j < dim; j++) { v[j] = buf.readFloatLE(off); off += 4 }
    map.set(id, v)
  }
  return { map, dim }
}
function writeEmb(path, map) {
  const rec = 4 + EMBED_DIM * 4
  const buf = Buffer.alloc(12 + map.size * rec)
  buf.write(MAGIC, 0, 4, 'ascii'); buf.writeUInt16LE(VERSION, 4); buf.writeUInt16LE(EMBED_DIM, 6); buf.writeUInt32LE(map.size, 8)
  let off = 12, written = 0
  for (const [id, v] of map) {
    if (v.length !== EMBED_DIM) continue
    buf.writeUInt32LE(id, off); off += 4
    for (let j = 0; j < EMBED_DIM; j++) { buf.writeFloatLE(v[j], off); off += 4 }
    written++
  }
  const tmp = path + '.train.tmp'
  writeFileSync(tmp, buf.subarray(0, off)); renameSync(tmp, path)
  return written
}

// The brain's texts — baseText (main index), moodText (mood index) and
// tempoEnergy (the tempo line inside moodText) — are imported from
// src/common/embedding-text.ts, the ONE source of truth the app also uses
// (Brief 181). They used to be hand-synced twins defined here; the twins
// had already drifted on untrimmed string fields. Do not redefine them
// locally — edit the shared module (and bump TEMPO_ENCODING_VERSION when
// tempoEnergy's output changes).

function readMood() { return existsSync(MOOD) ? readEmb(MOOD).map : new Map() }

// Embed + fold mood vectors with the same backup+verify discipline as the
// main brain. entries: [{ id, text }] (callers filter empty texts). Never
// throws — a mood failure must not sink the nightly enrichment.
async function updateMoodIndex(entries, label) {
  if (!entries.length) return 0
  try {
    const mmap = readMood()
    const before = mmap.size
    const vecs = await openaiEmbed(entries.map(e => e.text))
    if (existsSync(MOOD)) copyFileSync(MOOD, MOOD + '.bak')
    let n = 0
    for (let i = 0; i < entries.length; i++) { const v = vecs[i]; if (v) { mmap.set(Number(entries[i].id), v); n++ } }
    const written = writeEmb(MOOD, mmap)
    const check = readEmb(MOOD)
    if (check.dim !== EMBED_DIM || check.map.size < before) throw new Error(`verify failed: dim=${check.dim} count=${check.map.size} (>=${before})`)
    log(`mood-index ${label}: ${n} vector(s) updated (${written} total)`)
    return n
  } catch (e) {
    log(`mood-index ${label} FAILED —`, e.message, existsSync(MOOD + '.bak') ? '— restoring backup' : '')
    try { if (existsSync(MOOD + '.bak')) copyFileSync(MOOD + '.bak', MOOD) } catch { /* keep going */ }
    return 0
  }
}

// The prompt, the stock-word post-check and its one retry live in
// scripts/brain-redescribe.mjs (describeTrack / describePrompt, PROMPT_VERSION)
// so tests and scratch A/Bs run the exact same flow without this file's
// import-time checks. Here: only the Ollama call.
async function gemmaGenerate(prompt) {
  const r = await fetch(GEMMA_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // think:false — thinking models (qwen3) otherwise spend the whole token
    // budget inside <think> and return an empty response (2026-08-23 A/B lesson).
    body: JSON.stringify({ model: GEMMA_MODEL, prompt, stream: false, think: false, options: { temperature: 0.5, num_predict: 90 } }),
    signal: AbortSignal.timeout(GEMMA_MODEL === 'gemma3:4b' ? 30000 : 120000),
  })
  if (!r.ok) throw new Error(`gemma ${r.status}`)
  return (await r.json()).response
}

async function gemmaDescribe(t) {
  return describeTrack(t, gemmaGenerate)
}

// The main brain's text for a track. Until 2026-10-10 this appended Gemma's
// sound/mood descriptor (d) and the lyrics-derived meaning (m); the main brain
// is plain now (see baseText), so both are ignored here — d still feeds the
// mood index through moodText. Kept as the one entry point every re-embed
// path calls, so none of them can drift back to the old recipe.
function enrichedText(t, _d, _m) {
  return baseText(t)
}

// Sibling of gemmaDescribe: read a track's real lyrics and write ONE compact
// line about what the SONG IS ABOUT (themes/subject/arc) — an interpretation,
// NOT the words. The prompt forbids quoting so we store meaning, not lyrics
// (copyright + it's what the brain needs). Same 8..400 gate + null-on-failure
// as gemmaDescribe, so a lyric-less / failed track adds no meaning line.
async function gemmaMeaning(t, lyricText) {
  const prompt = `You are a music analyst. Read the lyrics below and describe in ONE line (max 24 words) what the SONG IS ABOUT: its central theme(s), subject, emotional arc, and the narrator's stance. Describe the MEANING abstractly — do NOT quote or paraphrase specific lyric lines. Output ONLY the description, no preamble.\n\nTrack: ${t.artist || '?'} — ${t.title || '?'}\nLyrics:\n${String(lyricText).slice(0, 3000)}`
  const r = await fetch(GEMMA_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GEMMA_MODEL, prompt, stream: false, options: { temperature: 0.4, num_predict: 90 } }),
    signal: AbortSignal.timeout(GEMMA_MODEL === 'gemma3:4b' ? 30000 : 120000),
  })
  if (!r.ok) throw new Error(`gemma-meaning ${r.status}`)
  let m = String((await r.json()).response || '').trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '')
  return (m.length >= 8 && m.length <= 400) ? m : null
}

async function openaiEmbed(texts) {
  const out = []
  for (let i = 0; i < texts.length; i += 100) {
    const chunk = texts.slice(i, i + 100)
    // A full re-embed is millions of tokens and hits the account's
    // tokens-per-minute cap (measured 2026-10-10: two concurrent re-embeds
    // failed in seconds with 429). Wait as long as OpenAI asks, then retry.
    let r
    for (let attempt = 0; ; attempt++) {
      r = await fetch(EMBED_URL, {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: chunk }), signal: AbortSignal.timeout(60000),
      })
      if (r.status !== 429 || attempt >= 8) break
      const body = await r.text()
      const m = /try again in ([\d.]+)(ms|s)/.exec(body)
      const wait = m ? (m[2] === 'ms' ? Number(m[1]) : Number(m[1]) * 1000) + 500 : 15000
      await new Promise((res) => setTimeout(res, wait))
    }
    if (!r.ok) throw new Error(`openai ${r.status} ${(await r.text()).slice(0, 160)}`)
    for (const row of (await r.json()).data) {
      if (Array.isArray(row.embedding) && row.embedding.length === EMBED_DIM) out.push(Float32Array.from(row.embedding))
      else out.push(null)
    }
  }
  return out
}

// Progress reports: macOS notification (same osascript pattern as the other
// JakeTunes agents) + a phone push via ntfy when the health-watchdog's topic
// file is configured. Awaited so the push actually flushes before exit.
async function notify(title, message) {
  if (process.env.BRAIN_QUIET) return   // bulk catch-up runs suppress per-batch pings
  try {
    execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], { timeout: 8000 })
  } catch { /* notifications best-effort */ }
  try {
    const tf = join(homedir(), '.config', 'jaketunes', 'ntfy-topic')
    if (existsSync(tf)) {
      const topic = readFileSync(tf, 'utf8').trim()
      if (topic) {
        const url = topic.startsWith('http') ? topic : `https://ntfy.sh/${topic}`
        await fetch(url, { method: 'POST', headers: { Title: title.replace(/[^\x20-\x7E]/g, '').trim() || 'Brain Trainer' }, body: message, signal: AbortSignal.timeout(8000) }).catch(() => {})
      }
    }
  } catch { /* phone push best-effort */ }
}

async function report(enrichedThisRun, doneTotal, total, sample) {
  const remaining = Math.max(0, total - doneTotal)
  const pct = total ? Math.round((doneTotal / total) * 100) : 0
  if (remaining === 0) {
    await notify('🧠 Brain Trainer — fully trained! 🎉',
      `All ${total.toLocaleString()} tracks now understood by sound + mood. Your brain's a wiz — from here I'll just keep new music fresh.`)
    return
  }
  const nights = Math.ceil(remaining / BATCH)
  const taste = sample ? `\nJust learned ${sample.artist} — ${sample.title}: “${sample.d.slice(0, 90)}”` : ''
  await notify('🧠 Brain Trainer',
    `+${enrichedThisRun} learned tonight · ${doneTotal.toLocaleString()}/${total.toLocaleString()} (${pct}%) · ~${nights} night${nights === 1 ? '' : 's'} to go${taste}`)
}

const OVERRIDES = join(STATE_DIR, 'metadata-overrides.json')

/**
 * Layer metadata-overrides.json onto the raw library tracks, in place.
 * ⚠️ TWIN: src/renderer/App.tsx (metadata overrides apply) — keep in sync.
 *
 * JakeTunes treats library.json as the master and metadata-overrides.json as
 * the layer on top; the app merges them AT LOAD. The audio analyser writes
 * bpm/keyRoot/keyMode/camelotKey only into the override layer, and Cynthia's
 * genre corrections live there too. library.json is rewritten only when the
 * renderer happens to save, which is not guaranteed to have happened — its copy
 * can be arbitrarily old.
 *
 * This trainer read library.json RAW, so it learned stale facts. After the
 * 2026-08-02 analyser fix corrected 4,027 tempos (846 of them by a full
 * octave), the canonical library.json still called System Of A Down's "Sad
 * Statue" 86.1 BPM where the analyser had measured 172.3 — so it would have
 * been embedded as "slow, spacious, downtempo, good for winding down", the
 * exact wrongness the fix set out to remove.
 *
 * Fingerprint validation is copied deliberately, not defensively: track IDs
 * shift when the iTunesDB track set changes, and applying an override whose
 * fingerprint no longer matches was the root cause of the hybrid-row metadata
 * bug. v1 entries (no `fields`) can't be validated at all, so they're ignored.
 */
const NUMERIC_OVERRIDE_FIELDS = new Set([
  'playCount', 'rating', 'duration', 'fileSize',
  'year', 'trackNumber', 'trackCount', 'discNumber', 'discCount',
  'lastPlayedAt', 'skipCount',
  'bpm', 'audioAnalysisAt', 'keyConfidence',
])

/**
 * Attach group members to tracks from STATE_DIR/artist-members.json
 * (scripts/artist-members.mjs, grounded in MusicBrainz). Missing file = no
 * members anywhere; the text is unchanged for every track.
 */
function applyArtistMembers(tracks) {
  const MEMBERS = join(STATE_DIR, 'artist-members.json')
  let m = {}
  try { m = JSON.parse(readFileSync(MEMBERS, 'utf8')) } catch { return 0 }
  const fold = (x) => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const byTag = new Map()
  for (const [tag, v] of Object.entries(m)) if (v && Array.isArray(v.members) && v.members.length) byTag.set(fold(tag), v.members)
  let n = 0
  for (const t of tracks) {
    const members = byTag.get(fold(t.artist)) || byTag.get(fold(t.albumArtist))
    if (members) { t.members = members; n++ }
  }
  log(`artist members: ${byTag.size} group(s) known, ${n} track(s) carry members`)
  return n
}

function applyMetadataOverrides(tracks) {
  if (!existsSync(OVERRIDES)) return
  let ov
  try { ov = JSON.parse(readFileSync(OVERRIDES, 'utf8')) } catch (e) {
    log('metadata-overrides.json unreadable — training on library.json alone:', e.message)
    return
  }
  let applied = 0, stale = 0, legacy = 0
  for (const t of tracks) {
    const entry = ov[String(t.id)]
    if (!entry || typeof entry !== 'object') continue
    if (!entry.fields) { legacy++; continue }
    const fp = `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`
    if (entry.fp !== fp) { stale++; continue }
    for (const [field, value] of Object.entries(entry.fields)) {
      t[field] = NUMERIC_OVERRIDE_FIELDS.has(field) && typeof value === 'string' ? (Number(value) || 0) : value
    }
    applied++
  }
  log(`metadata overrides: applied ${applied}${stale ? `, skipped ${stale} stale` : ''}${legacy ? `, ${legacy} legacy` : ''}`)
}

/** Bump when tempoEnergy()'s output changes — every track re-embeds.
 *
 *  MODULE scope on purpose. It used to be declared partway down main(), while
 *  `--reembed-all` (higher up the same function) already referenced it: a
 *  temporal dead zone, so that flag threw "Cannot access
 *  'TEMPO_ENCODING_VERSION' before initialization" — but only AFTER paying
 *  OpenAI to embed all ~8,800 tracks and writing the .bak, so it burned the
 *  money and saved nothing. Up here it cannot be shadowed by execution order. */
const TEMPO_ENCODING_VERSION = 3   // v3: omit low-confidence key/Camelot from embed text

// Remove vibe vectors whose track has left the library (ask #1 of the nightly
// brain exercise, PROPOSAL-mood-import-clobber.md fix 2). Identity-gated and
// capped by planMoodPrune: a short/torn library read refuses instead of
// deleting. Pre-prune copy kept at mood-index.bin.prune.bak (one-night undo);
// every pruned id is appended to brain-prune-ledger.jsonl. A pruned track that
// comes back gets its vector re-made by moodGapFill below.
function pruneMoodOrphans(tracks, { anyway = false } = {}) {
  if (!existsSync(MOOD)) return 0
  let backedUp = false
  try {
    const mmap = readMood()
    const before = mmap.size
    let prune
    if (anyway) {
      const lib = new Set(tracks.map(t => Number(t.id)))
      if (lib.size === 0) { log('mood-index prune REFUSED — library.json has no tracks'); return 0 }
      prune = [...mmap.keys()].filter(id => !lib.has(id))
    } else {
      const plan = planMoodPrune(mmap.keys(), tracks.map(t => t.id))
      if (plan.refused) { log(`mood-index prune REFUSED — ${plan.refused}`); return 0 }
      prune = plan.prune
    }
    if (!prune.length) return 0
    copyFileSync(MOOD, MOOD + '.prune.bak'); backedUp = true
    for (const id of prune) mmap.delete(id)
    writeEmb(MOOD, mmap)
    const check = readEmb(MOOD)
    if (check.dim !== EMBED_DIM || check.map.size !== before - prune.length) {
      throw new Error(`verify failed: dim=${check.dim} count=${check.map.size} (expected ${before - prune.length})`)
    }
    appendFileSync(join(STATE_DIR, 'brain-prune-ledger.jsonl'), JSON.stringify({ at: new Date().toISOString(), index: 'mood-index.bin', before, after: check.map.size, ids: prune }) + '\n')
    log(`mood-index prune: removed ${prune.length} vector(s) for tracks no longer in the library (${before} → ${check.map.size}); undo copy at mood-index.bin.prune.bak`)
    return prune.length
  } catch (e) {
    log('mood-index prune FAILED —', e.message, backedUp ? '— restoring the pre-prune copy' : '— nothing was changed')
    if (backedUp) { try { copyFileSync(MOOD + '.prune.bak', MOOD) } catch { /* keep going */ } }
    return 0
  }
}

// Self-heal: an in-library track that already has a Gemma descriptor but no
// vibe vector (pruned while it was briefly out of the library, or lost to an
// old clobber) would otherwise never get one back — the nightly pass only
// writes vectors for tracks it describes THAT night. Capped; usually 0.
async function moodGapFill(tracks, desc) {
  if (!existsSync(MOOD)) return 0
  const GAP_CAP = Number(process.env.BRAIN_MOOD_GAP_CAP) || 200
  const mmap = readMood()
  const entries = tracks
    .filter(t => (t.artist || t.title) && desc[String(t.id)]?.d && !mmap.has(Number(t.id)))
    .slice(0, GAP_CAP)
    .map(t => ({ id: t.id, text: moodText(t, desc[String(t.id)].d) }))
    .filter(e => e.text)
  if (!entries.length) return 0
  return updateMoodIndex(entries, 'gap-fill')
}

// The NAS can be slow to come back after a power blip; the trainer used to
// FATAL at 2:00 and lose the night (9 nights in a row, 9/27-10/5). Wait for
// the state dir, checking each minute, before giving up.
async function waitForStateDir() {
  const minutes = Number(process.env.BRAIN_MOUNT_WAIT_MIN ?? 60)
  for (let i = 0; i < minutes && !(existsSync(LIB) && existsSync(EMB)); i++) {
    if (i === 0) log(`state dir not there yet (${STATE_DIR}) — waiting up to ${minutes} min for the NAS`)
    await new Promise(r => setTimeout(r, 60_000))
  }
}

async function main() {
  await waitForStateDir()
  const deadline = Date.now() + MINUTES * 60_000
  if (!existsSync(LIB) || !existsSync(EMB)) fatal(`library.json or embeddings.bin missing under ${STATE_DIR} — is the NAS mounted?`)
  const libRaw = JSON.parse(readFileSync(LIB, 'utf8'))
  const tracks = Array.isArray(libRaw) ? libRaw : (libRaw.tracks || [])
  applyMetadataOverrides(tracks)
  applyArtistMembers(tracks)
  const { map, dim } = readEmb(EMB)
  if (dim !== EMBED_DIM) fatal(`embeddings dim ${dim} != ${EMBED_DIM}`)
  const startCount = map.size
  const desc = existsSync(DESC) ? JSON.parse(readFileSync(DESC, 'utf8')) : {}
  const done = new Set(Object.keys(desc))
  const total = tracks.filter(t => t.artist || t.title).length

  // Count only descriptors that still belong to a track in the library.
  //
  // desc keeps entries for tracks that have since left the library, and those
  // orphans were being counted as progress: on 2026-07-29 the status read
  // "8784 / 8761" — over 100% — and since remaining = max(0, total - done), it
  // announced "Fully trained" while 51 real songs had never been described at
  // all. A health file that overstates itself is worse than none; this is the
  // same trap the tempo-catchup log line was rewritten to avoid.
  //
  // Deliberately NOT pruning the orphan DESCRIPTORS. (The mood-index prune
  // below is separate and capped by planMoodPrune for exactly this reason.)
  // library.json is on the NAS and has
  // been observed torn mid-write; a transiently short read would make this
  // delete descriptors permanently. Counting honestly is free and safe —
  // reclaiming the space is a separate, deliberate job.
  const libIds = new Set(tracks.map(t => String(t.id)))
  const enrichedCount = () => Object.keys(desc).reduce((n, k) => n + (libIds.has(k) ? 1 : 0), 0)
  const orphanCount = () => Object.keys(desc).length - enrichedCount()

  // Mood-index hygiene, every run (including the quiet "nothing to do" nights):
  // prune vectors for tracks that left the library, then re-make any missing
  // vector for a described track that is in it.
  if (process.argv.includes('--prune-mood-orphans-anyway')) {
    pruneMoodOrphans(tracks, { anyway: true })
    return
  }
  pruneMoodOrphans(tracks)
  await moodGapFill(tracks, desc)

  // Grounded lyrics sidecar (written by scripts/lyrics-fetch.mjs, mirrored from
  // the laptop). lyricTextFor returns the plain lyric text (synced cues stripped)
  // for a track, or null when there are no lyrics / it's an instrumental / a miss
  // — so meaning is only ever derived from real words, never fabricated.
  const lyrics = existsSync(LYRICS) ? JSON.parse(readFileSync(LYRICS, 'utf8')) : {}
  const lyricTextFor = (id) => {
    const rec = lyrics[String(id)]
    if (!rec || rec.miss || rec.instrumental) return null
    let txt = rec.plain || (rec.synced ? rec.synced.replace(/^\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]\s?/gm, '') : '')
    txt = String(txt || '').trim()
    return txt.length >= 20 ? txt : null
  }

  // 4.5: fold the AI genre taxonomy into the embed text. Subgenres live in
  // metadata-overrides.json (fields.subgenre / subgenrePath), not library.json,
  // so load + merge them onto the tracks here; baseText() appends them.
  const OV = join(STATE_DIR, 'metadata-overrides.json')
  if (existsSync(OV)) {
    try {
      const ov = JSON.parse(readFileSync(OV, 'utf8'))
      const sub = new Map()
      for (const [id, e] of Object.entries(ov)) {
        const f = e && e.fields
        if (f && f.subgenre) sub.set(String(id), { subgenre: f.subgenre, subgenrePath: f.subgenrePath || f.subgenre })
      }
      for (const t of tracks) { const s = sub.get(String(t.id)); if (s) { t.subgenre = s.subgenre; t.subgenrePath = s.subgenrePath } }
      log(`taxonomy: merged subgenres onto ${tracks.filter(t => t.subgenre).length} of ${tracks.length} tracks`)
    } catch (e) { log('subgenre merge skipped:', e.message) }
  }

  // On-demand status check (no enrichment): `node brain-trainer.mjs --status`
  if (process.argv.includes('--status')) {
    const done = enrichedCount(), remaining = Math.max(0, total - done)
    const pct = total ? Math.round((done / total) * 100) : 0, nights = Math.ceil(remaining / BATCH)
    const msg = remaining === 0
      ? `Fully trained — all ${total.toLocaleString()} tracks understood by sound + mood.`
      : `${done.toLocaleString()}/${total.toLocaleString()} (${pct}%) tracks taught · ~${nights} night${nights === 1 ? '' : 's'} left at ${BATCH}/night.`
    await notify('🧠 Brain Trainer — status', msg)
    log('status:', msg)
    return
  }

  // Re-describe with the CURRENT model (2026-08-23, Jake: "if the e4b wins
  // upgrade the whole library overnight"; STAGED since 2026-10-27, see
  // scripts/brain-redescribe.mjs). Writes brain-descriptors.next.json ONLY —
  // the live store and both indexes are untouched until `--promote-next`,
  // which runs after the brain-eval harness has scored a candidate mood index
  // (`--mood-candidate`) against the baseline ("the models absolutely cannot
  // be getting worse"). Resumable: every staged entry records its model (`gm`),
  // so a multi-night run continues where it stopped. `--until HH:MM` ends the
  // night's window. YIELD RULE: this is the always-on serving box — before
  // every call we check for a MUSIC transcode (cable playout's video ffmpeg
  // runs 24/7 and does not count), for the 02:00 nightly trainer, and for
  // critical memory pressure; any one unloads the model until the coast is clear.
  if (process.argv.includes('--redescribe-all')) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const ua = process.argv.indexOf('--until')
    const stopAt = ua > 0 ? untilMs(process.argv[ua + 1]) : Infinity
    const busy = () => {
      let ps = ''
      try { ps = execFileSync('/bin/ps', ['-axo', 'command']).toString() } catch { /* can't tell → not busy */ }
      if (musicStreamActive(ps)) return 'music is streaming'
      if (nightlyTrainerActive(ps)) return 'the nightly trainer is running'
      try {
        const lvl = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).toString().trim())
        if (lvl >= 4) return 'memory pressure is critical'
      } catch { /* not macOS / no sysctl → skip */ }
      return null
    }
    const gemmaUnload = async () => {
      try {
        await fetch(GEMMA_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: GEMMA_MODEL, keep_alive: 0 }), signal: AbortSignal.timeout(15000) })
      } catch { /* best-effort */ }
    }
    const next = existsSync(DESC_NEXT) ? JSON.parse(readFileSync(DESC_NEXT, 'utf8')) : {}
    const persistNext = () => { writeFileSync(DESC_NEXT + '.tmp', JSON.stringify(next)); renameSync(DESC_NEXT + '.tmp', DESC_NEXT) }
    const cands = redescribeCandidates(tracks, desc, next, GEMMA_MODEL)
    const redo = staleStaged(next).length
    log(`redescribe-all: ${cands.length} track(s) need ${GEMMA_MODEL} descriptors from prompt v${PROMPT_VERSION}${redo ? ` (${redo} staged by an older prompt go first)` : ''} (staged in ${DESC_NEXT}${Number.isFinite(stopAt) ? `, window ends ${new Date(stopAt).toLocaleTimeString()}` : ''})`)
    let n = 0, fails = 0, stopped = false
    const t0 = Date.now()
    for (const t of cands) {
      if (Date.now() >= stopAt) { stopped = true; break }
      let why
      while ((why = busy())) {
        log(`${why} — yielding (model unloaded), rechecking in 2 min`)
        persistNext()
        await gemmaUnload()
        await sleep(120000)
        if (Date.now() >= stopAt) break
      }
      if (Date.now() >= stopAt) { stopped = true; break }
      try {
        const d = await gemmaDescribe(t)
        if (d) { next[String(t.id)] = { d, gm: GEMMA_MODEL, pv: PROMPT_VERSION, at: new Date().toISOString() }; n++ } else fails++
      } catch (err) { fails++; log(`describe failed id=${t.id}: ${err.message}`) }
      if ((n + fails) % 50 === 0) {
        persistNext()
        const rate = (Date.now() - t0) / Math.max(1, n + fails)
        log(`redescribe-all: ${n + fails}/${cands.length} (${fails} fails) · ${Math.round(rate)}ms/track · ~${Math.round((cands.length - n - fails) * rate / 3600000 * 10) / 10}h of work left`)
      }
    }
    persistNext()
    await gemmaUnload()
    const left = cands.length - n - fails
    writeStatus({ ok: true, mode: 'redescribe-all', model: GEMMA_MODEL, staged: n, fails, left, of: cands.length })
    log(stopped
      ? `redescribe-all: window over — ${n} staged tonight (${fails} fails), ${left} left for the next night.`
      : `redescribe-all DONE: ${n}/${cands.length} staged with ${GEMMA_MODEL} (${fails} fails). Next: --mood-candidate, score it, then --promote-next.`)
    return
  }

  // Candidate mood index for the eval gate: `--mood-candidate <file>` builds a
  // full mood index from the live descriptors with the staged ones laid over
  // them (`--use-current` = live only, the like-for-like baseline) and writes
  // it to <file>. Never touches mood-index.bin. One OpenAI embed pass.
  const mc = process.argv.indexOf('--mood-candidate')
  if (mc > 0) {
    const out = process.argv[mc + 1]
    if (!out || out.startsWith('--')) fatal('--mood-candidate needs an output file')
    if (out === MOOD) fatal('--mood-candidate must not write the live mood-index.bin')
    const next = existsSync(DESC_NEXT) ? JSON.parse(readFileSync(DESC_NEXT, 'utf8')) : {}
    const dmap = candidateDescriptors(desc, next, { useCurrent: process.argv.includes('--use-current') })
    const entries = tracks.filter(t => t.artist || t.title)
      .map(t => ({ id: t.id, text: moodText(t, dmap[String(t.id)]) })).filter(e => e.text)
    log(`mood-candidate: embedding ${entries.length} tracks (${Object.keys(next).length - staleStaged(next).length} staged descriptors at prompt v${PROMPT_VERSION}${process.argv.includes('--use-current') ? ' IGNORED, --use-current' : ''})`)
    const vecs = await openaiEmbed(entries.map(e => e.text))
    const cmap = new Map()
    for (let i = 0; i < entries.length; i++) if (vecs[i]) cmap.set(Number(entries[i].id), vecs[i])
    const written = writeEmb(out, cmap)
    log(`mood-candidate: wrote ${written} vectors to ${out}`)
    return
  }

  // Publish the staged descriptors (only after the candidate passed the eval):
  // merge them into the live store (backup first) and re-embed their mood
  // vectors through updateMoodIndex's backup + verify + restore.
  if (process.argv.includes('--promote-next')) {
    if (!existsSync(DESC_NEXT)) fatal(`--promote-next: nothing staged (${DESC_NEXT} missing)`)
    const next = JSON.parse(readFileSync(DESC_NEXT, 'utf8'))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    if (existsSync(DESC)) copyFileSync(DESC, `${DESC}.pre-promote-${stamp}.bak`)
    const changed = promoteNext(desc, next)
    // Staged by an older prompt (e.g. night 1's "Gritty, mid-tempo" lines):
    // never promoted. Their tracks stay to-do for --redescribe-all.
    const skipped = staleStaged(next)
    if (skipped.length) log(`promote-next: skipping ${skipped.length} staged descriptor(s) from an older prompt (current v${PROMPT_VERSION})`)
    writeFileSync(DESC + '.tmp', JSON.stringify(desc)); renameSync(DESC + '.tmp', DESC)
    const byId = new Map(tracks.map(t => [String(t.id), t]))
    const entries = changed.filter(id => byId.has(id))
      .map(id => ({ id, text: moodText(byId.get(id), desc[id]?.d) })).filter(e => e.text)
    const n = await updateMoodIndex(entries, 'promote-next')
    renameSync(DESC_NEXT, `${DESC_NEXT}.promoted-${stamp}`)
    writeStatus({ ok: true, mode: 'promote-next', promoted: changed.length, skippedStalePrompt: skipped.length, moodVectors: n })
    log(`promote-next: ${changed.length} descriptor(s) promoted, ${n} mood vector(s) re-embedded. Backup: ${DESC}.pre-promote-${stamp}.bak`)
    return
  }

  // Full re-embed (no new Gemma calls): rebuild EVERY track's vector with the
  // tempo/energy facts now in baseText + its existing descriptor. One-shot fix
  // to teach the live brain tempo/mood: `node brain-trainer.mjs --reembed-all`.
  if (process.argv.includes('--reembed-all')) {
    const cands = tracks.filter(t => (t.artist || t.title))
    log(`reembed-all: re-embedding ${cands.length} tracks with grounded tempo/energy facts (no Gemma)…`)
    const texts = cands.map(t => {
      const e = desc[String(t.id)]
      return enrichedText(t, e?.d, e?.m)   // base + sound/mood + lyrics-meaning (each gated)
    })
    const vecs = await openaiEmbed(texts)
    copyFileSync(EMB, EMB + '.bak')
    let n = 0
    for (let i = 0; i < cands.length; i++) { const v = vecs[i]; if (v) { map.set(Number(cands[i].id), v); const e = desc[String(cands[i].id)]; if (e) { e.te = (Number(cands[i].bpm) || 0) > 0 ? TEMPO_ENCODING_VERSION : false; e.teb = Number(cands[i].bpm) || 0 } n++ } }
    const gate = purityGate(map, new Map(tracks.map(t => [Number(t.id), { artist: t.artist, genre: t.genre }])), 'reembed-all')
    if (gate.block) throw new Error(`purity gate blocked the reembed-all publish: ${gate.reason}`)
    const written = writeEmb(EMB, map)
    try {
      const check = readEmb(EMB)
      if (check.dim !== EMBED_DIM || check.map.size < startCount) throw new Error(`verify failed: dim=${check.dim} count=${check.map.size} (>=${startCount})`)
    } catch (e) { log('VERIFY FAILED —', e.message, '— restoring backup'); copyFileSync(EMB + '.bak', EMB); throw e }
    writeFileSync(DESC + '.tmp', JSON.stringify(desc)); renameSync(DESC + '.tmp', DESC)   // persist te (tempo-included) flags
    log(`reembed-all done: ${n}/${cands.length} re-embedded; embeddings.bin ${written} vectors. Sync will carry it to homemini.`)
    // The vibe brain rebuilds from the same facts (descriptor + tempo + genre).
    await updateMoodIndex(
      cands.map(t => ({ id: t.id, text: moodText(t, desc[String(t.id)]?.d) })).filter(e => e.text),
      'reembed-all',
    )
    return
  }

  // Mood-index maintenance modes:
  //   --mood-backfill        embed vibe vectors ONLY for tracks missing one
  //                          (post-seed gap filler; cheap, run any time)
  //   --rebuild-mood-index   rebuild EVERY track's vibe vector (disaster recovery)
  if (process.argv.includes('--mood-backfill') || process.argv.includes('--rebuild-mood-index')) {
    const force = process.argv.includes('--rebuild-mood-index')
    const mmap = readMood()
    const entries = tracks
      .filter(t => t.artist || t.title)
      .map(t => ({ id: t.id, text: moodText(t, desc[String(t.id)]?.d) }))
      .filter(e => e.text && (force || !mmap.has(Number(e.id))))
    log(`mood ${force ? 'rebuild' : 'backfill'}: ${entries.length} track(s) to embed (index has ${mmap.size})`)
    await updateMoodIndex(entries, force ? 'rebuild' : 'backfill')
    return
  }

  // Tempo catch-up: re-embed already-enriched tracks whose bpm landed AFTER
  // their descriptor was written. Audio analysis is async (background worker,
  // paused during playback), so a freshly-imported track usually gets its Gemma
  // descriptor + embedding BEFORE librosa computes its bpm — leaving it stuck
  // tempo-less and not vibe-searchable. Each night we re-embed up to CATCHUP_CAP
  // such tracks (NO Gemma — reuses the descriptor) so every song becomes
  // vibe-searchable once it's been heard. `te` = tempo facts are in the vector.
  const CATCHUP_CAP = Number(process.env.BRAIN_TEMPO_CAP) || 500
  const TEMPO_DRIFT = 1.5            // bpm; below this the tempo sentence can't change
  // `teb` = the bpm that was actually folded into the vector.
  //
  // 2026-08-02: `te` alone gates on the ENCODING version, so it fires when
  // tempoEnergy()'s wording changes but NEVER when the tempo itself does. That
  // was invisible until the audio analyser was fixed: ~43% of the library's
  // bpms moved (many by a full octave — 86.1 -> 172.3), and every one of those
  // vectors would have gone on describing a fast song as "slow, spacious,
  // downtempo, good for winding down" forever, because te was already 2.
  // Recording the encoded bpm makes a tempo CORRECTION self-healing.
  //
  // Entries written before this field exists have no `teb`, so they read as
  // stale and re-embed once — deliberate, since there is no way to know what
  // tempo they were built from. CATCHUP_CAP bounds the nightly cost.
  const tempoStale = (t, e) => {
    if (e.te !== TEMPO_ENCODING_VERSION) return true
    return Math.abs((Number(t.bpm) || 0) - (Number(e.teb) || 0)) > TEMPO_DRIFT
  }
  // `--reembed-artists=Huncho Jack,The Beatles` — re-embed those artists'
  // tracks now (their text gained a members line) and stop. Same backup +
  // verify discipline as the tempo catch-up below.
  const raFlag = process.argv.find(a => a.startsWith('--reembed-artists='))
  if (raFlag) {
    const fold = (x) => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const want = new Set(raFlag.slice('--reembed-artists='.length).split(',').map(fold).filter(Boolean))
    const byArtist = tracks.filter(t => want.has(fold(t.artist)) || want.has(fold(t.albumArtist)))
    const sel = byArtist.filter(t => desc[String(t.id)])
    const unenriched = byArtist.length - sel.length
    if (unenriched) log(`reembed-artists: ${unenriched} matching track(s) have no descriptor yet — the nightly enrich pass embeds them WITH their members line; nothing to redo here`)
    if (!sel.length) { log(`reembed-artists: nothing to re-embed (${byArtist.length} matched by artist)`); return }
    log(`reembed-artists: ${sel.length} track(s) for ${[...want].join(', ')}`)
    const vecs = await openaiEmbed(sel.map(t => enrichedText(t, desc[String(t.id)].d, desc[String(t.id)].m)))
    copyFileSync(EMB, EMB + '.bak')
    let cn = 0
    for (let i = 0; i < sel.length; i++) { const v = vecs[i]; if (v) { map.set(Number(sel[i].id), v); cn++ } }
    writeEmb(EMB, map)
    try {
      const check = readEmb(EMB)
      if (check.dim !== EMBED_DIM || check.map.size < startCount) throw new Error(`verify failed: count=${check.map.size}`)
    } catch (e) { log('reembed-artists VERIFY FAILED —', e.message, '— restoring backup'); copyFileSync(EMB + '.bak', EMB); throw e }
    log(`reembed-artists: re-embedded ${cn}. Sample text:\n${enrichedText(sel[0], desc[String(sel[0].id)].d, desc[String(sel[0].id)].m)}`)
    return
  }
  const needTempo = tracks.filter(t => (Number(t.bpm) || 0) > 0 && desc[String(t.id)] && tempoStale(t, desc[String(t.id)])).slice(0, CATCHUP_CAP)
  if (needTempo.length && !process.argv.includes('--meaning-catchup')) {   // --meaning-catchup isolates meaning: no tempo re-embeds to confound a before/after eval
    // Say WHY each track is here. Since `te` became a version, this batch mixes
    // two different causes: tracks that genuinely gained bpm after enrichment
    // (te absent) and tracks whose encoding is simply out of date (te = an older
    // version). The old wording claimed all of them "gained bpm", which sent me
    // looking at audio analysis when the real answer was an encoding bump —
    // a log line that misstates its own trigger costs an hour later.
    const freshBpm = needTempo.filter(t => desc[String(t.id)].te === undefined || desc[String(t.id)].te === false).length
    // Third cause since `teb` exists: the encoding is current but the measured
    // tempo moved under it (a re-analysis corrected the bpm). Counted apart so
    // the line can't send the next reader hunting an encoding bump that never
    // happened — the same trap the two-cause split was written to avoid.
    const retuned = needTempo.filter(t => desc[String(t.id)].te === TEMPO_ENCODING_VERSION).length
    const restated = needTempo.length - freshBpm - retuned
    log(`tempo catch-up: re-embedding ${needTempo.length} track(s) with tempo/key encoding v${TEMPO_ENCODING_VERSION} (no Gemma) — `
      + `${freshBpm} newly analysed, ${restated} on an older encoding, ${retuned} whose bpm changed`)
    const cvecs = await openaiEmbed(needTempo.map(t => enrichedText(t, desc[String(t.id)].d, desc[String(t.id)].m)))
    copyFileSync(EMB, EMB + '.bak')
    let cn = 0
    for (let i = 0; i < needTempo.length; i++) { const v = cvecs[i]; if (v) { map.set(Number(needTempo[i].id), v); const e = desc[String(needTempo[i].id)]; e.te = TEMPO_ENCODING_VERSION; e.teb = Number(needTempo[i].bpm) || 0; cn++ } }
    writeEmb(EMB, map)
    try {
      const check = readEmb(EMB)
      if (check.dim !== EMBED_DIM || check.map.size < startCount) throw new Error(`verify failed: count=${check.map.size}`)
    } catch (e) { log('tempo catch-up VERIFY FAILED —', e.message, '— restoring backup'); copyFileSync(EMB + '.bak', EMB); throw e }
    writeFileSync(DESC + '.tmp', JSON.stringify(desc)); renameSync(DESC + '.tmp', DESC)
    log(`tempo catch-up: re-embedded ${cn} (now vibe-searchable). Sync carries it to homemini.`)
    // Their tempo line changed → refresh the vibe vectors too.
    await updateMoodIndex(
      needTempo.map(t => ({ id: t.id, text: moodText(t, desc[String(t.id)].d) })).filter(e => e.text),
      'tempo-catchup',
    )
  }

  // Meaning catch-up: backfill the lyrics-derived MEANING line onto tracks that
  // are ALREADY enriched (have a descriptor) and now have grounded lyrics but no
  // meaning yet — the counterpart of tempo catch-up for the lyrics brain. Gemma
  // reads the lyrics, we re-embed with meaning folded in. Most-played first, so
  // the songs Jake loves understand their words first; bounded per run
  // (BRAIN_MEANING_CAP, default 150) so the nightly stays invisible. Over time
  // the whole library gains "aboutness". Reuses each track's existing descriptor
  // (no new gemmaDescribe). `node brain-trainer.mjs --meaning-catchup` runs ONLY
  // this (with a high BRAIN_MEANING_CAP for the initial bulk backfill).
  const MEANING_CAP = Number(process.env.BRAIN_MEANING_CAP || 150)
  const needMeaning = tracks
    .filter(t => desc[String(t.id)] && !desc[String(t.id)].m && lyricTextFor(t.id))
    .sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0))
    .slice(0, MEANING_CAP)
  if (needMeaning.length) {
    log(`meaning catch-up: ${needMeaning.length} enriched track(s) have lyrics but no meaning — deriving + re-embedding`)
    const mpending = []
    for (const t of needMeaning) {
      try { const m = await gemmaMeaning(t, lyricTextFor(t.id)); if (m) mpending.push({ t, m }) }
      catch (e) { log('  meaning skip', `${t.artist} — ${t.title}`, '·', e.message) }
    }
    if (mpending.length) {
      const mvecs = await openaiEmbed(mpending.map(({ t, m }) => enrichedText(t, desc[String(t.id)].d, m)))
      copyFileSync(EMB, EMB + '.bak')
      let mn = 0
      for (let i = 0; i < mpending.length; i++) {
        const v = mvecs[i]; if (!v) continue
        const { t, m } = mpending[i]; map.set(Number(t.id), v); desc[String(t.id)].m = m; mn++
      }
      writeEmb(EMB, map)
      try {
        const check = readEmb(EMB)
        if (check.dim !== EMBED_DIM || check.map.size < startCount) throw new Error(`verify failed: count=${check.map.size}`)
      } catch (e) { log('meaning catch-up VERIFY FAILED —', e.message, '— restoring backup'); copyFileSync(EMB + '.bak', EMB); throw e }
      writeFileSync(DESC + '.tmp', JSON.stringify(desc)); renameSync(DESC + '.tmp', DESC)
      log(`meaning catch-up: ${mn} track(s) now understand their lyrics. Sync carries it to homemini.`)
    }
  }
  if (process.argv.includes('--meaning-catchup')) return   // explicit bulk-meaning run stops here

  // Candidates: every library track not yet enriched. NEWLY-ADDED tracks jump
  // the queue (Jake adds music almost daily and wants the brain to know it
  // right away); after the recent adds, most-played first for the historical
  // backfill. A track with no base embedding yet (new import the desktop hasn't
  // embedded) gets embedded here too — so the trainer ALONE guarantees every
  // song lands in the brain, heard, without waiting on a manual Settings backfill.
  const batch = pickBatch(tracks, done, { batch: BATCH })

  log(`${enrichedCount()}/${total} tracks enriched so far; processing ${batch.length} this run (every new add + up to ${BATCH} older, ${MINUTES}-min budget)`)
  if (batch.length === 0) {
    log('library fully enriched — nothing to do tonight')
    // Record the healthy no-op. This path returned WITHOUT writing status, so a
    // quiet night left brain-status.json untouched and "last successful run"
    // aged as though the job had died — on 2026-08-02 the file read four days
    // stale while the job was in fact running fine every night. That is exactly
    // the silent-failure mode this file's health reporting was added to kill:
    // "nothing to do" and "never ran" must not look identical on disk.
    writeStatus({ ok: true, enrichedThisRun: 0, enrichedTotal: enrichedCount(), ofTotal: total, vectors: startCount, orphans: orphanCount() })
    return
  }

  // 1) Gemma descriptors (sequential; free, local). Skip-on-fail, retry next run.
  const pending = []
  for (const [i, t] of batch.entries()) {
    if (Date.now() > deadline) { log(`time budget (${MINUTES} min) reached — ${batch.length - i} left for tomorrow night`); break }
    try {
      const d = await gemmaDescribe(t)
      if (!d) continue
      // If this track already has grounded lyrics, derive its meaning in the
      // same pass so a new song lands in the brain understanding what it's about.
      const lt = lyricTextFor(t.id)
      let m = null
      if (lt) { try { m = await gemmaMeaning(t, lt) } catch (e) { log('  meaning skip', `${t.artist} — ${t.title}`, '·', e.message) } }
      pending.push({ t, d, m })
    } catch (e) { log('  gemma skip', `${t.artist} — ${t.title}`, '·', e.message) }
  }
  if (pending.length === 0) {
    log('no descriptors produced this run (homemini Gemma down?) — nothing written')
    await notify('🧠 Brain Trainer — stalled', `Couldn't reach homemini's Gemma tonight — 0 tracks learned. Will retry tomorrow.`)
    writeStatus({ ok: false, stalled: true, error: 'no descriptors produced this run (homemini Gemma unreachable?) — nothing written' })
    return
  }

  // 2) Re-embed enriched text (batched).
  const vecs = await openaiEmbed(pending.map(({ t, d, m }) => enrichedText(t, d, m)))

  // 3) Back up the live brain, then fold the new vectors in.
  copyFileSync(EMB, EMB + '.bak')
  let enriched = 0, sample = null
  for (let i = 0; i < pending.length; i++) {
    const v = vecs[i]; if (!v) continue
    const { t, d, m } = pending[i]
    map.set(Number(t.id), v)
    desc[String(t.id)] = { d, m: m || undefined, at: new Date().toISOString(), artist: t.artist, title: t.title, te: (Number(t.bpm) || 0) > 0 ? TEMPO_ENCODING_VERSION : false, teb: Number(t.bpm) || 0 }
    if (!sample) sample = { artist: t.artist, title: t.title, d }
    enriched++
  }
  const gate = purityGate(map, new Map(tracks.map(t => [Number(t.id), { artist: t.artist, genre: t.genre }])), 'nightly')
  if (gate.block) throw new Error(`purity gate blocked the nightly publish: ${gate.reason}`)
  const written = writeEmb(EMB, map)

  // 4) Self-verify: re-read and confirm the brain round-tripped intact; else restore.
  try {
    const check = readEmb(EMB)
    if (check.dim !== EMBED_DIM || check.map.size !== map.size || check.map.size < startCount) {
      throw new Error(`verify failed: dim=${check.dim} count=${check.map.size} (expected ${map.size}, >=${startCount})`)
    }
  } catch (e) {
    log('VERIFY FAILED —', e.message, '— restoring backup, NOT writing progress')
    copyFileSync(EMB + '.bak', EMB)
    throw e
  }

  const dtmp = DESC + '.tmp'; writeFileSync(dtmp, JSON.stringify(desc)); renameSync(dtmp, DESC)
  // The freshly-described tracks get their vibe vector in the same pass.
  await updateMoodIndex(
    pending.map(({ t, d }) => ({ id: t.id, text: moodText(t, d) })).filter(e => e.text),
    'nightly',
  )
  log(`done: +${enriched} enriched this run; brain now ${enrichedCount()}/${total} (embeddings.bin ${written} vectors)` + (orphanCount() ? ` · ${orphanCount()} orphan descriptor(s) from tracks no longer in the library` : '') + `)`)
  log('the desktop→NAS sync will carry the richer brain to homemini on its next pass')
  // Record the healthy run. "When did the brain last actually learn something?"
  // becomes a fact on disk instead of something you infer from stale mixes.
  writeStatus({ ok: true, enrichedThisRun: enriched, enrichedTotal: enrichedCount(), ofTotal: total, vectors: written, orphans: orphanCount() })
  await report(enriched, enrichedCount(), total, sample)
}

// Run ONLY when invoked as the command, never on import.
//
// This file used to call main() at module scope, so merely importing it — to
// read a constant, to unit-test a helper, to check that it loads — started a
// real training run: Gemma calls, paid OpenAI embeddings, and a rewrite of
// embeddings.bin + brain-descriptors.json. I did exactly that while verifying
// an unrelated fix and re-embedded 500 tracks by accident. A module that runs
// itself on import is a landmine for every tool that touches it.
if (import.meta.url === pathToFileURL(process.argv[1] || '.').href) {
  main().catch(e => {
    // Brief 176: a crash mid-run is a failure like any other — it writes the
    // failure status and pushes the alert BEFORE exiting, so last night's
    // ok:true can never survive a crashed run and pose as health.
    const reason = `crash: ${e?.message || e}`
    log('FATAL', reason)
    try { writeStatus({ ok: false, error: reason }) } catch { /* reporting must not mask the exit */ }
    notifyFailure('JakeTunes brain: nightly training FAILED', reason)
    process.exit(1)
  })
}
