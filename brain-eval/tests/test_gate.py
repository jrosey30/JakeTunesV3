"""gate.py with synthetic deltas: pass, fail on the CI lower bound, fail on a
group drop, fail on grounding — plus the v1 bar and the dual-run rule."""
import contextlib, io, json, os, tempfile, unittest
import _paths  # noqa: F401
import gate as G

GROUPS = ("artist", "leaf", "vibe")


def rows(scores_by_group, lib="L1"):
    out = []
    for g, scores in scores_by_group.items():
        for i, s in enumerate(scores):
            out.append({"probe_id": f"{g}-{i:03d}", "group": g, "score": s, "library_sha": lib})
    return out


def pair(base_val, deltas_by_group):
    base = {g: [base_val] * len(d) for g, d in deltas_by_group.items()}
    cand = {g: [base_val + x for x in d] for g, d in deltas_by_group.items()}
    return rows(base), rows(cand)


def by_check(res):
    return {c["check"]: c["pass"] for c in res["checks"]}


class V3Gate(unittest.TestCase):
    def test_pass(self):
        b, c = pair(0.5, {g: [0.01] * 40 for g in GROUPS})
        r = G.v3_gate(b, c, 1.0)
        self.assertTrue(r["pass"], r)
        self.assertAlmostEqual(r["mean_delta"], 0.01, places=6)
        self.assertGreater(r["ci"][0], 0)

    def test_fail_on_lower_bound_only(self):
        # mean +0.006 (clears +0.005) but huge spread: the 90% interval straddles 0
        alt = [0.2 if i % 2 == 0 else -0.188 for i in range(40)]
        b, c = pair(0.5, {g: alt for g in GROUPS})
        r = G.v3_gate(b, c, 1.0)
        chk = by_check(r)
        self.assertFalse(r["pass"])
        self.assertTrue(chk["mean_delta"], r)
        self.assertFalse(chk["ci_lower"], r)
        self.assertTrue(chk["group_drop"], r)
        self.assertLessEqual(r["ci"][0], 0)

    def test_fail_on_group_drop_only(self):
        b, c = pair(0.5, {"artist": [0.03] * 40, "leaf": [0.03] * 40, "vibe": [-0.02] * 40})
        r = G.v3_gate(b, c, 1.0)
        chk = by_check(r)
        self.assertFalse(r["pass"])
        self.assertTrue(chk["mean_delta"] and chk["ci_lower"], r)
        self.assertFalse(chk["group_drop"], r)
        self.assertAlmostEqual(r["group_deltas"]["vibe"], -0.02, places=6)

    def test_group_drop_exactly_at_limit_passes(self):
        b, c = pair(0.5, {"artist": [0.03] * 40, "leaf": [0.03] * 40, "vibe": [-0.01] * 40})
        self.assertTrue(by_check(G.v3_gate(b, c, 1.0))["group_drop"])

    def test_mean_below_threshold_fails(self):
        b, c = pair(0.5, {g: [0.004] * 40 for g in GROUPS})
        chk = by_check(G.v3_gate(b, c, 1.0))
        self.assertFalse(chk["mean_delta"])
        self.assertTrue(chk["ci_lower"])

    def test_grounding_must_be_perfect_and_measured(self):
        b, c = pair(0.5, {g: [0.01] * 40 for g in GROUPS})
        self.assertFalse(by_check(G.v3_gate(b, c, 0.95))["grounding"])
        self.assertFalse(by_check(G.v3_gate(b, c, None))["grounding"])

    def test_probe_set_and_library_must_match(self):
        b, c = pair(0.5, {g: [0.01] * 40 for g in GROUPS})
        with self.assertRaises(G.GateInputError):
            G.v3_gate(b, c[:-1], 1.0)
        c2 = [dict(r, library_sha="L2") for r in c]
        with self.assertRaises(G.GateInputError):
            G.v3_gate(b, c2, 1.0)

    def test_fusion_state_must_match(self):
        b, c = pair(0.5, {g: [0.01] * 40 for g in GROUPS})
        b = [dict(r, mode="fusion") for r in b]
        with self.assertRaises(G.GateInputError):
            G.v3_gate(b, [dict(r, mode="mood") for r in c], 1.0)
        self.assertTrue(G.v3_gate(b, [dict(r, mode="fusion") for r in c], 1.0)["pass"])

    def test_bootstrap_is_deterministic(self):
        d = [0.01, -0.02, 0.03, 0.0, 0.05] * 10
        self.assertEqual(G.paired_bootstrap_ci(d), G.paired_bootstrap_ci(d))


class V1Bar(unittest.TestCase):
    base = {"retrieval": 0.80, "grounding": 1.0, "overall": 0.90, "persona": None, "brain_id": "m1", "mood_id": "x1"}

    def test_main_change_must_improve_retrieval_and_overall(self):
        cand = dict(self.base, brain_id="m2", retrieval=0.81, overall=0.905)
        self.assertTrue(G.v1_bar(self.base, cand)["pass"])
        flat = dict(self.base, brain_id="m2")
        self.assertFalse(G.v1_bar(self.base, flat)["pass"])

    def test_any_regression_fails(self):
        cand = dict(self.base, brain_id="m2", retrieval=0.82, overall=0.89)
        self.assertFalse(G.v1_bar(self.base, cand)["pass"])
        cand = dict(self.base, brain_id="m2", retrieval=0.82, overall=0.91, grounding=0.9)
        self.assertFalse(G.v1_bar(self.base, cand)["pass"])

    def test_grounding_must_be_measured(self):
        cand = dict(self.base, brain_id="m2", retrieval=0.82, overall=0.91, grounding=None)
        self.assertFalse(G.v1_bar(self.base, cand)["pass"])

    def test_mood_only_change_needs_no_per_probe_mood_drop(self):
        cand = dict(self.base, mood_id="x2")
        br = [{"probe_id": "ret-007", "group": "retrieval", "score_mood": 0.44},
              {"probe_id": "ret-013", "group": "retrieval", "score_mood": 0.90}]
        good = [dict(br[0], score_mood=0.84), dict(br[1], score_mood=0.90)]
        bad = [dict(br[0], score_mood=0.84), dict(br[1], score_mood=0.86)]
        self.assertTrue(G.v1_bar(self.base, cand, br, good)["pass"])
        self.assertFalse(G.v1_bar(self.base, cand, br, bad)["pass"])

    def test_identical_brain_has_nothing_to_apply(self):
        self.assertFalse(G.v1_bar(self.base, dict(self.base))["pass"])

    def test_dual_run_needs_both(self):
        p, f = {"pass": True}, {"pass": False}
        self.assertTrue(G.dual_run_decision(p, p)["apply"])
        self.assertFalse(G.dual_run_decision(p, f)["apply"])
        self.assertFalse(G.dual_run_decision(f, p)["apply"])
        self.assertFalse(G.dual_run_decision(None, p)["apply"])


class Cli(unittest.TestCase):
    def test_end_to_end_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            b, c = pair(0.5, {g: [0.01] * 40 for g in GROUPS})
            log = [
                {"run_id": "B3", "ruler": "v3", "label": "baseline", "grounding": 1.0, "eval_set_sha": "e", "primary_source": "bridge"},
                {"run_id": "C3", "ruler": "v3", "label": "candidate", "grounding": 1.0, "eval_set_sha": "e", "primary_source": "bridge"},
                {"run_id": "B1", "ruler": "v1", "label": "current", "retrieval": 0.8, "grounding": 1.0, "overall": 0.9, "brain_id": "m1", "mood_id": "x1"},
                {"run_id": "C1", "ruler": "v1", "label": "current", "retrieval": 0.81, "grounding": 1.0, "overall": 0.905, "brain_id": "m2", "mood_id": "x1"},
                {"run_id": "C1bad", "ruler": "v1", "label": "current", "retrieval": 0.79, "grounding": 1.0, "overall": 0.895, "brain_id": "m2", "mood_id": "x1"},
            ]
            prow = [dict(r, run_id="B3", label="baseline") for r in b] + [dict(r, run_id="C3", label="candidate") for r in c]
            with open(os.path.join(d, "score_log.jsonl"), "w") as f:
                f.write("\n".join(json.dumps(x) for x in log) + "\n")
            with open(os.path.join(d, "score_rows.jsonl"), "w") as f:
                f.write("\n".join(json.dumps(x) for x in prow) + "\n")
            base = ["--base", "B3", "--cand", "C3", "--log-dir", d, "--json"]
            run = lambda extra: G.main(base + extra)  # noqa: E731
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(run(["--v1-base", "B1", "--v1-cand", "C1"]), 0)
                self.assertEqual(run(["--v1-base", "B1", "--v1-cand", "C1bad"]), 1)
                self.assertEqual(run([]), 2)                    # dual-run needs the v1 runs
                self.assertEqual(run(["--v3-only"]), 1)         # pricing never applies


if __name__ == "__main__":
    unittest.main()
