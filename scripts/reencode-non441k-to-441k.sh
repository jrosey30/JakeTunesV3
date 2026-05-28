#!/usr/bin/env bash
#
# One-shot re-encoder: rewrite every .m4a in the JakeTunes library that
# isn't at 44100 Hz down to 44100 Hz AAC, in place. Companion to the
# platform.ts fix that pins future imports to `aac@44100` — this catches
# the ~1135 historical files that landed at 48 kHz and squeak on the
# iPod Mini Gen 1's hardware decoder.
#
# Defaults to DRY RUN. Pass --apply to actually rewrite files.
#
# Per-file flow:
#   1. afinfo to read source sample rate + duration
#   2. skip if already 44100 Hz
#   3. ffmpeg → tmp: -c:a aac -b:a 256k -ar 44100 -map_metadata 0 -c:v copy
#   4. afinfo the tmp to verify 44100 Hz + duration within 0.5s of source
#   5. capture source mtime, atomic mv tmp → src, restore mtime
#   6. on any failure, leave source untouched and continue
#
# Resume-safe: skips files already at 44.1 kHz, so re-running after an
# interrupt picks up where it left off.
#
# Why ffmpeg here (and afconvert in platform.ts):
#   - ffmpeg preserves m4a tags in one shot (-map_metadata 0); afconvert
#     would need a post-process mutagen pass (V3's embedTags). Simpler
#     for a standalone script with no electron context.
#   - Quality difference at 256k AAC is inaudible vs Apple's encoder.
#
# Why preserve mtime: library.json's freshness cache + the
# Mac↔NAS↔Mini sync chain key on mtime. Touching it triggers a full
# library reload and a full music rsync, both of which are expensive.

set -uo pipefail

LIB_ROOT="${LIB_ROOT:-$HOME/Music2/JakeTunesLibrary/iPod_Control/Music}"
TARGET_RATE=44100
TARGET_BITRATE_K=256

APPLY=0
BACKUP=1
LIMIT=0
BAK_SUFFIX=".pre-441k-fix.bak"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)     APPLY=1; shift ;;
    --no-backup) BACKUP=0; shift ;;
    --limit)     LIMIT="${2:-0}"; shift 2 ;;
    --limit=*)   LIMIT="${1#--limit=}"; shift ;;
    --help|-h)
      sed -n '2,30p' "$0"
      echo
      echo "Flags:"
      echo "  --apply         actually rewrite files (default: dry run)"
      echo "  --limit N       cap re-encodes at N files (0 = no cap)"
      echo "  --no-backup     skip writing $BAK_SUFFIX backups (default: backups ON)"
      echo
      echo "With backups on (the default), each rewritten file is preserved at"
      echo "<original>${BAK_SUFFIX} so you can verify and revert before deleting."
      exit 0
      ;;
    *)
      echo "unknown arg: $1 (use --help)" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$LIB_ROOT" ]; then
  echo "library root not found: $LIB_ROOT" >&2
  exit 1
fi

scanned=0
needs_fix=0
fixed=0
skipped_44k=0
failed=0

mode_label=$([ $APPLY -eq 1 ] && echo "APPLY" || echo "DRY RUN")
echo "[$mode_label] scanning $LIB_ROOT for non-${TARGET_RATE}Hz .m4a files…"
echo

# Capture file list once (find walk is the slow part on a big library).
# macOS default bash is 3.2 (no mapfile); use a tmpfile + while-read.
list_tmp=$(mktemp /tmp/jt-reencode-list.XXXXXX)
trap 'rm -f "$list_tmp"' EXIT
find "$LIB_ROOT" -type f -name "*.m4a" | sort > "$list_tmp"
total_files=$(wc -l < "$list_tmp" | tr -d ' ')
echo "found $total_files .m4a files"
echo

# Loop reads file list on FD 3 so ffmpeg/afinfo inside the loop can't
# consume bytes from the file list via stdin. (ffmpeg in particular
# reads from FD 0 by default to support `q` quit-key + interactive
# overwrite prompts, and was eating ~30 bytes per invocation, which
# truncated the next path and produced false "unreadable" warnings.)
while IFS= read -r src <&3; do
  [ -z "$src" ] && continue
  scanned=$((scanned + 1))
  rate=$(afinfo "$src" 2>/dev/null | grep "Data format" | head -1 | grep -oE "[0-9]+ Hz" | head -1 | grep -oE "[0-9]+")
  if [ -z "$rate" ]; then
    printf "  WARN  unreadable: %s\n" "$src"
    failed=$((failed + 1))
    continue
  fi
  if [ "$rate" = "$TARGET_RATE" ]; then
    skipped_44k=$((skipped_44k + 1))
    continue
  fi
  # Resume-safety: if a backup already exists, the file was already
  # processed in a previous run — don't re-encode (or re-backup) it.
  if [ -f "${src}${BAK_SUFFIX}" ]; then
    skipped_44k=$((skipped_44k + 1))
    continue
  fi
  if [ "$LIMIT" -gt 0 ] && [ "$needs_fix" -ge "$LIMIT" ]; then
    continue
  fi

  needs_fix=$((needs_fix + 1))
  src_dur=$(afinfo "$src" 2>/dev/null | grep "estimated duration" | grep -oE "[0-9]+\.[0-9]+" | head -1)
  printf "  %d/%d  %s Hz  %ss  %s\n" "$needs_fix" "$total_files" "$rate" "${src_dur:-?}" "${src#$LIB_ROOT/}"

  if [ $APPLY -eq 0 ]; then
    continue
  fi

  tmp="${src%.m4a}.reencode-tmp-$$.m4a"
  # Run ffmpeg quietly; capture stderr only on failure. </dev/null on
  # stdin is belt-and-suspenders with the FD-3 loop above — ffmpeg
  # reads from stdin for interactive prompts and would otherwise eat
  # bytes from whatever fd 0 happens to be.
  if ! err=$(ffmpeg -nostdin -y -v error -i "$src" \
        -c:a aac -b:a "${TARGET_BITRATE_K}k" -ar "$TARGET_RATE" \
        -map_metadata 0 -c:v copy "$tmp" </dev/null 2>&1); then
    printf "    FAIL  ffmpeg: %s\n" "$err"
    rm -f "$tmp"
    failed=$((failed + 1))
    continue
  fi

  # Verify the tmp file looks right.
  out_rate=$(afinfo "$tmp" 2>/dev/null | grep "Data format" | head -1 | grep -oE "[0-9]+ Hz" | head -1 | grep -oE "[0-9]+")
  out_dur=$(afinfo "$tmp" 2>/dev/null | grep "estimated duration" | grep -oE "[0-9]+\.[0-9]+" | head -1)
  if [ "$out_rate" != "$TARGET_RATE" ]; then
    printf "    FAIL  output rate %s, expected %s\n" "${out_rate:-?}" "$TARGET_RATE"
    rm -f "$tmp"
    failed=$((failed + 1))
    continue
  fi
  if [ -n "$src_dur" ] && [ -n "$out_dur" ]; then
    # Bash has no float math; use awk for the 0.5s tolerance check.
    if ! awk -v a="$src_dur" -v b="$out_dur" 'BEGIN { d=a-b; if (d<0) d=-d; exit (d<=0.5)?0:1 }'; then
      printf "    FAIL  duration drift %s -> %s\n" "$src_dur" "$out_dur"
      rm -f "$tmp"
      failed=$((failed + 1))
      continue
    fi
  fi

  # Atomic swap with mtime preservation. With backups on (the default),
  # we move the original to <src>.pre-441k-fix.bak BEFORE writing the
  # new file — that way the original is never destroyed by the mv, only
  # renamed. To revert: `mv <src>.pre-441k-fix.bak <src>`.
  src_mtime=$(stat -f "%m" "$src")
  if [ $BACKUP -eq 1 ]; then
    bak="${src}${BAK_SUFFIX}"
    if ! mv "$src" "$bak"; then
      printf "    FAIL  backup mv: could not rename original\n"
      rm -f "$tmp"
      failed=$((failed + 1))
      continue
    fi
    if ! mv "$tmp" "$src"; then
      printf "    FAIL  install mv: rolling back from backup\n"
      mv "$bak" "$src" 2>/dev/null || true
      rm -f "$tmp"
      failed=$((failed + 1))
      continue
    fi
  else
    if ! mv "$tmp" "$src"; then
      printf "    FAIL  mv: could not replace source\n"
      rm -f "$tmp"
      failed=$((failed + 1))
      continue
    fi
  fi
  # touch -t expects YYYYMMDDhhmm.SS — derive from epoch via date.
  touch -t "$(date -r "$src_mtime" "+%Y%m%d%H%M.%S")" "$src"

  fixed=$((fixed + 1))
done 3< "$list_tmp"

echo
echo "=== ${mode_label} summary ==="
echo "  scanned:                  $scanned"
echo "  already 44100 Hz / done:  $skipped_44k"
echo "  needed re-encode:         $needs_fix"
echo "  re-encoded OK:            $fixed"
echo "  failed:                   $failed"

if [ $APPLY -eq 1 ] && [ $fixed -gt 0 ] && [ $BACKUP -eq 1 ]; then
  echo
  echo "Backups: originals preserved at <file>${BAK_SUFFIX}."
  echo "  To list:        find \"$LIB_ROOT\" -name \"*${BAK_SUFFIX}\""
  echo "  To revert one:  mv <file>${BAK_SUFFIX} <file>"
  echo "  To delete all (after verifying playback): find \"$LIB_ROOT\" -name \"*${BAK_SUFFIX}\" -delete"
fi

if [ $APPLY -eq 0 ] && [ $needs_fix -gt 0 ]; then
  echo
  echo "Dry run only. Re-run with --apply to rewrite the $needs_fix files in place."
fi
