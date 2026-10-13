#!/usr/bin/env python3
"""
gate.py — the KEEP gate for scorecard v3, plus the unchanged v1 bar for the
dual-run period. Reads score_log.jsonl + score_rows.jsonl (run_eval writes
both) and decides whether a candidate brain may be applied. Writes nothing.

V3 GATE — every one of these must hold (candidate vs baseline, same probes):
  1. mean per-probe delta            >= +0.005
  2. 90% paired bootstrap interval   lower bound > 0
     (resample probes with replacement, 10,000 draws, fixed seed)
  3. no group's mean drops by more than 0.01
  4. candidate grounding             == 1.000 (measured, every question)
  Baseline and candidate must be measured on the same library (library_sha),
  the same probe set, the same primary source (bridge vs py-router) and the
  same audio-fusion state; anything else is a broken comparison, not a result.

V1 BAR — "Keep a change ONLY if it MEASURABLY improves the eval (retrieval AND
overall) with NO regression on any tracked metric" (nightly prompt, guardrail
4), encoded without loosening:
  a. no tracked v1 metric regresses: retrieval, grounding, overall (and
     persona when both runs judged) — and grounding must be measured;
  b. if embeddings.bin changed: v1 retrieval AND overall strictly improve;
  c. if mood-index.bin changed: no v1 probe's mood-index reading drops (the
     09-01 "worst per-probe mood delta >= 0" bar). v1 retrieval reads only
     embeddings.bin, so it is blind to a mood-only change by construction; per
     the 10-10 addendum ("judge vibe on the production-path bucket") the
     measurable improvement for such a change is carried by the v3 gate,
     whose primary score IS the production path;
  d. a candidate byte-identical to the baseline has nothing to apply.
  Which indexes changed is read from the runs' sha ids, never declared.

DUAL RUN: a candidate applies only if it passes BOTH the v1 bar and the v3
gate. Strictly stricter than either alone.

    python3 gate.py --base <v3 run_id> --cand <v3 run_id> --v1-base <v1 run_id> --v1-cand <v1 run_id>
    python3 gate.py --base B --cand C --v3-only          # measure-only pricing (never an apply)
    python3 gate.py ... --log-dir /tmp/out --json

Exit status: 0 = APPLY allowed, 1 = KEEP BASELINE, 2 = inputs invalid.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

MIN_MEAN_DELTA = 0.005
CI_LEVEL = 0.90
MAX_GROUP_DROP = 0.01
GROUNDING_REQUIRED = 1.0
N_BOOT = 10_000
BOOT_SEED = 0
EPS = 1e-9


class GateInputError(Exception):
    pass


# ------------------------------------------------------------------ io
def read_jsonl(path):
    if not os.path.exists(path):
        raise GateInputError(f"{path} not found")
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def load_run(log_dir, run_id):
    """(summary, probe_rows) for one run_id. Old v1 rows without 'ruler' are v1."""
    summ = [r for r in read_jsonl(os.path.join(log_dir, "score_log.jsonl")) if r.get("run_id") == run_id]
    rows = [r for r in read_jsonl(os.path.join(log_dir, "score_rows.jsonl")) if r.get("run_id") == run_id]
    if not summ:
        raise GateInputError(f"run_id {run_id!r} not in score_log.jsonl")
    current = [s for s in summ if s.get("label") != "base"] or summ
    return current[-1], [r for r in rows if r.get("label") == current[-1].get("label")]


# ------------------------------------------------------------------ statistics
def paired_bootstrap_ci(deltas, level=CI_LEVEL, n_boot=N_BOOT, seed=BOOT_SEED):
    d = np.asarray(deltas, dtype=np.float64)
    if d.size == 0:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    means = d[rng.integers(0, d.size, size=(n_boot, d.size))].mean(axis=1)
    a = (1.0 - level) / 2.0
    return float(np.quantile(means, a)), float(np.quantile(means, 1.0 - a))


def _paired(base_rows, cand_rows, field="score"):
    b = {r["probe_id"]: r for r in base_rows if r.get("group") != "grounding" and r.get(field) is not None}
    c = {r["probe_id"]: r for r in cand_rows if r.get("group") != "grounding" and r.get(field) is not None}
    if set(b) != set(c):
        raise GateInputError(f"probe sets differ: only-base {sorted(set(b) - set(c))[:8]}, "
                             f"only-cand {sorted(set(c) - set(b))[:8]}")
    if not b:
        raise GateInputError("no scored probes to compare")
    ids = sorted(b)
    return ids, b, c


# ------------------------------------------------------------------ v3 gate
def v3_gate(base_rows, cand_rows, cand_grounding, *, min_mean=MIN_MEAN_DELTA, level=CI_LEVEL,
            max_group_drop=MAX_GROUP_DROP, n_boot=N_BOOT, seed=BOOT_SEED):
    libs = {r.get("library_sha") for r in base_rows + cand_rows if r.get("group") != "grounding"}
    if len(libs) > 1:
        raise GateInputError(f"baseline and candidate were measured on different libraries {sorted(map(str, libs))}")
    ids, b, c = _paired(base_rows, cand_rows)
    fus_b = any("fusion" in str(r.get("mode", "")) for r in base_rows)
    fus_c = any("fusion" in str(r.get("mode", "")) for r in cand_rows)
    if fus_b != fus_c:
        raise GateInputError("audio fusion ran in one run but not the other (CLAP helper/audio-index changed) — "
                             "the production path itself differed; re-measure both under the same environment")
    deltas = np.array([c[i]["score"] - b[i]["score"] for i in ids], dtype=np.float64)
    mean = float(deltas.mean())
    lo, hi = paired_bootstrap_ci(deltas, level, n_boot, seed)
    groups = {}
    for i in ids:
        g = b[i]["group"]
        groups.setdefault(g, ([], []))
        groups[g][0].append(b[i]["score"])
        groups[g][1].append(c[i]["score"])
    gdelta = {g: round(float(np.mean(cv) - np.mean(bv)), 4) for g, (bv, cv) in sorted(groups.items())}
    worst_g = min(gdelta, key=gdelta.get)
    checks = [
        {"check": "mean_delta", "pass": mean >= min_mean - EPS,
         "detail": f"mean per-probe Δ {mean:+.4f} (need ≥ {min_mean:+.3f}) over {len(ids)} probes"},
        {"check": "ci_lower", "pass": lo > 0,
         "detail": f"{int(level * 100)}% paired bootstrap [{lo:+.4f}, {hi:+.4f}] (lower bound must be > 0)"},
        {"check": "group_drop", "pass": gdelta[worst_g] >= -max_group_drop - EPS,
         "detail": f"worst group {worst_g} {gdelta[worst_g]:+.4f} (no group may drop more than {max_group_drop})"},
        {"check": "grounding", "pass": cand_grounding is not None and cand_grounding >= GROUNDING_REQUIRED - EPS,
         "detail": f"candidate grounding {cand_grounding} (must be {GROUNDING_REQUIRED:.3f}, measured)"},
    ]
    return {
        "gate": "v3", "pass": all(x["pass"] for x in checks), "checks": checks,
        "n_probes": len(ids), "mean_delta": round(mean, 5), "ci": [round(lo, 5), round(hi, 5)],
        "group_deltas": gdelta,
        "changed": {"up": int((deltas > EPS).sum()), "down": int((deltas < -EPS).sum()), "same": int((np.abs(deltas) <= EPS).sum())},
    }


# ------------------------------------------------------------------ v1 bar
V1_TRACKED = ("retrieval", "grounding", "overall", "persona")


def v1_bar(base, cand, base_rows=(), cand_rows=()):
    checks = []
    for m in V1_TRACKED:
        bv, cv = base.get(m), cand.get(m)
        if m == "persona" and (bv is None or cv is None):
            continue  # persona is only tracked when both runs were judged
        if bv is None or cv is None:
            checks.append({"check": f"v1_{m}_measured", "pass": False,
                           "detail": f"v1 {m} not measured (base {bv}, cand {cv}) — can't prove no regression"})
            continue
        checks.append({"check": f"v1_{m}_no_regression", "pass": cv >= bv - EPS,
                       "detail": f"v1 {m} {bv:.4f} → {cv:.4f} ({cv - bv:+.4f})"})
    main_changed = base.get("brain_id") != cand.get("brain_id")
    mood_changed = base.get("mood_id") != cand.get("mood_id")
    if main_changed:
        for m in ("retrieval", "overall"):
            bv, cv = base.get(m), cand.get(m)
            ok = bv is not None and cv is not None and cv > bv + EPS
            checks.append({"check": f"v1_{m}_improves", "pass": ok,
                           "detail": f"embeddings.bin changed → v1 {m} must strictly improve ({bv} → {cv})"})
    if mood_changed:
        b = {r["probe_id"]: r.get("score_mood") for r in base_rows if r.get("group") == "retrieval"}
        c = {r["probe_id"]: r.get("score_mood") for r in cand_rows if r.get("group") == "retrieval"}
        common = [p for p in b if b[p] is not None and c.get(p) is not None]
        if not common:
            checks.append({"check": "v1_mood_per_probe", "pass": False,
                           "detail": "mood-index.bin changed but no v1 per-probe mood readings to compare"})
        else:
            worst = min(common, key=lambda p: c[p] - b[p])
            d = c[worst] - b[worst]
            checks.append({"check": "v1_mood_per_probe", "pass": d >= -EPS,
                           "detail": f"mood-index.bin changed → worst v1 per-probe mood Δ {worst} {d:+.4f} (must be ≥ 0)"})
    if not main_changed and not mood_changed:
        checks.append({"check": "v1_something_changed", "pass": False,
                       "detail": "candidate brain is byte-identical to the baseline — nothing to apply"})
    return {"gate": "v1", "pass": all(x["pass"] for x in checks), "checks": checks,
            "changed": {"embeddings.bin": main_changed, "mood-index.bin": mood_changed}}


def dual_run_decision(v1_result, v3_result):
    ok = bool(v1_result and v1_result["pass"]) and bool(v3_result and v3_result["pass"])
    return {"apply": ok, "rule": "dual-run: apply only if BOTH the v1 bar and the v3 gate pass",
            "v1": v1_result, "v3": v3_result}


# ------------------------------------------------------------------ cli
def _print(res):
    for x in res["checks"]:
        print(f"  [{'PASS' if x['pass'] else 'FAIL'}] {x['check']:<24} {x['detail']}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base", required=True, help="baseline v3 run_id")
    ap.add_argument("--cand", required=True, help="candidate v3 run_id")
    ap.add_argument("--v1-base", help="baseline v1 run_id (dual-run)")
    ap.add_argument("--v1-cand", help="candidate v1 run_id (dual-run)")
    ap.add_argument("--v3-only", action="store_true", help="price a proposal: v3 gate only, NEVER an apply verdict")
    ap.add_argument("--log-dir", default=HERE)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        bs, br = load_run(a.log_dir, a.base)
        cs, cr = load_run(a.log_dir, a.cand)
        for s, rid in ((bs, a.base), (cs, a.cand)):
            if s.get("ruler") != "v3":
                raise GateInputError(f"{rid} is ruler {s.get('ruler', 'v1')}, not v3")
        if bs.get("eval_set_sha") != cs.get("eval_set_sha"):
            raise GateInputError(f"different v3 rulers: {bs.get('eval_set_sha')} vs {cs.get('eval_set_sha')}")
        if bs.get("primary_source") != cs.get("primary_source"):
            raise GateInputError(f"primary source differs ({bs.get('primary_source')} vs {cs.get('primary_source')})")
        v3 = v3_gate(br, cr, cs.get("grounding"))
        v1 = None
        if not a.v3_only:
            if not (a.v1_base and a.v1_cand):
                raise GateInputError("dual-run needs --v1-base and --v1-cand (or --v3-only to price without applying)")
            v1b, v1br = load_run(a.log_dir, a.v1_base)
            v1c, v1cr = load_run(a.log_dir, a.v1_cand)
            for s, rid in ((v1b, a.v1_base), (v1c, a.v1_cand)):
                if s.get("ruler", "v1") != "v1":
                    raise GateInputError(f"{rid} is not a v1 run")
            v1 = v1_bar(v1b, v1c, v1br, v1cr)
    except GateInputError as e:
        print(f"[gate] INVALID INPUT: {e}", file=sys.stderr)
        return 2
    decision = dual_run_decision(v1, v3) if not a.v3_only else {"apply": False, "rule": "v3-only pricing (never applies)", "v3": v3}
    if a.json:
        print(json.dumps(decision, indent=1))
    else:
        print(f"v3 gate: {'PASS' if v3['pass'] else 'FAIL'}  (Δ {v3['mean_delta']:+.4f}, CI {v3['ci']}, "
              f"up/down/same {v3['changed']})")
        _print(v3)
        if v1:
            print(f"v1 bar: {'PASS' if v1['pass'] else 'FAIL'}  (changed: {v1['changed']})")
            _print(v1)
        print(f"DECISION: {'APPLY allowed' if decision['apply'] else 'KEEP BASELINE'} — {decision['rule']}")
    return 0 if decision["apply"] else 1


if __name__ == "__main__":
    sys.exit(main())
