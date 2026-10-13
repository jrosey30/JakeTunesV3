#!/usr/bin/env python3
"""
E1's method — on a SCRATCH COPY only: remove the mood-index vectors of in-library
tracks that have no Gemma descriptor ("bare": their mood text was tempo + genre
only). Absent beats bare (measured 10-12: the bare cohort took 14/25 of ret-007's
mood slots; a full reembed that ADDED bare vectors dropped it 0.44 -> 0.16).
When the trainer later describes those tracks, its nightly pass writes their
first real mood vector (descriptor-gated) — nothing is lost.

  python3 drop_bare_mood.py --state-dir /tmp/brain-cand-E1-20261013 [--dry-run]

Refuses the live brain dirs and symlinked files. Every kept record is copied
byte-for-byte (verified). The dropped ids land in <state-dir>/E1-dropped-ids.json.
"""
import argparse, json, os, struct, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
import scorecard as S  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    S.refuse_live_dir(a.state_dir)
    path = os.path.join(a.state_dir, "mood-index.bin")
    if os.path.islink(path):
        raise SystemExit(f"[fatal] {path} is a symlink — copy the file into the scratch dir (cp -p), never link it")
    drop = set(S.bare_mood_ids(a.state_dir))
    blob = open(path, "rb").read()
    ver, dim = struct.unpack_from("<H", blob, 4)[0], struct.unpack_from("<H", blob, 6)[0]
    count = struct.unpack_from("<I", blob, 8)[0]
    rec = 4 + dim * 4
    keep = []
    for i in range(count):
        r = blob[12 + i * rec: 12 + (i + 1) * rec]
        if struct.unpack_from("<I", r, 0)[0] not in drop:
            keep.append(r)
    print(f"mood-index.bin: {count} vectors, {len(drop)} bare in-library -> {'would keep' if a.dry_run else 'keeping'} {len(keep)}")
    if a.dry_run or not drop:
        return 0
    out = blob[0:4] + struct.pack("<HHI", ver, dim, len(keep)) + b"".join(keep)
    tmp = path + ".E1.tmp"
    with open(tmp, "wb") as f:
        f.write(out)
    os.replace(tmp, path)
    check = S.embd_ids(path)
    if len(check) != count - len(drop) or set(check) & drop:
        raise SystemExit("[fatal] verify failed after drop")
    with open(os.path.join(a.state_dir, "E1-dropped-ids.json"), "w") as f:
        json.dump(sorted(drop), f)
    print(f"wrote {path}: {len(check)} vectors (dropped {len(drop)}; ids in E1-dropped-ids.json)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
