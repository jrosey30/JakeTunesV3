"""apply_emb_20260904 — restore the trainer's 02:18 embeddings.bin output over
the desktop's 02:20 stale replay, keeping the 12 post-trainer import vectors.

The 02:18-02:25 autoBackupStateToNas replay fired AFTER the trainer for the
first time, reverting 612 of the trainer's night re-embeds (500 tempo/key-v3
catch-up + 50 nightly enrich + 150 meaning) while their te=3 / meaning stamps
survive in brain-descriptors.json — without this restore the trainer never
revisits them and they stay stale forever (the mood-clobber mechanism, now on
the identity index). Candidate = embeddings.bin.bak (trainer post-run state,
10,384 == the trainer log's vector count) + the 12 live-only Ramones imports.
Proven eval-neutral: identity 15-probe 0.756->0.754 (only delta ret-015 -0.03,
the documented Rock-tag ruler residual, mood-routed anyway); router-truth
unchanged 0.818. Precedent: the 08-25 restore-from-.bak.

Undo: cp /Volumes/JakeShared/JakeTunesState/embeddings.bin.pre-restore-20260904
        /Volumes/JakeShared/JakeTunesState/embeddings.bin
"""
import os, shutil, sys, hashlib, struct

NAS = "/Volumes/JakeShared/JakeTunesState"
LIVE = os.path.join(NAS, "embeddings.bin")
BACKUP = os.path.join(NAS, "embeddings.bin.pre-restore-20260904")
CAND = "/tmp/embeddings.candidate-20260904.bin"
EXPECT_LIVE_SHA = "7313b180777651f81061ba13f9a85ac8b430eb7f"

def sha(p):
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

# 1. pre-apply: live file must be EXACTLY what we measured
live_sha = sha(LIVE)
if live_sha != EXPECT_LIVE_SHA:
    raise SystemExit(f"[ABORT] live embeddings.bin changed since measurement: {live_sha[:12]} != {EXPECT_LIVE_SHA[:12]} — DISCARD apply")
print(f"pre-apply OK: live sha {live_sha[:12]} matches snapshot")

# 2. verified backup of the current (replayed) live file
shutil.copy2(LIVE, BACKUP)
b = sha(BACKUP)
if b != EXPECT_LIVE_SHA:
    raise SystemExit(f"[ABORT] backup sha mismatch {b[:12]} — NOT proceeding")
print(f"backup verified: {BACKUP} sha {b[:12]}")

# 3. temp + atomic rename on the same share
cand_sha = sha(CAND)
tmp = f"{LIVE}.{os.getpid()}.restore20260904.tmp"
shutil.copyfile(CAND, tmp)
if sha(tmp) != cand_sha:
    os.unlink(tmp); raise SystemExit("[ABORT] tmp copy sha mismatch — not renaming")
os.rename(tmp, LIVE)

# 4. post-write verify
blob = open(LIVE, "rb").read()
assert blob[0:4] == b"EMBD", "bad magic after write"
dim = struct.unpack_from("<H", blob, 6)[0]
count = struct.unpack_from("<I", blob, 8)[0]
final = sha(LIVE)
if final != cand_sha or dim != 1536 or count != 10396:
    print(f"[FAIL] round-trip bad (sha {final[:12]} dim {dim} count {count}) — RESTORING BACKUP")
    shutil.copy2(BACKUP, LIVE)
    raise SystemExit(1)
print(f"APPLIED: embeddings.bin now sha {final[:12]} ({count} vecs, dim {dim}); backup sha {b[:12]}")
