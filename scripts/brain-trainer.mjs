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

// STATE_DIR defaults to the desktop app's local dir, but JT_STATE_DIR lets the
// homemini nightly job point it at the NAS canonical (/Volumes/JakeShared/
// JakeTunesState) so the mini owns + writes the shared brain. See
// project_brain_homemini_migration.
const STATE_DIR = process.env.JT_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'JakeTunes')
const LIB = join(STATE_DIR, 'library.json')
const EMB = join(STATE_DIR, 'embeddings.bin')
const MOOD = join(STATE_DIR, 'mood-index.bin')
const DESC = join(STATE_DIR, 'brain-descriptors.json')
const ENV = join(homedir(), 'JakeTunesV3', '.env')
const GEMMA_URL = 'http://homemini:11434/api/generate'
const GEMMA_MODEL = 'gemma3:4b'
const EMBED_URL = 'https://api.openai.com/v1/embeddings'
const EMBED_MODEL = 'text-embedding-3-small'
const EMBED_DIM = 1536
const BATCH = Number(process.env.BRAIN_BATCH || 300)
const MAGIC = 'EMBD', VERSION = 1

const log = (...a) => console.log(new Date().toISOString(), '[brain-trainer]', ...a)

const KEY = (existsSync(ENV)
  ? (readFileSync(ENV, 'utf8').split('\n').find(l => l.startsWith('OPENAI_API_KEY=')) || '').slice('OPENAI_API_KEY='.length).trim().replace(/^["']|["']$/g, '')
  : '') || process.env.OPENAI_API_KEY || ''
if (!KEY) { log('FATAL: no OPENAI_API_KEY (checked ~/JakeTunesV3/.env and env)'); process.exit(1) }

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
function tempoEnergy(t) {
  const b = Number(t.bpm) || 0
  if (b <= 0) return ''   // no bpm → say nothing (never fabricate)
  const tempo = b >= 120 ? 'fast, up-tempo, driving' : b >= 90 ? 'mid-tempo, moderate groove' : 'slow, relaxed, downtempo'
  const g = String(t.genre || '').toLowerCase()
  // Only add energy/use-case for CLEAR high/low cases. Bland "medium energy /
  // everyday listening" filler on the big mid-tempo middle of the library just
  // dilutes precise genre queries (punk/house/new-wave) without helping any
  // mood search. Tempo is always stated — it's factual and drives the win.
  let mood = ''
  if (b >= 130 || /punk|metal|grunge|hardcore|techno|drum/.test(g)) mood = '. energy: high-energy and intense. good for: working out, running, parties'
  else if ((b > 0 && b <= 85) || /ambient|folk|acoustic|classical|jazz|soul/.test(g)) mood = '. energy: low-energy, mellow and calm. good for: late night, relaxing, winding down, chilling'
  return `tempo: ${b} BPM, ${tempo}${mood}`
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
  if (!existsSync(LIB) || !existsSync(EMB)) { log('FATAL: library.json or embeddings.bin missing'); process.exit(1) }
  const libRaw = JSON.parse(readFileSync(LIB, 'utf8'))
  const tracks = Array.isArray(libRaw) ? libRaw : (libRaw.tracks || [])
  const { map, dim } = readEmb(EMB)
  if (dim !== EMBED_DIM) { log(`FATAL: embeddings dim ${dim} != ${EMBED_DIM}`); process.exit(1) }
  const startCount = map.size
  const desc = existsSync(DESC) ? JSON.parse(readFileSync(DESC, 'utf8')) : {}
  const done = new Set(Object.keys(desc))
  const total = tracks.filter(t => t.artist || t.title).length

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
      const d = desc[String(t.id)]?.d
      return d ? `${baseText(t)}\nsound and mood: ${d}` : baseText(t)
    })
    const vecs = await openaiEmbed(texts)
    copyFileSync(EMB, EMB + '.bak')
    let n = 0
    for (let i = 0; i < cands.length; i++) { const v = vecs[i]; if (v) { map.set(Number(cands[i].id), v); const e = desc[String(cands[i].id)]; if (e) e.te = (Number(cands[i].bpm) || 0) > 0; n++ } }
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
  const CATCHUP_CAP = 500
  const needTempo = tracks.filter(t => (Number(t.bpm) || 0) > 0 && desc[String(t.id)] && desc[String(t.id)].te !== true).slice(0, CATCHUP_CAP)
  if (needTempo.length) {
    log(`tempo catch-up: ${needTempo.length} enriched track(s) gained bpm since enrichment — re-embedding with tempo (no Gemma)`)
    const cvecs = await openaiEmbed(needTempo.map(t => `${baseText(t)}\nsound and mood: ${desc[String(t.id)].d}`))
    copyFileSync(EMB, EMB + '.bak')
    let cn = 0
    for (let i = 0; i < needTempo.length; i++) { const v = cvecs[i]; if (v) { map.set(Number(needTempo[i].id), v); desc[String(needTempo[i].id)].te = true; cn++ } }
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
      if (d) pending.push({ t, d })
    } catch (e) { log('  gemma skip', `${t.artist} — ${t.title}`, '·', e.message) }
  }
  if (pending.length === 0) {
    log('no descriptors produced this run (homemini Gemma down?) — nothing written')
    await notify('🧠 Brain Trainer — stalled', `Couldn't reach homemini's Gemma tonight — 0 tracks learned. Will retry tomorrow.`)
    return
  }

  // 2) Re-embed enriched text (batched).
  const vecs = await openaiEmbed(pending.map(({ t, d }) => `${baseText(t)}\nsound and mood: ${d}`))

  // 3) Back up the live brain, then fold the new vectors in.
  copyFileSync(EMB, EMB + '.bak')
  let enriched = 0, sample = null
  for (let i = 0; i < pending.length; i++) {
    const v = vecs[i]; if (!v) continue
    const { t, d } = pending[i]
    map.set(Number(t.id), v)
    desc[String(t.id)] = { d, at: new Date().toISOString(), artist: t.artist, title: t.title, te: (Number(t.bpm) || 0) > 0 }
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
  await report(enriched, Object.keys(desc).length, total, sample)
}

main().catch(e => { log('FATAL', e.message); process.exit(1) })
