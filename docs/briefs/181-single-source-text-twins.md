# Brief 181 — Single-source the trainer/app text twins

**Stacked on Brief 179** (`feat/brief-179-brain-purity-gate` ← Brief 176):
merge 176, then 179, then this.

## Source / evidence
- Proposed briefs 160+, Brief 181 (desktop audit Lens 3, finding F6).
- Verified against JakeTunesV3 main `12bb43b24d49a146bc73489d945f34092878f707`:
  `baseText`/`moodText`/`tempoEnergy` existed as hand-synced twins in
  `scripts/brain-trainer.mjs` and the app (`src/main/ai/embeddings.ts`
  `buildEmbeddingText`, `src/main/ai/mood-index.ts` `buildMoodText`,
  `src/main/ai/tempo-energy.ts` `tempoEnergyText`), held together by
  ⚠️ TWIN comments and the source-shape pins in
  `src/main/__tests__/brain-text.test.ts`. (The mood genre line was already
  single-sourced 2026-10-13 via `src/common/mood-genre-line.ts` — the
  pattern this brief extends.)

## The no-op proof (run BEFORE the change, harness preserved in tests)
Old implementations were mechanically extracted from pristine main
(brace-matching extraction, the same technique brain-text.test.ts uses)
and run old-vs-old, then old-vs-new, over a 35-track fixture corpus
(normal/missing/empty fields, string years, every bpm band boundary,
key-confidence floor edges, descriptor variants):

- **old-vs-old:** `tempoEnergy` and `moodText` — identical on every
  fixture. `baseText` — identical EXCEPT the untrimmed-string-field class
  (whitespace-padded year `" 2003 "`, whitespace-only artist/album/genre):
  **the twins had already drifted** — the trainer interpolated raw values
  (`album: Record ( 2003 )`, `genre: ` with an empty tag, a leading
  `" — "` for a whitespace artist), the app trimmed first. 5 corpus cases.
- **old-vs-new:** the canonical module is **byte-identical to the old app
  implementations on 100% of outputs** (35 tracks × base + tempo + 5 mood
  variants = 245 outputs, 0 diffs), and byte-identical to the old trainer
  on every input except exactly those 5 drift cases, where the two old
  implementations disagreed with each other — so no single "before"
  behaviour existed to preserve there. Canonical semantics = the app's
  trim-first ones.
- The frozen old implementations + corpus ship as the guard:
  `scripts/__tests__/embedding-text-old-impls.mjs` +
  `scripts/__tests__/embedding-text.test.mjs` (asserts both directions
  above, and that the trainer defines none of the twins).

## What changes
- **NEW `src/common/embedding-text.ts`** — the one source of truth:
  `baseText`, `moodText`, `tempoEnergy` (+ `tempoEnergyText` alias,
  `KEY_CONFIDENCE_FLOOR`, input types). Pure; imports only the already
  shared `mood-genre-line.ts`. The measurement rationales from both old
  homes are preserved in its comments.
- **`scripts/brain-trainer.mjs`** — the three local twins are deleted;
  it imports `{ baseText, moodText, tempoEnergy }` from the shared module
  (the same import style as its existing `mood-genre-line.ts` import).
  `enrichedText()` still routes every re-embed through `baseText`.
- **`src/main/ai/embeddings.ts`** — `buildEmbeddingText` delegates to
  `baseText`. Signature and callers unchanged.
- **`src/main/ai/mood-index.ts`** — `buildMoodText` delegates to
  `moodText`. Signature and callers unchanged.
- **`src/main/ai/tempo-energy.ts`** — now a re-export shim
  (`tempoEnergyText`, `KEY_CONFIDENCE_FLOOR`, `TempoEnergyInput`) so its
  import sites don't move. It imports the canonical module with an
  explicit `.ts` extension: the shim is imported by `node --test`
  suites (tempo-energy.test.ts), where extensionless relative imports
  fail — the same reason mood-genre-line.ts uses `.ts` internally.
- **`src/main/__tests__/brain-text.test.ts`** — rewritten for the
  single-source world: pins the canonical plain shape, the delegation in
  all three app consumers, the trainer's import + non-definition, and
  runtime spot-equality through the shim.
- **NEW `scripts/__tests__/embedding-text.test.mjs`** +
  **`embedding-text-old-impls.mjs`** — the byte-equality guard above.

## What does NOT change
- **The mobile backend's `identityText`** (JakeTunesMobile
  `backend/src/util/embeddingsSupplement.ts`) is a third twin in another
  repo, verified against the trainer's `baseText` by Brief 159's guard.
  That guard stays exactly as-is; this brief removes the desktop/trainer
  twin only, per the brief text.
- No text output changes for any track whose fields are trimmed or
  absent (see proof). For untrimmed fields the trainer now produces the
  app's (trimmed) text — the deliberate, disclosed resolution of the
  pre-existing drift, in the direction of the newer, measured
  implementation.
- `TEMPO_ENCODING_VERSION` is NOT bumped: outputs on real (app-written,
  trimmed) library data are unchanged, so no re-embed is owed.
- No version bump.

## Done looks like
- Exactly one definition of each text exists; both writers import it;
  the byte-equality guard fails CI if a future edit changes a generated
  text without updating the frozen reference (which is a re-embed event,
  not a quiet edit).

## Tests (run in the agent environment, Node v24.20.0)
- Proof harness (pre-change): old-vs-old and old-vs-new outputs as
  recorded above.
- `node --test scripts/__tests__/embedding-text.test.mjs` — **4/4 pass**.
- `node --test --experimental-strip-types src/main/__tests__/brain-text.test.ts src/main/__tests__/tempo-energy.test.ts`
  — **12/12 pass** (the pre-existing tempo-energy suite runs unchanged
  against the shim).
- All edited TS files parse clean after type-stripping; the edited
  trainer runs the fully-enriched fixture state dir to `ok:true`
  (exit 0) with the canonical import chain live.
- Full `npm run check` (tsc over the whole app) is NOT runnable from the
  agent environment (no node_modules here) — it must run on the Mac/CI;
  the delegations are signature-preserving and the touched files were
  parse-checked individually.

## Manual steps (verbatim)
1. None for activation — both writers pick up the shared module on their
   next run/build after merge (stacked on 176/179).
2. On the next desktop build, `npm run check` should be run once on the
   Mac to confirm the whole-app typecheck (not runnable from the agent
   environment) — the PR is marked PR-ready only until CI is verified.
