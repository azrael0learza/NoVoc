#!/usr/bin/env bash
# Generates an 8-second demo track (kick + wobble pad + pink noise) for preview/testing.
set -euo pipefail
cd "$(dirname "$0")/.."
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "sine=frequency=90:duration=8" \
  -f lavfi -i "sine=frequency=440:duration=8" \
  -f lavfi -i "sine=frequency=660:duration=8" \
  -f lavfi -i "anoisesrc=color=pink:amplitude=0.12:duration=8" \
  -filter_complex "[0:a]tremolo=f=2:d=0.97[k];[1:a]tremolo=f=0.5:d=0.9,volume=0.5[p1];[2:a]tremolo=f=0.25:d=0.9,volume=0.3[p2];[k][p1][p2][3:a]amix=inputs=4:normalize=0,volume=1.4" \
  -ar 44100 test/sample.wav
echo "wrote test/sample.wav"
