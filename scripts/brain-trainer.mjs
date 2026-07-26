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
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'

// STATE_DIR defaults to the desktop app's local dir, but JT_STATE_DIR lets the
// homemini nightly job point it at the NAS canonical (/Volumes/JakeShared/
// JakeTunesState) so the mini owns + writes the shared brain. See
// project_brain_homemini_migration.
const STATE_DIR = process.env.JT_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const LIB = join(STATE_DIR, 'library.json')
const EMB = join(STATE_DIR, 'embeddings.bin')
const MOOD = join(STATE_DIR, 'mood-index.bin')
const DESC = join(STATE_DIR, 'brain-descriptors.json')
const LYRICS = join(STATE_DIR, 'lyrics.json')   // grounded LRCLIB lyrics (scripts/lyrics-fetch.mjs)
const ENV = join(homedir(), 'JakeTunesV3', '.env')
const GEMMA_URL = process.env.GEMMA_URL || 'http://homemini:11434/api/generate'
const GEMMA_MODEL = 'gemma3:4b'
const EMBED_URL = 'https://api.openai.com/v1/embeddings'
const EMBED_MODEL = 'text-embedding-3-small'
const EMBED_DIM = 1536
const BATCH = Number(process.env.BRAIN_BATCH || 300)
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
  const body = JSON.stringify({ ...payload, at: new Date().toISOString(), host: hostname() }, null, 2)
  for (const p of new Set([STATUS, STATUS_LOCAL])) {
    try { writeFileSync(p, body) } catch { /* best-effort — never let reporting break the run */ }
  }
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
}

/** Log loudly, record the failure durably, notify, and exit non-zero. */
function fatal(reason) {
  log('FATAL: ' + reason)
  writeStatus({ ok: false, error: reason })
  notifyFailure('JakeTunes brain: nightly training FAILED', reason)
  process.exit(1)
}

const KEY = (existsSync(ENV)
  ? (readFileSync(ENV, 'utf8').split('\n').find(l => l.startsWith('OPENAI_API_KEY=')) || '').slice('OPENAI_API_KEY='.length).trim().replace(/^["']|["']$/g, '')
  : '') || process.env.OPENAI_API_KEY || ''
if (!KEY) fatal('no OPENAI_API_KEY (checked ~/JakeTunesV3/.env and env)')

// ── embeddings.bin (EMBD binary format, shared with src/main/ai/embeddings.ts) ──
function readEmb(path) {
  const buf = readFileSync(path)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== MAGIC) throw new Error('embeddings.bin: bad magic')
  const dim = buf.readUInt16LE(6), count = buf.readUInt32LE(8), rec = 4 + dim * 4
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

// Grounded tempo/energy/use-case from REAL library bpm + genre. The literary
// "sound and mood" descriptor alone scored ~random (0.47 AUC) on tempo queries
// like "fast workout music" / "mellow late-night" — the brain had no idea what
// was fast or slow despite bpm sitting right in the library. Appending this
// lifts mood retrieval +0.32/+0.36 AUC (validated /tmp/validate_mood.py 2026-06-26).
// ⚠️ TWIN: src/main/ai/embeddings.ts buildEmbeddingText — keep these in sync.
// Rewritten 2026-07-26. See the TS twin for the full rationale + measurements.
// Short version: the old line described all 8,730 tracks with 10 distinct
// strings (33% identical, 60% with no energy statement, 259 self-contradicting
// because a genre regex overrode the measured tempo). Now: bpm thresholds
// calibrated to this library's real 72-152 spread, plus key/mode — 100% covered
// by audio analysis and never previously used. 504 distinct descriptions.
function tempoEnergy(t) {
  const b = Number(t.bpm) || 0
  if (b <= 0) return ''   // no bpm → say nothing (never fabricate)
  const tempo =
    b < 88 ? 'slow, spacious, downtempo'
    : b < 100 ? 'relaxed, loping mid-tempo'
    : b < 112 ? 'steady mid-tempo groove'
    : b < 122 ? 'brisk, forward-moving'
    : b < 134 ? 'fast, driving, propulsive'
    : 'very fast, urgent, relentless'

  const parts = [`tempo: ${Math.round(b)} BPM, ${tempo}`]

  const root = String(t.keyRoot || '').trim()
  const mode = String(t.keyMode || '').trim().toLowerCase()
  if (mode === 'minor' || mode === 'major') {
    parts.push(mode === 'minor'
      ? `key: ${root} minor — darker, moody, melancholy, introspective`
      : `key: ${root} major — brighter, warmer, open, resolved`)
  }

  const fast = b >= 122
  const slow = b < 100
  const minor = mode === 'minor'
  parts.push('good for: ' + (
    fast && minor ? 'driving late-night, workout, intense focus'
    : fast ? 'workout, running, parties, daytime energy'
    : slow && minor ? 'late night, rainy day, winding down, solitude'
    : slow ? 'morning, relaxing, background, easy listening'
    : 'focus, walking, everyday listening'
  ))

  const cam = String(t.camelotKey || '').trim()
  if (cam) parts.push(`camelot ${cam}`)
  return parts.join(' · ')
}

// ⚠️ TWIN: src/main/ai/embeddings.ts subgenreText — keep in sync. Folds the AI
// genre taxonomy's general→specific path into the embed text.
function subgenreText(t) {
  const p = String(t.subgenrePath || t.subgenre || '').trim()
  return p ? `subgenre: ${p.replace(/\s*›\s*/g, ' / ')}` : ''
}

// The mood index — the brain's second ear (vibe-only text, identity stripped).
// ⚠️ TWIN: src/main/ai/mood-index.ts buildMoodText — keep in sync. Validated
// on the brain-eval branch (mood_index_proto.py): vibe recall 0.756→0.900.
function moodText(t, d) {
  const lines = []
  const dd = String(d || '').trim()
  if (dd) lines.push(`sound and mood: ${dd}`)
  const te = tempoEnergy(t); if (te) lines.push(te)
  const g = String(t.genre || '').trim(); if (g) lines.push(`genre: ${g}`)
  return lines.join('\n')
}

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

// Mirrors src/main/ai/embeddings.ts buildEmbeddingText so enriched vectors live
// in the same space as the rest, just with the sound/mood line appended.
function baseText(t) {
  const lines = [`${(t.artist || '?').trim()} — ${(t.title || '?').trim()}`]
  if (t.album) lines.push(`album: ${String(t.album).trim()}${t.year ? ` (${t.year})` : ''}`)
  else if (t.year) lines.push(`year: ${t.year}`)
  if (t.genre) lines.push(`genre: ${String(t.genre).trim()}`)
  const sg = subgenreText(t); if (sg) lines.push(sg)
  const te = tempoEnergy(t); if (te) lines.push(te)
  const r = Number(t.rating) || 0, p = Number(t.playCount) || 0, sig = []
  if (r > 0) sig.push(`★${r}`)
  if (p > 5) sig.push(`loved (${p} plays)`); else if (p > 0) sig.push(`${p} plays`)
  if (sig.length) lines.push(sig.join(' '))
  return lines.join('\n')
}

async function gemmaDescribe(t) {
  const prompt = `You are a precise music cataloguer. In ONE line (max 18 words), describe the SOUND and MOOD of this track: energy level, tempo feel, instrumentation, emotional tone, and the setting it fits. Name concrete sonic traits and instruments; vary your vocabulary; avoid generic filler. Output ONLY the descriptor, no preamble.\n\nTrack: ${t.artist || '?'} — ${t.title || '?'}\nAlbum: ${t.album || '?'} (${t.year || '?'})\nGenre: ${t.genre || '?'}`
  const r = await fetch(GEMMA_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GEMMA_MODEL, prompt, stream: false, options: { temperature: 0.5, num_predict: 70 } }),
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`gemma ${r.status}`)
  let d = String((await r.json()).response || '').trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '')
  return (d.length >= 8 && d.length <= 400) ? d : null
}

// The enrichment layer: base library facts + Gemma's sound/mood descriptor (d)
// + a lyrics-derived MEANING line (m). Kept OUT of baseText()/buildEmbeddingText
// (the base twin the desktop shares) on purpose — the desktop has no lyrics, so
// meaning lives here at the trainer's append layer, exactly like sound/mood.
// Each line is gated on a truthy value so a missing signal adds NOTHING (never
// fabricate). This is the ONLY place the enriched embed text is assembled.
function enrichedText(t, d, m) {
  let s = baseText(t)
  if (d) s += `\nsound and mood: ${d}`
  if (m) s += `\nmeaning: ${m}`
  return s
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
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) throw new Error(`gemma-meaning ${r.status}`)
  let m = String((await r.json()).response || '').trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '')
  return (m.length >= 8 && m.length <= 400) ? m : null
}

async function openaiEmbed(texts) {
  const out = []
  for (let i = 0; i < texts.length; i += 100) {
    const chunk = texts.slice(i, i + 100)
    const r = await fetch(EMBED_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: chunk }), signal: AbortSignal.timeout(60000),
    })
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

async function main() {
  if (!existsSync(LIB) || !existsSync(EMB)) fatal(`library.json or embeddings.bin missing under ${STATE_DIR} — is the NAS mounted?`)
  const libRaw = JSON.parse(readFileSync(LIB, 'utf8'))
  const tracks = Array.isArray(libRaw) ? libRaw : (libRaw.tracks || [])
  const { map, dim } = readEmb(EMB)
  if (dim !== EMBED_DIM) fatal(`embeddings dim ${dim} != ${EMBED_DIM}`)
  const startCount = map.size
  const desc = existsSync(DESC) ? JSON.parse(readFileSync(DESC, 'utf8')) : {}
  const done = new Set(Object.keys(desc))
  const total = tracks.filter(t => t.artist || t.title).length

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
    const done = Object.keys(desc).length, remaining = Math.max(0, total - done)
    const pct = total ? Math.round((done / total) * 100) : 0, nights = Math.ceil(remaining / BATCH)
    const msg = remaining === 0
      ? `Fully trained — all ${total.toLocaleString()} tracks understood by sound + mood.`
      : `${done.toLocaleString()}/${total.toLocaleString()} (${pct}%) tracks taught · ~${nights} night${nights === 1 ? '' : 's'} left at ${BATCH}/night.`
    await notify('🧠 Brain Trainer — status', msg)
    log('status:', msg)
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
    for (let i = 0; i < cands.length; i++) { const v = vecs[i]; if (v) { map.set(Number(cands[i].id), v); const e = desc[String(cands[i].id)]; if (e) e.te = (Number(cands[i].bpm) || 0) > 0 ? TEMPO_ENCODING_VERSION : false; n++ } }
    const written = writeEmb(EMB, map)
    try {
      const check = readEmb(EMB)
      if (check.dim !== EMBED_DIM || check.map.size < startCount) throw new Error(`verify failed: dim=${check.dim} count=${check.map.size} (>=${startCount})`)
    } catch (e) { log('VERIFY FAILED —', e.message, '— restoring backup'); copyFileSync(EMB + '.bak', EMB); process.exit(1) }
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
  const TEMPO_ENCODING_VERSION = 2   // bump when tempoEnergy()'s output changes
  const CATCHUP_CAP = Number(process.env.BRAIN_TEMPO_CAP) || 500
  const needTempo = tracks.filter(t => (Number(t.bpm) || 0) > 0 && desc[String(t.id)] && desc[String(t.id)].te !== TEMPO_ENCODING_VERSION).slice(0, CATCHUP_CAP)
  if (needTempo.length && !process.argv.includes('--meaning-catchup')) {   // --meaning-catchup isolates meaning: no tempo re-embeds to confound a before/after eval
    // Say WHY each track is here. Since `te` became a version, this batch mixes
    // two different causes: tracks that genuinely gained bpm after enrichment
    // (te absent) and tracks whose encoding is simply out of date (te = an older
    // version). The old wording claimed all of them "gained bpm", which sent me
    // looking at audio analysis when the real answer was an encoding bump —
    // a log line that misstates its own trigger costs an hour later.
    const freshBpm = needTempo.filter(t => desc[String(t.id)].te === undefined || desc[String(t.id)].te === false).length
    const restated = needTempo.length - freshBpm
    log(`tempo catch-up: re-embedding ${needTempo.length} track(s) with tempo/key encoding v${TEMPO_ENCODING_VERSION} (no Gemma) — `
      + `${freshBpm} newly analysed, ${restated} on an older encoding`)
    const cvecs = await openaiEmbed(needTempo.map(t => enrichedText(t, desc[String(t.id)].d, desc[String(t.id)].m)))
    copyFileSync(EMB, EMB + '.bak')
    let cn = 0
    for (let i = 0; i < needTempo.length; i++) { const v = cvecs[i]; if (v) { map.set(Number(needTempo[i].id), v); desc[String(needTempo[i].id)].te = TEMPO_ENCODING_VERSION; cn++ } }
    writeEmb(EMB, map)
    try {
      const check = readEmb(EMB)
      if (check.dim !== EMBED_DIM || check.map.size < startCount) throw new Error(`verify failed: count=${check.map.size}`)
    } catch (e) { log('tempo catch-up VERIFY FAILED —', e.message, '— restoring backup'); copyFileSync(EMB + '.bak', EMB); process.exit(1) }
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
      } catch (e) { log('meaning catch-up VERIFY FAILED —', e.message, '— restoring backup'); copyFileSync(EMB + '.bak', EMB); process.exit(1) }
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
  const RECENT_MS = 14 * 24 * 60 * 60 * 1000
  const now = Date.now()
  const addedMs = (t) => { const d = Date.parse(t.dateAdded || ''); return Number.isFinite(d) ? d : 0 }
  const isRecent = (t) => { const a = addedMs(t); return a > 0 && now - a < RECENT_MS }
  const batch = tracks
    .filter(t => !done.has(String(t.id)) && (t.artist || t.title))
    .sort((a, b) => {
      const ra = isRecent(a), rb = isRecent(b)
      if (ra !== rb) return ra ? -1 : 1               // new adds jump the queue
      if (ra && rb) return addedMs(b) - addedMs(a)    // newest of the recent first
      return (b.playCount ?? 0) - (a.playCount ?? 0)  // else most-played first
    })
    .slice(0, BATCH)

  log(`${Object.keys(desc).length}/${total} tracks enriched so far; processing ${batch.length} this run (batch=${BATCH})`)
  if (batch.length === 0) { log('library fully enriched — nothing to do tonight'); return }

  // 1) Gemma descriptors (sequential; free, local). Skip-on-fail, retry next run.
  const pending = []
  for (const t of batch) {
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
    desc[String(t.id)] = { d, m: m || undefined, at: new Date().toISOString(), artist: t.artist, title: t.title, te: (Number(t.bpm) || 0) > 0 ? TEMPO_ENCODING_VERSION : false }
    if (!sample) sample = { artist: t.artist, title: t.title, d }
    enriched++
  }
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
    process.exit(1)
  }

  const dtmp = DESC + '.tmp'; writeFileSync(dtmp, JSON.stringify(desc)); renameSync(dtmp, DESC)
  // The freshly-described tracks get their vibe vector in the same pass.
  await updateMoodIndex(
    pending.map(({ t, d }) => ({ id: t.id, text: moodText(t, d) })).filter(e => e.text),
    'nightly',
  )
  log(`done: +${enriched} enriched this run; brain now ${Object.keys(desc).length}/${total} (embeddings.bin ${written} vectors)`)
  log('the desktop→NAS sync will carry the richer brain to homemini on its next pass')
  // Record the healthy run. "When did the brain last actually learn something?"
  // becomes a fact on disk instead of something you infer from stale mixes.
  writeStatus({ ok: true, enrichedThisRun: enriched, enrichedTotal: Object.keys(desc).length, ofTotal: total, vectors: written })
  await report(enriched, Object.keys(desc).length, total, sample)
}

main().catch(e => { log('FATAL', e.message); process.exit(1) })
