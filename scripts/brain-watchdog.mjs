#!/usr/bin/env node
/**
 * brain-watchdog.mjs — Brief 176: the staleness watchdog for the nightly
 * brain trainer.
 *
 * The trainer now writes brain-status.json on every exit path (see
 * brain-status.mjs), but a job that never STARTS — launchd broken, machine
 * asleep through the window, script deleted — writes nothing at all, and
 * silence looks exactly like health from inside the trainer. This watchdog
 * is the outside check: run it hourly from launchd
 * (scripts/launchd/, template com.jaketunes.brain-watchdog — Brief 183).
 *
 *   status fresh (< ~26 h)  → exit 0, silent
 *   missing / unparseable / stale → ntfy push (the SAME topic file the
 *     trainer's notify() uses: ~/.config/jaketunes/ntfy-topic) + a local
 *     macOS notification attempt + exit 1
 *
 * Usage:
 *   node scripts/brain-watchdog.mjs [--status-path <file>] [--max-age-hours <n>]
 *
 * The status path defaults to $JT_STATE_DIR/brain-status.json when
 * JT_STATE_DIR is set, else the local app-support copy — the fallback the
 * trainer writes precisely for the case where the NAS copy is unreachable.
 * BRAIN_WATCHDOG_NO_NOTIFY=1 suppresses the pushes (fixture runs, tests).
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { readBrainStatus, statusAgeMs, isStale, STALE_AFTER_MS } from './brain-status.mjs'

const argv = process.argv.slice(2)
const argVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }

const STATUS_PATH = argVal('--status-path')
  || (process.env.JT_STATE_DIR
    ? join(process.env.JT_STATE_DIR, 'brain-status.json')
    : join(homedir(), 'Library', 'Application Support', 'JakeTunes', 'brain-status.json'))
const MAX_AGE_MS = (Number(argVal('--max-age-hours')) || STALE_AFTER_MS / 3600000) * 3600 * 1000

// Same ntfy channel as the trainer's notify(): the health-watchdog topic
// file at ~/.config/jaketunes/ntfy-topic (a bare topic or a full URL).
async function pushNtfy(title, message) {
  try {
    const tf = join(homedir(), '.config', 'jaketunes', 'ntfy-topic')
    if (!existsSync(tf)) return
    const topic = readFileSync(tf, 'utf8').trim()
    if (!topic) return
    const url = topic.startsWith('http') ? topic : `https://ntfy.sh/${topic}`
    await fetch(url, {
      method: 'POST',
      headers: { Title: title.replace(/[^\x20-\x7E]/g, '').trim() || 'Brain Watchdog' },
      body: message,
      signal: AbortSignal.timeout(8000),
    }).catch(() => {})
  } catch { /* push is best-effort — the exit code is the durable signal */ }
}

function notifyLocal(title, message) {
  try {
    execFileSync('/usr/bin/osascript', ['-e',
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
      { timeout: 5000, stdio: 'ignore' })
  } catch { /* headless / no GUI session */ }
}

const status = readBrainStatus(STATUS_PATH)
const ageMs = statusAgeMs(status)

if (!isStale(status, Date.now(), MAX_AGE_MS)) {
  // Fresh: health is silent by design (exit 0, no output, no push).
  process.exit(0)
}

const reason = !status
  ? `brain-status.json is missing or unparseable at ${STATUS_PATH} — the trainer has not reported at all`
  : status.ok === false
    ? `last trainer run FAILED at ${status.at}: ${status.error || 'unknown error'} (status now ${Math.round(ageMs / 3600000)}h old)`
    : `brain-status.json is ${Math.round(ageMs / 3600000)}h old (last ok run ${status.at}) — the nightly trainer has missed a night`

console.error(`[brain-watchdog] STALE: ${reason}`)
if (!process.env.BRAIN_WATCHDOG_NO_NOTIFY) {
  notifyLocal('JakeTunes brain: trainer is STALE', reason)
  await pushNtfy('JakeTunes brain: trainer is STALE', reason)
}
process.exit(1)
