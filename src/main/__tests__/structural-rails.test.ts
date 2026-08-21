/**
 * The iron-clad rails — CLAUDE.md's paper rules, promoted to machine gates.
 *
 * Jake, 2026-08-16: "all code rules need to be iron clad to making the app
 * work as designed." Every rule in this file has already been violated at
 * real cost while existing only as prose: the type net was down for weeks
 * behind 73 errors nothing checked; a tested doctrine function sat unwired
 * while an inline twin drifted-in-waiting did its job; a deleted module
 * shipped inside the asar for two months; 78 silent catch-swallows hid a
 * "dead in production" hunt that took an hour to disprove.
 *
 * Two mechanisms:
 *   BANS     — things that must be ZERO, forever.
 *   RATCHETS — debts too big to fix tonight, locked at today's count so
 *              they can only shrink. Lowering a ratchet after cleanup is
 *              the intended maintenance; raising one requires saying so in
 *              this file, in a commit, out loud.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '../..')

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, exts))
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

function countAcross(files: string[], re: RegExp): { total: number; hits: Array<{ file: string; n: number }> } {
  const hits: Array<{ file: string; n: number }> = []
  let total = 0
  for (const f of files) {
    const n = (readFileSync(f, 'utf-8').match(re) || []).length
    if (n > 0) { hits.push({ file: f.slice(SRC.length + 1), n }); total += n }
  }
  return { total, hits }
}

describe('BANS — zero, forever', () => {
  test('no renderer browser dialogs — they fail SILENTLY in Electron', () => {
    // CLAUDE.md: "Zero results is the only acceptable output." Matches CALLS
    // (with the paren), not comments that cite the rule.
    const files = walk(join(SRC, 'renderer'), ['.ts', '.tsx'])
    const { total, hits } = countAcross(files, /window\.(prompt|alert|confirm)\s*\(/g)
    assert.equal(total, 0,
      `forbidden renderer dialog call(s) in: ${hits.map((h) => h.file).join(', ')} — these return null/no-op silently in Electron; use inline inputs / ConfirmDialog`)
  })

  test('no raw ipcMain.handle outside the registrar — default-deny is the doctrine', () => {
    // Every handler goes through createIpcRegistrar so a forgotten sender
    // guard is impossible-by-default. ipcMain.on for fire-and-forget events
    // is allowed; HANDLE (request/response) must use the registrar.
    const files = walk(join(SRC, 'main'), ['.ts']).filter((f) => !f.endsWith('ipc-register.ts'))
    const { total, hits } = countAcross(files, /ipcMain\.handle\(/g)
    assert.equal(total, 0,
      `raw ipcMain.handle in: ${hits.map((h) => `${h.file}(${h.n})`).join(', ')} — register through createIpcRegistrar`)
  })
})

describe('RATCHETS — locked at today, may only shrink', () => {
  // ── index.ts line count ──────────────────────────────────────────────
  // The god file. 17,067 lines on lock day, and every wiring regression
  // this codebase has suffered lived inside it. The decomposition project
  // (persona-memory, library-digest, personas, listener-profile, exa,
  // eviction, …) shrinks it cut by cut; this ratchet makes growth a
  // deliberate act instead of the path of least resistance. Small slack
  // (+150) so an ordinary fix isn't blocked mid-crisis; the direction is
  // what's enforced.
  const INDEX_LINES_LOCKED = 16255
  test(`index.ts stays ≤ ${INDEX_LINES_LOCKED + 150} lines and the lock follows it down`, () => {
    const lines = readFileSync(join(SRC, 'main/index.ts'), 'utf-8').split('\n').length
    assert.ok(lines <= INDEX_LINES_LOCKED + 150,
      `index.ts is ${lines} lines (lock ${INDEX_LINES_LOCKED} + 150 slack). New capability belongs in a MODULE — see the decomposition pattern in personas.ts / library-eviction.ts.`)
    if (lines < INDEX_LINES_LOCKED - 300) {
      assert.fail(`index.ts shrank to ${lines} — good work; lower INDEX_LINES_LOCKED to ${lines} in this file so the gain is locked in.`)
    }
  })

  // ── silent catches ───────────────────────────────────────────────────
  // `.catch(() => {})` swallowed the mixtape-mint "failure" (which was
  // real), the auto-repair abort (which cost a night), and 76 friends.
  // Some are legitimate (fire-and-forget UI notices); the RATE of new ones
  // is the disease. Locked at 78: every new silent catch either handles
  // its error, logs once (the silence-expected-failures doctrine: gate on
  // observable state, log the abnormal), or consciously raises this
  // number in its commit.
  const SILENT_CATCHES_LOCKED = 78
  test(`silent .catch(() => {}) in main stays ≤ ${SILENT_CATCHES_LOCKED}`, () => {
    // Live code only: _archive is dead by definition, and test files cite
    // the pattern as data (this one included — the regex is assembled so
    // it cannot match its own source).
    const files = walk(join(SRC, 'main'), ['.ts'])
      .filter((f) => !f.includes('/_archive/') && !f.includes('/__tests__/'))
    const { total, hits } = countAcross(files, new RegExp('\\.catch' + '\\(\\(\\) => \\{\\}\\)', 'g'))
    assert.ok(total <= SILENT_CATCHES_LOCKED,
      `${total} silent catches (locked at ${SILENT_CATCHES_LOCKED}). New ones in: ${hits.slice(0, 4).map((h) => `${h.file}(${h.n})`).join(', ')} — handle it, log it, or raise the lock in your commit with a reason.`)
    if (total < SILENT_CATCHES_LOCKED - 10) {
      assert.fail(`silent catches down to ${total} — lower SILENT_CATCHES_LOCKED to ${total} to lock in the cleanup.`)
    }
  })
})

describe('WIRING — the tested code is the live code', () => {
  // The class of regression this repo actually suffers: rebuilds that drop
  // wires while every unit test stays green. Each entry pins a doctrine
  // function to its call sites. (Per-feature locks live in their own test
  // files — audio-signal-path, stream-playback-path, download-explicit;
  // this is the roster of load-bearing wires with no better home.)
  const WIRES: Array<{ fn: string; file: string; minCalls: number; why: string; literal?: boolean }> = [
    { fn: 'explicitWins', file: 'main/download-search.ts', minCalls: 1, why: 'the dedupe merge must run on the TESTED doctrine (unwired 08/10-08/15; moved with P1C3)' },
    { fn: 'ensureContiguousDb', file: 'main/index.ts', minCalls: 1, why: 'the catalog layout pass — content gates cannot see fragmentation' },
    { fn: 'sweepOnce', file: 'main/index.ts', minCalls: 1, why: 'pass-through eviction — without the wire the laptop silently hoards again' },
    { fn: 'initPersonaPrompts', file: 'main/index.ts', minCalls: 1, why: 'supplier injection — a missing init freezes activeHost at boot value' },
    { fn: 'searchItunesSuggestions', file: 'main/index.ts', minCalls: 1, why: 'P1C3 — the search shim must call the module' },
    { fn: 'itunesAlbumTracks', file: 'main/index.ts', minCalls: 1, why: 'P1C3 — the album-expand shim must call the module' },
    { fn: 'initImportPipeline', file: 'main/index.ts', minCalls: 1, why: 'P1C1 — the pipeline is dead weight without its world wired in' },
    // Called as df.applyQualityFloor (dynamic-import namespace), so the wire
    // matches the literal dotted form the bare-call regex would reject.
    { fn: '.applyQualityFloor(', file: 'main/index.ts', minCalls: 1, literal: true, why: 'discovery quality floor — without the wire the shop ships 40% "no signal" cards again' },
    // Passed by REFERENCE (importDownloaded: importDownloadedFiles), never
    // called directly in index — so this wire matches the reference form.
    { fn: 'importDownloaded: importDownloadedFiles', file: 'main/index.ts', minCalls: 2, literal: true,
      why: 'P1C1 — both store integrations receive the import bridge' },
  ]
  for (const w of WIRES) {
    test(`${w.fn} is wired (${w.why})`, () => {
      const src = readFileSync(join(SRC, w.file), 'utf-8')
      const calls = w.literal
        ? src.split(w.fn).length - 1
        : (src.match(new RegExp(`(?<![\\w.])${w.fn}\\(`, 'g')) || []).length
      assert.ok(calls >= w.minCalls,
        `${w.fn} has ${calls} call site(s) in ${w.file}, needs ≥${w.minCalls} — a rebuild dropped the wire again`)
    })
  }
})
