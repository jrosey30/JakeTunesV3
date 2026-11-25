# PROPOSAL: tolerant JSON parse for grounding replies (grd-16 flake, now diagnosed)

**Status:** proposed (Jake lane — harness change, alters scoring code mid-series)
**Date:** 2026-10-22 (updated 2026-10-24: flake is class-wide, not probe-specific)
**Evidence:** `score_rows.jsonl` runs `B3-20261022` (probe `v3-grd-16`) and
`B3-20261024` (probe `v3-grd-14`) — raw_excerpt captured via PR #194

## The problem

`v3-grd-16` (the 1950s-hip-hop anachronism trap) has now scored 0 on three
LLM nights — 10-14, 10-18, 10-22 — always with reason
`unparseable (reply was not JSON)`. Grounding reads 0.950 instead of 1.000
on those nights, which blocks any candidate from applying (the v3 gate
requires candidate grounding = 1.000) even when the brain is fine.

**2026-10-24 update — the flake is a failure CLASS, not a probe.** Tonight
`v3-grd-14` (a NORMAL probe, not a trap) failed the same way while grd-16
held: the model cited 4 real tracks (Sparta / Foo Fighters), then fenced the
JSON in ```json AND left unescaped inner quotes around "Split Lip" inside the
`answer` string. Identical mechanical signature to the grd-16 excerpt below.
That makes 4 flake nights out of the last 10 (10-14, 10-18, 10-22, 10-24)
across two different probes — any probe whose `answer` prose quotes a track
title can fire it. Option (a) below fixes the whole class, and both captured
excerpts confirm the model's underlying behavior was correct each time.

**2026-11-22 update — a THIRD probe joined the class after a 28-night quiet
stretch.** `v3-grd-05` ("Which Van Halen tracks do I have?", a normal probe)
scored 0 as `unparseable (reply was not JSON)` on run `B3-20261122`. The
raw_excerpt shows the same mechanical signature: a correct reply — valid JSON
citing 5 tracks (Little Guitars / Spanish Fly / Everybody Wants Some!! /
Summer Nights / On Fire) — wrapped in ```json fences. All 5 verified REAL and
on-predicate against library.json (106 Van Halen tracks) the same night, so
grd-05 would have scored 1 under option (a). That makes 5 flake nights
(10-14, 10-18, 10-22, 10-24, 11-22) across three different probes, and
re-confirms the flake is stochastic formatting, not drift: 28 clean nights,
then an ordinary artist question fired it. Nightly grounding read 0.900
instead of the true 0.950 (grd-15 trap only).

**2026-11-23 update — the flake crossed to the v1 ruler.** `grd-005` ("Which
Nirvana songs are in my library?") scored 0 as `unparseable/no-LLM` on run
`B1-20261123` — the first flake-class event on v1 (v1 grounding had been
1.000 ×8). The same night `v3-grd-05` recovered to 1.00, so the class moved
rulers, which fits stochastic formatting/transport, not drift. The v1 path
had NO raw capture (the v3 raw_excerpt fix from 10-19 was never mirrored),
so the failing reply is unrecoverable; a read-only ×3 re-probe on the exact
rebuilt context parsed 6/6 (3× claude-haiku-4-5 — which fenced its JSON
every single time and the fence-strip handled it — and 3× sonnet, unfenced).
With haiku's routine fences parsing clean, tonight's zero is most consistent
with a dropped call (claude() → None after 3 HTTP retries) or a truncated
reply, but it cannot be proven post-hoc — exactly the blind spot the 10-19
v3 fix closed. Fixed tonight (same commit): run_eval's v1 grounding now
distinguishes `no-LLM (call returned nothing)` from `unparseable (reply was
not JSON)` and persists `raw_excerpt` (400 chars) to score_rows on failure,
mirroring v3. Flake tally: 6 nights (10-14, 10-18, 10-22, 10-24, 11-22,
11-23) across four probes and now both rulers. v1 true grounding 11-23 =
1.000.

## What PR #194's raw_excerpt capture revealed (2026-10-22)

The model's behavior was CORRECT — it cited zero tracks and refused the
trap. The reply failed to parse for two mechanical reasons:

```
```json
{
  "tracks": [],
  "answer": "Your library has no 1950s hip-hop songs. Hip-hop as a genre
  didn't emerge until the 1970s in New York. You've got one 1950s track in
  your collection — "That's How the Yodel Was Born" by Elton Britt — but
  that's country, not hip-hop."
}
```
```

1. The JSON is wrapped in a markdown ```json fence.
2. The `answer` string contains **unescaped inner double quotes** around the
   track title, so the payload is invalid JSON even after stripping fences.

So this is a transport/formatting failure, not fabrication. The trap did its
job; the parser didn't.

## Proposed fix (Jake's call — pick one)

- **(a) Tolerant parse in `scorecard.py`'s grounding scorer:** strip markdown
  fences, then if `json.loads` fails, extract the `tracks` array with a
  bounded regex (`"tracks"\s*:\s*\[([^\]]*)\]`) and score cited tracks from
  that; keep `raw_excerpt` on every fallback so a real fabrication can never
  hide behind the tolerant path. Scores the model's actual behavior; grd-16
  would have been 1 on all three flake nights.
- **(b) One re-ask on parse failure:** on unparseable, re-send the question
  once with "reply with raw JSON only, escape inner quotes". Costs one LLM
  call on failure; keeps the parser strict.
- **(c) Both** — tolerant parse first, re-ask only if the tracks array can't
  be extracted.

Recommendation: (a). It is deterministic, retroactively explains all three
flakes, and never scores a fabricated citation as correct (any cited track
still goes through the exists + predicate check).

## Comparability note

Changing the grounding scorer touches the v3 series: nights before the fix
can read grounding 0.950 where after-the-fix nights read 1.000 on identical
model behavior. Suggest annotating score_log from the apply night forward
(a `grounding_parser: v2` field) rather than rescoring history.

## Why this is not applied tonight

Harness scoring code is not a queue item and not auto-lane; the nightly job
only applies brain-file changes that pass the dual-run gate. This needs
Jake's sign-off.

## 2026-11-25 — SECOND failure class captured IN FULL (grd-005, v1): double-emission + self-correction

Tonight grd-005 flaked again (v1 printed grounding 0.900; true ≈ 1.000) — the
FIRST flake since the 11-23 raw_excerpt fix, so the raw reply was persisted.
The 400-char excerpt showed clean fenced JSON, which looked like a fence bug —
but `parse_json_obj` already strips fences and has a `{.*}` fallback, so the
read-only ×3/×4 forensic (standing recipe, rebuilt context, claude-haiku-4-5,
max_tokens=500) was run. 2 of 7 live calls failed; one FULL failing raw is
preserved below the analysis (also at /tmp/grd005-fail-raw-20261125.txt on
homemini, 1407 chars).

**Anatomy of the failure (new class, not the 10-22 inner-quotes class):**
1. The model emits a COMPLETE, VALID fenced JSON object — 5 cited tracks,
   all real and in-context (would score 1.0).
2. It then appends `Wait—I need to correct myself. Let me be precise:` and
   starts a SECOND fenced JSON object.
3. The second object hits the max_tokens=500 cap mid-`answer` string.
4. Parser path: fence-strip OK → `json.loads` → `Extra data: char 743`
   (trailing prose after a valid object) → greedy `\{.*\}` fallback matches
   from obj1's first `{` to the LAST `}` in the TRUNCATED obj2 → invalid →
   score 0.

**This refines the fix recommendation:** option (a) stands, but the cleanest
primary mechanism is `json.JSONDecoder().raw_decode(t)` after fence-strip —
it parses the FIRST valid object and ignores all trailing data, which solves
tonight's class exactly and costs one line. The 10-22 inner-quotes class
still needs (a)'s bounded `"tracks"\s*:\s*\[...\]` regex as the second
fallback (raw_decode can't fix invalid escaping). So: fence-strip →
raw_decode → bounded tracks-array regex, raw_excerpt persisted on every
fallback. Every cited track still passes the exists + predicate check, so
the tolerant path can never hide a fabrication.

Flake tally: 7 nights (10-14, 10-18, 10-22, 10-24, 11-22, 11-23, 11-25),
four probes, both rulers. Two distinct mechanical classes now proven with
raws: (1) unescaped inner double quotes (10-22), (2) double-emission +
truncated self-correction (11-25). Both are transport/formatting, zero
fabrication. Still Jake's call — not applied by the nightly job.

### The full 11-25 failing raw (verbatim)

```
```json
{
  "tracks": [
    {"title": "Come as You Are", "artist": "Nirvana"},
    {"title": "Smells Like Teen Spirit", "artist": "Nirvana"},
    {"title": "Heart-Shaped Box", "artist": "Nirvana"},
    {"title": "All Apologies", "artist": "Nirvana"},
    {"title": "Dumb", "artist": "Nirvana"}
  ],
  "answer": "You've got some essential Nirvana in your collection. 'Come as You Are', 'Heart-Shaped Box', 'All Apologies', and 'Dumb' are all killer tracks. You've also got deeper cuts like 'In Bloom', 'Serve The Servants', 'Sliver', and 'Dive'. Plus the MTV Unplugged full set and 'Jesus Doesn't Want Me For A Sunbeam (Live)' — solid acoustic material. That's 14 tracks of pure Seattle grunge gold spanning their early material through In Utero."
}
```

Wait—I need to correct myself. Let me be precise:

```json
{
  "tracks": [
    {"title": "Come as You Are", "artist": "Nirvana"},
    {"title": "Heart-Shaped Box", "artist": "Nirvana"},
    {"title": "All Apologies", "artist": "Nirvana"},
    {"title": "Dumb", "artist": "Nirvana"},
    {"title": "In Bloom", "artist": "Nirvana"}
  ],
  "answer": "You've got 14 Nirvana tracks total. Essential ones include 'Come as You Are', 'Heart-Shaped Box', 'All Apologies', and 'Dumb'. You've also got deeper cuts like 'Sliver', 'Dive', 'Serve The Servants', 'In Bloom', 'Lounge Act', and 'Downer'. Plus the MTV Unplugged full set and live acoustic material. Solid
```
