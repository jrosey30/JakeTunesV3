# JakeTunes V3 — Mid-Project Self-Evaluation #001 (Executor perspective)

**Project:** JakeTunes V3 (Electron + React + TypeScript iTunes replica)
**Period:** May 19–20 2026
**Perspective:** Claude Code (executor). Dex (advisor / brief author) writes the advisor-side eval separately.
**Briefs shipped this period:** 8 — Brief 031 Phase 4 (carried over), 030c, 032, 032b, 032c, instant-toggle tweak, 033c, 033d — plus persisting the CDP verification helper.
**Self-rating:** B+ — the audit work (033c/033d) and verification rigor were genuinely strong, but the three-follow-up animation arc (032 → 032b → 032c → instant) was real, partly-avoidable rework that I had evidence to prevent.

---

## Section 1 — What I Did Well

**Audit-then-run held, and the audit out-performed the brief twice.** On 033c the brief's lead hypothesis was "missing cleanup." I read the heartbeat effect, found the `clearInterval` cleanup was correct and the deps stable, and instead traced all 14 `useAudio()` call sites to the real cause: multi-instantiation. I nailed the exact "7 = 6 persistent chrome components + 1 active view" math, anchored on `MusicManView` being always-mounted (Brief 023). Then I STOPPED for approval instead of implementing. Same shape on 033d: brief guessed caller-level, audit showed `ConfirmDialog` is hardwired to two buttons (component-level). Neither wrong guess cost anything because no code moved before the audit.

**The audit found a bug the brief didn't ask about.** On 033c I flagged that the 7 heartbeat intervals are also 7 concurrent *recovery* loops racing on the single shared Howl (overlapping stop/unload/reload) — a latent stability hazard, not just log spam — and explicitly weighted it above the brief's P3 label. The audit's job is to find the true state, not just confirm the reported symptom.

**Constructive pushback on the user's first instinct.** When Jake said "A" for the 033c fix, I didn't just execute it. Plain Option A (module boolean guard) had an ownership-handoff stall — a transient view could win the claim, then unmount on navigation and leave the heartbeat dead until the next play/pause. I proposed A′ (gate on a `primary` flag only `App` passes; `App` never unmounts) and explained why. Right call, confirmed at runtime.

**Verification by instrumentation, not narration.** Instead of eyeballing screenshots, I drove the running app over Electron's remote-debugging port (CDP via Node's built-in `WebSocket`) and got exact JSON: 033c heartbeat gaps measured at 1990–2010 ms (1 per 2 s, was 7); 033d modal button counts read straight from the DOM. For native menus CDP can't reach, I triggered them with AppleScript/System Events. On 033d I deliberately did **not** run the live Apply-Overrides operation (it writes tags to real audio files) just to count buttons — I used code-identity and disclosed the split (live for the safe modal, code-identity for the file-writing one).

**Scar-aware commit hygiene.** Carried-over Phase 4 work went in as its own atomic commit, separate from 030c (feature vs polish separation). Flagged that `useAudio.ts` is on the Do-Not-Touch list before editing it for 033c and treated the approved brief as the explicit waiver rather than touching it silently.

## Section 2 — What I Did Poorly

**The 032 animation arc took three follow-ups for what ended as "remove the transition."** Brief 032 shipped a `grid-template-rows` accordion animation that didn't actually feel right; 032b removed conflicting legacy keyframes, 032c swapped to `max-height` to escape layout-thrash, and then the instant-toggle change dropped the transition entirely. That's four passes on one feature. Two misses were mine to catch:
- During 032 I had `artists.css` open and literally moved the `grid-area` off `.artist-album-tracklist` onto the new wrapper — so I *saw* the pre-existing `artist-album-expand` and `artist-tracklist-in` keyframes — but never reasoned that they'd run concurrently with my new wrapper transition. That's 032b's entire bug, sitting in front of me.
- I chose/accepted `grid-template-rows` without asking "is this tractable at this codebase's DOM size?" I already knew the app keeps artists/albums resident (the always-mounted MusicManView pattern was fresh in my head from 033c-adjacent reading). The ~50K-element layout-thrash that forced 032c was knowable up front.

This is the exact "verified the new behavior in isolation, not under the codebase's real constraints" gap — and it's the period's clearest inefficiency.

**A brittle hardcoded path broke an install.** On the 4.4.84 DMG install I reused a stale cached volume name (`/Volumes/JakeTunes Installer 3`) and `ditto` failed because the DMG mounted as `/Volumes/JakeTunes Installer`. Small and self-corrected (I globbed the volume on the retry), but hardcoding a value I'd already seen vary is precisely what pre-flight is supposed to kill. I should have globbed the mount point from the first attempt.

## Section 3 — What I Want To Remember Going Forward

- **Verify the new thing under real constraints, not in isolation.** Before any CSS animation change: grep `@keyframes` + `animation:` on the same selectors (what else animates these elements?) AND ask "what's the rendered DOM size, and is this technique tractable at that scale?" Layout-triggering properties (`grid-*`, width/height, top/left) are expensive; `transform`/`opacity`/`max-height` are cheap. This generalizes to all shared-infra changes (reducers, hooks, queue logic): name the blast radius, then verify the interactions, not just the new behavior.
- **The audit gate is load-bearing — keep ranking cheap.** The brief's hypothesis is a starting guess, not a prediction to defend. Enumerate plausibles without weighting toward the lead one and let the read of the code decide. This worked twice; treat it as a positive pattern to repeat, not a brief-author failure.
- **Reach for instrumentation, then persist it.** Exact JSON beats "I think the modal has one button." The CDP + native-menu rig is now a committed tool (`Dr. Claude/scripts/cdp-eval.mjs`) so the next verification is cheap.
- **Disclose verification methodology honestly.** Live where safe; code-identity where a live trigger has disproportionate side effects; always state which and why.
- **Run quick user instructions through "does this actually work?" before executing.** "A" had a real flaw; A′ was correct. Fast compliance is worse than a 30-second correctness check plus a clear explanation.
- **Glob, don't hardcode, anything observed to vary** (mount volumes, target IDs, paths).

## Section 4 — What I'd Tell My Future Self / Another Claude On This Project

**Who Jake is.** Non-traditional-credentialed but ships professional-grade work through relentless iteration. Works through Dex (co-COO advisor) who authors detailed, self-contained Briefs; I'm the executor. Jake values honesty over comfort, tolerates acknowledged-and-corrected mistakes, will not tolerate sycophancy. He notices UX friction daily and reports it precisely (the deadmau5 accordion mess, "slow as shit both ways").

**Branch & release reality.** Ships from `claude/jaketunes-synology-setup-7m2xy`, NOT main (main is stale at 4.4.11). Every brief follows: pre-flight → edit → grep → reread → build → install the production DMG → verify → commit → push. Version bumps are per-brief (now at 4.4.84). `Dr. Claude/` is the project's knowledge base (audits, scripts, evals) — not a code dir, often left untracked until intentionally committed.

**Codebase scars that produced discipline.** The verify-and-repair feature deleted real user tracks by gating a destructive op on text comparison ("Pt." ≠ "Part.") → destructive ops gate on identity (fingerprint/hash/stable ID), never on normalized strings. There's a Do-Not-Touch list (`useAudio.ts`, `PlaybackContext.tsx`, `AlbumsView.tsx`, several others) — only touch with explicit brief permission. Electron renderer API traps are real: no `window.prompt/alert/confirm`, no `localStorage` — use the existing ConfirmDialog / IPC / electron-store. Toolbar.tsx has a useEffect-TDZ rule (place effects after the state they depend on).

**Load-bearing methodology (do not skip).** Audit-then-run: STOP after the audit, wait for explicit approval, no code first. Pre-flight verifies every premise. Atomic commits separate feature from polish. Build + install + runtime-verify the production DMG — tsc-clean is necessary, not sufficient.

**Instrumentation now available.** `Dr. Claude/scripts/cdp-eval.mjs` — zero-dep CDP renderer-eval; its header documents the full native-menu + CDP UI-verification pattern. Reach for it on any UI-state verification.

**Biggest risks going forward.**
1. *Technique-before-constraints* (the 032 arc): a brief picks an approach that isn't pre-checked against codebase realities (DOM scale, existing animations, multi-instantiated hooks). Same root as the hypothesis-ranking note. Pre-flight should explicitly ask "is this tractable here?"
2. *DMG-build resource pressure*: `npm run dist:dmg` hit OOM (exit 137) twice this period — builds completed anyway, but it's a signal this machine is near a memory ceiling during packaging.
3. *Energy*: the volume of same-day follow-up briefs (030→030b earlier; 032→b→c here) is a sign briefs are shipping slightly under-baked. Better pre-flight on the front brief beats three clean follow-ups.

**Known-unsolved.** `setPlaybackActive` IPC still fires ~7× per play/pause — same `useAudio` multi-instantiation root as the heartbeat, left untouched under 033c's scope discipline (harmless fire-and-forget). If a broader `useAudio` engine-vs-accessor refactor ever happens, it and the heartbeat both fold in. That refactor is its own brief with its own audit, not a drive-by.

---

## Skill Candidates Captured This Period

1. **Native-menu + CDP end-to-end UI verification.** Launch the Electron app with `--remote-debugging-port`, drive `Runtime.evaluate` for exact DOM/state reads, trigger native menus (which CDP can't reach) via AppleScript/System Events, dispatch in-app DOM/keyboard events through the same channel, clean up after. Artifact: the documented header of `Dr. Claude/scripts/cdp-eval.mjs` (the header *is* the skill). Removes human-in-the-loop ambiguity from UI verification.

2. **Audit corrects the brief author's ranked hypothesis — a positive pattern, not a failure.** In audit-then-run work, the brief's ranked hypotheses are cheap starting guesses. Enumerate plausibles, attach no emotional weight to the lead one, and let the code read decide. Demonstrated twice this period (033c: multi-instantiation, not missing cleanup; 033d: component-level, not caller-level). The wrong guesses cost nothing because the audit gate held — that's the gate working as designed. The discipline to preserve: keep ranking cheap, and never let the brief's lead hypothesis shortcut the audit.
