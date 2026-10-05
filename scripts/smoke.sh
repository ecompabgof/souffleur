#!/usr/bin/env bash
# Plays an English sentence into BlackHole so you can test Souffleur without a real meeting.
# Usage: npm run smoke  (app must be running with "Eux" = BlackHole 2ch)
set -euo pipefail
FFMPEG="${FFMPEG_PATH:-ffmpeg}"
TMP="$(mktemp -d)"
TEXT="${1:-Thanks for taking the time today. Before we go further, I need to understand how your pricing works, because we already have an internal sales team and I'm not sure this is the right moment for us.}"

say -v Samantha -o "$TMP/say.aiff" "$TEXT"
"$FFMPEG" -hide_banner -loglevel error -y -i "$TMP/say.aiff" -ar 48000 -ac 2 "$TMP/say.wav"

# audiotoolbox output device index (CoreAudio order, differs from avfoundation)
IDX="$("$FFMPEG" -hide_banner -f audiotoolbox -list_devices true -i "" 2>&1 | grep -i blackhole | head -1 | sed -E 's/.*\[([0-9]+)\].*/\1/' || true)"
if [ -z "$IDX" ]; then
  echo "BlackHole not found among audiotoolbox output devices:" >&2
  "$FFMPEG" -hide_banner -f audiotoolbox -list_devices true -i "" 2>&1 | grep -E '^\[' >&2 || true
  exit 1
fi
echo "Playing into BlackHole (audiotoolbox device $IDX)…"
"$FFMPEG" -hide_banner -loglevel error -re -i "$TMP/say.wav" -f audiotoolbox -audio_device_index "$IDX" -
rm -rf "$TMP"
echo "Done."
