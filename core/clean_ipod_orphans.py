"""
Delete audio files on the iPod that aren't referenced by the current
library.json. These accumulate during CD rip/restore churn: old files
stay on disk when library metadata shifts to different paths.

Usage:
  python3 core/clean_ipod_orphans.py --dry /Volumes/JakeTunes
  python3 core/clean_ipod_orphans.py --delete /Volumes/JakeTunes

--dry    print what would be deleted, no changes
--delete actually delete the files

Safety rules:
  - Only touches .m4a / .mp3 / .wav / .aiff / .aif / .m4p / .alac in
    iPod_Control/Music/F??/ — never anything outside Music.
  - Leaves iTunesDB, iTunesDB.bak-*, Play Counts, iTunesPrefs, etc.
    entirely alone.
  - Library is read from the app's canonical userData/library.json so
    nothing runtime-in-memory gets clobbered.
"""
import json
import os
import sys

AUDIO_EXTS = {'.m4a', '.mp3', '.wav', '.aiff', '.aif', '.m4p', '.alac', '.flac'}
LIB_JSON = os.path.expanduser('~/Library/Application Support/JakeTunes/library.json')


def build_referenced_paths(ipod_mount: str) -> set:
    lib = json.load(open(LIB_JSON))
    paths = set()
    for t in lib.get('tracks', []):
        p = t.get('path', '')
        if not p:
            continue
        rel = p.lstrip(':').replace(':', '/')
        # Normalize by joining to mount (so comparisons are apples-to-apples)
        paths.add(os.path.normpath(os.path.join(ipod_mount, rel)))
    return paths


def main(mount: str, do_delete: bool) -> None:
    if not os.path.isdir(os.path.join(mount, 'iPod_Control', 'Music')):
        print(f'Not an iPod mount: {mount}', file=sys.stderr)
        sys.exit(1)

    referenced = build_referenced_paths(mount)
    music_root = os.path.join(mount, 'iPod_Control', 'Music')

    orphans = []
    for dp, _, fns in os.walk(music_root):
        for fn in fns:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in AUDIO_EXTS:
                continue
            full = os.path.normpath(os.path.join(dp, fn))
            if full in referenced:
                continue
            orphans.append(full)

    total_bytes = 0
    for p in orphans:
        try:
            total_bytes += os.path.getsize(p)
        except OSError:
            pass

    print(f'Library tracks:   {len(referenced)}')
    print(f'Orphan files:     {len(orphans)}')
    print(f'Reclaimable size: {total_bytes / 1e9:.2f} GB')
    print()

    if not orphans:
        print('Nothing to clean. iPod is tidy.')
        return

    if not do_delete:
        print('--dry mode — showing first 20 orphans:')
        for p in orphans[:20]:
            print(f'  {os.path.relpath(p, mount)}')
        if len(orphans) > 20:
            print(f'  ... and {len(orphans) - 20} more')
        print()
        print(f'Re-run with --delete to remove them (after a backup of iTunesDB).')
        return

    # Delete pass. No stops on error — log and continue so one locked
    # file doesn't abort the whole cleanup.
    deleted = 0
    failed = 0
    for p in orphans:
        try:
            os.remove(p)
            deleted += 1
        except OSError as e:
            print(f'  could not delete {p}: {e}', file=sys.stderr)
            failed += 1

    print(f'Deleted: {deleted}')
    if failed:
        print(f'Failed:  {failed}')


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('--dry', '--delete'):
        print('Usage: clean_ipod_orphans.py --dry|--delete <ipod_mount>', file=sys.stderr)
        sys.exit(1)
    main(sys.argv[2], do_delete=sys.argv[1] == '--delete')
