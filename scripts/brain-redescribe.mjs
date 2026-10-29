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

/** Tracks still needing a `model` descriptor: neither live nor staged has one. */
export function redescribeCandidates(tracks, desc, next, model) {
  return tracks.filter((t) => {
    if (!(t.artist || t.title)) return false
    const id = String(t.id)
    return desc[id]?.gm !== model && next[id]?.gm !== model
  })
}

/**
 * The descriptor map a candidate mood index is built from: live descriptors
 * with every staged one laid over them (unless useCurrent).
 */
export function candidateDescriptors(desc, next, { useCurrent = false } = {}) {
  const out = {}
  for (const [id, e] of Object.entries(desc)) if (e?.d) out[id] = e.d
  if (!useCurrent) for (const [id, e] of Object.entries(next)) if (e?.d) out[id] = e.d
  return out
}

/**
 * Merge staged descriptors into the live store (mutates desc). Only the
 * descriptor fields move: `d`, `gm`, `at`. Everything else on the live entry
 * (meaning `m`, tempo flags `te`/`teb`, artist/title) is kept. Returns the
 * ids that changed.
 */
export function promoteNext(desc, next) {
  const changed = []
  for (const [id, e] of Object.entries(next)) {
    if (!e?.d || typeof e.d !== 'string') continue
    const cur = desc[id] || {}
    if (cur.d === e.d && cur.gm === e.gm) continue
    desc[id] = { ...cur, d: e.d, gm: e.gm, at: e.at || cur.at }
    changed.push(id)
  }
  return changed
}
