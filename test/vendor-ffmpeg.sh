#!/usr/bin/env bash
# Fetch the static ffmpeg build used by the desktop packaging (not committed:
# it exceeds GitHub's 100 MB per-file limit). GPL build, includes libx264,
# libvpx, ffv1, prores. Only the ~176 MB ffmpeg binary is kept (no ffprobe;
# the server never calls it).
set -euo pipefail
cd "$(dirname "$0")/.."
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
DEST="desktop/vendor"
BIN="$DEST/ffmpeg"
if [ -x "$BIN" ]; then echo "already vendored: $BIN ($("$BIN" -version | head -1 | cut -d' ' -f3))"; exit 0; fi
mkdir -p "$DEST"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "downloading static ffmpeg (~90 MB compressed)..."
curl -fsSL "$URL" -o "$tmp/ffmpeg.tar.xz"
tar -xf "$tmp/ffmpeg.tar.xz" -C "$tmp" --wildcards '*/bin/ffmpeg'
mv "$(find "$tmp" -type f -path '*/bin/ffmpeg' | head -1)" "$BIN"
chmod +x "$BIN"
echo "vendored: $BIN"
"$BIN" -version | head -1
