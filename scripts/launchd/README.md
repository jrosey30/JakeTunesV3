# scripts/launchd — scheduler definitions live in git (Brief 183)

Before this directory, the nightly pipeline's schedules existed only as
hand-installed plists on individual machines: undiscoverable, unauditable,
and gone the day a machine is rebuilt. Now:

- **`jobs.json`** — the manifest: every JakeTunes launchd job, its
  schedule, its machine, its status source, and the evidence for each.
  Jobs whose definitions live elsewhere are listed as `existing-plist`
  (loose plists already in this repo) or `external` (not defined in this
  repo — recorded, never invented). `proposed: true` marks a schedule
  this manifest newly proposes.
- **`templates/`** — plist templates for the `managed` jobs, with
  `__HOME__` / `__REPO__` / `__NODE__` / `__PYTHON3__` tokens.
- **`install-launchagents.sh`** — renders templates → diffs against the
  installed plists → reloads only what changed. **Dry-run by default**;
  `--apply` is required to change anything. Idempotent.
- **`status.sh`** (or `install-launchagents.sh --status`) — every job's
  last-known status from its own status file: `brain-status.json`
  (Brief 176), `taxonomy-deferred.json` (Brief 182),
  `taste-eval-history.jsonl`, `enrichment-status.json` (Brief 177).

Usage on a Mac:

```sh
scripts/launchd/install-launchagents.sh            # preview: renders + diffs
scripts/launchd/install-launchagents.sh --apply    # install + reload changed agents
scripts/launchd/install-launchagents.sh --status   # health glance
```

Not a job here: `com.jaketunes.sync`. It was superseded by the app
itself (macOS Sequoia blocks launchd processes from network volumes —
see `src/main/sync-orchestrator.ts`); the manifest lists it as external
so nobody resurrects it. The sync script it used to run is checked for
drift against its repo copy at app startup (Brief 183).
