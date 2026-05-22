# Git Workflow Rules for JakeTunes

These rules exist to prevent the branch graveyard that accumulated through May 2026 from re-forming. They apply to all sessions, all tools, all contributors.

## Trunk Discipline

- `claude/jaketunes-synology-setup-7m2xy` is the current trunk. Main is stale and pending update in a future brief.
- All work happens on trunk or on short-lived feature branches.
- Feature branches must be merged back to trunk and deleted within 7 days. No exceptions.

## Branch Naming

- Do not use auto-generated random-name branches (`claude/quizzical-swartz-8b11c9` style).
- Feature branches must have meaningful names: `fix/artwork-reverify`, `feat/library-export`, `refactor/main-index`.

## Worktrees

- Do not create git worktrees inside the repo without explicit user authorization.
- If a worktree is created, it must be removed at session end.
- The `.claude/worktrees/` directory is not a default — it is a footgun.

## Brief-Driven Commits

- All non-trivial work is brief-driven (see `Dr. Claude/*.md`).
- Commits reference the brief they fulfill in the commit message footer.
- A single commit fulfills a single brief — no scope creep.

## Cleanup Cadence

- Once per month, run `git branch -a` and audit. Any branch >30 days old without active work gets evaluated for deletion.
- Once per month, run `git worktree list`. Any unexpected worktree gets removed.
