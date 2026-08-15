#!/usr/bin/env python3
"""exp_mood_decade — 2026-08-13 nightly experiment (READ-ONLY on the brain).

P3 from the 08-11 nightly: would a grounded DECADE token in moodText()
(+ relaxing the router's decade→main short-circuit) fix ret-012
("new wave 80s": mood scores 1.00 but the decade guard routes it to main
where it scores 0.35) without breaking true year filters (ret-006,
main 0.64 > mood 0.52 today)?

The 07-03 era-token NO-GO was IDENTITY-index-only (year digits already in
that embed text). moodText() has NO year at all — this is a genuinely new
lever. Method = the 08-07 counterfactual playbook, adapted to mood:

  1. Reconstruct moodText(t, d) for every track with a mood vector
     (byte-perfect port of scripts/brain-trainer.mjs moodText/tempoEnergy).
  2. FIDELITY GATE A: sample cosine(recon-embed, stored) — report.
  3. Re-embed ALL reconstructions -> "recon" index.
     FIDELITY GATE B (the real gate): recon must score within
     FIDELITY_TOL of the ACTUAL mood index on EVERY retrieval probe,
     else ABORT — the reconstruction cannot be trusted.
  4. Candidate = recon + one line `era: {decade}s ({YY}s)` derived from
     t.year (grounded library metadata; only 1900 <= year <= 2035).
  5. Compare candidate vs recon (same pipeline both sides — no
     reconstruction confound).

PRE-REGISTERED DECISION RULES (written before any embedding ran):
  SUPPORTED (upgrade P3 to a measured proposal) iff ALL of:
    a. cand-mood recall >= identity-main recall on BOTH decade probes
       (ret-006 and ret-012) — i.e. relaxing the guard loses nothing.
    b. No currently-mood-routed probe drops by more than 0.01
       (cand vs recon).
    c. Proposed router-truth mean (no decade short-circuit, cand mood)
       > current router-truth mean (current router, actual mood).
  REFUTED if (a) fails on ret-012 or (b) fails.
  MIXED (report, propose nothing) otherwise — e.g. token helps ret-012
  but ret-006 regresses => the guard must stay and the token alone is
  pointless (decade queries would still route to main).

Writes NOTHING outside stdout + tmp/. The live brain is never touched;
all inputs come from the frozen JT_STATE_DIR snapshot.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import run_eval as R  # noqa: E402

FIDELITY_TOL = 0.02
REGRESS_TOL = 0.01
BATCH = 100

# ---- byte-perfect ports of scripts/brain-trainer.mjs (⚠️ TWIN of moodText/tempoEnergy) ----

def tempo_energy(t):
    b = float(t.get("bpm") or 0)
    if b <= 0:
        return ""
    if b < 88: tempo = "slow, spacious, downtempo"
    elif b < 100: tempo = "relaxed, loping mid-tempo"
    elif b < 112: tempo = "steady mid-tempo groove"
    elif b < 122: tempo = "brisk, forward-moving"
    elif b < 134: tempo = "fast, driving, propulsive"
    else: tempo = "very fast, urgent, relentless"
    parts = [f"tempo: {round(b)} BPM, {tempo}"]
    root = str(t.get("keyRoot") or "").strip()
    mode = str(t.get("keyMode") or "").strip().lower()
    if mode in ("minor", "major"):
        parts.append(
            f"key: {root} minor — darker, moody, melancholy, introspective" if mode == "minor"
            else f"key: {root} major — brighter, warmer, open, resolved")
    fast, slow, minor = b >= 122, b < 100, mode == "minor"
    parts.append("good for: " + (
        "driving late-night, workout, intense focus" if fast and minor
        else "workout, running, parties, daytime energy" if fast
        else "late night, rainy day, winding down, solitude" if slow and minor
        else "morning, relaxing, background, easy listening" if slow
        else "focus, walking, everyday listening"))
    cam = str(t.get("camelotKey") or "").strip()
    if cam:
        parts.append(f"camelot {cam}")
    return " · ".join(parts)


def mood_text(t, d):
    lines = []
    dd = str(d or "").strip()
    if dd:
        lines.append(f"sound and mood: {dd}")
    te = tempo_energy(t)
    if te:
        lines.append(te)
    g = str(t.get("genre") or "").strip()
    if g:
        lines.append(f"genre: {g}")
    return "\n".join(lines)


def era_line(t):
    y = t.get("year")
    try:
        y = int(y)
    except (TypeError, ValueError):
        return ""
    if not (1900 <= y <= 2035):
        return ""
    dec = (y // 10) * 10
    return f"era: {dec}s ('{str(dec)[-2:]}s)"


def embed_all(texts, label):
    out = []
    for i in range(0, len(texts), BATCH):
        out.append(R.embed_texts(texts[i:i + BATCH]))
        done = min(i + BATCH, len(texts))
        if done % 2000 < BATCH or done == len(texts):
            print(f"  [{label}] embedded {done}/{len(texts)}", flush=True)
    return np.vstack(out)


# ---- router port (same as diag_ret011_012.py) ----
DECADE_QUERY_RE = re.compile(
    r"\b(19|20)\d{2}s?\b|(^|\D)['’]?[1-9]0s\b|"
    r"\b(fifties|sixties|seventies|eighties|nineties|noughties|aughts|2000s)\b",
    re.I,
)
GENRE_WORD_ARTISTS = {"house", "gospel", "punk", "disco", "funk", "soul", "jazz", "blues"}


def route(query, artist_norms, mood_count, main_count, decade_guard=True):
    if decade_guard and DECADE_QUERY_RE.search(query):
        return "main"
    qnorm = " " + re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", query.lower())).strip() + " "
    for a in artist_norms:
        if f" {a} " in qnorm:
            return "main"
    if mood_count >= main_count * 0.5 and mood_count > 0:
        return "mood"
    return "main"


def main():
    ids_m, vecs_m, meta_m = R.read_embeddings(R.EMB_PATH)
    mood_path = os.path.join(R.STATE_DIR, "mood-index.bin")
    ids_x, vecs_x, meta_x = R.read_embeddings(mood_path)
    tracks, by_id, titles, artists = R.load_library()
    desc = json.load(open(os.path.join(R.STATE_DIR, "brain-descriptors.json")))
    dmap = desc.get("tracks", desc) if isinstance(desc, dict) else {}
    print(f"identity: {meta_m['count']} vecs sha {R.sha_of(R.EMB_PATH)[:12]}")
    print(f"mood:     {meta_x['count']} vecs sha {R.sha_of(mood_path)[:12]}")

    # Reconstruct mood text for every mood-vector id present in the library.
    pos = {int(i): n for n, i in enumerate(ids_x)}
    recon = []          # (row, text, cand_text)
    unrecon = 0
    for t in tracks:
        n = pos.get(int(t["id"]))
        if n is None:
            continue
        d = dmap.get(str(t["id"]), {})
        d = d.get("d") if isinstance(d, dict) else None
        txt = mood_text(t, d)
        if not txt:
            unrecon += 1
            continue
        el = era_line(t)
        recon.append((n, txt, txt + "\n" + el if el else txt))
    with_era = sum(1 for _, a, b in recon if a != b)
    print(f"reconstructable: {len(recon)}/{meta_x['count']} mood vectors "
          f"({unrecon} empty-text kept as-is); era line added on {with_era}")

    # Gate A: sample cosine fidelity (informative).
    rng = np.random.default_rng(20260813)
    sample = rng.choice(len(recon), size=min(100, len(recon)), replace=False)
    sv = embed_all([recon[i][1] for i in sample], "gateA")
    cos = np.sum(sv * vecs_x[[recon[i][0] for i in sample]], axis=1)
    print(f"gate A sample fidelity: min {cos.min():.4f} · p10 {np.percentile(cos, 10):.4f} "
          f"· median {np.median(cos):.4f} · frac>=0.9999 {(cos >= 0.9999).mean():.2f}")

    # Build recon + candidate indexes (start from actual vectors, replace reconstructed rows).
    rv = embed_all([r[1] for r in recon], "recon")
    cv_needed = [(k, r) for k, r in enumerate(recon) if r[1] != r[2]]
    cvecs = embed_all([r[2] for _, r in cv_needed], "cand")
    vecs_recon = vecs_x.copy()
    vecs_cand = None
    for k, (n, _, _) in enumerate(recon):
        vecs_recon[n] = rv[k]
    vecs_cand = vecs_recon.copy()
    for j, (k, (n, _, _)) in enumerate(cv_needed):
        vecs_cand[n] = cvecs[j]

    # Score all retrieval probes on 4 indexes.
    prompts = [p for p in json.load(open(os.path.join(R.HERE, "eval_set.json")))["prompts"]
               if p["bucket"] == "retrieval"]
    qvecs = R.embed_texts([p["query"] for p in prompts])
    artist_norms = set()
    for t in tracks:
        a = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (t.get("artist") or "").lower())).strip()
        if len(a) >= 4 and a not in GENRE_WORD_ARTISTS:
            artist_norms.add(a)

    print(f"\n{'probe':<9} {'main':>6} {'mood':>6} {'recon':>6} {'cand':>6} {'cand-recon':>10}  route")
    rows = []
    for p, qv in zip(prompts, qvecs):
        expected = R.expected_ids(p["expected"], tracks)
        k = p["k"]
        r = {}
        for label, iv in (("main", (ids_m, vecs_m)), ("mood", (ids_x, vecs_x)),
                          ("recon", (ids_x, vecs_recon)), ("cand", (ids_x, vecs_cand))):
            r[label] = R.recall_at_k(R.retrieve_topk(qv, iv[0], iv[1], k), expected, k)
        rt_cur = route(p["query"], artist_norms, meta_x["count"], meta_m["count"], decade_guard=True)
        rt_prop = route(p["query"], artist_norms, meta_x["count"], meta_m["count"], decade_guard=False)
        rows.append((p, r, rt_cur, rt_prop))
        print(f"{p['id']:<9} {r['main']:>6.2f} {r['mood']:>6.2f} {r['recon']:>6.2f} {r['cand']:>6.2f} "
              f"{r['cand'] - r['recon']:>+10.2f}  {rt_cur}->{rt_prop}  \"{p['query']}\"")

    # Gate B: recon must track actual mood on every probe.
    bad = [(p["id"], r["mood"], r["recon"]) for p, r, _, _ in rows
           if abs(r["recon"] - r["mood"]) > FIDELITY_TOL]
    if bad:
        print(f"\nGATE B FAIL — reconstruction unfaithful beyond {FIDELITY_TOL} on: {bad}")
        print("ABORT: candidate comparison would be confounded. No conclusion tonight.")
        sys.exit(2)
    print(f"\ngate B PASS: recon within {FIDELITY_TOL} of actual mood on all {len(rows)} probes")

    # Decision rules.
    by = {p["id"]: (r, rt_cur, rt_prop) for p, r, rt_cur, rt_prop in rows}
    a_006 = by["ret-006"][0]["cand"] >= by["ret-006"][0]["main"]
    a_012 = by["ret-012"][0]["cand"] >= by["ret-012"][0]["main"]
    regress = [(pid, v[0]["cand"] - v[0]["recon"]) for pid, v in by.items()
               if v[1] == "mood" and v[0]["cand"] - v[0]["recon"] < -REGRESS_TOL]
    rt_cur_mean = np.mean([r["mood"] if rt == "mood" else r["main"] for _, r, rt, _ in rows])
    rt_prop_mean = np.mean([r["cand"] if rt == "mood" else r["main"] for _, r, _, rt in rows])
    print(f"\nrule a (cand >= main on decade probes): ret-006 {a_006} "
          f"({by['ret-006'][0]['cand']:.2f} vs {by['ret-006'][0]['main']:.2f}) · "
          f"ret-012 {a_012} ({by['ret-012'][0]['cand']:.2f} vs {by['ret-012'][0]['main']:.2f})")
    print(f"rule b (no mood-routed regression > {REGRESS_TOL}): "
          f"{'PASS' if not regress else 'FAIL ' + str(regress)}")
    print(f"rule c (router-truth): current {rt_cur_mean:.3f} vs proposed {rt_prop_mean:.3f}")

    if a_006 and a_012 and not regress and rt_prop_mean > rt_cur_mean:
        print("\nVERDICT: SUPPORTED — decade token + relaxed guard is a measured win (gated proposal).")
    elif (not a_012) or regress:
        print("\nVERDICT: REFUTED — do not pursue the decade token.")
    else:
        print("\nVERDICT: MIXED — see rules above; propose nothing.")


if __name__ == "__main__":
    main()
