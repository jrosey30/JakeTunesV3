#!/bin/bash
# scripts/build-native.sh — compile the native helpers under native/ into
# native/bin (gitignored). Runs as the last step of `npm run build`;
# electron-builder ships native/bin as Resources/bin (package.json
# build.extraResources), so a packaged app finds them at
# process.resourcesPath/bin/<name> and a dev run at native/bin/<name>.
#
# Helpers today:
#   micwatch — native/micwatch/micwatch.swift, the microphone sensor behind
#              "Pause for video calls" (src/main/pause-for-calls.ts).
#
# Policy when the Swift toolchain is missing on a Mac: WARN and exit 0. The
# app still builds and runs; the feature stands down with one warning in
# main.log. A hard failure here would break the unattended auto-deploy on a
# Mac without Xcode, which is worse than one missing feature. Export
# JT_NATIVE_STRICT=1 to make a missing toolchain fail the build instead.
#
#   bash scripts/build-native.sh            build what is out of date
#   bash scripts/build-native.sh --force    rebuild regardless
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=native/bin
SRC=native/micwatch/micwatch.swift
BIN="$OUT/micwatch"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[build-native] not macOS — native helpers skipped"
  exit 0
fi

mkdir -p "$OUT"

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "[build-native] WARNING: swiftc not found — install Xcode or the Command Line Tools (xcode-select --install)." >&2
  echo "[build-native] WARNING: micwatch NOT built; the app runs, and 'Pause for video calls' stands down with one warning in main.log." >&2
  if [ -n "${JT_NATIVE_STRICT:-}" ]; then exit 1; fi
  exit 0
fi

# Up to date? (source and this script both older than the binary)
if [ "${1:-}" != "--force" ] && [ -x "$BIN" ] && [ ! "$SRC" -nt "$BIN" ] && [ ! "$0" -nt "$BIN" ]; then
  echo "[build-native] micwatch up to date ($BIN)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Swift 5 language mode on purpose: the helper is top-level code with a
# serial DispatchQueue guarding its state; Swift 6 strict concurrency has
# no way to express that for globals and refuses to compile it.
FLAGS=(-O -swift-version 5 -module-name micwatch)

xcrun swiftc "${FLAGS[@]}" -target arm64-apple-macos14.0 -o "$TMP/micwatch-arm64" "$SRC"

# Intel slice when it is cheap (same source, one more compile); never fail
# the build over it — Intel is out of scope (CLAUDE.md), arm64 is the ship.
if xcrun swiftc "${FLAGS[@]}" -target x86_64-apple-macos14.0 -o "$TMP/micwatch-x86_64" "$SRC" 2>"$TMP/x86.err"; then
  xcrun lipo -create -output "$TMP/micwatch" "$TMP/micwatch-arm64" "$TMP/micwatch-x86_64"
else
  cp "$TMP/micwatch-arm64" "$TMP/micwatch"
  echo "[build-native] x86_64 slice skipped: $(head -1 "$TMP/x86.err")"
fi

chmod 755 "$TMP/micwatch"
mv -f "$TMP/micwatch" "$BIN"
echo "[build-native] wrote $BIN ($(xcrun lipo -archs "$BIN"))"
