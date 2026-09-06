# PROPOSAL — tempo catch-up should embed fresh-import tracks FIRST

**Status: proposed 2026-09-06 (nightly). Trainer change — needs Jake's
sign-off; the harness never edits the trainer (THE ONE RULE).**

## The problem, proven tonight

The 09-05 report declined to repair last night's fresh-50 metadata-skew
suspects on the grounds that "every one of the 33 is the trainer's own
tempo-catch-up target **tomorrow night**." Tonight disproved the
*tomorrow* part:

- All 33 (ids 11467–11499: הדג נחש / Cut Worms / Bear Ghost) are STILL
  suspects, still `te=False, teb=0`, with real bpm sitting in the
  library since yesterday 02:50.
- Cause is in `scripts/brain-trainer.mjs`:
  `needTempo = tracks.filter(tempoStale).slice(0, CATCHUP_CAP)` —
  **library order, capped at 500/night**. Tonight's log confirms the
  slice was `0 newly analysed, 500 on an older encoding`: all 500
  slots went to aged te=2 re-encodes.
- Backlog: **8,481 te=2 tracks** (te counts tonight: 3→1,558, 2→8,481,
  False→124, True→22). New imports append at the END of the library, so
  a fresh wave track waits **~17 nights** for its tempo/genre to reach
  the mood index — while being served to the phone + desktop mixes as
  a tempo-less, sometimes genre-less vibe vector.
- The class **compounds**: tonight added 49 more fresh-skew suspects
  (ids 11643–11692). Next wave night adds more. Meanwhile the nightly
  scan's "aged suspects" count — the clobber alarm — inflates with
  known-benign entries (34 tonight), eroding the alarm's meaning.

## The fix (one line of ordering, no new writes)

Sort `needTempo` so tracks that have **never** been tempo-encoded come
first; among equals, newest first (or keep library order):

```js
const needTempo = tracks
  .filter(t => (Number(t.bpm) || 0) > 0 && desc[String(t.id)] && tempoStale(t, desc[String(t.id)]))
  .sort((a, b) => {
    const rank = t => { const te = desc[String(t.id)].te
      return (te === undefined || te === false) ? 0 : 1 }  // never-encoded first
    return rank(a) - rank(b)
  })
  .slice(0, CATCHUP_CAP)
```

Cost: zero — same 500 embeds/night, same verify discipline. The te=2
drain finishes ~one night later; fresh imports become correctly
vibe-searchable the morning after their bpm lands instead of 2–3 weeks
later.

## Interaction with the nightly scan

Once applied, wave-night fresh suspects self-heal on N+1 as the 09-05
report assumed, and the scan's aged-suspect count goes back to meaning
"possible clobber" instead of "queue backlog."

## Evidence

- `repair_20260906_ids.json` (`aged_watchlist_confirmed` — 34/34 match)
- REPORT-20260906-nightly.md — settledness proof (aged intended vectors
  cos 1.0000 vs last night's), candidate rt deltas
- trainer log 2026-09-06 06:00:07Z line: `0 newly analysed, 500 on an
  older encoding, 0 whose bpm changed`
