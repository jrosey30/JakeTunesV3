// Brief 165 — shared write path for scripts that rewrite library.json.
//
// Two protections, one import:
//
//   1. writeJsonAtomic(path, value) — serialize to a temp file in the SAME
//      directory, parse it back, then rename over the target. This is the
//      pattern scripts/fix-bpm-octaves.mjs and scripts/recover-orphans.mjs
//      already use; a script killed mid-write can no longer leave a torn
//      library.json behind.
//   2. assertAppNotRunning() — the app-quit gate scripts/taxonomy-classify.py
//      already uses (its app_running()): the app serializes only its OWN
//      saves, so an external write landing mid-save is silently overwritten
//      (the mtime guard only catches writes from before the save started).
//      Writers refuse (exit 3) while JakeTunes is running.
//
// The gate is a same-host check only: a script running on another machine
// against a NAS-resident library cannot see the app process, and there
// temp+rename is the protection. See docs/briefs/165-script-writers-atomic-gate.md.
//
// Callers keep their existing timestamped backup behaviour — this helper
// only replaces the final in-place write and adds the gate.

import { writeFileSync, readFileSync, renameSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'

/** Mirror of taxonomy-classify.py's app_running(): pgrep match ⇒ running; any error ⇒ not running. */
export function appRunning() {
  try {
    execFileSync('pgrep', ['-f', 'JakeTunes.app/Contents/MacOS/JakeTunes'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Refuse to write while the desktop app is running (it would clobber the write on its next save). */
export function assertAppNotRunning(action = 'write library.json') {
  if (!appRunning()) return
  console.error(`REFUSED: JakeTunes is running — quit the app before you ${action}.`)
  console.error('The app does not see an external write that lands mid-save; the change would be silently overwritten.')
  process.exit(3)
}

/** Write `value` as JSON (2-space indent, matching the scripts' existing format) via temp + parse-back + rename. */
export function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  try {
    // Parse the temp file back before it replaces anything — a torn write
    // must never become library.json (same verify as fix-bpm-octaves.mjs).
    JSON.parse(readFileSync(tmp, 'utf8'))
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw err
  }
  renameSync(tmp, path)
}
