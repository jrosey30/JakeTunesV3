# Brief 004 — Salvage Audit Results

**Audit date:** 2026-05-15
**Trunk:** `claude/jaketunes-synology-setup-7m2xy` @ `dc351c7` (`docs(git): add salvage manifest and workflow rules`)
**Audit scope:** the 6 remote branches preserved by Brief 003. Read-only — no code, refs, or branches modified.

**Branches audited (in audit order):**
1. `origin/cursor/fix-ci-flakiness-e4fe`
2. `origin/cursor/fix-typescript-strict-d3eb`
3. `origin/cursor/fix-tsc-errors-hard-gate-6ed2`
4. `origin/cursor/review-ui-state-persistence-19f1`
5. `origin/claude/add-security-protocols-md-XlHV7`
6. `origin/claude/begin-mobile-development-4Hv2P`

No URGENT FINDINGS surfaced during this audit. One notable latent bug (`s.currentTrack` reference in `useAudio.ts` — see branch 2 verdict) is real but non-regressing; recommended for normal Brief-005 timing, not expedited.

---

## cursor/fix-ci-flakiness-e4fe

**Verdict:** DEFER

**Unique commits:** 1

**Files touched:** 1 file, +27 / -2 lines

**Conflict status:** clean

**Stale dependencies:** none

**Summary of work:**
Adds a 3-attempt retry helper (`/tmp/ci-retry.sh`, exponential backoff via `BASE_DELAY_SECONDS`) to `.github/workflows/check.yml`, and wraps the `npm ci` and `npm run build` steps with it. Hardens CI against transient registry/network blips. Pure CI infrastructure — does not touch any application code.

**Reasoning for verdict:**
The work itself is small, well-commented, and clean (0 conflict markers). It would be CHERRY-PICK on its merits. But Brief 003's out-of-scope list explicitly defers CI/Actions indefinitely, and the JakeTunes release path currently does not gate on `check.yml` results. Cherry-picking now adds a retry to a workflow no one watches. Hold until CI is reactivated as a release gate.

**If DEFER:**
- Reason for deferral: CI workflow is dormant per Brief 003 — retry hardening only pays off when CI is actually gating builds.
- Re-evaluation date or trigger: when CI is reactivated as a release gate (e.g. once `main` is fast-forwarded and a release-on-trunk workflow is wanted).

---

## cursor/fix-typescript-strict-d3eb

**Verdict:** CHERRY-PICK

**Unique commits:** 2 (`5c92e9d` clear 13 errors; `942b9eb` flip tsc to hard gate)

**Files touched:** 10 files, +94 / -44 lines

**Conflict status:** conflicts in 3 file regions (likely `src/main/index.ts` Buffer fix + overlaps where trunk diverged)

**Stale dependencies:** none — the symbols this branch targets (`s.currentTrack` in `useAudio.ts`, `RefObject<HTMLDivElement | null>` in `useVirtualScroll.ts`, no `env.d.ts`/`assets.d.ts` ambient image decls) are confirmed still present on trunk

**Summary of work:**
Fixes the ~13 baseline TypeScript errors that have been tagged "known/expected" in this codebase for months. Adds `src/renderer/env.d.ts` with ambient module declarations for image imports plus an `interface File { readonly path: string }` augmentation for Electron's `File.path`. Fixes the silent `s.currentTrack`-doesn't-exist bug in `useAudio.ts` (`recordSkip` is currently never called). Flips the CI tsc step from `continue-on-error: true` to a hard gate. Deletes the exploratory `fixes/FixTypeScriptErrors.ts` notes file.

**Reasoning for verdict:**
This is real work that resolves a real latent bug. Trunk's `useAudio.ts:821-822` references `s.currentTrack` (which doesn't exist on the state shape) — so `recordSkip` IPC is silently never invoked, meaning Music Man's skip telemetry is currently broken without anyone noticing. The other fixes (env.d.ts ambient decls, MutableRefObject for nullable refs, structural AlacResult coercion) are clean type-correctness improvements that survive even without the hard-gate CI step. Trunk's existing lazy `as unknown as BodyInit` cast for the artwork Response will conflict with this branch's `data.buffer.slice(...)` fix — resolvable by hand. Well-commented; explains WHY each cast/change, matching CLAUDE.md style.

**If CHERRY-PICK:**
- Suggested follow-up brief: **Brief 005 — Adopt the TypeScript-strict baseline fix**
- Estimated complexity: medium (3 conflict regions, plus the question of whether to also flip the CI step now or keep it informational until CI is reactivated)
- Dependencies on other salvage branches: none, but `cursor/review-ui-state-persistence-19f1` (also CHERRY-PICK) touches `SmartPlaylistView.tsx` — Brief 005 should land first to avoid double-touching that file

---

## cursor/fix-tsc-errors-hard-gate-6ed2

**Verdict:** SKIP

**Unique commits:** 1 (`a360d11`)

**Files touched:** 10 files, +69 / -42 lines

**Conflict status:** conflicts in 5 file regions

**Stale dependencies:** redundant with `cursor/fix-typescript-strict-d3eb` — solves the same 13 tsc errors with stylistically inferior choices

**Summary of work:**
A single-commit earlier sibling of `cursor/fix-typescript-strict-d3eb`. Targets the same 13 tsc errors. Adds `src/renderer/assets.d.ts` (instead of `env.d.ts`) for image module declarations. Uses `new Uint8Array(data)` for the Response/Buffer fix; uses `containerRef as React.RefObject<HTMLDivElement>` cast-at-usage (instead of changing the type definition); makes `recordPlay/recordSkip/recordRating` required (vs optional in the sibling branch); flips tsc to hard gate.

**Reasoning for verdict:**
This and `cursor/fix-typescript-strict-d3eb` are two competing iterations on the same problem from Jake's Cursor experimentation session. The sibling branch is strictly better: cleaner `MutableRefObject` fix at the type definition (vs a cast at every call site), more flexible optional record-methods types, better explanatory comments, and a 2-commit history that separates the error fixes from the gate flip. Keeping this one is technical debt for no gain. SKIP per CLAUDE.md "Bad code is technical debt even when it ships" — this is the inferior of two solutions to the same problem.

**If SKIP:**
- Suggested follow-up: delete from origin in a future cleanup brief

---

## cursor/review-ui-state-persistence-19f1

**Verdict:** CHERRY-PICK

**Unique commits:** 1 (`d6cb80a`)

**Files touched:** 2 files (`src/renderer/components/ShowDuplicatesModal.tsx`, `src/renderer/views/SmartPlaylistView.tsx`), +93 / -56 lines

**Conflict status:** conflicts in 3 file regions

**Stale dependencies:** none — verified `window.electronAPI.loadUiState()` / `saveUiState()` IPC is present on trunk (used in `App.tsx`, `DeviceView.tsx`, `ImportConvertModal.tsx`, `SplashScreen.tsx`, and typed in `renderer/types.ts:309-310`)

**Summary of work:**
Removes the last two `localStorage` consumers from the renderer (Duplicates dismissals + Music Man Picks daily cache) and replaces them with the existing `loadUiState` / `saveUiState` IPC. Adds `dismissedLoaded` / `picksStateLoaded` guard refs so the first-write-after-mount doesn't clobber the file before the load completes — proper async load-then-write semantics.

**Reasoning for verdict:**
CLAUDE.md explicitly bans `localStorage` in the Electron renderer: *"localStorage / sessionStorage — use electron-store or IPC to main process instead."* This branch is the cleanup that brings two remaining offenders into compliance. The required IPC already exists and is heavily used (8+ trunk references), so there's no dependency on un-merged plumbing. The race-condition handling (`*Loaded` guard before save effect) is a real engineering correctness improvement on top of the simple swap. Conflicts are likely from `SmartPlaylistView.tsx` overlapping with `cursor/fix-typescript-strict-d3eb` (which also touches this file).

**If CHERRY-PICK:**
- Suggested follow-up brief: **Brief 006 — Replace remaining renderer localStorage with ui-state IPC**
- Estimated complexity: low-medium (2 files, mechanical swap pattern, but conflicts with Brief 005's `SmartPlaylistView.tsx` changes)
- Dependencies on other salvage branches: **must land AFTER Brief 005** (`cursor/fix-typescript-strict-d3eb`) to minimize the SmartPlaylistView.tsx merge conflict

---

## claude/add-security-protocols-md-XlHV7

**Verdict:** DEFER

**Unique commits:** 1 (`5fef8ec`)

**Files touched:** 8 files (all `.md`), +331 / -0 lines, no code

**Conflict status:** clean

**Stale dependencies:** none — purely additive docs work

**Summary of work:**
Adds a comprehensive supply-chain security section to `CLAUDE.md` (~115 lines: lockfile law, new-dep checklist with `npm view <pkg> time` 72h hold, postinstall script audit, secret-scan grep, build/runtime hardening including Electron `contextIsolation: true`, incident response, and an explicit anti-cargo-cult section). Cross-references this from `README.md` (36-line "Security" section), `docs/4.0-mbid-backfill.md` (§8.5), `docs/4.0-scope.md` (§2.5 supply-chain baseline with acceptance criteria), `docs/CHANGELOG.md` (top-level "Security baseline" prologue), and three postmortems (each gets a "Security note (added 2026-05-12)" trailer connecting that incident's lesson to supply-chain triage).

**Reasoning for verdict:**
The work is high quality — specific commands, real threat model (npm worm-class attacks), explicit anti-cargo-cult list naming what NOT to do (no vendored `node_modules`, no private registry mirror, no per-install manual review). 0 conflicts, fully additive. The blocker for CHERRY-PICK is not the work, it's the commitment: adopting these protocols changes how Jake develops. He'd need to use `npm ci` not `npm install`, wait 72h on new top-level deps, audit `postinstall` scripts before re-enabling install scripts, gate releases on `npm audit`. Recent activity in this repo (4.4.51–4.4.60) does not appear to follow these rules. Cherry-picking now publishes a ruleset that current practice ignores — that's worse than not having the doc, because it creates rules-vs-reality drift inside CLAUDE.md itself. Hold until Jake explicitly decides to adopt.

**If DEFER:**
- Reason for deferral: the doc is good but adopting it changes day-to-day workflow significantly — Jake should decide whether to commit to the practice before merging
- Re-evaluation date or trigger: (a) an npm worm-class incident hits a JakeTunes dependency, OR (b) Jake explicitly wants to formalize supply-chain practice

---

## claude/begin-mobile-development-4Hv2P

**Verdict:** DEFER

**Unique commits:** 7

**Files touched:** 55 files, +5271 / -1 lines

**Conflict status:** conflicts in 3 file regions

**Stale dependencies:** unknown without merge attempt — package.json gets +5 lines (likely a test-runner dependency), the new test files (`library-overrides.test.ts`, `library-snapshot.test.ts`, `twin-invariants.test.ts`) need a Jest/Vitest runner that may not be wired on trunk; CLAUDE.md gets +223 lines of mobile-development rules

**Summary of work:**
A multi-commit branch that scaffolds JakeTunes Mobile (React Native, iOS) and adds the desktop-side infrastructure that mobile needs: ~38 new files under `mobile/` (RN app, RN screens, services for NAS streaming and secure storage, components, types), plus ~840 lines of new desktop code: `src/main/library-snapshot.ts` (140 lines, library.json exporter with a path-format contract), `src/main/library-overrides.ts` (181 lines, override queue with identity-gated desktop drain), three regression test files (`twin-invariants.test.ts` pins CLAUDE.md's twin-discovery rule with executable assertions; `library-overrides.test.ts` and `library-snapshot.test.ts` give the new modules coverage — the commit message claims "60 tests, all green"). Also wires `src/main/index.ts` (+151), `src/preload/index.ts` (+33), `src/renderer/App.tsx` (+60), `src/renderer/types.ts` (+38), and adds 223 lines to CLAUDE.md (mobile development rules).

**Reasoning for verdict:**
The mobile/ scaffold is parked work — mobile development is not the current priority and the user explicitly paused it. So a clean CHERRY-PICK isn't right. But this branch is unusual in that ~16% of its diff is genuinely desktop-side infrastructure (snapshot exporter, override queue, three regression test files including one that pins a CLAUDE.md rule). Those pieces are valuable regardless of whether mobile ever ships. A whole-branch verdict is DEFER, but a future split-cherry-pick brief is strongly recommended — see Cross-Branch Notes. The 60-test regression suite is particularly worth recovering since CLAUDE.md asks for tests that pin postmortem rules and there's no such infrastructure on trunk today.

**If DEFER:**
- Reason for deferral: mobile is parked at Jake's request; whole-branch merge isn't right while mobile is paused
- Re-evaluation date or trigger: (a) mobile development reactivates → take the whole branch (modulo conflict resolution), OR (b) Jake authorizes a partial-cherry-pick brief that takes only the desktop-coupled pieces (snapshot + overrides + tests) while leaving `mobile/` parked. The partial brief is recommended even while mobile stays parked — see Cross-Branch Notes.

---

## Cross-Branch Notes

### Dependency chains and order

- **Brief 005 must precede Brief 006.** `cursor/fix-typescript-strict-d3eb` and `cursor/review-ui-state-persistence-19f1` both touch `src/renderer/views/SmartPlaylistView.tsx`. Cherry-picking #2 first (Brief 005) lands the type-correctness edits to the event-listener handler. #4 (Brief 006) then replaces the `localStorage` block with `loadUiState`/`saveUiState` cleanly. Reversed order forces a manual merge in SmartPlaylistView for no benefit.
- **Brief 005 has internal Buffer/BodyInit conflict with trunk.** Trunk already applied a lazy `data as unknown as BodyInit` cast for the artwork-protocol Response. #2's structural `data.buffer.slice(...)` approach is cleaner. Brief 005 should consciously choose between trunk's cast and #2's slice — recommend keeping #2's slice (better contract with BodyInit).
- **#5 (security) and #6 (mobile) both modify `CLAUDE.md`** in non-overlapping sections (security adds ~115 lines after the existing "Toolbar.tsx" section, mobile adds 223 lines further down). If both were ever cherry-picked, line offsets would need rebasing but no semantic conflict.
- **#1 (ci-flakiness) and #2/#3 all modify `.github/workflows/check.yml`** in different stanzas (#1 adds a retry-helper step + wraps `npm ci`/`npm run build`; #2/#3 flip the tsc step from soft-gate to hard). The two changes can coexist mechanically but a future CI-reactivation brief should land both together for a coherent workflow.

### Combined-vs-separate brief recommendations

| Follow-up | Source branch(es) | Scope |
|---|---|---|
| **Brief 005** | `cursor/fix-typescript-strict-d3eb` | Adopt the type-correctness baseline fix. Decide whether to flip tsc to hard-gate now (no, CI is dormant) or just land the type fixes. |
| **Brief 006** | `cursor/review-ui-state-persistence-19f1` | Replace remaining renderer `localStorage` with ui-state IPC. Must land after Brief 005. |
| **Brief 007 (recommended, optional)** | `claude/begin-mobile-development-4Hv2P` (split) | Partial cherry-pick: take only `library-snapshot.ts`, `library-overrides.ts`, the three regression test files (`twin-invariants`, `library-overrides`, `library-snapshot`), the package.json test-runner dep, and the minimal main/preload/renderer wiring needed to run them. Leave the `mobile/` directory and the 223-line CLAUDE.md mobile-rules addition untouched on origin until mobile reactivates. |
| **Cleanup brief** | `cursor/fix-tsc-errors-hard-gate-6ed2` | Delete from origin. SKIP-verdict branches earned this fate. |
| **Future, gated on a decision** | `cursor/fix-ci-flakiness-e4fe` + `claude/add-security-protocols-md-XlHV7` + `claude/begin-mobile-development-4Hv2P` (whole) | Cherry-pick when their respective triggers fire (CI reactivation / security-practice adoption / mobile reactivation). No brief scheduled now. |

### Risk surface (highest-to-lowest among the recommended cherry-picks)

1. **Brief 005 (TypeScript baseline)** — medium. 10 files including hot paths (`src/main/index.ts` Response handling, `src/renderer/hooks/useAudio.ts` skip telemetry, `src/renderer/hooks/useVirtualScroll.ts` shared by every list view, `src/renderer/types.ts` global Window interface). 3 conflict regions. Includes a real silent-bug fix in useAudio that means runtime behavior of Music Man telemetry will *change* (it starts recording skips). Verify nothing else relied on the broken-skip behavior — almost certainly nothing, but worth a sanity-check.
2. **Brief 007 (mobile split, if pursued)** — medium-high. New `src/main/library-snapshot.ts` and `src/main/library-overrides.ts` are file-system-touching code (write `library.json` snapshots, modify Track records via override queue). Both need a careful read in the cherry-pick brief — confirm no destructive-text-comparison anti-patterns (per CLAUDE.md), confirm identity gating on the desktop drain. The +151 lines in `src/main/index.ts` (already the most complex file in the repo) is the highest local-change-risk surface.
3. **Brief 006 (ui-state IPC)** — low-medium. 2 files, no hot paths, mechanical pattern. The race-condition guard (`*Loaded` refs) is what makes it correct — must survive the merge.

### Items the audit *did not* attempt

- Running `git merge` (any flavor) for any branch — explicitly out of scope.
- Inspecting each individual commit on the mobile branch — the 5 NEW desktop files + 38 mobile/ files would have been a 2x audit. The verdict (DEFER) doesn't require commit-by-commit detail; the split-brief recommendation can do that work when scoped.
- Confirming the 60 test claim on the mobile branch — would require running the suite, which means at minimum installing whatever test runner that branch adds in `package.json`. Treat the count as the commit message's claim, not as audited.

---

## Summary Table

| Branch | Verdict | Suggested follow-up |
|---|---|---|
| `cursor/fix-ci-flakiness-e4fe` | DEFER | hold until CI reactivated |
| `cursor/fix-typescript-strict-d3eb` | CHERRY-PICK | **Brief 005** — TypeScript baseline fix |
| `cursor/fix-tsc-errors-hard-gate-6ed2` | SKIP | delete from origin (future cleanup brief) |
| `cursor/review-ui-state-persistence-19f1` | CHERRY-PICK | **Brief 006** — remove renderer localStorage (after Brief 005) |
| `claude/add-security-protocols-md-XlHV7` | DEFER | hold until supply-chain practice formalized or worm incident |
| `claude/begin-mobile-development-4Hv2P` | DEFER | whole-branch when mobile reactivates · optional **Brief 007** to split desktop-coupled pieces now |
