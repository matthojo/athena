#!/usr/bin/env bash
# Second cut: AR cards floating above tracked phones, upbeat music. Output athena-ad-v2.mp4 (24fps).
set -euo pipefail
A="${AD_DIR:-$(pwd)}"  # working folder with life10/, ov/, app/ and audio/
S="${SOUNDS_DIR:-$A/sounds}"  # the levelled UI sounds
cd "$A"; mkdir -p seg2
V=venv/bin/python
# scene clip start len overlay ov_at card_w valid_from valid_to
SCENES="1 a1 0.6 9.4 o1 1.2 420 2.0 10
2 a2 0.3 9.7 o2 0.6 520 0 10
3 a3 0.0 10.0 o3 0.5 520 0 5.5
4 a4 2.0 8.0 o4 3.6 460 6.0 10
5 a5 1.5 8.5 o5 2.8 520 4.0 10
6 a6 0.0 10.0 o6 0.5 520 0 7.0"
: > seg2/list.txt
while read n clip st len ov at cw v0 v1; do
  $V composite.py life10/$clip.mp4 life10/$clip.json ov/$ov.mov seg2/$n.mp4 $st $len $at $cw $v0 $v1 < /dev/null
  echo "file '$n.mp4'" >> seg2/list.txt
done <<< "$SCENES"
# End card at 24fps, held to fill the minute.
ffmpeg -nostdin -v error -y -i app/s13.mp4 -vf "fps=24,tpad=stop_mode=clone:stop_duration=0.4,format=yuv420p" \
  -c:v libx264 -preset slow -crf 16 seg2/7.mp4
echo "file '7.mp4'" >> seg2/list.txt
# Effects, placed on the card moments.
cd audio
ffmpeg -nostdin -v error -y -i $S/notification-2.mp3 -i $S/send-2.mp3 -i $S/reply-1.mp3 -i $S/saved-1.mp3 \
  -i $S/done-3.mp3 -i $S/done-3.mp3 -i $S/done-3.mp3 -i $S/tap-3.mp3 -filter_complex \
"[0]adelay=11400|11400,volume=0.3[a];[1]adelay=20200|20200,volume=0.3[b];[2]adelay=23330|23330,volume=0.4[c];\
[3]adelay=32900|32900,volume=0.45[d];[4]adelay=40800|40800,volume=0.3[e];[5]adelay=42300|42300,volume=0.3[f];\
[6]adelay=43800|43800,volume=0.3[g];[7]adelay=47600|47600,volume=0.5[h];\
[a][b][c][d][e][f][g][h]amix=inputs=8:normalize=0,apad=whole_dur=60,atrim=0:60" -ar 48000 -ac 2 sfx2-track.wav
ffmpeg -nostdin -v error -y -i mus2-vo.wav -i sfx2-track.wav -filter_complex \
  "[0][1]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1:LRA=9" -ar 48000 -ac 2 mix2.wav
cd ..
ffmpeg -nostdin -v error -y -f concat -safe 0 -i seg2/list.txt -i audio/mix2.wav -map 0:v -map 1:a \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -r 24 -c:a aac -b:a 256k -shortest -movflags +faststart athena-ad-v2.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 athena-ad-v2.mp4
