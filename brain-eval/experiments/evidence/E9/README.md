# E9 evidence: the 10/12 taste-slip diagnosis

Scripts only. No data is committed; the scripts expect these files next to them:

- `library.json`, `metadata-overrides.json` (and any library backups), copied from the app's userData;
- `mobile-plays.json`, `mobile-play-log.json`, `mobile-stars.json`, copied from the NAS state dir. Read-only copies.

| Script | What it does |
|---|---|
| `be.py` | Python port of JakeTunesMobile `backend/src/routes/brainEval.ts`, the production tasteScore with hash-fold CV. It reproduced every weekly reading 8/28–10/9 within 0.004. |
| `homemini_emul.py` | Applies homemini's getLibrary inputs (phone plays, stars, play log) as of a date. |
| `shapley.py` | Splits the 8/28 → 10/9 drop by cause: aged-in negatives −0.0253, clock drift −0.0084, new stars +0.0075, re-tag 0.0000. |
| `clock.py` | The "only today moves" test: same tracks, only `now` changes. Result −0.0093, and +0.0001 with intensity removed. **E9's acceptance metric.** |
| `why.py` | Explains why aged-in finds are hard: intensity as a single feature scores 0.586 against them vs 0.730 against older negatives. |
| `noise.py` | Noise of one reading: deterministic, fold variation 0.0003, sampling SE about 0.008. |
| `h1_validate.py` | Validated the shipped measurement fix (JakeTunesMobile #403, rule `matured-90d`): the six-week slide went from −0.028 to −0.015. |

The verdict was a population artifact, not lost taste knowledge. The measurement fix shipped and went live 10/12 (first reading 0.7852, finds 0.7491). What's left is the intensity drift, which is E9.
