"""
Pre-populate the JakeTunes play-cache so the first play of every ALAC
track is instant instead of waiting 1-3s for an on-demand ffmpeg
transcode. The app's audio protocol handler computes the cache filename
as sha1(abs_path)[:16] + ".m4a" and considers a cache entry fresh when
its mtime >= source mtime — we match both exactly so pre-generated
entries are picked up without code changes.

Usage: python3 core/prewarm_play_cache.py
"""

import hashlib
import json
import os
import subprocess
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from tag_reader import read_tags  # noqa: E402


PLAY_CACHE = os.path.expanduser('~/Library/Application Support/JakeTunes/play-cache')
LIBRARY    = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')
LOCAL_ROOT = os.path.expanduser('~/Music2/JakeTunesLibrary')


def cache_path_for(src: str) -> str:
    h = hashlib.sha1(src.encode()).hexdigest()[:16]
    return os.path.join(PLAY_CACHE, f'{h}.m4a')


def transcode(src: str, dest: str) -> tuple[bool, str]:
    """Write atomically: ffmpeg → tmp file → rename on success.

    Without this, a killed ffmpeg leaves a partial file at `dest` whose
    mtime still passes the freshness check — the app then serves a
    truncated 42-second version of a 4-minute track. Rename is the
    only way to guarantee `dest` is either complete-or-missing.
    """
    # Use `.partial.m4a` (not `.tmp`) so ffmpeg recognizes the mp4
    # container format from the extension. Atomic-rename into place
    # on success. Either .m4a or nothing — never partial at dest.
    tmp = dest + '.partial.m4a'
    try:
        r = subprocess.run([
            'ffmpeg', '-y', '-i', src, '-vn',
            '-c:a', 'aac', '-b:a', '256k',
            '-map_metadata', '0',
            '-loglevel', 'error',
            tmp,
        ], capture_output=True, timeout=300)
        if r.returncode != 0:
            try: os.unlink(tmp)
            except OSError: pass
            return False, r.stderr.decode(errors='replace')[:200]
        # Verify the tmp file's duration is reasonable (at least 90%
        # of what we can probe from the source). Catches the case
        # where ffmpeg reports success but wrote a silent/truncated
        # file due to corrupt source frames.
        src_d = ffprobe_duration(src)
        tmp_d = ffprobe_duration(tmp)
        if src_d > 1.0 and tmp_d < src_d * 0.9:
            try: os.unlink(tmp)
            except OSError: pass
            return False, f'output truncated: {tmp_d:.1f}s vs source {src_d:.1f}s'
        os.replace(tmp, dest)
        return True, 'ok'
    except subprocess.TimeoutExpired:
        try: os.unlink(tmp)
        except OSError: pass
        return False, 'timeout'
    except FileNotFoundError:
        try: os.unlink(tmp)
        except OSError: pass
        return False, 'ffmpeg not installed'


def ffprobe_duration(path: str) -> float:
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=nw=1:nk=1', path],
            capture_output=True, timeout=15,
        )
        return float((r.stdout.decode().strip() or '0'))
    except Exception:  # noqa: BLE001
        return 0.0


def main() -> None:
    os.makedirs(PLAY_CACHE, exist_ok=True)
    with open(LIBRARY) as fh:
        lib = json.load(fh)
    tracks = lib.get('tracks', [])
    print(f'library tracks: {len(tracks)}')
    print(f'cache dir: {PLAY_CACHE}')

    # Resolve abs paths + identify which are ALAC (only those need cache)
    alac_targets: list[tuple[str, float]] = []
    skipped_non_alac = 0
    skipped_missing = 0
    fresh = 0
    for t in tracks:
        colon = t.get('path', '') or ''
        if not colon:
            continue
        rel = colon.lstrip(':').replace(':', '/')
        abs_p = os.path.join(LOCAL_ROOT, rel)
        try:
            s = os.stat(abs_p)
        except OSError:
            skipped_missing += 1
            continue
        # Only m4a-container files need an ALAC probe
        if not abs_p.lower().endswith(('.m4a', '.alac', '.mp4')):
            skipped_non_alac += 1
            continue
        tags = read_tags(abs_p)
        if (tags.get('codec') or '').lower() != 'alac':
            skipped_non_alac += 1
            continue

        cache = cache_path_for(abs_p)
        try:
            cs = os.stat(cache)
            if cs.st_mtime >= s.st_mtime:
                fresh += 1
                continue
        except OSError:
            pass
        alac_targets.append((abs_p, s.st_mtime))

    print(f'  already cached (fresh):   {fresh}')
    print(f'  non-ALAC (no cache need): {skipped_non_alac}')
    print(f'  missing files:            {skipped_missing}')
    print(f'  need pre-warming:         {len(alac_targets)}')

    if not alac_targets:
        print('Nothing to do.')
        return

    print()
    print(f'Pre-warming {len(alac_targets)} ALAC transcodes (4-way parallel)...', flush=True)
    t0 = time.time()
    ok_count = 0
    failed = []

    # Run 4 ffmpeg processes in parallel. Each one is single-threaded for
    # a simple decode→encode chain, so modern Macs have plenty of cores
    # to chew through the backlog quickly without starving the UI.
    from concurrent.futures import ThreadPoolExecutor, as_completed
    done = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            pool.submit(transcode, src, cache_path_for(src)): (src, mtime)
            for src, mtime in alac_targets
        }
        for fut in as_completed(futures):
            src, mtime = futures[fut]
            try:
                success, reason = fut.result()
            except Exception as e:  # noqa: BLE001
                success, reason = False, f'{type(e).__name__}: {e}'
            if success:
                ok_count += 1
                try:
                    os.utime(cache_path_for(src), (time.time(), mtime + 1))
                except OSError:
                    pass
            else:
                failed.append((src, reason))
            done += 1
            if done % 25 == 0 or done == len(alac_targets):
                print(f'  [{done}/{len(alac_targets)}] ok={ok_count} failed={len(failed)} ({time.time()-t0:.1f}s)', flush=True)

    print(f'\nDone in {time.time()-t0:.1f}s. {ok_count} pre-warmed, {len(failed)} failed.')
    if failed:
        for p, r in failed[:10]:
            print(f'  FAIL: {os.path.basename(p)} — {r}')


if __name__ == '__main__':
    main()
