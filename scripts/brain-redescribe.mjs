/**
 * The staged re-describe — its own module so tests can load it without the
 * trainer's import-time checks (the OpenAI key, the state dir).
 *
 * 2026-10-27 (Jake: "There's gotta be a much improved open model out there"):
 * a blind five-model A/B on homemini scored gemma4:12b at 77% accurate sound
 * descriptors vs the live gemma3:4b's 55%. Upgrading the whole library is
 * ~12k calls at ~4.7 s — several nights — and the rule is "the models
 * absolutely cannot be getting worse". So a re-describe never writes the
 * live brain-descriptors.json:
 *
 *   1. `--redescribe-all [--until HH:MM]` writes brain-descriptors.next.json
 *      (resumable across nights, stops at the window's end).
 *   2. `--mood-candidate <file> [--use-current]` builds a mood index from the
 *      staged (or the current) descriptors into <file>, never mood-index.bin,
 *      so the brain-eval harness can score candidate vs baseline.
 *   3. `--promote-next` merges the staged descriptors into the live store and
 *      re-embeds their mood vectors — run only after the eval passes.
 */

import { basename, join } from 'node:path'

/**
 * Is a MUSIC stream being transcoded right now? Takes `ps -axo command` text.
 *
 * The old yield rule was `pgrep -x ffmpeg`, which is ALWAYS true on homemini:
 * the cable channels run video ffmpeg around the clock, so a re-describe would
 * have unloaded the model and slept forever. The music server's transcodes
 * always pass `-vn` (Mobile backend/src/routes/audio.ts); cable playout always
 * passes `-vf`. An ffmpeg with `-vn`, or without `-vf`, counts as music.
 */
export function musicStreamActive(psText) {
  return String(psText || '').split('\n').some((line) => {
    const l = line.trim()
    const bin = l.split(/\s+/, 1)[0] || ''
    if (!(bin === 'ffmpeg' || bin.endsWith('/ffmpeg'))) return false
    return / -vn(\s|$)/.test(l) || !/ -vf(\s|$)/.test(l)
  })
}

/**
 * Is the regular nightly trainer (02:00, gemma3:4b, a few minutes) running?
 * Takes `ps -axo command` text. The re-describe window starts before it
 * (Jake 10/29: "extend it as much as possible... I'm sleeping"), so it steps
 * aside rather than hold a second model in memory beside the trainer's.
 * Our own process carries --redescribe-all and never counts.
 */
export function nightlyTrainerActive(psText) {
  return String(psText || '').split('\n').some((line) => {
    const l = line.trim()
    return /(^|\/|\s)brain-trainer\.mjs(\s|$)/.test(l) && /(^|\/)node(\s|$)/.test(l.split(/\s+/, 1)[0] || '') && !/\s--redescribe-all(\s|$)/.test(l)
  })
}

/**
 * Is the Mobile repo's BPM/key worker running? Takes `ps -axo command` text.
 * It measures audio on homemini 19:00-23:55 and 02:20-03:00 (Mobile
 * deploy/bpm-key-worker.sh, Brief 245); the re-describe steps aside rather than
 * load a 12b model beside its measurers. Its node process (dist/bpmKeyWorker.js)
 * and its Python measurers (tools/bpm-key/analyze.py) both count.
 */
export function bpmKeyWorkerActive(psText) {
  return String(psText || '').split('\n').some((line) => {
    const l = line.trim()
    const bin = (l.split(/\s+/, 1)[0] || '').toLowerCase()
    if (/(^|\/)node$/.test(bin)) return /(^|[\s/])bpmKeyWorker\.js(\s|$)/.test(l)
    if (/(^|\/)python[\d.]*$/.test(bin)) return /\/bpm-key\/analyze\.py(\s|$)/.test(l)
    return false
  })
}

/** homemini's "someone is listening" window: the Mobile backend's QUIET_MS. */
export const LISTENING_QUIET_MS = 120000

/**
 * Is someone listening, by homemini's own record? `stampText` is the content
 * of the Mobile backend's audio-last-served.json ({ "at": <epoch ms> }),
 * which GET /audio/:id writes for a listener and NOT for a copy
 * (JakeTunesMobile backend/src/util/playbackActivity.ts, the rule the BPM/key
 * and artist-page workers already wait on).
 *
 *   true / false   the record was read: listening within the window, or not
 *   null           no usable record (not homemini, backend never ran): the
 *                  caller falls back to musicStreamActive
 *
 * Why not just look for an audio ffmpeg (musicStreamActive)? On 2026-11-10
 * the re-describe sat paused from 01:01 to 03:20 for workmini's overnight
 * pre-load: a copy job, but each song it had not fetched before made homemini
 * convert it, and that ffmpeg looks like music. The same rule misses a real
 * listener whose song needs no conversion (the phone, on Wi-Fi). A stamp from
 * the future (a clock step) counts as listening, as it does in the backend.
 */
export function listeningByStamp(stampText, now = Date.now(), quietMs = LISTENING_QUIET_MS) {
  if (!stampText) return null
  let at
  try { at = JSON.parse(stampText)?.at } catch { return null }
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  return now - at < quietMs
}

/** Megabytes of swap in use, from `sysctl -n vm.swapusage` ("total = 7168.00M  used = 5696.62M  free = ..."), or null. */
export function parseSwapUsedMB(text) {
  const m = /used\s*=\s*([\d.]+)\s*([MG])/i.exec(String(text || ''))
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return m[2].toUpperCase() === 'G' ? n * 1024 : n
}

/** Swap in use above which the re-describe steps aside (homemini stands at 4 to 6 GB). */
export const MAX_SWAP_MB = 10000

/**
 * Should the re-describe step aside for memory? `pressureLevel` is macOS's
 * kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical.
 *
 * Until 2026-11-10 only "critical" counted, and the job ran for hours with
 * swap at 19 GB on a 16 GB machine while the music server's file calls timed
 * out: the level never reached critical. So swap in use past `maxSwapMB`
 * now counts too. "Warn" (2) does NOT: measured on homemini, the level sits
 * at warn the whole time an 8 GB model is loaded with swap steady near 5 GB,
 * so yielding at warn would unload the model, drop to normal, reload, and
 * loop. A value that could not be read (null, NaN) never yields by itself.
 */
export function memoryYieldReason({ pressureLevel = null, swapUsedMB = null } = {}, { maxSwapMB = MAX_SWAP_MB } = {}) {
  if (Number.isFinite(pressureLevel) && pressureLevel >= 4) return 'memory pressure is critical'
  if (Number.isFinite(swapUsedMB) && swapUsedMB > maxSwapMB) return `swap in use is ${Math.round(swapUsedMB / 1024 * 10) / 10} GB (limit ${Math.round(maxSwapMB / 1024 * 10) / 10} GB)`
  return null
}

/** The default staged file, and the live store a staged file must never be. */
export const DEFAULT_NEXT_FILE = 'brain-descriptors.next.json'
const LIVE_STORE = 'brain-descriptors.json'

/**
 * The staged file for --redescribe-all / --mood-candidate / --promote-next:
 * `--next-file <name>` in argv, else brain-descriptors.next.json. A plain file
 * name inside the state dir only (no paths: the staged file sits beside the
 * store it may one day be promoted into), never the live store. Throws on a
 * missing or bad value.
 */
export function nextFilePath(argv, stateDir) {
  const i = argv.indexOf('--next-file')
  if (i < 0) return join(stateDir, DEFAULT_NEXT_FILE)
  const name = argv[i + 1]
  if (!name || name.startsWith('--')) throw new Error('--next-file needs a file name')
  if (name !== basename(name) || name === '.' || name === '..') throw new Error(`--next-file wants a plain file name in the state dir, got "${name}"`)
  if (!name.endsWith('.json')) throw new Error(`--next-file wants a .json name, got "${name}"`)
  if (name === LIVE_STORE) throw new Error('--next-file must not be the live brain-descriptors.json')
  return join(stateDir, name)
}

/**
 * Epoch ms of the next local HH:MM at or after `now` (today if still ahead,
 * else tomorrow). Throws on a malformed value so a typo can't mean "forever".
 */
export function untilMs(hhmm, now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`--until wants HH:MM, got "${hhmm}"`)
  const d = new Date(now)
  d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** A staged entry that counts: written by `model` with the current prompt. */
export function stagedCurrent(e, model, pv = PROMPT_VERSION) {
  return !!e && typeof e.d === 'string' && e.d !== '' && (model == null || e.gm === model) && e.pv === pv
}

/**
 * Tracks still needing a `model` descriptor from the CURRENT prompt: neither
 * live nor staged has one. A staged entry from an older prompt (no `pv`, or
 * an older one — night 1's 3,399 "Gritty, mid-tempo" lines) is still to-do,
 * and those come FIRST so the redo finishes before new ground is broken.
 * The stale entry stays in the file until its replacement is written.
 */
export function redescribeCandidates(tracks, desc, next, model, pv = PROMPT_VERSION) {
  const stale = [], fresh = []
  for (const t of tracks) {
    if (!(t.artist || t.title)) continue
    const id = String(t.id)
    if (stagedCurrent(desc[id], model, pv) || stagedCurrent(next[id], model, pv)) continue
    ;(next[id] ? stale : fresh).push(t)
  }
  return [...stale, ...fresh]
}

/**
 * The descriptor map a candidate mood index is built from: live descriptors
 * with every CURRENT-prompt staged one laid over them (unless useCurrent).
 * Stale-prompt staged entries are left out, so the eval never scores them.
 */
export function candidateDescriptors(desc, next, { useCurrent = false, pv = PROMPT_VERSION } = {}) {
  const out = {}
  for (const [id, e] of Object.entries(desc)) if (e?.d) out[id] = e.d
  if (!useCurrent) for (const [id, e] of Object.entries(next)) if (stagedCurrent(e, null, pv)) out[id] = e.d
  return out
}

/**
 * Merge staged descriptors into the live store (mutates desc). Only the
 * descriptor fields move: `d`, `gm`, `at`, `pv`. Everything else on the live
 * entry (meaning `m`, tempo flags `te`/`teb`, artist/title) is kept. A staged
 * entry from an older prompt version is SKIPPED (never promoted) and listed
 * (see staleStaged). Returns the ids that changed.
 */
export function promoteNext(desc, next, pv = PROMPT_VERSION) {
  const changed = []
  for (const [id, e] of Object.entries(next)) {
    if (!e?.d || typeof e.d !== 'string') continue
    if (e.pv !== pv) continue
    const cur = desc[id] || {}
    if (cur.d === e.d && cur.gm === e.gm && cur.pv === e.pv) continue
    desc[id] = { ...cur, d: e.d, gm: e.gm, pv: e.pv, at: e.at || cur.at }
    changed.push(id)
  }
  return changed
}

/** Staged ids written by an older prompt — what --promote-next skips. */
export function staleStaged(next, pv = PROMPT_VERSION) {
  return Object.entries(next).filter(([, e]) => e?.d && typeof e.d === 'string' && e.pv !== pv).map(([id]) => id)
}

/*
 * ── The describe prompt (moved here from brain-trainer.mjs so tests and
 * scratch A/Bs can call it without the trainer's import-time checks) ──
 *
 * 2026-10-29 (Jake: "fix the mid tempo/gritty glitch"). Night 1 of the
 * gemma4:12b re-describe staged 3,399 lines; vs gemma3:4b on the same songs
 * "mid-tempo" went 3% → 39%, "gritty" 8% → 22%, "late-night" 7% → 12%, and
 * 257 opened "Gritty, mid-tempo". Red Hot Chili Peppers' "My Friends" (a
 * soft acoustic ballad) became "Gritty, mid-tempo funk-rock … heavy guitar
 * riffs". Cause: the old prompt was a slot list — "energy level, tempo feel,
 * instrumentation, emotional tone, setting" — so the model filled the slots
 * in order (adjective, tempo word, genre, "featuring" instruments, mood,
 * setting) and, knowing only artist/title/genre, guessed the tempo slot with
 * the safe middle ("mid-tempo" on songs the analyser measured at 80 and 178
 * BPM alike) and described the artist's/genre's typical sound instead of the
 * song. Tempo is already in the mood text from the measured BPM
 * (tempoEnergy), so a guessed tempo word only adds noise or contradicts it.
 *
 * Fix: no slot list; describe THIS recording (the real arrangement, vocal,
 * dynamics) and, when unsure, stay with what artist/album/genre make likely
 * — a first draft that said "a quiet ballad by a loud band is a quiet
 * ballad" made the model INVENT acoustic ballads for fast punk songs
 * (blink-182, Buzzcocks, Sublime, 10/29 A/B), so the prompt now forbids an
 * invented contrast instead;
 * ground it in the analyser's facts (BPM, length); lead with the
 * most distinctive sound, not an adjective pair; tempo words only when pace
 * is the defining trait. Then a cheap deterministic post-check: an output
 * that opens with the "Adj, adj …" formula or uses a stock word gets ONE
 * retry with a nudge naming what to drop, and the cleaner of the two is kept.
 *
 * v3, 2026-11-08 (Jake: "that is unacceptable the whole point of the LLM
 * switch was to improve!!!!"). The v2 candidate won genre and tempo but lost
 * the vibe probes (vibe 0.659 → 0.612; "aggressive heavy intense music"
 * 0.93 → 0.53). Over all 13,185 songs its lines had lost the feeling —
 * emotion words per line 2.39 → 0.55 — and used intensity words (heavy, raw,
 * distorted…) 3x as often on ordinary songs, so they no longer marked the
 * heavy ones. River In The Road went from "…evoke desolate desert landscapes
 * and brooding melancholic introspection" to "A heavy, swinging groove…".
 * v3 asks for the sound AND the feeling (two or three emotion words that set
 * the song apart from its genre, plus an honest energy word), and keeps
 * intensity words for loud sound only. Pilot numbers are in the PR.
 *
 * PROMPT_VERSION is stamped on every staged entry (`pv`). Bump it whenever
 * the prompt or the post-check changes: everything staged under an older
 * version becomes to-do again and is never promoted.
 */
export const PROMPT_VERSION = 3

/** Words the models lean on whatever the song (measured 10/29, both models). */
export const STOCK_WORDS = ['mid-tempo', 'gritty', 'late-night', 'shimmering', 'driving', 'high-octane']

const STOCK_RE = new RegExp(`\\b(${STOCK_WORDS.map((w) => w.replace(/-/g, '[- ]')).join('|')})\\b`, 'gi')

/** The stock words a descriptor uses (lower-case, de-duplicated, hyphenated). */
export function stockHits(d) {
  const hits = new Set()
  for (const m of String(d || '').matchAll(STOCK_RE)) hits.add(m[1].toLowerCase().replace(' ', '-'))
  return [...hits]
}

/** Opens with the "Adjective, adjective …" formula ("Gritty, mid-tempo glam rock …")? */
export function formulaOpener(d) {
  return /^[A-Za-z][\w-]*,\s+[a-z][\w-]*\s/.test(String(d || '').trim())
}

/** How stock a descriptor is: one point per stock word, one for the formula opener. */
export function stockScore(d) {
  return stockHits(d).length + (formulaOpener(d) ? 1 : 0)
}

function fmtLen(sec) {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The analyser's facts for a track, as one prompt line ('' when there are
 * none). Key mode is deliberately left out: given it, the model parroted
 * "minor-key" into most lines (a new tic, 10/29 smoke test), and the mood
 * text already carries the key from tempoEnergy.
 */
export function audioFacts(t) {
  const facts = []
  const bpm = Number(t.bpm) || 0
  if (bpm > 0) facts.push(`about ${Math.round(bpm)} BPM (the analyser can read double or half time)`)
  let dur = Number(t.duration) || 0
  if (dur > 10000) dur /= 1000   // library durations are ms
  if (dur > 0) facts.push(`${fmtLen(dur)} long`)
  return facts.length ? `Measured from the audio (to judge the feel by; do not restate): ${facts.join(', ')}.` : ''
}

/**
 * The describe prompt. `retry` = the first draft's problems ({ words, opener })
 * to nudge a second attempt away from.
 */
export function describePrompt(t, retry = null) {
  const facts = audioFacts(t)
  const lines = [
    'You are a precise music cataloguer writing one line for a mood-search index.',
    'People search it by feeling as much as by sound ("rainy day melancholy", "angry and loud", "warm and hopeful").',
    '',
    `Track: ${t.artist || '?'} — ${t.title || '?'}`,
    `Album: ${t.album || '?'} (${t.year || '?'})`,
    `Genre: ${t.genre || '?'}`,
    ...(facts ? [facts] : []),
    '',
    'In ONE line (max 30 words), say how THIS recording sounds AND how it feels.',
    '- The sound: what is actually on the record (arrangement, lead instrument, vocal delivery, production). If you do not know the recording well, stay with what the artist, album and genre make likely — never invent a contrast with the artist\'s usual sound.',
    '- The feeling: two or three plain emotion words for what THIS song makes the listener feel, the way a friend would put it — the words that set it apart from other songs in its genre, not a mood that would fit any song.',
    '- The energy, honestly: hushed, gentle, relaxed, lively, urgent, intense or ferocious.',
    '- Intensity words (heavy, aggressive, raw, distorted, fuzz, crushing, screaming, abrasive) are for LOUD sound only. When the song is loud and aggressive (as much punk, metal and hard rock is), say so plainly. A soft, acoustic or gentle song never gets them, and never use "heavy" or "raw" for a sad feeling.',
    '- Never start with a comma-separated pair of adjectives.',
    '- Tempo is stored separately: do not mention tempo or pace unless it is the defining trait of the song.',
    '- Use exact words; avoid stock filler such as gritty, mid-tempo, driving, shimmering, late-night, high-octane.',
    '- No artist name, no song title, no preamble. Output ONLY the line.',
  ]
  if (retry) {
    const why = []
    if (retry.words?.length) why.push(`it used ${retry.words.map((w) => `"${w}"`).join(', ')}`)
    if (retry.opener) why.push('it opened with a pair of adjectives')
    lines.push('', `Your first draft was rejected because ${why.join(' and ')}. Write a different line that avoids those, leading with what makes this song sound unlike its neighbours.`)
  }
  return lines.join('\n')
}

/** Normalise a model reply into a descriptor, or null when unusable (same 8..400 gate as before). */
export function cleanDescriptor(raw) {
  const d = String(raw || '').trim().replace(/\s+/g, ' ').replace(/^["']|["']$/g, '')
  return (d.length >= 8 && d.length <= 400) ? d : null
}

/** Does a first draft get the one retry? */
export function needsRetry(d) {
  return !!d && stockScore(d) > 0
}

/** Keep the retry only when it is usable and strictly less stock than the first draft. */
export function pickDescriptor(first, second) {
  if (!first) return second || null
  if (!second) return first
  return stockScore(second) < stockScore(first) ? second : first
}

/**
 * Describe one track: prompt, post-check, at most one retry. `generate(prompt)`
 * returns the model's raw text (the trainer passes its Ollama call), so the
 * whole flow is testable without a model.
 */
export async function describeTrack(t, generate) {
  const first = cleanDescriptor(await generate(describePrompt(t)))
  if (!needsRetry(first)) return first
  let second = null
  try { second = cleanDescriptor(await generate(describePrompt(t, { words: stockHits(first), opener: formulaOpener(first) }))) } catch { /* keep the first */ }
  return pickDescriptor(first, second)
}
