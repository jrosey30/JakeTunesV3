import os, shutil, sys, hashlib
sys.path.insert(0, "/tmp/brain-eval-20260820/brain-eval")
NAS = "/Volumes/JakeShared/JakeTunesState"
LIVE = os.path.join(NAS, "mood-index.bin")
BACKUP = os.path.join(NAS, "mood-index.bin.pre-repair-20260820")
CAND = "/tmp/mood-index.candidate-20260820.bin"
EXPECT_LIVE_SHA = "fa5571801b626b759666f3ee9c901ff71d653359"
def sha(p):
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()

# 1. pre-apply: live file must be EXACTLY what we measured
live_sha = sha(LIVE)
if live_sha != EXPECT_LIVE_SHA:
    raise SystemExit(f"[ABORT] live mood-index changed since measurement: {live_sha[:12]} != {EXPECT_LIVE_SHA[:12]} — DISCARD apply")
emb_stat = os.stat(os.path.join(NAS, "embeddings.bin"))
print(f"pre-apply OK: live sha {live_sha[:12]} matches snapshot; embeddings.bin size {emb_stat.st_size} mtime {emb_stat.st_mtime}")

# 2. verified backup
shutil.copy2(LIVE, BACKUP)
b = sha(BACKUP)
if b != EXPECT_LIVE_SHA:
    raise SystemExit(f"[ABORT] backup sha mismatch {b[:12]} — NOT proceeding")
print(f"backup verified: {BACKUP} sha {b[:12]}")

# 3. temp + atomic rename on the same share
cand_sha = sha(CAND)
tmp = f"{LIVE}.{os.getpid()}.repair20260820.tmp"
shutil.copyfile(CAND, tmp)
if sha(tmp) != cand_sha:
    os.unlink(tmp); raise SystemExit("[ABORT] tmp copy sha mismatch — not renaming")
os.rename(tmp, LIVE)

# 4. post-write verify
import struct
blob = open(LIVE, "rb").read()
assert blob[0:4] == b"EMBD", "bad magic after write"
dim = struct.unpack_from("<H", blob, 6)[0]
count = struct.unpack_from("<I", blob, 8)[0]
final = sha(LIVE)
if final != cand_sha or dim != 1536 or count != 9592:
    print(f"[FAIL] round-trip bad (sha {final[:12]} dim {dim} count {count}) — RESTORING BACKUP")
    shutil.copy2(BACKUP, LIVE)
    raise SystemExit(1)
print(f"APPLIED: mood-index.bin now sha {final[:12]} ({count} vecs, dim {dim}); backup sha {b[:12]}")
