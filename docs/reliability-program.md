# The Pyramid Program — operational excellence for JakeTunes

Jake, 2026-08-21: "i now want to shift focus to glitch stomping, bug fixing,
reliability, efficiency, speed, accuracy… you know how the pyramids and
stonehenge have stood for tens of thousands of years? thats how sturdy the
guts of the app need to be."

This is the program. It is evidence-led: every item below traces to something
found in the 2026-08-21 audit, and every fix ships through the gate with a
rail or test so it can never silently un-fix.

## What the audit found (2026-08-21)

- **Zero crashes on record** — no JakeTunes entries in DiagnosticReports.
  The app does not fall over; its failures are QUIET ones.
- **Zero durable main-process logging.** Every `console.warn`/`error` in
  main went to stdout, and stdout goes nowhere when launched from Finder.
  Years of lane failures, cache misses, and sync warnings — all evaporated.
- **Zero renderer crash net.** No ErrorBoundary, no `window.onerror`, no
  `unhandledrejection` hook. The documented TDZ grey-screen class died
  without a trace every time.
- **78 silent `.catch(() => {})`** (ratcheted) — 46 of them in index.ts.
- **30 main modules with no test file** — notably mixtapes (6 silent
  catches), sync-orchestrator, tag-writer, state-dir.
- **Zero boot/perf instrumentation** — no numbers on startup, IPC, loads.
- **State dir at 8.8GB** — ~270MB of dead embeddings backups
  (`.bak-stale`, `.pretempo`, `.presubgenre`), a 74MB June embed cache,
  multiple dead library.json backups. Growth with no janitor.
- Existing bright spots to build on: audio-events.log (heartbeat flight
  recorder for playback, WITH rotation), evictions journal, vern
  diagnostics, KPI snapshot, the iron rails.

## P0 — See every failure *(SHIPPED 2026-08-21: flight recorder + crash net)*

The meta-fix. Stomping glitches without instrumentation is guessing
(diagnostic-before-fix doctrine, applied at program scale).

- ✅ `src/main/flight-recorder.ts` — main.log in LOCAL userData (never
  STATE_DIR: it can resolve to the NAS, and a wedged mount would hang
  appends exactly when logging matters). JSON lines, 5MB rotation into one
  `.1` generation, never-throws, drops confessed via `droppedBefore`.
  `mirrorConsole()` makes every existing warn/error site flow in unchanged.
- ✅ `src/renderer/CrashNet.tsx` — ErrorBoundary (recover-in-place reload
  panel, inline styles so it needs nothing) + `window.onerror` +
  `unhandledrejection`, all reporting over the `flight-record` channel
  through `sanitizeCrashPayload` (untrusted-wire discipline).
- ✅ Boot marks: `boot.main-start`, `boot.ready`, `boot.renderer-mounted`
  — the first timing baseline, free.
- Rails: `initFlightRecorder` and `armGlobalNets` are WIRING-locked.

## P1 — Stomp what the recorder catches

- Let main.log accumulate across days of real use. Each session starts by
  reading it: rank the noisiest tags, fix by evidence, re-verify in the log.
  ("Silence expected failures" gains its missing half: abnormal = DURABLY
  LOGGED, and now visible.)
- Silent-catch drawdown: 78 → under 40. Each site becomes handled, logged
  (one `console.warn` now suffices — the mirror makes it durable), or
  consciously kept with a comment. Lower the ratchet as it falls. Start
  with index.ts's 46 — many will leave naturally with the P2 cuts.

## P2 — Structural sturdiness (the renovation, continued)

- P1C2 sync-engine extraction and P1C4 play-cache closure surgery
  (roadmap: docs/renovation-roadmap.md). index.ts 16,299 → shrinking;
  the ratchet follows it down.
- Tests for load-bearing untested modules, worst first: mixtapes,
  sync-orchestrator, tag-writer, state-dir.
- Delete the stale worktree (`.claude/worktrees/lucid-hamilton-15355d`) —
  it already caused one wrong-build install on 2026-08-21.

## P3 — Speed and efficiency

- Boot budget: measure main-start → ready → renderer-mounted from the boot
  marks; then attack the loads (library.json 9.4MB, embeddings 59MB —
  when do they actually load, and does anything block paint?).
- State-dir janitor: bounded, journal-before-act (the eviction doctrine),
  Trash never unlink — reclaim the dead backups, cap the caches.

## P4 — Accuracy and proof

- Reliability KPIs into the Sunday snapshot: errors/day by tag from
  main.log, boot ms, drops count. The pyramid gets inspected, not assumed.

## Rules of engagement

- Evidence before fixes; the recorder is the evidence.
- Every fix lands with the test or rail that makes regression loud.
- No behavior changes ride along with instrumentation commits.
- Polish and plumbing stay in separate commits (CLAUDE.md commit rule).
