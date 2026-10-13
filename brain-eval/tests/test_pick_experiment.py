"""pick_experiment.py: picking order, preconditions, jake-lane pricing, the
series cap, ledger-driven night limits, status transitions and re-queueing."""
import contextlib, copy, io, json, os, tempfile, unittest
import _paths  # noqa: F401
import pick_experiment as P


def item(iid, lane="auto", priority=50, status="queued", pre=None, **kw):
    it = {"id": iid, "title": f"item {iid}", "status": status, "priority": priority, "lane": lane,
          "hypothesis": {"metric": "m", "from": 0.4, "to_beat": 0.8}, "method": ["true"], "touches": ["mood-index.bin"],
          "preconditions": pre or [], "acceptance": "gate", "rollback": "undo", "grounding_source": "report",
          "budget": {}, "max_nights": 1, "series": False, "result": None}
    it.update(kw)
    return it


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.yes = os.path.join(self.d, "present.txt")
        open(self.yes, "w").write("guard: pending.map(({ t, d }) => x)\n")
        self.no = os.path.join(self.d, "absent.txt")

    def tearDown(self):
        self.tmp.cleanup()

    def pc(self, ok):
        return [{"kind": "file_exists", "path": self.yes if ok else self.no}]


class Picking(Fixture):
    def test_highest_priority_eligible_auto_wins(self):
        q = {"items": [item("A", priority=90, pre=self.pc(False)), item("B", priority=80, pre=self.pc(True)),
                       item("C", priority=70, pre=self.pc(True)), item("J", lane="jake", priority=99, pre=self.pc(True))]}
        r = P.pick(q, [], {})
        self.assertEqual((r["mode"], r["item"]), ("run", "B"))
        self.assertFalse(r["checked"][0]["eligible"])

    def test_falls_back_to_pricing_the_top_jake_item(self):
        q = {"items": [item("A", pre=self.pc(False)), item("J1", lane="jake", priority=40, pre=self.pc(True)),
                       item("J2", lane="jake", priority=60, pre=self.pc(False)), item("J3", lane="jake", priority=50)]}
        r = P.pick(q, [], {})
        self.assertEqual((r["mode"], r["item"]), ("price", "J3"))

    def test_idle_when_nothing_qualifies(self):
        q = {"items": [item("A", pre=self.pc(False)), item("D", status="done"), item("J", lane="jake", pre=self.pc(False))]}
        self.assertEqual(P.pick(q, [], {})["mode"], "idle")

    def test_non_queued_items_are_never_picked(self):
        q = {"items": [item("R", status="rejected", priority=99), item("A", priority=10)]}
        self.assertEqual(P.pick(q, [], {})["item"], "A")

    def test_out_of_nights_is_skipped(self):
        q = {"items": [item("W", priority=90, series=True, max_nights=3), item("A", priority=10)]}
        led = [{"at": f"2026-10-{d}T03:10:00", "event": "result", "id": "W"} for d in (10, 11, 12)]
        r = P.pick(q, led, {})
        self.assertEqual(r["item"], "A")
        self.assertIn("out of nights", r["checked"][0]["why"])
        self.assertEqual(P.pick(q, led[:2], {})["item"], "W")

    def test_source_grep_and_status_preconditions(self):
        q = {"items": [item("A", pre=[{"kind": "source_grep", "file": self.yes, "pattern": r"pending\.map", "expect": "present"},
                                      {"kind": "item_status", "id": "E4", "in": ["done"]}]),
                       item("E4", lane="jake", status="done")]}
        self.assertEqual(P.pick(q, [], {})["item"], "A")
        q["items"][0]["preconditions"][0]["expect"] = "absent"
        self.assertEqual(P.pick(q, [], {})["mode"], "idle")

    def test_state_preconditions_without_a_state_dir_fail_closed(self):
        q = {"items": [item("A", pre=[{"kind": "bare_backlog", "min": 1}])]}
        r = P.pick(q, [], {"state_dir": None})
        self.assertEqual(r["mode"], "idle")
        self.assertIn("could not check", r["checked"][0]["preconditions"][0]["detail"])


class Validation(unittest.TestCase):
    def test_series_cap_and_required_fields(self):
        q = {"items": [item("A", series=True, max_nights=4)]}
        self.assertTrue(any("capped at 3" in e for e in P.validate(q)))
        bad = item("B"); del bad["rollback"]
        self.assertTrue(any("rollback" in e for e in P.validate({"items": [bad]})))
        self.assertTrue(any("number to beat" in e for e in P.validate({"items": [item("C", hypothesis={"statement": "x"})]})))
        self.assertTrue(any("lane" in e for e in P.validate({"items": [item("D", lane="nightly")]})))

    def test_the_real_queue_is_valid_and_seeded(self):
        q = P.load_queue()
        self.assertEqual(P.validate(q), [])
        ids = {i["id"]: i for i in q["items"]}
        self.assertTrue({"E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"} <= set(ids))
        self.assertEqual(ids["E4"]["status"], "done")
        self.assertIn("#105", ids["E4"]["grounding_source"] + json.dumps(ids["E4"]["result"]))
        for a in ("E1", "E2", "E3", "E8"):
            self.assertEqual(ids[a]["lane"], "auto")
        for j in ("E5", "E6", "E7", "E9"):
            self.assertEqual(ids[j]["lane"], "jake")
        self.assertTrue(ids["E8"].get("measure_only"))


class RecordAndRequeue(Fixture):
    def test_record_transitions_and_guards(self):
        led = os.path.join(self.d, "ledger.jsonl")
        q = {"items": [item("A"), item("J", lane="jake"), item("M", measure_only=True, touches=[])]}
        with self.assertRaises(ValueError):
            P.record(q, "A", "applied", "no gate", ledger=led)           # applied needs an apply=true gate
        with self.assertRaises(ValueError):
            P.record(q, "J", "applied", "x", gate={"apply": True}, ledger=led)   # jake lane never applies
        with self.assertRaises(ValueError):
            P.record(q, "M", "applied", "x", gate={"apply": True}, ledger=led)   # measure-only never applies
        P.record(q, "A", "rejected", "failed the CI bound", metrics={"mean_delta": 0.003}, ledger=led)
        self.assertEqual(q["items"][0]["status"], "rejected")
        P.record(q, "J", "priced", "Δ +0.004", ledger=led)
        self.assertEqual(q["items"][1]["status"], "priced")
        rows = P.read_ledger(led)
        self.assertEqual([r["outcome"] for r in rows], ["rejected", "priced"])
        self.assertEqual(rows[0]["hypothesis"]["to_beat"], 0.8)

    def test_applied_with_a_passing_gate(self):
        led = os.path.join(self.d, "ledger.jsonl")
        q = {"items": [item("A")]}
        P.record(q, "A", "applied", "dual-run PASS", gate={"apply": True}, ledger=led)
        self.assertEqual(q["items"][0]["status"], "applied")

    def test_no_change_on_last_night_expires(self):
        led = os.path.join(self.d, "ledger.jsonl")
        q = {"items": [item("A", max_nights=1)]}
        P.record(q, "A", "no-change", "nothing moved", ledger=led)
        self.assertEqual(q["items"][0]["status"], "expired")

    def test_requeue_needs_a_new_hypothesis(self):
        led = os.path.join(self.d, "ledger.jsonl")
        q = {"items": [item("A")]}
        with self.assertRaises(ValueError):
            P.requeue(q, "A", {"metric": "m", "to_beat": 0.9}, "x", [])      # still queued
        P.record(q, "A", "rejected", "missed", ledger=led)
        same = copy.deepcopy(q["items"][0]["hypothesis"])
        with self.assertRaises(ValueError):
            P.requeue(q, "A", same, "again", P.read_ledger(led))
        with self.assertRaises(ValueError):
            P.requeue(q, "A", {"statement": "vibes"}, "no number", P.read_ledger(led))
        row = P.requeue(q, "A", {"metric": "m", "from": 0.4, "to_beat": 0.6}, "smaller cohort", P.read_ledger(led))
        self.assertEqual(q["items"][0]["status"], "queued")
        self.assertEqual(row["event"], "requeued")
        P.append_ledger(row, led)
        P.record(q, "A", "rejected", "missed again", ledger=led)
        with self.assertRaises(ValueError):   # neither earlier hypothesis may come back
            P.requeue(q, "A", same, "third try", P.read_ledger(led))

    def test_cli_pick_dry_run_writes_nothing(self):
        qp, lp = os.path.join(self.d, "q.json"), os.path.join(self.d, "l.jsonl")
        json.dump({"items": [item("A", pre=self.pc(True))]}, open(qp, "w"))
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(P.main(["pick", "--queue", qp, "--ledger", lp, "--dry-run", "--json"]), 0)
        self.assertEqual(json.loads(out.getvalue())["item"], "A")
        self.assertFalse(os.path.exists(lp))
        with contextlib.redirect_stdout(io.StringIO()):
            P.main(["pick", "--queue", qp, "--ledger", lp])
        self.assertEqual(P.read_ledger(lp)[0]["event"], "picked")


if __name__ == "__main__":
    unittest.main()
