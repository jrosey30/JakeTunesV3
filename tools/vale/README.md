# tools/vale: the anti-AI-slop check

Jake (2026-11-19): confusing app messages are "AI slop". His rule for anything
the app says: one short plain line, no ids, no internals. This folder holds the
rules that catch the tells of machine-written prose, and the script that runs
them over the words the app shows.

## What is here

| Path | What |
|---|---|
| `styles/ai-tells/` | 137 Vale rules from **vale-ai-tells v1.37.0**, vendored unchanged (MIT, Tony Burns; `styles/ai-tells/LICENSE`). Source: https://github.com/tbhb/vale-ai-tells, release v1.37.0. Release zip sha256 `f8d1e981abbfbac1aa092d1623a1ac9bc935f0b15e8071e7a072915abddf0570`. |
| `.vale.ini` | The rules the build-time check runs (117 of 137). Same file in both repos. |
| `styles/JakeTunes/` | The house style, written here (not vendored), same files in both repos: `Names.yml` (one name for each thing, any case: Songs, Listening List, Record Shop, Up Next, Live Albums, Download, the Music Man, Offline, color), `Concerts.yml` (a bare "concert": a person picks Shows for tickets or Live Albums for recordings), `Internals.yml` (homemini, Tailscale, NAS, streamrip, iTunesDB, error codes…), `Marks.yml` ("...", "(s)", "!", emoji). |
| `slop-check.py` | Pulls the words a person reads out of the code, runs Vale, reports `file:line`. Byte-identical in JakeTunesMobile and JakeTunesV3. |
| `allow.tsv` | Per repo: the few strings the check lets stand, each with why (a file another change owns, a Do-Not-Touch file, a word Jake still has to pick). |

## Vale itself is not in the repo

The binary is **Vale v3.26.0** (MIT, Joseph Kato; https://github.com/errata-ai/vale).
The check looks for it at `$JT_VALE`, else `~/.jaketunes-vale/bin/vale`
(installed on the MacBook and on homemini). With no binary the check prints one
line and passes.

Pinned sha256 of the v3.26.0 release assets (from the GitHub release's own digests):

| Asset | sha256 |
|---|---|
| `vale_3.26.0_macOS_arm64.tar.gz` | `a6c3370f53bad93086c6b85f3163676e44e08049d69743afdcc13f3aab5b7482` |
| `vale_3.26.0_Linux_64-bit.tar.gz` | `22aa69a556558e4a9dfc63c17030777383d8d3c48dcdfad655fa98e839d666ed` |
| the extracted macOS arm64 `vale` binary | `ebaab47b28ea7ecba0d9eb704c9ec6e303d981ad436882ef640a3aaa051a1dfe` |

**CI** downloads exactly that tarball for its runner, checks the sha256 above
(a mismatch fails the job before anything runs), and sets `JT_VALE` and
`JT_VALE_REQUIRED=1`, so on CI a missing Vale is a failure, not a skip.

## Running it

```bash
python3 tools/vale/slop-check.py              # the check (repo picked from the tree)
python3 tools/vale/slop-check.py --dump       # the words it reads, file:line
python3 tools/vale/slop-check.py --calibrate  # every rule over today's words, with counts
```

A line that has to keep something a rule dislikes can carry `slop-ok` in a
comment on the same source line.

## How the rules were picked (2026-11-20)

Every one of the 137 rules ran over today's words in both apps (772 strings in
mobile, 1,409 in the desktop). The 20 that fired are off; read by hand, each
hit was fine copy (em dashes, colons, "Nothing downloaded yet", "lands here").
The other 117 are on. A rule goes on only after `--calibrate` shows it silent,
or after the copy it catches is rewritten.

homemini's runtime gate on AI-written text (JakeTunesMobile `backend/src/util/slopGate.ts`) runs a narrower set, `.vale-runtime.ini` in that repo.

## Upgrading the rules

Replace `styles/ai-tells/` with the new release (check its sha256 first), run
`--calibrate` in both repos (and on homemini's text for the mobile runtime set), and update the `.ini` files
and this README in the same change.

## The house style (2026-11-24)

Jake's rules from the slop sweep (`Dr. Claude/slop-sweep` in JakeTunesMobile), as Vale
styles in `styles/JakeTunes/`: one name for each thing, no internals, no "...", "(s)", "!"
or emoji. They read the same words the ai-tells rules read: never code, logs or ids.
They fail the check here (`HOUSE_ENFORCED` in the script); in JakeTunesMobile they are
counted and listed with `--house`, not enforced, until the phone's own sweep lands.

What the check reads, beyond the first version: one-word strings ("Tracks", "Queue"),
`set…Notice/Error/Status(…)` calls, `confirmLabel` / `cancelLabel`, the main process's menu
items and the words inside `dialog.show…(…)` calls. It skips `console.*(…)` and the sync
engines' progress titles and raw errors, which `sync-failure-copy.ts` and
`sync-progress-model.ts` turn into the lines a person reads.

A string that must keep a flagged word: `slop-ok` and why in a comment on its line, or, when
that file can't be touched today, one line in `allow.tsv` (file, words as `--dump` prints
them, why). An `allow.tsv` line that matches nothing any more is printed as a note.

Before reading the tree the check runs over a planted file (`selftest` in the script): each
house rule, a one-word string, and a string under two JSX closing tags at a known line (the
line-number bug, fixed here, read `</` as a regex and lost a newline: 322 of 1,498 desktop
strings pointed at the wrong line). If it can't see those, the check fails instead of
passing blind. Mutation-tested 2026-11-24: the old lexer, single words off, each house
style off, and eleven planted strings in the tree (a menu "...", a dialog naming homemini,
a confirmLabel "!", a one-word "Tracks" heading, …) each fail it; the clean tree passes.

