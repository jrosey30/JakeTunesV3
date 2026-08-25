/**
 * The missing verification layer: catalog LAYOUT.
 *
 * 2026-08-15, the 79-of-500 night. The sync engine verifies everything about
 * the catalog's CONTENT — per-song fsync, remount-verified files, cold-remount
 * readback, an independent firmware-semantic validator — and the Mini still
 * indexed 79, then 12, then 471 of a catalog every layer called perfect. The
 * raw FAT walk found what none of them look at: iTunesDB was lying on the card
 * in NINE FRAGMENTS, scattered across the holes the activity sync's mass
 * delete-then-rewrite punched into free space. Rewriting the identical bytes
 * as ONE contiguous run — nothing else — was the only intervention that
 * changed what the firmware saw. Fragmented catalogs pass every content gate;
 * the firmware walks the FAT chain, gives up partway, and the count lands
 * wherever it died. A different layout every sync = a different count every
 * sync = "roulette".
 *
 * So: the Python writer produces iTunesDB on a LOCAL file (Mac temp).
 * This module rewrites that local file as one contiguous run. The sync
 * engine then copyFile + F_FULLFSYNC onto the CF and remount-proves the
 * bytes. Running this pass on the fskit mount was the 450: F_NOCACHE is
 * a no-op there, so "verified 500 rows" was the Mac cache, never the card.
 *
 * Failure policy: if the rewritten file cannot be VERIFIED byte-identical,
 * the worker swaps the original back and reports failure — a fragmented
 * catalog that is correct beats a contiguous one that is torn. If only the
 * contiguous *allocation* is refused (fcntl unsupported), the fresh single
 * write proceeds anyway: while the old file still occupies its scattered
 * clusters, the allocator cannot reuse those holes, so a fresh write is
 * strictly less fragmented than the writer's output even without the fcntl.
 */

import { spawn } from 'child_process'

export interface ContiguityResult {
  ok: boolean
  /** fcntl F_PREALLOCATE(F_ALLOCATECONTIG) accepted — contiguity was
   *  guaranteed at allocation, not just probable. */
  preallocContig: boolean
  bytes: number
  md5: string
  /** One line for the sync log. */
  summary: string
  error?: string
}

/** Runs inside python3. Prints exactly one JSON object to stdout.
 *  Kept as a single source string so the logic ships inside app.asar with no
 *  extra file to forget in electron-builder's files list. */
const PY_WORKER = `
import fcntl, hashlib, json, os, struct, sys
db = sys.argv[1]
F_NOCACHE, F_FULLFSYNC, F_PREALLOCATE = 48, 51, 42
F_ALLOCATECONTIG, F_PEOFPOSMODE = 2, 3

def nocache_bytes(path):
    fd = os.open(path, os.O_RDONLY)
    try: fcntl.fcntl(fd, F_NOCACHE, 1)
    except OSError: pass
    with os.fdopen(fd, 'rb') as f:
        return f.read()

out = {'ok': False, 'preallocContig': False, 'bytes': 0, 'md5': ''}
try:
    data = open(db, 'rb').read()
    src_md5 = hashlib.md5(data).hexdigest()
    out['bytes'] = len(data)
    out['md5'] = src_md5

    tmp = db + '.contig'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    try:
        buf = struct.pack('=iiqqq', F_ALLOCATECONTIG, F_PEOFPOSMODE, 0, len(data), 0)
        fcntl.fcntl(fd, F_PREALLOCATE, buf)
        out['preallocContig'] = True
    except OSError:
        pass
    os.write(fd, data)
    try: fcntl.fcntl(fd, F_FULLFSYNC)
    except OSError: os.fsync(fd)
    os.close(fd)

    if hashlib.md5(nocache_bytes(tmp)).hexdigest() != src_md5:
        os.unlink(tmp)
        out['error'] = 'contig copy readback mismatch; original left in place'
        print(json.dumps(out)); sys.exit(0)

    prev = db + '.prefrag'
    try: os.unlink(prev)
    except OSError: pass
    os.rename(db, prev)
    os.rename(tmp, db)

    if hashlib.md5(nocache_bytes(db)).hexdigest() != src_md5:
        # Torn after swap — restore the writer's original before reporting.
        os.rename(db, db + '.torn')
        os.rename(prev, db)
        out['error'] = 'post-swap readback mismatch; original restored'
        print(json.dumps(out)); sys.exit(0)

    out['ok'] = True
except Exception as e:
    out['error'] = f'{type(e).__name__}: {e}'
print(json.dumps(out))
`

export function ensureContiguousDb(dbPath: string, pythonCmd: string): Promise<ContiguityResult> {
  return new Promise((resolve) => {
    const fail = (error: string): void => resolve({
      ok: false, preallocContig: false, bytes: 0, md5: '',
      summary: `contiguity pass FAILED (${error}) — writer's original left in place`,
      error,
    })
    let out = ''
    let err = ''
    const py = spawn(pythonCmd, ['-c', PY_WORKER, dbPath])
    py.stdout.on('data', (d: Buffer) => { out += d.toString() })
    py.stderr.on('data', (d: Buffer) => { err += d.toString() })
    py.on('error', (e: Error) => fail(e.message))
    py.on('close', () => {
      try {
        const r = JSON.parse(out.trim().split('\n').pop() || '{}') as Omit<ContiguityResult, 'summary'>
        const summary = r.ok
          ? `catalog rewritten as one run (${r.bytes} bytes, md5 ${r.md5.slice(0, 8)}, contiguous allocation ${r.preallocContig ? 'GUARANTEED by fcntl' : 'best-effort'})`
          : `contiguity pass FAILED (${r.error || 'unknown'}) — writer's original left in place`
        resolve({ ...r, summary })
      } catch {
        fail(`worker output unparseable: ${(err || out).slice(0, 160)}`)
      }
    })
  })
}
