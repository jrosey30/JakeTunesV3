# Brief 262 — the anti-AI-slop detector (Vale), desktop half

**Date:** 2026-11-20
**Repo:** JakeTunes V3. The homemini half (runtime gate on the Music Man, album histories, artist bios) is JakeTunesMobile Brief 262.
**Jake:** "begin anti AI slop detector build (find something safe and reputable on github)". His rule for anything the app says: one short plain line, no ids, no internals. He called confusing messages "AI slop" (2026-11-19, on a sync message).

## The tools

- **Vale v3.26.0** (MIT, errata-ai/vale). Not in the repo: `~/.jaketunes-vale/bin/vale`, or `JT_VALE`.
- **vale-ai-tells v1.37.0** (MIT, tbhb/vale-ai-tells), 137 rules, vendored unchanged in `tools/vale/styles/ai-tells` with its LICENSE. Versions and sha256s: `tools/vale/README.md`.

## Changes

1. `tools/vale/.vale.ini` (⚠️ TWIN: same file in JakeTunesMobile): all 137 rules ran over today's words in both apps (1,409 strings here, 772 on mobile). The 20 that fired are off (each hit read; fine copy: em dashes, colons, "Nothing matches", the Year in Review's own voice). 117 on.
2. `tools/vale/slop-check.py` (⚠️ TWIN, byte-identical): pulls the words a person reads (renderer JSX text, `title`/`placeholder`/`alt`/`aria-label`, `notifyToast`/`notify`/`confirm` and `title:`/`message:`/`label:`/`happened:`/`next:`… literals; every prose literal in `sync-failure-copy.ts`, `downloads-panel-model.ts`, `record-shop*.ts`, `shop-*.ts`), runs Vale, reports `file:line`. A source line with `slop-ok` is skipped.
3. `npm run check:slop`, and `npm run check` (the pre-commit gate) ends with it. No Vale: one line, passes.
4. CI (`check.yml`, macOS arm64): fetches exactly `vale_3.26.0_macOS_arm64.tar.gz`, checks sha256 `a6c3370f…7482` (the release's own digest), runs the check with `JT_VALE_REQUIRED=1`.
5. Mutation-tested: "Let's delve into why … won't play" in a `notifyToast` fails at `useAudio.ts:1572` (OverusedVocabulary). Restored.

## Not changed

- No copy changed: no calibrated rule needed a rewrite to switch on.
- No Vale binary in the repo.
