#!/usr/bin/env bash
# Builds athena-ad.mp4 from life/*.mp4 (Runway), app/*.mp4 (screen captures) and audio/mix.wav.
set -euo pipefail
A="${AD_DIR:-$(pwd)}"  # working folder with life10/, ov/, app/ and audio/
cd "$A"; mkdir -p seg
# shot  source            in   dur
SHOTS="01 life/s01.mp4 0.4 4
02 app/s02.mp4 0 6
03 life/s03.mp4 0.6 4
04 app/s04.mp4 0 5
05 life/s05.mp4 0.5 4
06 app/s06.mp4 0 7
07 life/s07.mp4 0.6 4
08 app/s08.mp4 0 4
09 life/s09.mp4 0.6 4
10 app/s10.mp4 0 6
11 life/s11.mp4 0.0 5
12 app/s12.mp4 0 3
13 app/s13.mp4 0 4"
: > seg/list.txt
while read n src in dur; do
  case $src in
    life/*) vf="scale=1920:1080:flags=lanczos,eq=contrast=1.03:saturation=0.94:gamma=1.02,fps=30" ;;
    *)      vf="scale=1920:1080:flags=lanczos,fps=30" ;;
  esac
  [ "$n" = "01" ] && vf="$vf,fade=t=in:st=0:d=0.6"
  ffmpeg -nostdin -hide_banner -loglevel error -y -ss "$in" -i "$src" -t "$dur" -an -vf "$vf,format=yuv420p" \
    -c:v libx264 -preset slow -crf 16 -r 30 "seg/$n.mp4"
  echo "file '$n.mp4'" >> seg/list.txt
done <<< "$SHOTS"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i seg/list.txt -i audio/mix.wav \
  -map 0:v -map 1:a -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -c:a aac -b:a 256k \
  -shortest -movflags +faststart athena-ad.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 athena-ad.mp4
